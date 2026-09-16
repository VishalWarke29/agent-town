"""Exercise the real Windows launcher in its own hidden console; no accounts or model calls."""
from __future__ import annotations

import argparse
import ctypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request


def powershell_json(script: str):
    result = subprocess.run(
        [str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
         "-NoProfile", "-Command", script],
        capture_output=True, text=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return json.loads(result.stdout) if result.stdout.strip() else None


def listener(port: int):
    rows = powershell_json(
        f"@(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | "
        "Select-Object LocalAddress,LocalPort,OwningProcess) | ConvertTo-Json -Compress"
    )
    return rows if isinstance(rows, list) else [rows] if rows else []


def descendants(parent: int):
    rows = powershell_json(
        "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress"
    )
    found = {parent}
    while True:
        extra = {int(row["ProcessId"]) for row in rows if int(row["ParentProcessId"]) in found}
        if extra.issubset(found):
            break
        found.update(extra)
    return [row for row in rows if int(row["ProcessId"]) in found]


def send_ctrl_c(parent: int):
    # This helper has no console initially. Attach only to our CREATE_NEW_CONSOLE launch.
    # CTRL_C_EVENT with group 0 reaches that console; a nonzero group cannot target Ctrl+C.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.FreeConsole()
    if not kernel.AttachConsole(parent):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not kernel.SetConsoleCtrlHandler(None, True):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.GenerateConsoleCtrlEvent(0, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        time.sleep(0.2)
    finally:
        kernel.FreeConsole()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-directory", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--preserve-port", type=int, action="append", default=[])
    parser.add_argument("--signal-owned-console", type=int)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("This smoke checks the Windows launcher and Windows console shutdown.")
    if args.signal_owned_console:
        send_ctrl_c(args.signal_owned_console)
        return
    root = Path(__file__).resolve().parents[2]
    if not args.data_directory or not args.output:
        parser.error("A new --data-directory below project .data and a new --output are required.")
    data = args.data_directory.resolve()
    output = args.output.resolve()
    if not data.is_relative_to(root / ".data") or data == root / ".data" or data.exists():
        parser.error("The fixture data directory must be new and inside project .data.")
    if output.exists() or not output.is_relative_to(root):
        parser.error("The evidence file must be new and inside this project.")
    for item in (root / "apps/web/dist/index.html", root / "apps/service/dist/index.js"):
        if not item.is_file():
            parser.error("Build the application before invoking this smoke.")
    lock_hash = hashlib.sha256((root / "package-lock.json").read_bytes()).hexdigest()
    stamp = root / "node_modules/.agent-town-lock"
    if not (root / "node_modules/.package-lock.json").is_file() or not stamp.is_file() or stamp.read_text().strip().lower() != lock_hash:
        parser.error("Install the locked dependencies first; this smoke does not permit npm ci.")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", args.port))
        port = reservation.getsockname()[1]
    if port in args.preserve_port or port < 1024:
        parser.error("Choose a separate unused unprivileged port.")
    baseline = {str(item): listener(item) for item in args.preserve_port}
    data.mkdir(parents=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    evidence = {"startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "fixture": data.relative_to(root).as_posix(), "port": port,
                "applicationMode": "production", "launch": "run.ps1 -NoBuild",
                "console": "separate hidden Windows console", "modelCalls": 0,
                "accountAuthorizations": 0, "preservedListenersBefore": baseline,
                "liveSourceHotReloadVerified": False, "passed": False}
    process = None
    handles = []
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    try:
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0
        # Avoid inheriting PowerShell 7 module precedence into Windows PowerShell 5.1.
        # Its built-in Get-FileHash otherwise resolves the incompatible Core module first.
        env = {key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"}
        env["PSModulePath"] = str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/Modules")
        env["AGENT_TOWN_DATA_DIR"] = str(data)
        command = [str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
                   "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(root / "run.ps1"),
                   "-Mode", "production", "-NoBuild", "-Port", str(port),
                   "-GitHubClientId", "isolated-launcher-public-id"]
        with (data / "launcher.log").open("wb") as log:
            process = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=log, startupinfo=startup,
                                       creationflags=subprocess.CREATE_NEW_CONSOLE)
            evidence["launcherPid"] = process.pid
            base = f"http://127.0.0.1:{port}"
            deadline = time.monotonic() + 40
            health = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("Launcher exited before health became available; inspect owned fixture log.")
                try:
                    with urllib.request.urlopen(base + "/api/v1/health", timeout=1) as response:
                        health = json.load(response)
                    break
                except (OSError, ValueError):
                    time.sleep(0.2)
            if health is None:
                raise RuntimeError("Health did not become available within the bounded startup deadline.")
            evidence["health"] = health
            assert health["ok"] and health["applicationMode"] == "production"
            assert not health["hostedDeploymentReady"] and not health["paidWorkEnabledByDefault"]
            assert health["sourceHotReload"] is False and health["build"]["id"]
            with urllib.request.urlopen(base + "/", timeout=5) as response:
                html = response.read().decode("utf-8")
            entry = health["build"]["webEntry"]
            assert isinstance(entry, str) and entry.startswith("/assets/") and entry in html
            with urllib.request.urlopen(base + entry, timeout=5) as response:
                asset = response.read()
            assert asset
            evidence["webAsset"] = {"path": entry, "bytes": len(asset), "sha256": hashlib.sha256(asset).hexdigest()}
            session_request = urllib.request.Request(base + "/api/v1/session", method="POST", headers={"Origin": base})
            with urllib.request.urlopen(session_request, timeout=5) as response:
                session = json.load(response)
            # Only non-identifying setup fields are retained.
            evidence["session"] = {"applicationMode": session["applicationMode"], "hasOwner": session["user"] is not None,
                                   "workspaceCount": len(session["workspaces"]), "githubConfigured": session["identity"]["configured"]}
            assert session["applicationMode"] == "production" and session["user"] is None and not session["workspaces"]
            assert session["identity"]["configured"] is True
            owned = descendants(process.pid)
            evidence["ownedProcesses"] = owned
            for row in owned:
                handle = kernel.OpenProcess(0x100000, False, row["ProcessId"])
                if not handle:
                    raise RuntimeError("Could not hold an exact owned process handle for shutdown verification.")
                handles.append((row["ProcessId"], handle))
            bound = listener(port)
            owned_ids = {row["ProcessId"] for row in owned}
            assert bound and all(row["OwningProcess"] in owned_ids for row in bound)
            evidence["ownedListener"] = bound
            lock = data / "production/private/.agent-town.lock"
            assert lock.is_file()
            saved_lock = json.loads(lock.read_text())
            assert saved_lock["pid"] in owned_ids and saved_lock["operation"] == "service"
            evidence["serviceLockOwned"] = True
            signal = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--signal-owned-console", str(process.pid)],
                                    capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
            evidence["ctrlCSignalExitCode"] = signal.returncode
            if signal.returncode:
                raise RuntimeError("The isolated console CTRL_C_EVENT helper failed.")
            evidence["launcherExitCode"] = process.wait(timeout=20)
            exited = {str(pid): kernel.WaitForSingleObject(handle, 5000) == 0 for pid, handle in handles}
            evidence["ownedProcessHandlesSignalled"] = exited
            evidence["fixturePortClosed"] = not listener(port)
            evidence["serviceLockReleased"] = not lock.exists()
            after = {str(item): listener(item) for item in args.preserve_port}
            evidence["preservedListenersAfter"] = after
            evidence["preservedListenersUnchanged"] = baseline == after
            assert all(exited.values()) and evidence["fixturePortClosed"] and evidence["serviceLockReleased"]
            assert baseline == after
            assert process.returncode in (0, 130, -1073741510, 3221225786)
            evidence["passed"] = True
    except Exception as error:
        evidence["failure"] = {"type": type(error).__name__, "message": str(error) if isinstance(error, (RuntimeError, AssertionError)) else "Launcher smoke could not complete; inspect owned fixture artifacts."}
        if process and process.poll() is None:
            # Assertion failures still stop our console normally. Never force-kill unrelated processes.
            try:
                cleanup = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--signal-owned-console", str(process.pid)],
                                         capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
                evidence["failureCleanupSignalExitCode"] = cleanup.returncode
                evidence["failureCleanupLauncherExitCode"] = process.wait(timeout=20)
            except (OSError, subprocess.TimeoutExpired):
                evidence["ownedLauncherStillRunning"] = process.pid
        raise
    finally:
        for _, handle in handles:
            kernel.CloseHandle(handle)
        evidence["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
