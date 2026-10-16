# AGENTS.md — vidia

How to work in this repo so every unit of work compounds. The loop is
**Plan → Work → Assess → Compound**: when something goes wrong, don't just fix
the instance — write the rule here. Prune during Assess: retire rules that
stopped being load-bearing; keep the dates, they signal staleness.

## Verify before pushing

- `npm run check-types` (tsc), `npm run lint` (eslint),
  `node esbuild.js --production` — all green before any push.
- `npm run key:check` exercises `src/keyVerifier.ts` outside the extension
  host (needs `NVIDIA_API_KEY` in env).

## Workflow: branches + PRs

- Default: feature branch → PR → merge. Direct-to-`main` only on an explicit
  one-time exception, never as habit.
- Push via `~/workspace/bin/push_vidia_pr.py` with `PR_BRANCH` / `PR_BASE` /
  `PR_HEAD` / `PR_TITLE` / `PR_BODY` env vars (it takes no CLI flags).
- Before pushing: `git fetch -q origin main:main`, rebase the branch onto it,
  then check the **two-dot** diff (`git diff main..HEAD`) for files you didn't
  intend to touch. The three-dot diff hides reversions.
  - 2026-10-12: PR #5's head was built from a stale branch; its tree silently
    reverted `src/nimManager.ts` (PR #4's nvcr.io login) into main. Restored
    byte-for-byte via PR #7.
- Never let `git add -A` sweep in `out/` or `dist/` (build artifacts).

## Command wiring discipline

A command exists in four places and all four must agree: `package.json`
`contributes.commands` (declaration) ↔ `extension.ts` `registerCommand`
(handler) ↔ `contributes.menus` (placement) ↔ `executeCommand('…')` call
sites. After any rename, compare the sets:

- declared − registered = dead palette entry (click does nothing)
- registered − declared = invisible handler
- menu refs must all be declared

Incidents, both from renames that updated only some of the four:

- 2026-10-16: "Re-check NIM Setup" left `extension.ts` registering the old
  `vidia.recheckSetup` id and the view/title menu pointing at it. Fixed in
  PR #8.
- 2026-10-16: "Clear API Key" was folded into the Configure API Key quickpick
  but its package.json declaration survived as a dead palette entry. Removed.

## Code conventions

- `vscode`-free modules (`src/keyVerifier.ts`, `src/ngcVerifier.ts`,
  `src/nimCatalog.ts`, `src/catalogVerifier.ts`): no `vscode` import, so the
  logic can be bundled and tested outside the extension host (see
  `scripts/key-check.mjs`). Keep new pure logic in this shape.
- Secrets: never log keys, never pass them on command lines (`ps` exposure).
  `docker login` via `--password-stdin`; container env via a `0600`
  `--env-file` deleted after `docker run`.
- User-facing terminology: "Free Endpoint" (FE), not "cloud". Current command
  titles: "Add Model", "Add Free Endpoint", "Add NIM Model", "Verify NIM
  Setup", "Probe FE Catalog", "Configure API Key", "Refresh Status".
- User-facing changes get a CHANGELOG entry under `[Unreleased]`.
- Container commands (`ps`, `rm`, `logs`) must use the detected runtime
  (`NimManager.detectRuntime()`), never a hardcoded `docker`.

## Data sources

- The NIM pick-list comes from the public NGC catalog search
  (`src/nimCatalog.ts`), never from guessing `nvcr.io/nim/<id>:latest` — many
  guesses never existed (2026-10-12: there is no `nim/01-ai/yi-large`
  container).
- The FE `/models` list is authoritative for ids but contains retired entries
  — verify liveness before trusting it (`VIDIA: Probe FE Catalog`,
  `src/catalogVerifier.ts`).
