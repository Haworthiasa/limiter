# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code marketplace (`.claude-plugin/marketplace.json`) holding one plugin, `limit-line/`: a "mod" written as function hooks that hot-load into a running Claude Code (≥ 2.1.287). It draws a limits band above the prompt, a `/usage-plus` pane, and a Bash-output distiller. User-facing docs are in Vietnamese (`limit-line/README.md`); `PLAN.md` is the original design/phase plan (P0–P5), `limit-line/NOTES.md` records what the engine's types and live probes actually do (entries marked **≠ PLAN** override the plan). Read NOTES.md before touching engine-facing code.

There is no build step and no `package.json` dependencies. Code is TypeScript with erasable syntax only, run directly by the engine and by Node ≥ 23.6 (Node 24 here).

## Commands (run from `limit-line/`)

```
claude plugin validate --strict .     # manifest + module validation
claude plugin test .                  # engine tests (tests/*.test.ts)
node --test tests/indexer.node.mjs    # indexer tests (plain node:test)
npx -p typescript@5 tsc -p .          # typecheck; needs .claude-plugin/types, which Claude Code generates (gitignored)
node scripts/build-fixtures.mjs       # regenerate tests/fixtures/logs.gen.ts after adding logs to tests/fixtures/<kind>/
node scripts/indexer.mjs --rebuild    # re-read all of ~/.claude/projects from scratch
```

`claude plugin test .` runs the whole suite; check its help for filtering to one file.

## Architecture

**Entry point:** `hooks/hooks.json` lists a single module, `hooks/register.tsx`, which exports `register(on)` and subscribes to engine events (`session.start/measure/compact`, `turn.step/complete`, `command.run`, `ui.render`). It also calls `registerDistiller(on)` from `hooks/distiller.ts`.

**Engine constraints that shape the file layout** (details in NOTES.md "P1–P3 findings"):
- The engine follows `$` (the engine handle) only into functions defined in the *same file*. Passing `$` to an imported helper fails validation. So all `$`-touching code lives in `register.tsx` and `distiller.ts`, each with its own small file helpers (`dataPath`, `appendJson`, `readJsonFile`).
- An atom (`atom({plugin, key}, initial)`) must be declared in the file that reads/writes it.
- An event with no matcher may be hooked only once per plugin (`session.start` is in `register.tsx` only).
- `turn.step` hooks must be `async function*` using `yield* next(e)`.
- Everything else is **pure logic in separate modules** with no `$`: `band.ts` (band/turn line formatting), `limits.ts` (5h/week readings, ETA, warn levels), `ledger.ts`, `metrics.ts`, `pricing.ts`, `turnstats.ts`, `dashdata.ts` + `dashboard.ts` (pane content), `charts.ts`, `paths.ts`. These are unit-tested directly; shared types are in `types/index.d.ts`.
- Imports use explicit `.ts` extensions (works in both the engine and Node; `tsconfig.json` enables `allowImportingTsExtensions`).

**Data flow:** live hooks append per-request records to a buffer atom, flushed to `~/.local/share/limit-line/ledger/<day>.json` on `turn.complete`. `scripts/indexer.mjs` (spawned by `/usage-plus` via `$.process.run`, also runnable standalone) incrementally reads `~/.claude/projects/**/*.jsonl` into `index/days/<day>.json`. `loadDash` in `register.tsx` merges ledger + index + measure/compact/distill history into `DashData`. `hooks/metrics.ts` and `hooks/distill/*` are shared by the mod, the indexer, and the wrapper CLI. Day boundaries use Asia/Bangkok (`TZ_OFFSET_MIN` in `paths.ts`). No per-plugin data dir exists in the engine, hence the fixed `~/.local/share/limit-line/`.

**Distiller (`hooks/distiller.ts`, `hooks/distill/`):** hooks Bash `tool.call`. Successful long output (≥ 8000 chars) is rewritten after the run: return `{ result: { ...r.result, stdout: short, stderr: '' } }` and **drop `ref`/`text`**, otherwise core uses the original verbatim. Failed output *cannot* be shortened after the fact (the engine rejects or loses `isError`), so commands matching an allowlist (`detect.ts`) are rewritten *before* execution into a wrapper that runs `node hooks/distill/cli.ts`, writes the full log under `<project>/.claude/distill/`, prints the filtered head, and preserves the exit code. Consequence: permission rules and auto mode see the wrapper, not the original command. Filters: `pytest.ts` (groups failures by signature) and `generic.ts`; `index.ts` dispatches. `hooks/distill/cli.ts` runs under plain Node and is excluded from tsconfig.

**JSONL/ledger gotchas:** one API response appears as 2–3 JSONL lines; dedupe on `message.id + requestId`. Live `usage` has no 5m/1h cache-write split (JSONL does). Advisor sub-calls live in `usage.iterations[]`: the indexer counts them, the live ledger/band do not.

## Testing notes

A test's `$` has no `fs`/`store`; tests mock files by hooking `fs.read/write/exists` under the plugin. Test logs can't be imported as `.log`, so `build-fixtures.mjs` embeds them into `tests/fixtures/logs.gen.ts` (generated, rerun after changing fixtures). JSONL fixtures in `tests/fixtures/jsonl/` are produced by `scripts/sanitize-jsonl.mjs` and keep only ids, timestamps, types, model and usage (cwd is anonymized).

## Conventions

- Band/UI uses single-cell glyphs (`▓░▲▼●█▁▂▃▄▅▆▇`), never emoji.
- Failures in side features (ledger, history, toasts) are caught and swallowed so the band and the turn never break; keep that pattern in new hooks.
- `limit-line@my-mods` may also be installed from a `/mnt/d` marketplace and hot-loaded from `~/.claude/dev-mods/…`; two same-named plugins can load at once.
- Gitignored: `.claude-plugin/types/`, `node_modules/`, `.claude/distill/`.
