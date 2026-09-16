"""Run real development refresh checks against a copied application, never live sources."""
from __future__ import annotations

import argparse
import ctypes
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
helper_spec = importlib.util.spec_from_file_location("launcher_smoke", Path(__file__).with_name("launcher-smoke.py"))
helper = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(helper)
POWERSHELL = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"


def get_json(url: str, origin: str | None = None):
    request = urllib.request.Request(url, method="POST", headers={"Origin": origin}) if origin else url
    with urllib.request.urlopen(request, timeout=2) as response:
        return json.load(response)


def copy_application(destination: Path, fixture: Path):
    destination.mkdir()
    # Explicit application source/config paths; no private configuration, data or credentials.
    for name in ["apps/service/src", "apps/service/drizzle", "apps/web/src", "apps/web/public", "packages/contracts/src"]:
        source = ROOT / name
        if source.is_dir():
            shutil.copytree(source, destination / name, symlinks=True)
    for name in ["package.json", "package-lock.json", "tsconfig.json", "run.ps1", "apps/web/index.html",
                 "apps/web/vite.config.ts", "apps/web/package.json", "apps/service/package.json", "packages/contracts/package.json"]:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)
    scripts = destination / "scripts"
    scripts.mkdir()
    for source in (ROOT / "scripts").glob("*.mjs"):
        shutil.copy2(source, scripts / source.name)
    # Reuse installed packages without installs. Keep the cache root local, and route workspace
    # packages to the copied sources so service watch cannot import the user's live contracts.
    modules = destination / "node_modules"
    modules.mkdir()
    links = []
    for source in (ROOT / "node_modules").iterdir():
        if source.name in ("@agent-town", ".vite", ".vite-temp", ".cache"):
            continue
        if source.is_dir():
            links.append({"source": str(source.resolve()), "destination": str(modules / source.name)})
        elif source.name in (".agent-town-lock", ".package-lock.json"):
            shutil.copy2(source, modules / source.name)
    (modules / "@agent-town").mkdir()
    for name, relative in [("contracts", "packages/contracts"), ("service", "apps/service"), ("web", "apps/web")]:
        links.append({"source": str(destination / relative), "destination": str(modules / "@agent-town" / name)})
    manifest = fixture / "dependency-links.json"
    manifest.write_text(json.dumps(links), encoding="utf-8")
    script = fixture / "link-dependencies.ps1"
    script.write_text("param([string]$Manifest)\n$ErrorActionPreference = 'Stop'\n"
                      "foreach ($entry in (Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json)) {\n"
                      "  New-Item -ItemType Junction -Path $entry.destination -Target $entry.source -ErrorAction Stop | Out-Null\n}\n", encoding="utf-8")
    subprocess.run([str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-Manifest", str(manifest)],
                   check=True, capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--preserve-port", action="append", type=int, default=[])
    args = parser.parse_args()
    fixture = args.fixture.resolve()
    output = args.output.resolve()
    if fixture.parent != ROOT / ".data" or not fixture.name.startswith("dev-launcher-") or fixture.exists():
        parser.error("Use a new .data/dev-launcher-* fixture directory.")
    if not output.is_relative_to(ROOT) or output.exists():
        parser.error("Use a new evidence file inside this project.")
    package_hash = hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest()
    if (ROOT / "node_modules/.agent-town-lock").read_text().strip().lower() != package_hash:
        parser.error("Locked dependencies must already be installed; this smoke installs nothing.")
    reserved = [socket.socket(), socket.socket()]
    for sock in reserved:
        sock.bind(("127.0.0.1", 0))
    service_port, web_port = [sock.getsockname()[1] for sock in reserved]
    if any(port in args.preserve_port for port in (service_port, web_port)):
        parser.error("Selected fixture port overlaps a preserved listener.")
    before = {str(port): helper.listener(port) for port in args.preserve_port}
    fixture.mkdir(parents=True)
    copy_root = fixture / "application"
    copy_application(copy_root, fixture)
    for sock in reserved:
        sock.close()
    runtime = fixture / "runtime"
    evidence = {"startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "fixture": fixture.relative_to(ROOT).as_posix(),
                "servicePort": service_port, "webPort": web_port, "sourceCopy": True, "installs": 0,
                "accountAuthorizations": 0, "modelCalls": 0, "preservedListenersBefore": before, "passed": False}
    env = {key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"}
    env["PSModulePath"] = str(POWERSHELL.parent / "Modules")
    env["AGENT_TOWN_DATA_DIR"] = str(runtime)
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handles = {}
    process = None
    def capture_owned():
        rows = helper.descendants(process.pid)
        for row in rows:
            pid = row["ProcessId"]
            if pid not in handles:
                handle = kernel.OpenProcess(0x100000, False, pid)
                if not handle:
                    raise RuntimeError("An exact owned process handle was unavailable.")
                handles[pid] = handle
        return rows
    def signal_and_wait():
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("launcher-smoke.py")), "--signal-owned-console", str(process.pid)],
                                capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
        evidence["ctrlCSignalExitCode"] = result.returncode
        if result.returncode:
            raise RuntimeError("Isolated CTRL_C_EVENT failed; no forced kill attempted.")
        evidence["launcherExitCode"] = process.wait(timeout=25)
    try:
        with (fixture / "launcher.log").open("wb") as log:
            process = subprocess.Popen([str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(copy_root / "run.ps1"),
                                        "-Mode", "development", "-Dev", "-Port", str(service_port), "-WebPort", str(web_port),
                                        "-GitHubClientId", "isolated-development-public-id"], cwd=copy_root, env=env,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, startupinfo=startup,
                                       creationflags=subprocess.CREATE_NEW_CONSOLE)
            evidence["launcherPid"] = process.pid
            service = f"http://127.0.0.1:{service_port}"
            web = f"http://127.0.0.1:{web_port}"
            deadline = time.monotonic() + 45
            while True:
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("Development servers did not become ready; inspect the owned fixture log.")
                try:
                    initial = get_json(web + "/api/v1/health")
                    assert initial["sourceHotReload"] and initial["build"]["id"] == "development-source"
                    assert initial == get_json(service + "/api/v1/health")
                    break
                except (OSError, ValueError, AssertionError):
                    time.sleep(0.25)
            evidence["initialHealth"] = initial
            session = get_json(web + "/api/v1/session", web)
            assert session["applicationMode"] == "development" and session["user"] is None
            assert session["identity"]["configured"]
            evidence["proxiedSessionAccepted"] = True
            evidence["ownedProcessesBeforeReload"] = capture_owned()
            lock = runtime / "private/.agent-town.lock"
            original_pid = json.loads(lock.read_text())["pid"]
            assert original_pid in handles
            hmr = subprocess.run(["node", str(ROOT / "tests/smoke/vite-hmr.mjs"), "--web-port", str(web_port),
                                  "--fixture-web-root", str(copy_root / "apps/web")], cwd=copy_root,
                                 capture_output=True, text=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
            if hmr.returncode:
                raise RuntimeError("Real HMR probe failed; no tokens or raw response output are exposed.")
            evidence["frontendHmr"] = json.loads(hmr.stdout)
            assert evidence["frontendHmr"]["ok"]
            # Edit only copied source. A different response proves actual module reload, not a log message.
            source = copy_root / "apps/service/src/build-info.ts"
            original = source.read_text()
            assert original.count("'development-source'") == 1
            marker = "development-source-smoke-reloaded"
            source.write_text(original.replace("'development-source'", repr(marker)), encoding="utf-8")
            deadline = time.monotonic() + 25
            while True:
                if time.monotonic() > deadline:
                    raise RuntimeError("Copied service source did not reload within the deadline.")
                try:
                    updated = get_json(web + "/api/v1/health")
                    if updated["build"]["id"] == marker:
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(0.25)
            evidence["updatedHealth"] = updated
            updated_pid = json.loads(lock.read_text())["pid"]
            evidence["ownedProcessesAfterReload"] = capture_owned()
            assert updated_pid != original_pid and updated_pid in handles
            assert kernel.WaitForSingleObject(handles[original_pid], 5000) == 0
            evidence["serviceReload"] = {"originalPid": original_pid, "replacementPid": updated_pid,
                                         "oldProcessExited": True, "healthChangedAfterSourceWrite": True}
            signal_and_wait()
            exited = {str(pid): kernel.WaitForSingleObject(handle, 5000) == 0 for pid, handle in handles.items()}
            evidence["ownedProcessHandlesSignalled"] = exited
            evidence["portsClosed"] = not helper.listener(service_port) and not helper.listener(web_port)
            evidence["serviceLockReleased"] = not lock.exists()
            after = {str(port): helper.listener(port) for port in args.preserve_port}
            evidence["preservedListenersAfter"] = after
            evidence["preservedListenersUnchanged"] = before == after
            evidence["liveServiceSourceUnchanged"] = (ROOT / "apps/service/src/build-info.ts").read_text() == original
            assert all(exited.values()) and evidence["portsClosed"] and evidence["serviceLockReleased"]
            assert before == after and evidence["liveServiceSourceUnchanged"]
            assert process.returncode in (0, 130, -1073741510, 3221225786)
            evidence["passed"] = True
    except Exception as error:
        evidence["failure"] = {"type": type(error).__name__, "message": str(error) if isinstance(error, RuntimeError) else "Inspect owned fixture artifacts; no private details emitted."}
        if process and process.poll() is None:
            try:
                capture_owned()
                signal_and_wait()
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                evidence["ownedLauncherStillRunning"] = process.pid
        raise
    finally:
        if handles and not evidence["passed"]:
            evidence["ownedProcessHandlesSignalled"] = {str(pid): kernel.WaitForSingleObject(handle, 3000) == 0 for pid, handle in handles.items()}
            evidence["portsClosed"] = not helper.listener(service_port) and not helper.listener(web_port)
            evidence["serviceLockReleased"] = not (runtime / "private/.agent-town.lock").exists()
            after = {str(port): helper.listener(port) for port in args.preserve_port}
            evidence["preservedListenersAfter"] = after
            evidence["preservedListenersUnchanged"] = before == after
        for handle in handles.values():
            kernel.CloseHandle(handle)
        evidence["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
