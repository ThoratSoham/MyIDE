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
