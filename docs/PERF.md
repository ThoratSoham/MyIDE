# Nova IDE (MyIDE) — Free-Tier Performance & Efficiency Log

This document records measured model calls, token budgets, tool executions, and failed edit attempts across **5 fixed scripted engineering tasks** (`npm run bench`) executed end-to-end through the real `JobManager`, `runAgent` loop, workspace tools, and `RunTelemetryTracker` against a deterministic capability-aware mock provider.

## Benchmark Suite (`scripts/bench.mjs`)

1. **Create a small website** — Build & verify a responsive 3-file landing page (`index.html`, `css/style.css`, `js/main.js`).
2. **Fix a TS error** — Locate and fix `u.fullName` -> `u.name` in a CRLF + 4-space indented TypeScript project and verify.
3. **Add function + test** — Implement `slugify(input)` in `src/slugify.js` plus unit tests in `src/slugify.test.js` and run `node --test`.
4. **Rename across files** — Rename `APP_TITLE` to `BRAND_NAME` across 4 importing files in `src/` alongside a 240-line unrelated module.
5. **Explain a file** — Inspect `@src/cache.ts` (200+ lines) and explain its `LruCache` eviction order.

---

## Phase 0 — Baseline (Before Free-Tier Optimizations)

**Bottlenecks observed in baseline:**
- Single-tool JSON envelope (`{ thought, tool, args }`) forces 1 LLM round-trip per read, write, edit, or verify call.
- No workspace repo-map or BM25 retrieval in prompt context, forcing blind `listDir` + full-file `readFile` exploration turns.
- Strict `String.prototype.indexOf` in `editFile` fails on CRLF / 2-space vs. 4-space indentation differences (`FailEdit = 1`).
- Unconditional "no files changed" nudge in `loop.ts` wastes an extra round-trip on read-only code explanation tasks.

| Task | Model Calls | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Failed Edits |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Create a small website | 5 | 7,357 | 1,251 | 8,608 | 5 | 0 |
| 2. Fix a TS error | 8 | 8,300 | 330 | 8,630 | 8 | 1 |
| 3. Add function + test | 6 | 6,007 | 276 | 6,283 | 6 | 0 |
| 4. Rename across files | 11 | 15,958 | 473 | 16,431 | 11 | 0 |
| 5. Explain a file | 3 | 4,950 | 202 | 5,152 | 1 | 0 |
| **TOTAL (5 tasks)** | **33** | **42,572** | **2,532** | **45,104** | **31** | **1** |


---

## Phase 1 — Batched Actions in the Agent Loop (`src/main/agent/loop.ts`)

**Changes:**
- Extended `AGENT_SCHEMA` to accept `actions: [{ tool, args }, ...]` (capped at 8 per turn) alongside legacy single-tool `{ tool, args }`.
- Contiguous read-only actions (`readFile`, `listDir`, `listTree`, `grep`, `getSymbols`) execute in parallel via `Promise.all`; mutating and command actions run sequentially and stop immediately at the first failure or command-approval denial, returning all executed results in one `<tool_results>` block.
- Updated repeat-call detector to hash the normalized action batch + combined result hashes.
- Added compact batched schema + 1-line JSON example to the system prompt (`Settings.batchedActions`, default `true`).

| Task | Model Calls | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Failed Edits |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Create a small website | 2 (-60%) | 2,989 | 1,259 | 4,248 | 5 | 0 |
| 2. Fix a TS error | 6 (-25%) | 7,539 | 311 | 7,850 | 7 | 1 |
| 3. Add function + test | 3 (-50%) | 3,645 | 278 | 3,923 | 6 | 0 |
| 4. Rename across files | 4 (-64%) | 5,934 | 424 | 6,358 | 11 | 0 |
| 5. Explain a file | 3 (0%) | 5,535 | 202 | 5,737 | 1 | 0 |
| **TOTAL (5 tasks)** | **18 (-45.5%)** | **25,642** | **2,474** | **28,116 (-37.7%)** | **30** | **1** |

---

## Phase 2 — Single-Shot `<file>` Emission, Merged Website Build+Verify & Auto-Verify (`file-tags.ts`, `website-single-shot.ts`, `auto-verify.ts`)

**Changes:**
- Added `<file path="relative/path.ext">...</file>` parser (`src/main/agent/file-tags.ts`) with unclosed-EOF tolerance, inner markdown-fence stripping, and full `insideWorkspace` + `.env` blocking + `.myide/backups` protection.
- Merged Website Plan + Build (`src/main/pipeline/website-single-shot.ts`) into 1 single-shot `<file>` model call followed by local `verifyWebsite` and at most 2 targeted snippet-only repair rounds (`Settings.singleShotFileTags`).
- Added automatic post-write local verification (`src/main/agent/auto-verify.ts`): caches detected project tooling in `.myide/project.json` and runs local `tsc --noEmit`, `eslint` on changed files, `verifyWebsite` on HTML, and matching unit test files automatically after write/edit turns, summarizing errors to `<= 40` deduplicated lines (`Settings.autoVerifyAfterEdits`).

| Task | Model Calls | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Failed Edits |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Create a small website | 1 (-80% vs P0) | 370 | 1,098 | 1,468 | 4 | 0 |
| 2. Fix a TS error | 5 (-38% vs P0) | 6,017 | 248 | 6,265 | 6 | 1 |
| 3. Add function + test | 3 (-50% vs P0) | 3,667 | 278 | 3,945 | 6 | 0 |
| 4. Rename across files | 4 (-64% vs P0) | 5,934 | 424 | 6,358 | 11 | 0 |
| 5. Explain a file | 3 (0% vs P0) | 5,535 | 202 | 5,737 | 1 | 0 |
| **TOTAL (5 tasks)** | **16 (-51.5% vs P0)** | **21,523** | **2,250** | **23,773 (-47.3% vs P0)** | **28** | **1** |

---

## Phase 3 — 4-Tier Fuzzy `editFile`, Atomic Multi-Edit & Workspace Search Tools (`fuzzy-edit.ts`, `tools.ts`)

**Changes:**
- Implemented 4-tier `editFile` cascade (`src/main/agent/fuzzy-edit.ts`, `Settings.fuzzyEditMatch`): Tier 1 exact -> Tier 2 trailing-whitespace + CRLF/LF normalization -> Tier 3 indentation-insensitive match with automatic scale/offset re-indentation -> Tier 4 unique sliding-window similarity (`>= 0.90`). Ambiguous matches are always rejected; failed edits return up to 3 closest line-numbered snippets.
- Added atomic multi-edit `edits: [{ find, replace }]` on `editFile` (all-or-nothing in memory, single backup) and `replaceLines { path, startLine, endLine, content }`.
- Upgraded `readFile` with `startLine`/`endLine` 1-based line-numbered ranges and automatic symbol outline + 150-line head truncation on files `> 200` lines.
- Added `.gitignore`- and `.env`-safe `grep`, `listTree`, and `getSymbols` read-only tools.

| Task | Model Calls | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Failed Edits |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Create a small website | 1 (-80% vs P0) | 370 | 1,098 | 1,468 | 4 | 0 |
| 2. Fix a TS error | 4 (-50% vs P0) | 5,643 | 195 | 5,838 | 5 | 0 |
| 3. Add function + test | 3 (-50% vs P0) | 4,415 | 278 | 4,693 | 6 | 0 |
| 4. Rename across files | 3 (-73% vs P0) | 4,560 | 358 | 4,918 | 6 | 0 |
| 5. Explain a file | 3 (0% vs P0) | 6,273 | 202 | 6,475 | 1 | 0 |
| **TOTAL (5 tasks)** | **14 (-57.6% vs P0)** | **21,261** | **2,131** | **23,392 (-48.1% vs P0)** | **22** | **0** |
