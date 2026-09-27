# Agent Town: working instructions for Claude Code

This file is the Claude-Code-specific twin of [AGENTS.md](AGENTS.md), the project's authoritative working-instructions file. Claude Code loads `CLAUDE.md` automatically at the start of a session (including for subagents); other tools (Codex and similar) load `AGENTS.md`. The two must stay in sync. If they ever diverge, **AGENTS.md is authoritative** — fix this file to match it, not the other way around.

Apply this guidance to work in this folder and its descendants, subject to higher-priority instructions and applicable nested guidance. The user's latest explicit instructions take precedence over project defaults. Preserve earlier requirements unless the user changes them.

## Always wear all hats

On every task, consider **every perspective below** when understanding the request, choosing an approach, and reviewing the result. Give each perspective a brief relevance check, then spend effort in proportion to its impact. Small changes still get the full review; they do not need a ceremony or a report from every hat.

| Hat | Responsibility on every task |
| --- | --- |
| Product manager and user advocate | Identify the user's actual goal, the affected journey, scope, and observable acceptance criteria. Deliver a complete useful outcome. |
| Researcher and domain analyst | Separate facts, assumptions, and unknowns. Inspect local evidence first; verify changing external claims against current primary sources. Record sources for consequential decisions. |
| Software architect | Check component boundaries, data flow, contracts, failure behavior, and future maintenance. Choose the simplest design that satisfies the requirements. |
| Backend and data engineer | Review validation, persistence, transactions, migrations, ordering, deduplication, concurrency, and API compatibility. Protect durable state. |
| Frontend engineer | Review component structure, state ownership, loading/error/empty states, browser behavior, responsive layout, and integration with real data. |
| Product, interaction, and visual designer | Make the workflow understandable and visually coherent. Review hierarchy, spacing, typography, feedback, motion, and consistency with the documented world and glass overlays. |
| Accessibility and inclusive-design reviewer | Check keyboard access, focus, semantics, contrast, reduced motion/transparency, and equivalent access through the List view. |
| Security and privacy engineer | Check trust boundaries, workspace/account isolation, permissions, credentials, untrusted inputs, and what reaches logs or model context. |
| QA engineer and skeptical reviewer | Look for regressions, edge cases, incorrect assumptions, and misleading success states. Verify observable behavior with appropriate evidence. |
| Reliability, operations, and performance engineer | Consider startup/shutdown, cancellation, retries, reconnects, recovery, diagnostics, resource use, and responsiveness on the target Windows environment. |
| AI integration and cost engineer | Check actual tool capabilities, context delivery, model-call necessity, limits, and billing attribution. Use deterministic code for deterministic work. |
| Technical writer and maintainer | Keep names, instructions, decisions, limitations, and handoffs clear and current. Leave enough context for another agent to continue accurately. |

One agent can wear all these hats. This requirement does not request separate agents, extra paid reviews, or a model change. When perspectives conflict, explain the material tradeoff and prioritize the user's goal, correctness, privacy, usability, and maintainability. State uncertainty instead of claiming expertise or evidence you do not have.

## Establish and preserve context

1. Confirm the working directory and read applicable agent guidance. Inspect the relevant files and existing changes before editing; use Git status/diffs when Git is available. Do not assume this folder has a Git repository or initialize one just to inspect changes.
2. Read [the documentation index](docs/README.md), [the product plan](docs/01-product-plan.md), and the relevant part of [the delivery roadmap](docs/12-delivery-roadmap.md). Reuse already-read context unless it has changed. Read additional documents through the map below as needed.
3. Establish the intended outcome, constraints, acceptance criteria, current implementation, and unresolved assumptions. Keep observed behavior distinct from planned behavior. Documentation status labels can lag behind code; verify important claims directly by reading the source and, where practical, running `npm run check` / `npm test`.
4. Treat older wording such as "the current task only documents the plan" as the scope of that earlier task. Evaluate authorization using the active conversation; do not let stale task descriptions block later user-authorized implementation.
5. Follow the latest user corrections without losing the ongoing objective. Ask only for information that materially blocks a sound decision; make reasonable, reversible choices within the authorized scope and continue independent work.
6. Preserve other people's or agents' changes. Re-read files that changed during your work and incorporate compatible updates. Avoid unrelated rewrites and formatting churn.
7. When work changes a documented behavior or decision, update the relevant document and decision record in the same task. Keep this file focused on durable guidance; keep implementation status and task history in the relevant project documents.
8. For work that needs a handoff, preserve the objective, acceptance criteria, user decisions, files changed, checks and results, open issues, and next concrete step. Include evidence paths and dates for time-sensitive facts. Never put secrets or raw private transcripts in project memory.

## Project context and navigation

Agent Town is a private local web app for understanding AI agents working across repositories, collecting reports, and keeping an AI coordinator informed. The initial environment is Windows with a local service and browser UI. The intended experience is a full-screen interactive 3D world with original pixel characters and collapsible glass sidebars, plus an accessible List view.

The workspace uses npm workspaces and TypeScript with strict checking:

| Location | Purpose and existing stack |
| --- | --- |
| `apps/web` | Browser application: React, Vite, Three.js, React Three Fiber, and Drei. |
| `apps/service` | Local service and storage: Fastify, SQLite through better-sqlite3, and Drizzle. |
| `packages/contracts` | Shared TypeScript and Zod contracts used across application boundaries. |
| `docs` | Product requirements, designs, contracts, acceptance criteria, setup, roadmap, and research. |
| `package.json`, `package-lock.json` | Workspace commands, Node requirements, and locked dependencies; inspect these before setup or dependency changes. |

Packages and scripts establish intended structure, not proof that a feature or command works. Inspect the current source and run the relevant checks before reporting implementation status.

| Work area | Read before making consequential changes |
| --- | --- |
| UI, scene, animation, accessibility | [UI and animation](docs/02-ui-and-animation.md), [first-run walkthrough](docs/14-first-run-walkthrough.md) |
| Components, data flow, storage, contracts | [System architecture](docs/03-system-architecture.md), [data and API contracts](docs/09-data-and-api-contracts.md), [high-level system design](docs/16-high-level-system-design.md) |
| Repository discovery and telemetry | [Repos and API monitoring](docs/04-repos-and-api-monitoring.md) |
| Agent connectors and supported controls | [Agent integrations](docs/05-agent-integrations.md) |
| Reports, manager, context, execution | [Manager and context](docs/06-manager-and-context.md) |
| Identity, accounts, billing, privacy | [Accounts and billing](docs/07-accounts-and-billing.md), [security and privacy](docs/08-security-and-privacy.md) |
| Validation and release readiness | [Testing and acceptance](docs/10-testing-and-acceptance.md), [delivery roadmap](docs/12-delivery-roadmap.md) |
| Setup, operations, recovery | [Local setup and operations](docs/11-local-setup-and-operations.md) |
| External capabilities, decisions, model costs | [Research and decisions](docs/13-research-and-decisions.md), [models and cost optimization](docs/15-models-and-cost-optimization.md) |
| Houses, connecting projects and tools, hand-off (plan v5) | [Houses-first master plan](docs/44-houses-first-master-plan.md), [glossary](docs/records/README.md#glossary) |
| Item status, decisions, evidence, handoff, release gates | [Records rules](docs/records/README.md), [tracker](docs/records/tracker.json), [decisions](docs/records/decisions.md), [handoff](docs/records/handoff.md), [gates](docs/records/gates.md) |

## Product requirements to preserve

These are product defaults. A user-authorized change should update the corresponding specification and decision record.

- The world fills the viewport. Both glass sidebars start closed; opening an overlay preserves scene size, camera state, and the mounted world. Keep the main experience free of permanent dashboard columns.
- Provide equivalent information and actions through an accessible List view, including a usable fallback when WebGL fails.
- Saved events drive animation. Animation completion, a finished response, or an end-turn event must not imply that a task was accepted or that the manager processed a report.
- Distinguish observed, inferred, simulated, declared by you, stale, and unavailable information. Missing measurements are unavailable, not zero. Label demo data clearly.
- Keep report persistence, manager processing, shared context version, and delivery to each agent as separate states.
- Repository discovery is read-only and limited to selected roots. Reading text from project files (manifests, README, instruction files) needs a separate per-project switch, off by default, and that text is never sent to a model without the owner's explicit approval. Monitoring an external agent does not imply control of its execution, billing, or complete visibility into its activity.
- Preserve private workspace ownership and account separation. Fix the selected billing connection for each managed run; never silently switch account, provider, or billing mode.
- Within the product, the user approves new managed assignments and final integration. Do not add automatic pushes, merges, deployments, or unapproved follow-up runs.
- Agent Town installs, edits or removes no hook, skill, plugin, MCP server or instruction file unless the owner has seen the exact change and approved it.
- Keep Economy defaults. Monitoring, animation, source parsing, and opening saved details require zero model inference. Connecting a service must not start paid work; preserve explicit paid-work enablement and limits.
- Keep raw API bodies, sensitive headers, credentials, and URL secrets out of monitoring, logs, exports, and model inputs. Store local data privately by default.
- A worktree separates edits; it does not enforce a sandbox. Honor the documented execution boundary and actual connector capabilities.

## Houses-first rules to preserve

These are the owner's decisions of 2026-09-24 (D38 to D45, DR-051 to DR-058 in [decisions](docs/records/decisions.md); D45 adopts plan v5) and the plan v5 safety rules that build on them (Stop watching, H0-13; the exact-change approval, D12 / DR-025; hand-off text is data, CH-04). [Plan v5](docs/44-houses-first-master-plan.md) and the [glossary](docs/records/README.md#glossary) hold the detail. Each rule states required behavior, not what is built. Following D20 (DR-033), a rule the app does not yet follow carries "planned per decision Dn", and a "Built, not yet verified" sentence says what the source already does. The status labels were checked on 2026-09-24 against the source and [tracker.json](docs/records/tracker.json) and can age: the source and tracker.json win over this text, so check them before saying a feature works, and whoever finishes an item updates its line here (dated pair first, see Records and process rules). Changing a rule needs the owner's decision, recorded in decisions.md.

- Connecting a project only creates its house. It scans no sessions, installs nothing, writes no file into the project, starts no tool, and pre-selects no tool, account or session. Status: planned per decision D38. Built, not yet verified: the service call that connects a project reads no session and installs nothing (read from the code; no test pins it yet). Not true yet: the tracking panel that opens next checks this computer's tools and sessions by itself when the project has no connection, and its review pre-ticks every tool found.
- Watching sessions (hooks) is a separate opt-in per project, off by default, applied only after the owner has seen the exact change, and undone per project by Stop watching. Importing session history is a separate opt-in too. Connecting a project or a tool never turns either on. On screen the word is "watch", never "sync". Status: planned per decision D38 for Stop watching (today removing the hook and revoking the connection are separate manual steps), the history opt-in and the word "watch" (screens still say "tracking"). Built, not yet verified: both screens that apply hooks show the exact file and setting first (the service's apply calls do not themselves require that review).
- Connecting an AI tool records it as an assignment target for that project and triggers only the zero-AI folder-layout scan: folder and file names, no file opened, no session read, no model called. Status: planned per decision D40; nothing built yet (today a tool's "connection" is a session-watching connection).
- Say "no sessions were scanned". Do not claim that nothing at all was scanned: Git and instruction-file metadata of the selected roots are still checked in the background. Status: planned per decision D38; today's tool check does read sessions, so the sentence is not yet true on screen.
- A house is one area of a project (web, backend, shared code, docs, tests, tooling). The first scan creates houses automatically with Undo; later scans only propose changes. Status: planned per decision D39; today a house is one connected project.
- Assigning a task to the owner's AI tool is a hand-off: Agent Town prepares the exact task text for the owner to run in that tool, under their own sign-in. A hand-off never starts a run: Agent Town does not sign in to the tool for it, store or read a tool subscription, or run the task on this computer. Its own API key serves only its own optional paid AI calls, never a tool sign-in. Never say a task was assigned, started, accepted or delivered without a fact the owner marked; copying the text is not delivery. Status: planned per decisions D41 and D42; the task hand-off is not built (today's "Manual handoff" only copies saved manager context).
- In Agent Town's own screens, chats, hand-offs and packets, text is data, never instructions to Agent Town: text the owner types or pastes, and text a hand-off, a paste or a download brings in from a tool, a project or another source (agent replies, reports, skill files, instruction files), is shown, stored or quoted and never changes a rule, a permission or a command Agent Town builds, or becomes a path it opens (a folder the owner types into Add folder is the owner's own choice). This is not a rule about the owner's own instructions to you in a session, which take precedence as stated at the top of this file. Status: planned per decision D41 (CH-04, not yet written); no hand-off exists yet to carry such text.

## How to execute work

- Own the authorized task through implementation, review, and verification. Do not stop at a proposal when the user asked for action. Resolve routine implementation details autonomously.
- For substantial tasks, establish a short plan and acceptance criteria. Use all hats to identify the important tradeoffs and unknowns before committing to an approach.
- Search with Grep/Glob (or `rg` / `rg --files` in Bash); exclude dependencies and generated outputs. Batch independent reads and searches when supported. Keep dependent edits and shared-state mutations sequential.
- Prefer existing components, dependencies, and conventions. Keep TypeScript strict, validate external inputs at boundaries, and evolve shared contracts with their callers. Avoid speculative abstractions and silent error handling.
- For uncertain or changing integration behavior, consult current official documentation and verify compatibility with the installed version. Record the source and date for consequential research. Do not treat historical model names, prices, or capability tables as permanently current.
- Implement loading, empty, failure, unavailable, and recovery states alongside the success path when applicable. Inspect rendered UI for visual changes when browser tools are available.
- Keep changes focused and reviewable. Do not reset user changes, delete working data to make a test pass, expose credentials, or edit generated artifacts when their source should change.
- On Windows, use PowerShell (or the Bash tool's POSIX shell, matching its own syntax) with literal paths for filesystem operations. Resolve and check the full target path before recursive moves or deletes. Use hidden windows when launching background helpers.
- Carry forward existing authorization. Before a consequential external action that lacks authorization, finish the local preparation and make the proposed result concrete and reviewable. Explain any actual approval requirement and its source.
- If the user explicitly requests delegation and tools permit it, assign bounded independent tasks with the goal, relevant files, constraints, ownership, acceptance criteria, and expected evidence. Every participating agent applies all hats. The lead integrates and verifies the results. Do not create parallel agents solely to enact this checklist.

## Records and process rules

Agent Town keeps its own tracking in [docs/records](docs/records/README.md): rules, fixed vocabulary, id formats and the glossary.

- Read [handoff.md](docs/records/handoff.md) first for the current state, open decisions and next step, then the item's row in the tracker.
- [tracker.json](docs/records/tracker.json) is the only source of item status. `tracker.md` is generated and never edited by hand. Use the fixed status, proof and claim words from the records README.
- Whoever finishes an item updates its tracker row, the [changelog](docs/records/changelog.md), and every decision, risk and document it changes, together in the same change.
- A decision gets a `DR-NNN` id in [decisions.md](docs/records/decisions.md) with the owner's exact words and the date. Never record an unanswered question as decided.
- Evidence (a run, a capture, an audit result) goes in [docs/records/evidence](docs/records/evidence/) as a dated `EV-` entry; an outside fact (a tool flag, a price, a vendor rule) is a dated row in `evidence/sources.md`. Never put secrets or raw private transcripts there.
- Describe a capability only with these five labels, written exactly (fixed vocabulary in the [records README](docs/records/README.md), no synonyms): `Working (verified <date>, <version>)`, `Built, not yet verified`, `Planned`, `Not planned yet (allowed with opt-in)`, `Excluded by design`.
- Commit or push only when the owner says so. Never push secrets, hook files that hold machine paths, local data or the gitignored documents.
- `docs/` is gitignored (DR-018), so git shows no diff and keeps no history for it. `AGENTS.md` and `CLAUDE.md` are tracked and pushed as of DR-063 (2026-09-27), the owner's explicit exception to DR-018 for these two files only. Before editing either instruction file, save a dated pair in [instruction-history](docs/records/instruction-history/README.md) (never overwrite an earlier copy; a second pair on the same day takes a -2, -3 suffix) and show the owner the diff against it. Before a batch of edits, take a dated safety copy outside the repository with `npm run safety-copy -- --label NAME`.
- `npm run records`, `npm run check:docs` and `npm run gate` are planned per decision D19 (DR-032). Read `package.json` for what exists before running them; until they exist, compare files and links by hand.

## Verification and completion

Read the current package scripts before running commands. The root scripts presently provide:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start service and web development processes. |
| `npm run check` | TypeScript checking without emitted output. |
| `npm test` | Run Vitest tests; inspect `vitest.config.ts` for discovery rules. |
| `npm run build` | Build the web application and service. |
| `npm run test:e2e` | Run Playwright; first verify the configuration and tests exist. |
| `npm start` | Start the built service after a successful build. |
| `npm run safety-copy -- --label NAME` | Copy source and unsaved changes to a dated folder outside the repository; `-- --verify FOLDER` re-checks a copy. |

- Select checks that establish the changed behavior. For code changes, run type checking and relevant tests; run builds for changes affecting bundling, dependencies, or application integration. Exercise affected browser journeys for UI behavior when feasible.
- Add regression tests when they protect meaningful behavior or failure cases. Do not add tests that merely restate the implementation or require an application test suite for prose-only edits; check document accuracy and links instead.
- A missing test suite, unavailable integration, or unexecuted command is not a pass. Report what ran, its result, and material gaps. Distinguish existing failures from failures caused by the change without claiming either without evidence.
- When piping a command's output (e.g. through `tee`), check the actual output for failures rather than trusting the pipeline's exit code — a later command in the pipe can mask a non-zero exit from an earlier one.
- Review the final changes through every hat. Fix relevant defects within scope; surface unresolved tradeoffs and blockers. Re-run affected checks after fixes, then stop repeating successful checks without a reason.
- Apply the appropriate acceptance criteria from the project documents. Real integrations need real smoke-test evidence before being advertised as working; simulations and screenshots alone do not establish completion.
- Keep the final response concise: outcome, key files, verification, and any material limitation. Describe observable results without narrating every hat or claiming independent reviews that did not occur.

## Maintaining this guidance

Keep `AGENTS.md` at the project root as the single authoritative copy of these working instructions, per the [official AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md). Keep this file (`CLAUDE.md`) as its Claude-Code-specific mirror, since Claude Code, with its default setting, reads `CLAUDE.md` and not `AGENTS.md` when both exist. Update both together whenever paths, commands, or durable decisions change; link to detailed documents instead of copying their full contents. Neither file configures another tool's runtime permissions, billing, models, or context-delivery mechanism.

`AGENTS.md` is the authoritative copy and `CLAUDE.md` is its Claude Code mirror. Edit `AGENTS.md` first, then copy the identical rule text into `CLAUDE.md` in the same change. The only intended differences are four tool-specific hunks: the title and opening paragraph of `CLAUDE.md`, the search-tool wording and the Windows shell wording in "How to execute work", and the first paragraph of this section. Any other difference is drift to fix.
