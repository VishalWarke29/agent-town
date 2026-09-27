# Agent Town

A little interactive world for your coding agents.

**The local foundation includes private workspaces, discovery, observation, API monitoring and Economy controls — each Built and covered by automated (fixture) checks; real native-tool events and real provider/sandbox execution are Built, not yet verified.** See the [implementation status](docs/17-implementation-status.md) for current delivery and remaining gates, [the capability matrix](docs/records/evidence/capability-matrix.md) for the claim-to-evidence table, and [house exploration verification](docs/31-house-exploration-verification.md) for the interactive workrooms. Managed task execution stays Excluded by design on this computer until the installed runtime passes its restricted-read boundary check (see [managed execution](docs/23-managed-execution.md)). Paid work starts disabled.

Add your IDs later using the numbered [account setup guide](docs/24-connect-your-accounts.md). The prepared `agent-town.config.json` accepts your public GitHub Client ID and optional application mode; provider keys go through protected connection forms.

## Start everything with one command

Open PowerShell in this folder and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Choose an explicit environment with `-Mode demo`, `-Mode development` (default), or `-Mode production` (`-Environment prod` also works). Demo opens sample data and blocks real connections. Production uses separate local storage and disables sample access; it does not publish the app. Add `-Dev` for hot reload in demo/development.

Then open **http://127.0.0.1:4310**. Press **Ctrl+C** in that terminal to stop.

- Requires Node.js **24.14 or newer within the 24.x series**.
- The script checks dependencies, builds the app, and starts one service that serves both the website and API.
- The first install needs internet access. The sample town needs no account. Private sign-in and provider operations contact their official services.
- `-ExecutionPolicy Bypass` applies to this PowerShell process only. It does not change the machine's execution policy.
- If your script policy already permits local scripts, `./run.ps1` works too.

## Connect your workspace

The home page opens account setup first. Add your public GitHub Client ID when ready; an unconfigured service detects the saved file and the visible setup page refreshes within five seconds. Sign in, then select or create a private workspace. Repositories and agents appear from your connected data. A configured GitHub registration stays fixed until restart; changing application mode also requires a restart.

The sample town is optional: choose **Explore sample town** to open it. **Exit sample town** returns to setup or your private workspace. Opening the normal address or signing out never substitutes fictional agents for your own work.

## Explore the optional sample town

1. Choose **Explore sample town**, then drag to pan and scroll to zoom.
2. Click a repository house to zoom into its workroom. Select a resident to inspect its activity, or open **Agents in this repository** for the full roster. **Back to town** restores your view.
3. Open Agents, select Milo, and choose **Send sample report**.
4. Watch Milo walk to the manager. Choose **Visit the manager**.
5. Choose **Update sample brief**, then refresh. The brief and report remain saved.
6. Try **Run demo** for changing sample activities. Each session pauses after 10 minutes.

Both glass drawers start closed. They overlay the same full-screen world. List view provides the same sample actions without using the scene.

For real work, sign in, create a private workspace, and add local project folders; each project gets a house. Watching a tool's sessions is a separate, optional step: prepare an observation hook in Connections, and events the tool sends after that, or sessions you choose to show in town, create characters. Watching is Built and covered by automated checks, but a real event from each installed tool is not yet recorded as evidence (see [the capability matrix](docs/records/evidence/capability-matrix.md)). Connecting a project reads no sessions on its own (item H0-02, checked in the source 2026-09-25): a check of this computer's installed tools starts only when you press **Check this computer** in Repository details, and it writes nothing until you review and apply its proposed hooks. API-funded workers and Codex subscription tasks are separate, explicit connection modes; both are Excluded by design on this computer while preflight blocks the installed execution environment.

**Planned change (plan v5, 24 September 2026, [docs/44](docs/44-houses-first-master-plan.md)).** Watching will be an explicit per-project opt-in with a Stop watching action, a project's houses will be its areas, and tasks will be assigned through a chat that hands the exact text to your own tool; none of that is built yet. (Connecting a project already reads no sessions on its own, described above — item H0-02.) Agent Town does not sign in to the Claude, ChatGPT, Cursor or Copilot tools you run yourself and does not use their subscriptions for its own AI calls; each tool keeps its own sign-in. The one exception in the current build is Agent Town's own isolated Codex sign-in under Connections, which is separate from your Codex, powers no task on this computer and is frozen until the owner decides.

Documentation and screenshots stay on this computer. `AGENTS.md` (including lowercase spelling) and `docs/` are excluded by `.gitignore` at the owner's request.

## Other startup options

```powershell
# Check types and run service tests before starting
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Check

# Start the existing build quickly
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -NoBuild

# Use a different port
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Port 4320

# Develop with automatic reload: open http://127.0.0.1:5173
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Dev

# Check the environment without starting or changing it
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Doctor
```

Development defaults to service port 4310 and website port 5173. Use `-Dev -Port 4312 -WebPort 5174` for different, distinct ports; the API proxy and hot reload use those exact ports. A second instance also needs its own `AGENT_TOWN_DATA_DIR`. The built app serves both website and API on `-Port`. Startup reports an occupied port and leaves the existing process alone.

Stop any older instance before refreshing dependencies. Windows locks loaded native libraries; the launcher detects these locks before installation, including instances on another port.

Offline backup and restore use `-Backup NEW_FOLDER` and `-Restore BACKUP_FOLDER -RestoreTo NEW_RUNTIME_FOLDER`. Stop Agent Town first. See [the recovery steps and exclusions](docs/25-recovery-and-diagnostics.md).

## Development commands

| Command | Purpose |
| --- | --- |
| `npm.cmd ci` | Install the locked dependencies |
| `npm.cmd run check` | Check TypeScript |
| `npm.cmd test` | Run service, storage, and route-finding tests |
| `npm.cmd run build` | Build the website and service |
| `npm.cmd start` | Start the built app |
| `npm.cmd run dev` | Start both development processes |
| `npm.cmd run test:e2e` | Run desktop and mobile browser checks |

Browser checks use installed Microsoft Edge by default. Set `AGENT_TOWN_BROWSER=chrome` to use installed Chrome, or `chromium` after installing Playwright's Chromium. Tests use a separate data folder and port 4311.

## Files and local data

- `apps/web`: React, the 3D town, glass drawers, and accessible list.
- `apps/service`: Fastify, identity, safe discovery, observation, manager/budgets, OTLP, supervised workers, storage, and recovery.
- `packages/contracts`: shared records and command validation.
- `.data/preview.sqlite`: local sample state. This folder is ignored by Git.
- `%LOCALAPPDATA%\AgentTown`: private workspace databases and connector data.
- `%LOCALAPPDATA%\AgentTownCredentials`: Windows-protected secrets, outside ordinary backups.
- `docs`: the product plan, architecture, roadmap, and implementation evidence.

Sample reports use a deterministic manager template. Private manager processing uses an explicitly enabled, bounded API request with an API key you enter (Built, not yet verified with a real model); running the manager on a Claude or ChatGPT plan is Planned only, by hand-off in your own tool. Monitoring, source parsing, scene interaction, and reading saved details use zero model inference. Unknown usage stays unresolved; the app never silently switches accounts or upgrades models.

Native integration coverage and sandbox compatibility vary by installed tool. Subscription allowance is not an app-enforced dollar budget. Native Codex API and Claude SDK modes stay blocked when their internal requests cannot satisfy the required controls; the separate bounded API workers are explicit choices. See [managed execution](docs/23-managed-execution.md).

Read [build status and verification](docs/17-implementation-status.md), [the complete plan](docs/README.md), or [the system design](docs/16-high-level-system-design.md).
