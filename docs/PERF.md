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

---

## Phase 4 — Context Efficiency: Repo Map, BM25 Retriever, Working Memory & Lane Budget Fitter (`src/main/context/*`)

**Changes:**
- **`src/main/context/repo-map.ts`** (`Settings.repoMapEnabled`): Extracts compact symbol outlines + relative import edges across TS/JS/CSS/HTML/JSON/Python, caches per-file metadata by `mtimeMs` in `.myide/cache/repo-map.json` (invalidated by `fs-watcher.ts` and write tools), and ranks files within a ~1,200-token budget.
- **`src/main/context/bm25.ts`**: Pure main-process Okapi BM25 (`k1 = 1.5, b = 0.75`) behind `CodeRetriever`, resolving `@file`, `@symbol`, and code identifiers directly into `[Retrieved Context]` with zero model calls.
- **`src/main/context/working-memory.ts`** (`Settings.rollingSummaryEnabled`): Converts older `<tool_result>` messages into 1-line stubs and distills evicted history into `[Working Memory]`.
- **`src/main/context/budget.ts`**: Preserves `messages[0]` byte-for-byte for provider prompt-cache hits and fits prompts to each lane's token cap in strict priority order (`system > working memory > user task > recent turns > repo map > retrieved BM25`).

| Task | Model Calls | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Failed Edits |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Create a small website | 1 (-80% vs P0) | 370 | 1,098 | 1,468 | 4 | 0 |
| 2. Fix a TS error | 2 (-75% vs P0) | 2,835 | 127 | 2,962 | 2 | 0 |
| 3. Add function + test | 2 (-67% vs P0) | 3,015 | 259 | 3,274 | 4 | 0 |
| 4. Rename across files | 2 (-82% vs P0) | 3,351 | 352 | 3,703 | 5 | 0 |
| 5. Explain a file | 2 (-33% vs P0) | 3,839 | 165 | 4,004 | 0 | 0 |
| **TOTAL (5 tasks)** | **9 (-72.7% vs P0)** | **13,410** | **2,001** | **15,411 (-65.8% vs P0)** | **15** | **0** |

---

## Phase 5 — Smarter Router, Proactive Token Bucket, Malformed-JSON Probation & `freeTierSaver` (`router.ts`, `ledger.ts`, `model-settings.ts`, `jobs.ts`)

**Changes:**
- **Task-class routing (`src/main/ai/router.ts`, `model-settings.ts`)**: Classified calls into `classify | summarize | plan | codegen | repair | chat` (`TaskClass`), prioritizing lighter/faster lanes for `classify`, `summarize`, `plan`, and `chat`, while reserving higher-capacity coder lanes for `codegen` and `repair` (configurable per model via `taskClasses` in `models.json`).
- **Proactive quota token bucket (`src/main/ai/ledger.ts`)**: `canAfford(lane, estimatedTotalTokens)` checks RPM, TPM, and RPD windows *before* firing HTTP requests so known-exhausted or insufficient-budget lanes are skipped with zero wasted failed calls.
- **Dynamic lane scoring & malformed-JSON probation**: Tracks rolling valid-JSON rate, error rate, and average latency per lane; lanes exceeding 25% malformed JSON rate across `>= 4` schema calls enter temporary probation cooldown and are automatically re-tested once the cooldown expires.
- **Native structured output (`src/main/ai/real-providers.ts`)**: Capability-aware `response_format: { type: "json_object" }` (with automatic 400 fallback) and Gemini `responseMimeType: "application/json"` + `responseSchema`, stored as capability flags in `models.json`.
- **`freeTierSaver` (`src/main/jobs.ts`, `loop.ts`, default `ON`)**: Answers `explain` / trivial `chat` prompts in a single tool-free call with pre-injected BM25 / `@file` context, skips clarification round-trips when the local classifier is confident, and omits `updatePlan` prompt overhead on small focused edits.

| Task | Model Calls | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Failed Edits |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Create a small website | 1 (-80% vs P0) | 370 | 1,098 | 1,468 | 4 | 0 |
| 2. Fix a TS error | 2 (-75% vs P0) | 2,743 | 127 | 2,870 | 2 | 0 |
| 3. Add function + test | 2 (-67% vs P0) | 2,923 | 259 | 3,182 | 4 | 0 |
| 4. Rename across files | 2 (-82% vs P0) | 3,259 | 352 | 3,611 | 5 | 0 |
| 5. Explain a file | 1 (-67% vs P0) | 1,263 | 85 | 1,348 | 0 | 0 |
| **TOTAL (5 tasks)** | **8 (-75.8% vs P0)** | **10,558** | **1,921** | **12,479 (-72.3% vs P0)** | **15** | **0** |

---

## Phase 8 — Headless Browser Verification & Feature Flags UI (`headless-verify.ts`, `SettingsPanel.tsx`)

**Changes:**
- **Offscreen Electron BrowserWindow verify (`src/main/quality/headless-verify.ts`)**: Behind `Settings.headlessBrowserVerify === true`, evaluates generated web apps in a strictly sandboxed, hidden BrowserWindow (`show: false, sandbox: true, contextIsolation: true`), capturing runtime console errors, failed network requests, broken local script/link/image tags, and offscreen PNG screenshots into `.myide/verify/`, feeding real errors directly to the repair loop. Fallback to static `verifyWebsite` is clean and automatic.
- **Granular Optimization Controls in Settings UI (`SettingsPanel.tsx`)**: Added dedicated toggle controls with 1-line explanations for all 8 core optimization features:
  1. `batchedActions` — multi-tool execution per turn (up to 8).
  2. `singleShotFileTags` — full website generation in 1 call via `<file>` blocks.
  3. `autoVerifyAfterEdits` — local tsc, eslint & website verification after writes.
  4. `fuzzyEditMatch` — 4-tier fuzzy match (exact, CRLF/LF, indent, similarity).
  5. `repoMapEnabled` — mtime-cached workspace symbol outline & import graph.
  6. `rollingSummaryEnabled` — old tool result stubs & `[Working Memory]` compression.
  7. `freeTierSaver` — single-shot explain Q&A and zero-overhead small edits.
  8. `headlessBrowserVerify` — offscreen Chromium runtime validation.

---

## Performance Summary: Phase 0 Baseline vs. Phase 8 Final

| Metric | Phase 0 Baseline | Phase 8 Final | Improvement |
| :--- | :--- | :--- | :--- |
| **Model Calls (5 benchmark tasks)** | **33 calls** | **8 calls** | **-75.8% reduction** |
| Multi-file website build | 5 calls | 1 call | **-80.0% reduction** |
| TypeScript error fix | 8 calls | 2 calls | **-75.0% reduction** |
| Add function + test | 6 calls | 2 calls | **-66.7% reduction** |
| Rename across 4 files | 11 calls | 2 calls | **-81.8% reduction** |
| Code explanation | 3 calls | 1 call | **-66.7% reduction** |
| **Total Tokens Consumed** | **45,104 tokens** | **12,479 tokens** | **-72.3% reduction** |
| **Failed `editFile` Attempts** | 1 failure (indent mismatch) | **0 failures** | **100% edit success rate** |
| **Cloud Quota Burn with Local Models** | 100% cloud quota spent | **0% on light/chat tasks** | **Unlimited local offload** |

---

## How to Tune for Free Tier

When running on tight free-tier providers (Gemini 15 RPM / 1,500 RPD, Groq 30 RPM / 8k TPM, OpenRouter :free models):

### 1. If a model returns broken JSON in multi-action turns
- Set `batchedActions: false` in **Settings > Agent & Workflow > Free-Tier Optimization Flags**.
- The loop automatically switches to the single-tool envelope (`{ thought, tool, args }`).

### 2. If a small model struggles to emit `<file>` tags
- Toggle `singleShotFileTags: false`.
- The pipeline will plan and write files step-by-step using individual `writeFile` tool calls.

### 3. If hitting Groq 8k TPM limits on large files
- Ensure `repoMapEnabled: true` and `rollingSummaryEnabled: true` are enabled.
- The lane budget fitter (`src/main/context/budget.ts`) will prioritize the recent turns, shed older context, and skip Groq when requests exceed 5,500 tokens.

### 4. If edits fail on strange tab/space formatting
- Ensure `fuzzyEditMatch: true` is on.
- It cascades from exact match to whitespace normalization, indentation-relative scale matching, and 90% sliding similarity before giving up.

### 5. Conserving Cloud Quota with Local Ollama / LM Studio
- Open **Settings > Local Models**, start Ollama or LM Studio, and click **Detect Servers**.
- The IDE will route `classify`, `summarize`, `chat`, and simple edits to your local GPU/CPU for **0 cloud tokens**, reserving scarce Gemini/Groq daily quotas for hard multi-file codegen and repair tasks.

---

## Website Builder Engine Upgrade (Phases 1 - 6)

### Phase 1: Complete File Set & Integrity
- **Manifest Step**: Resolves target file set prior to generation. Defaults to a single self-contained `index.html` on free tier (inline `<style>`, `<script>`, and vector SVGs) to avoid 404s.
- **Reference-Closure Checker**: Extracts all local HTML `href`, `src`, and CSS `url()` references and ensures every local file exists or is automatically stubbed/inlined locally.
- **Duplicate Document Validator**: Enforces strict document structure (rejects and sanitizes duplicate `<!DOCTYPE html>`, `<html>`, or `<body>` blocks caused by accidental concatenation).
- **Line Diff Fix**: Preserves baseline pre-run snapshots so rewritten files report realistic additions and deletions (e.g. `+240/-210`) rather than `+N/-0`.

### Phase 2: Capability-Aware Routing & "Wait for Best Lane"
- **Lane Capability Metadata**: Added `maxOutputTokens`, `contextWindow`, `supportsVision`, `isReasoning`, and `roleTags` to all lanes.
- **Filtering**: Filters out lanes whose `maxOutputTokens < minCodegenOutput` (e.g. Groq 5,500 token completion limit) from single-shot codegen.
- **Lane Pinning**: Pins the model used for the initial file generation across all subsequent repair and verification rounds to eliminate style and architecture drift.
- **Wait for Best Lane**: When preferred lane hits a 429 quota with a short cooldown ($\le 20$s wait budget), the IDE waits with live countdown events instead of degrading to weaker models.
- **Reasoning Budget**: Automatically reserves 30% thinking overhead for reasoning models (e.g. `groq/gpt-oss-120b`).

### Phase 3: Concrete Style Packs & Non-Destructive Restyle
- **7 Production Style Packs**:
  1. `neo-brutalism`: 3px solid black borders, hard 5px 5px 0px offset shadows, vibrant flat fills, Space Grotesk / JetBrains Mono typography.
  2. `glassmorphism`: Frosted translucent panels (`backdrop-filter: blur(16px)`), vivid radial gradient mesh, glowing border accents.
  3. `minimal-editorial`: Refined serif typography (Playfair Display), generous whitespace, hairline borders, quiet luxury layout.
  4. `dark-neon-tech`: Deep `#090A0F` canvas, neon cyan and purple glows, tech grid lines.
  5. `soft-pastel-playful`: Creamy warm pastels, pill badges, bouncy curves, cheerful modern aesthetic.
  6. `corporate-clean`: Slate backgrounds, royal blue primary accents, structured SaaS component grids.
  7. `retro-y2k`: Early-2000s nostalgic web aesthetic, candy gradients, bevels, vintage web elements.
- **Non-Destructive Restyle**: Edits existing `index.html` by upgrading design tokens and CSS variables in `<style id="nova-style-pack">` without touching existing content, markup, or scripts.
- **UI Style Selector**: Quick-select style chip row in `ChatPanel` and default style pack dropdown in `SettingsPanel`.

### Phase 4: Staged Build for Small-Output Lanes
- Automatically activates when the pinned lane has `maxOutputTokens < 16,000` (e.g. Groq 5,500).
- Splits generation into 4 focused sub-4,000-token stages:
  1. `design-system` -> `css/style.css`
  2. `skeleton` -> `index.html` with section comment placeholders
  3. `sections` -> Real markup spliced into each placeholder (2-3 sections per call)
  4. `behavior` -> `js/main.js` interactive event listeners
- Auto-continuation: Detects unclosed `<file>` tags and prompts the model to resume exactly where it stopped.

### Phase 5: Headless Screenshot Review with Vision Model
- **Local Heuristics**: Evaluates horizontal overflow (`scrollWidth > innerWidth`), WCAG AA text contrast ($< 4.5:1$), empty tags, and unstyled default fonts without requiring network or cloud tokens.
- **Vision Model Evaluation**: Passes desktop (1280px) and mobile (390px) previews to vision models (e.g. Gemini 2.5 Flash) for structured JSON scoring (1-10). Scores $< 7$ automatically trigger a targeted visual repair round.
- **Preview Review Card**: Renders Desktop and Mobile preview thumbnails, check badges (`Structure ✓ | Assets ✓ | Visual 8/10`), and an itemized visual findings list in chat.

### Phase 6: Stateful Intent Router & Paste Protection
- **Follow-Up Resumes**: Short commands like `"continue"`, `"resume"`, `"go on"`, `"retry"` resume the active pipeline without re-triggering clarification chips.
- **Targeted Fixes**: `"fix it"` or `"why did it fail"` automatically feeds pending verification issues into the fix turn.
- **Incremental Restyle**: Commands like `"make it darker"` or `"apply glassmorphism"` route directly to non-destructive website restyle instead of rebuilding from scratch.
- **Engineering Prompt Paste Protection**: Long pasted prompts ($> 1,500$ chars) containing structured engineering tokens (`GOAL`, `PHASE`, `ROOT CAUSE`, `TypeScript`, `Electron`, `IPC`) route directly to the codebase `agent`, preventing false-positive website routing.


---

## Phase 6 — Local Model Adapter (`src/main/ai/local-providers.ts`, `SettingsPanel.tsx`)

**Changes:**
- **OpenAI-compatible Ollama & LM Studio adapter (`src/main/ai/local-providers.ts`)**: Auto-detects running local servers (`http://127.0.0.1:11434/api/tags` & `http://127.0.0.1:1234/v1/models`), filters out embedding-only models (`nomic-embed-text`, `bge-*`, `all-minilm`), and registers unlimited zero-quota lanes (`rpm: Infinity, rpd: Infinity`).
- **Zero-cloud-burn utility & simple-edit routing (`src/main/ai/service.ts`)**: Routes `classify`, `summarize`, `autocomplete`, `chat`, and capable `plan`/`general` tasks to local lanes first (`0` cloud free-tier RPD/TPM spent), while keeping cloud lanes primary for hard `codegen` and `repair` calls with local coder lanes as an unlimited safety fallback.
- **Offline starter pack replacement**: When no cloud API keys are configured, detected local models automatically replace the static offline starter pack, keeping the starter pack only as the last-resort fallback when nothing else is reachable.
- **Settings UI (`SettingsPanel.tsx`)**: Added **Local Models** tab with server URL inputs, **Detect Servers**, **Test Ollama / LM Studio**, preferred model selection, and a manual-install recommended small coder model hint list (never auto-downloads).

| Task | Model Calls | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Failed Edits |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 5-task suite (cloud mock) | **8 (-75.8% vs P0)** | **10,558** | **1,921** | **12,479 (-72.3% vs P0)** | **15** | **0** |
| Cloud calls when local coder active | **0–6 (up to -100% cloud RPD on utility/explain/simple edits)** | — | — | — | — | **0** |

---

## Phase 7 — Safety Net for Batching: Per-Run Checkpoints & Diff View (`checkpoints.ts`, `ChatPanel.tsx`, `EditorArea.tsx`)

**Changes:**
- **Per-run checkpoint manager (`src/main/agent/checkpoints.ts`)**: Before the first write, edit, or delete of any file within a run, stores its pre-run state in `.myide/backups/runs/<runId>/manifest.json` and preserves original content blobs.
- **Line diff calculations & stats**: Automatically computes `+addedLines / -removedLines` per changed file (`ChangedFile`), displayed directly in the chat `FilesCard`.
- **One-click "Undo this run" & per-file "Revert"**: Restores modified/deleted files back to their exact pre-run byte content and safely moves newly created files into `.myide/trash` (recoverable).
- **Monaco Diff Viewer (`EditorArea.tsx`)**: Clicking **Diff** on any changed file opens a side-by-side Monaco DiffEditor showing original vs. modified code with an inline **Revert File** button.

| Task | Model Calls | Input Tokens | Output Tokens | Total Tokens | Tool Calls | Failed Edits |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1. Create a small website | 1 (-80% vs P0) | 370 | 1,098 | 1,468 | 4 | 0 |
| 2. Fix a TS error | 2 (-75% vs P0) | 2,743 | 127 | 2,870 | 2 | 0 |
| 3. Add function + test | 2 (-67% vs P0) | 2,923 | 259 | 3,182 | 4 | 0 |
| 4. Rename across files | 2 (-82% vs P0) | 3,259 | 352 | 3,611 | 5 | 0 |
| 5. Explain a file | 1 (-67% vs P0) | 1,263 | 85 | 1,348 | 0 | 0 |
| **TOTAL (5 tasks)** | **8 (-75.8% vs P0)** | **10,558** | **1,921** | **12,479 (-72.3% vs P0)** | **15** | **0** |

---

## Phase 8 — Headless Browser Verification & Feature Flags UI (`headless-verify.ts`, `SettingsPanel.tsx`)

**Changes:**
- **Offscreen Electron BrowserWindow verify (`src/main/quality/headless-verify.ts`)**: Behind `Settings.headlessBrowserVerify === true`, evaluates generated web apps in a strictly sandboxed, hidden BrowserWindow (`show: false, sandbox: true, contextIsolation: true`), capturing runtime console errors, failed network requests, broken local script/link/image tags, and offscreen PNG screenshots into `.myide/verify/`, feeding real errors directly to the repair loop. Fallback to static `verifyWebsite` is clean and automatic.
- **Granular Optimization Controls in Settings UI (`SettingsPanel.tsx`)**: Added dedicated toggle controls with 1-line explanations for all 8 core optimization features:
  1. `batchedActions` — multi-tool execution per turn (up to 8).
  2. `singleShotFileTags` — full website generation in 1 call via `<file>` blocks.
  3. `autoVerifyAfterEdits` — local tsc, eslint & website verification after writes.
  4. `fuzzyEditMatch` — 4-tier fuzzy match (exact, CRLF/LF, indent, similarity).
  5. `repoMapEnabled` — mtime-cached workspace symbol outline & import graph.
  6. `rollingSummaryEnabled` — old tool result stubs & `[Working Memory]` compression.
  7. `freeTierSaver` — single-shot explain Q&A and zero-overhead small edits.
  8. `headlessBrowserVerify` — offscreen Chromium runtime validation.

---

## Performance Summary: Phase 0 Baseline vs. Phase 8 Final

| Metric | Phase 0 Baseline | Phase 8 Final | Improvement |
| :--- | :--- | :--- | :--- |
| **Model Calls (5 benchmark tasks)** | **33 calls** | **8 calls** | **-75.8% reduction** |
| Multi-file website build | 5 calls | 1 call | **-80.0% reduction** |
| TypeScript error fix | 8 calls | 2 calls | **-75.0% reduction** |
| Add function + test | 6 calls | 2 calls | **-66.7% reduction** |
| Rename across 4 files | 11 calls | 2 calls | **-81.8% reduction** |
| Code explanation | 3 calls | 1 call | **-66.7% reduction** |
| **Total Tokens Consumed** | **45,104 tokens** | **12,479 tokens** | **-72.3% reduction** |
| **Failed `editFile` Attempts** | 1 failure (indent mismatch) | **0 failures** | **100% edit success rate** |
| **Cloud Quota Burn with Local Models** | 100% cloud quota spent | **0% on light/chat tasks** | **Unlimited local offload** |

---

## How to Tune for Free Tier

When running on tight free-tier providers (Gemini 15 RPM / 1,500 RPD, Groq 30 RPM / 8k TPM, OpenRouter :free models):

### 1. If a model returns broken JSON in multi-action turns
- Set `batchedActions: false` in **Settings > Agent & Workflow > Free-Tier Optimization Flags**.
- The loop automatically switches to the single-tool envelope (`{ thought, tool, args }`).

### 2. If a small model struggles to emit `<file>` tags
- Toggle `singleShotFileTags: false`.
- The pipeline will plan and write files step-by-step using individual `writeFile` tool calls.

### 3. If hitting Groq 8k TPM limits on large files
- Ensure `repoMapEnabled: true` and `rollingSummaryEnabled: true` are enabled.
- The lane budget fitter (`src/main/context/budget.ts`) will prioritize the recent turns, shed older context, and skip Groq when requests exceed 5,500 tokens.

### 4. If edits fail on strange tab/space formatting
- Ensure `fuzzyEditMatch: true` is on.
- It cascades from exact match to whitespace normalization, indentation-relative scale matching, and 90% sliding similarity before giving up.

### 5. Conserving Cloud Quota with Local Ollama / LM Studio
- Open **Settings > Local Models**, start Ollama or LM Studio, and click **Detect Servers**.
- The IDE will route `classify`, `summarize`, `chat`, and simple edits to your local GPU/CPU for **0 cloud tokens**, reserving scarce Gemini/Groq daily quotas for hard multi-file codegen and repair tasks.

---

## Website Builder Engine Upgrade (Phases 1 - 6)

### Phase 1: Complete File Set & Integrity
- **Manifest Step**: Resolves target file set prior to generation. Defaults to a single self-contained `index.html` on free tier (inline `<style>`, `<script>`, and vector SVGs) to avoid 404s.
- **Reference-Closure Checker**: Extracts all local HTML `href`, `src`, and CSS `url()` references and ensures every local file exists or is automatically stubbed/inlined locally.
- **Duplicate Document Validator**: Enforces strict document structure (rejects and sanitizes duplicate `<!DOCTYPE html>`, `<html>`, or `<body>` blocks caused by accidental concatenation).
- **Line Diff Fix**: Preserves baseline pre-run snapshots so rewritten files report realistic additions and deletions (e.g. `+240/-210`) rather than `+N/-0`.

### Phase 2: Capability-Aware Routing & "Wait for Best Lane"
- **Lane Capability Metadata**: Added `maxOutputTokens`, `contextWindow`, `supportsVision`, `isReasoning`, and `roleTags` to all lanes.
- **Filtering**: Filters out lanes whose `maxOutputTokens < minCodegenOutput` (e.g. Groq 5,500 token completion limit) from single-shot codegen.
- **Lane Pinning**: Pins the model used for the initial file generation across all subsequent repair and verification rounds to eliminate style and architecture drift.
- **Wait for Best Lane**: When preferred lane hits a 429 quota with a short cooldown ($\le 20$s wait budget), the IDE waits with live countdown events instead of degrading to weaker models.
- **Reasoning Budget**: Automatically reserves 30% thinking overhead for reasoning models (e.g. `groq/gpt-oss-120b`).

### Phase 3: Concrete Style Packs & Non-Destructive Restyle
- **7 Production Style Packs**:
  1. `neo-brutalism`: 3px solid black borders, hard 5px 5px 0px offset shadows, vibrant flat fills, Space Grotesk / JetBrains Mono typography.
  2. `glassmorphism`: Frosted translucent panels (`backdrop-filter: blur(16px)`), vivid radial gradient mesh, glowing border accents.
  3. `minimal-editorial`: Refined serif typography (Playfair Display), generous whitespace, hairline borders, quiet luxury layout.
  4. `dark-neon-tech`: Deep `#090A0F` canvas, neon cyan and purple glows, tech grid lines.
  5. `soft-pastel-playful`: Creamy warm pastels, pill badges, bouncy curves, cheerful modern aesthetic.
  6. `corporate-clean`: Slate backgrounds, royal blue primary accents, structured SaaS component grids.
  7. `retro-y2k`: Early-2000s nostalgic web aesthetic, candy gradients, bevels, vintage web elements.
- **Non-Destructive Restyle**: Edits existing `index.html` by upgrading design tokens and CSS variables in `<style id="nova-style-pack">` without touching existing content, markup, or scripts.
- **UI Style Selector**: Quick-select style chip row in `ChatPanel` and default style pack dropdown in `SettingsPanel`.

### Phase 4: Staged Build for Small-Output Lanes
- Automatically activates when the pinned lane has `maxOutputTokens < 16,000` (e.g. Groq 5,500).
- Splits generation into 4 focused sub-4,000-token stages:
  1. `design-system` -> `css/style.css`
  2. `skeleton` -> `index.html` with section comment placeholders
  3. `sections` -> Real markup spliced into each placeholder (2-3 sections per call)
  4. `behavior` -> `js/main.js` interactive event listeners
- Auto-continuation: Detects unclosed `<file>` tags and prompts the model to resume exactly where it stopped.

### Phase 5: Headless Screenshot Review with Vision Model
- **Local Heuristics**: Evaluates horizontal overflow (`scrollWidth > innerWidth`), WCAG AA text contrast ($< 4.5:1$), empty tags, and unstyled default fonts without requiring network or cloud tokens.
- **Vision Model Evaluation**: Passes desktop (1280px) and mobile (390px) previews to vision models (e.g. Gemini 2.5 Flash) for structured JSON scoring (1-10). Scores $< 7$ automatically trigger a targeted visual repair round.
- **Preview Review Card**: Renders Desktop and Mobile preview thumbnails, check badges (`Structure ✓ | Assets ✓ | Visual 8/10`), and an itemized visual findings list in chat.

### Phase 6: Stateful Intent Router & Paste Protection
- **Follow-Up Resumes**: Short commands like `"continue"`, `"resume"`, `"go on"`, `"retry"` resume the active pipeline without re-triggering clarification chips.
- **Targeted Fixes**: `"fix it"` or `"why did it fail"` automatically feeds pending verification issues into the fix turn.
- **Incremental Restyle**: Commands like `"make it darker"` or `"apply glassmorphism"` route directly to non-destructive website restyle instead of rebuilding from scratch.
- **Engineering Prompt Paste Protection**: Long pasted prompts ($> 1,500$ chars) containing structured engineering tokens (`GOAL`, `PHASE`, `ROOT CAUSE`, `TypeScript`, `Electron`, `IPC`) route directly to the codebase `agent`, preventing false-positive website routing.

