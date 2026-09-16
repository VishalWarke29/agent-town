# Explicit integration smoke checks

## Real OpenTelemetry SDKs

Run from the project root after normal application dependencies are installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\smoke\run-otlp.ps1
```

- Downloads pinned official OpenTelemetry packages into a fresh `.data/otel-smoke-<id>` directory and a dedicated Python virtual environment. No global installation or application dependency change.
- Requires Node, npm, Python with `venv`, and registry access. npm package lifecycle scripts are disabled. Python installs wheels only.
- Opens an isolated Agent Town service on a dynamically allocated loopback port. It uses a synthetic owner/workspace, an in-memory credential vault and a reviewed fixture route. No GitHub account, provider, user repository or hook is contacted or modified.
- Runs real Node and Python HTTP handlers with explicit OpenTelemetry SDK instrumentation and official HTTP/Protobuf exporters.
- For each language, verifies two requests after `forceFlush`, then a third request delivered by shutdown. Three spans plus cumulative metrics still count as three requests with one error.
- Verifies source/repository scope, known route templates, unavailable unknown routes, rejected resource mismatch and ignored unapproved run attribution. A second three-request fixture per language deliberately uses a mismatched resource.
- Synthetic private-looking URL, query, header, body, span-name, event and resource markers must be absent from saved state and every persisted fixture file. Ephemeral credentials must also be absent.
- Confirms the exporters accepted real Protobuf responses. The process prints a sanitized JSON result and retains it as `result.json` in the fresh environment.
- Retains the isolated SDK installations and synthetic databases for review. The fixture service and child HTTP servers stop before the command finishes.
- This is an exporter/receiver interoperability test. It does not certify every Express/FastAPI/Flask launcher or zero-code instrumentation package. gRPC and compressed OTLP remain unsupported.

Optional arguments select a **new** environment beneath this project's `.data` folder and a new evidence file:

```powershell
.\tests\smoke\run-otlp.ps1 -EnvironmentDirectory C:\projects\Agent\.data\otel-smoke-review -Output C:\projects\Agent\docs\assets\audit\otel-review.json
```

After the dependencies are already installed, a focused rerun can reuse them while creating a fresh synthetic runtime:

```powershell
node --import tsx tests/smoke/otlp-sdk.ts --environment .data/otel-smoke-review --output .data/otel-smoke-review/second-result.json
```

Node direct dependencies and transitive hashes are pinned in `node/package.json` and `node/package-lock.json`. Python direct and transitive versions are pinned in `python/requirements.txt`. This smoke suite is explicitly invoked; ordinary unit tests do not install packages or run it.

References checked 14 September 2026: [official JavaScript exporters](https://opentelemetry.io/docs/languages/js/exporters/), [official Python exporters](https://opentelemetry.io/docs/languages/python/exporters/), [HTTP metric conventions](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/), and [OTLP exporter settings](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/).

## Windows launcher and Ctrl+C

After installing the locked application dependencies and building the app, choose a new fixture directory and evidence file:

```powershell
python tests/smoke/launcher-smoke.py --data-directory .data/launcher-review --output docs/assets/audit/launcher-review.json --preserve-port 4310
```

- Uses Python's standard library and Windows PowerShell 5.1; installs nothing. Refuses startup if the dependency stamp is stale or built files are missing.
- Runs the real `run.ps1 -Mode production -NoBuild` on a dynamically selected unused loopback port with a fresh data directory and a fictional public GitHub Client ID. No authorization or paid work starts.
- Creates a separate hidden Windows console. Its child environment uses the Windows PowerShell module directory, avoiding inherited PowerShell 7 module precedence.
- Checks health, the actual build ID and served JavaScript, production mode, configured sign-in without an owner, and the owned service lock.
- Sends a real `CTRL_C_EVENT` only to that isolated console. Holds exact process handles to verify that the launcher, Node and console host exit; verifies the port closes and service lock is released.
- Records listeners on each optional `--preserve-port` before and after. Never stops those processes. `--port` can select a specific unused test port.
- Retains synthetic fixture data and a sanitized JSON result. An unavailable console signal is a failure; there is no forced process-kill fallback.
- This built-launcher check does not verify source hot reload; the separate development smoke below does.

The final local run passed on 14 September 2026 with build `445d92880051`: [sanitized startup and graceful-shutdown evidence](../../docs/assets/audit/2026-09-15-launcher-smoke-passed.json). Earlier harness attempts remain recorded separately; they do not count as passes.

Windows signal behavior follows [GenerateConsoleCtrlEvent](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent), [AttachConsole](https://learn.microsoft.com/en-us/windows/console/attachconsole), and [process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags). A nonzero process group cannot target `CTRL_C_EVENT`; isolation here comes from the newly created console, with group zero signalling only its occupants.

## Real development source refresh

```powershell
python tests/smoke/dev-launcher-smoke.py --fixture .data/dev-launcher-review --output docs/assets/audit/dev-launcher-review.json --preserve-port 4310
```

- Uses a new application source copy, a new runtime directory and two unused loopback ports. No live application source or private configuration is copied or changed.
- Reuses installed packages through dependency junctions, with separate cache directories and workspace package links pointing to the copied sources. Installs nothing; retains the fixture for review.
- Runs actual `run.ps1 -Mode development -Dev -Port ... -WebPort ...` in its own hidden console. Checks proxied health and a same-origin session request with a fictional public Client ID.
- The Node `vite-hmr.mjs` helper registers two copied modules, opens the real HMR WebSocket with the browser Origin and runtime token, changes a dependency on disk and verifies both the update frame and fresh transformed source. Tokens are never printed or saved.
- Changes only the copied service build marker. Verifies a different process and changed HTTP response, and that the previous service process exited.
- Sends real Ctrl+C to the owned launcher console, checks every captured process handle, both ports, the service lock and preserved user listeners. Avoid listing a Playwright-managed port under `--preserve-port` because its independent lifecycle can stop or restart it during the check.
- Covers file watching, module graph, HMR transport and fresh source delivery. It does not execute React in a browser or prove component state preservation.

The final smoke passed on 14 September 2026: [sanitized evidence](../../docs/assets/audit/2026-09-15-dev-launcher-smoke-passed.json). It exposed and then verified the fix for an earlier nested npm/concurrently shutdown race; that earlier failed artifact remains separate. The direct development supervisor now asks its owned service to stop through private IPC and waits for exit before replacement or launcher completion.

Vite references checked 14 September 2026: [WebSocket server options](https://vite.dev/config/server-options#server-ws) and [HMR API](https://vite.dev/guide/api-hmr).
