# Change Log

All notable changes to the "vidia" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- NIM model rows now show the real container lifecycle instead of a boolean
  "running": `Not downloaded`, `Stopped`, `Starting…`, `Ready`, or `Exited`,
  each with its own icon and a tooltip explaining what to do. Green only marks
  the active chat model when it is actually `Ready`; an active-but-not-ready NIM
  is tinted orange with a `!` badge. Start/Stop actions (context menu and inline
  buttons) appear based on the current state, and the tree auto-refreshes while
  a container is warming up (and on window focus). Chatting with a NIM model
  whose container is down now prompts to start it (new
  `vidia.nim.autoStartOnChat` setting: `prompt`/`always`/`never`) instead of
  failing with a connection error.
- Fixed a third `localhost`→`127.0.0.1` IPv6 bug: `NimManager.run()` still
  returned `http://localhost:<port>/v1`, which on Windows can resolve to IPv6
  `::1` while Docker publishes only IPv4 — same class of bug as the
  `waitForHealthy` and `resolveTarget` fixes.
- Added `AGENTS.md`: the project's compounding instructions (Plan → Work →
  Assess → Compound) — push workflow, command-wiring discipline, code
  conventions, and the incident-derived rules so future work starts smarter.
- Removed the dead `VIDIA: Clear API Key` palette entry — clearing now lives
  inside the Configure API Key quickpick, but its `package.json` declaration
  survived the refactor with no handler behind it.

- Fixed `VIDIA: Re-check NIM Setup` doing nothing from the palette — the rename
  left `extension.ts` registering the old `vidia.recheckSetup` id and the
  view/title menu pointing at it. Aligned all registrations, menu entries,
  and user-facing strings with the new id/title.
- Removed dead code in `SecretManager`: unreachable `if (!key)` guard, the
  never-used `withProgress: false` path of `runNgcStep`, the unused `link`
  parameter of `saveKey`, and duplicated context-sync/tree-refresh calls in
  `setNvidiaKey`/`changeNvidiaKey` (already done by `saveKey` on success).
- `NimManager` now uses the detected container runtime (docker/podman) for
  `isRunning`/`stop`/`logs` instead of hardcoded `docker`; `run()` resolves
  with the server URL (fixes `http://localhost:undefined/v1` when no port was
  set, and the wrong localhost URL for remote hosts); `waitForHealthy` is private.
- NIM add flows now list real containers from the public NGC catalog instead of
  guessing `nvcr.io/nim/<model-id>:latest` from the chat catalog (many guesses,
  e.g. `nim/01-ai/yi-large`, never existed). Entries carry their actual latest
  tag; custom image entry remains as an escape hatch.
- New `VIDIA: Probe FE Catalog` command probes every cloud catalog model
  with a tiny request (paced ~30 RPM, cancellable) and caches per-model
  liveness verdicts for 5 days; the Add Model pick-list hides models with a
  fresh "dead" verdict (retired or not entitled for the key).

- Added a full NVIDIA setup check when the API key is saved: the key is verified
  against the cloud endpoint and probed for NGC pull access (`api.ngc.nvidia.com`).
  The verdict is persisted and drives the tree — the cloud group shows when the key
  is valid, and the NIM group is disabled with guidance when the key is not
  NGC-enabled. New `VIDIA: Re-check NVIDIA Setup` command re-runs the check.

- Initial release
- Added `viewsWelcome` welcome content to the Models Explorer tree view prompting users to set their NVIDIA API key when not configured.
- Added `VIDIA: Clear API Key` command (also a `$(clear-all)` button in the
  Models Explorer title bar) to remove stored NVIDIA/NGC API keys from
  SecretStorage with confirmation.