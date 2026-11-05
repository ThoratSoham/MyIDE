# MyIDE

**Free models, premium results, no surprise failures.**

MyIDE is a desktop AI IDE for Windows, macOS and Linux that turns *weak, free* AI models
(Google AI Studio / Gemini, OpenRouter, Groq) into **premium results** — powered by
**free-tier keys only**, no paid API required.

It is built with **Electron + React + TypeScript + Tailwind CSS** and a locally bundled
**Monaco** editor.

---

## Why MyIDE exists

Weak free models usually fail in predictable ways: they reply in chat but never create
files, they run out of daily quota mid-job, they blow past token limits, or they declare a
broken website "done". MyIDE is engineered around those failure modes.

The core idea: **the intelligence lives in the library, not in the model.**

MyIDE gets premium output from cheap models in four ways:

1. **Split every job into small, code-checked steps.** Each step has a strict format and
   is validated by code before anything touches disk.
2. **A hand-made design library** (tokens, palettes, fonts, section templates, motion
   recipes). The model *picks and fills in* — it does not invent from nothing.
3. **Code verifies, the model only suggests.** A code-only verifier runs the real page in a
   real browser before MyIDE ever says "done".
4. **Quota protection.** MyIDE knows each provider's limits, counts real usage, plans work
   around them, and pauses safely when the day's quota runs out.

> **One-line pitch:** Free models, premium results, no surprise failures.

---

## Features

### Foundation
- **Electron desktop app** (Windows / macOS / Linux) with a hardened main process:
  `contextIsolation` on, `nodeIntegration` off, sandbox on, typed IPC bridge.
- **Monaco editor** with a lazy file tree, tabs, read / write / save.
- **Private preview** of HTML, images and video through a custom `myide-ws://` protocol
  that serves only workspace files.
- **Real providers**: Gemini, OpenRouter and Groq, plus a deterministic `offline` lane so
  pipelines still run with **no keys at all**.

### Providers, lanes & quota ledger (`FR-2`)
- A **lane** = one provider + one model.
- A **quota ledger** persisted to disk counts requests and tokens per lane.
- **Size-aware routing**: Gemini and OpenRouter limit *requests*; Groq limits *tokens*
  (a single request over ~8,000 tokens hard-fails with `413`). Big prompts go to Gemini,
  small prompts go to Groq.
- Limits are **editable defaults** and are also **learned from real error messages and
  response headers**.

### Router & failover (`FR-3`)
- Error matrix handling: `429` (min / day), `5xx`, network / timeout, `413`, `400`, `401`,
  `403` / `404`, and empty responses each have a defined recovery path.
- Backoff, lane cooldowns, dead-model tracking, and honest reporting of what was skipped.

### Reliable agent (`FR-5`, `FR-6`)
- Small **agent tool set** (list / read / write / edit / delete / run command / verify),
  all executed in the main process.
- **Workspace-only paths** (FR-5.3), `.env` files can never be read, commands require
  **approval** with a timeout and process-tree kill (FR-5.4).
- **Safety net (FR-13.3):** every delete goes to `.myide/trash`, every overwrite is backed
  up to `.myide/backups` — 100% recoverable.
- **Progress ledger + resume:** state is saved after every step, so long runs either
  finish or **pause safely** and resume at the quota reset time.

### Quality engine (`FR-7` – `FR-10`)
- **Pipeline** = a fixed list of small stages, assembled from the library.
- **Verifier (code only, no AI):** loads the built page in a real browser via
  `puppeteer-core` at three viewports (desktop 1440×900, tablet 768×1024, mobile 390×844)
  and reports every issue with a stable id, severity, selector and fix hint — plus
  screenshots to `.myide/verify`.
- **Critic + ratchet:** a change is kept only if the rubric score improves.
- **Best-of-N**, **hedging** and **verifier-gated completion** (a run cannot be marked
  complete while an HTML file changed and the verifier has not passed since).

### Library (skill packs) (`FR-8`)
Hand-made packs live in [`resources/skills`](resources/skills):

| Pack | Contents |
| --- | --- |
| `web-core` | base CSS, design tokens, section templates, rubric |
| `web-motion` | motion recipes with a "visible without JS" contract |
| `three-core` | Three.js scene presets |
| `topo-core` | topology / explainer recipes |
| `video-core` | video export recipes |

Design work is done by seniors, once — then reused by every free model.

### UI (`FR-12`)
- File tree + editor, chat and pipeline view, live status bar (mode / score / countdown),
  quota panel, settings (key management, free-tier limits, library packs) and preview.

---

## Project principles

1. **Smart child with a checklist.** Small step, strict format, code validates.
2. **The intelligence lives in the library,** not in the model.
3. **Code verifies, the model only suggests.**
4. **Never trust model output.** Validate before it touches the disk.
5. **Degrade quality steps first** (extra candidates, extra critic rounds) — never starve
   required steps.
6. **Always resumable.** State is saved after every step.
7. **Be honest.** Show quota, models, and what was skipped.
8. **Safe by default.** Workspace only, approvals, trash, backups.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Shell | Electron 33 |
| UI | React 18 + TypeScript (strict) + Vite |
| Styling | Tailwind CSS |
| Editor | Monaco (`@monaco-editor/react` + local `monaco-editor`, no CDN) |
| Verification | `puppeteer-core` (Chrome / Edge / Brave) |
| Media | bundled `ffmpeg-static` |
| Logging | `electron-log` |

---

## Getting started

### Prerequisites
- **Node.js 20+** (developed on Node 24)
- npm
- A Chromium-based browser (Chrome, Edge or Brave) for the verifier — optional but
  recommended.

### Install

```bash
git clone https://github.com/ThoratSoham/MyIDE.git
cd MyIDE
npm install
```

### Run in development

```bash
npm run dev
```

This type-checks the main process, starts Vite on `http://localhost:5173`, and launches
Electron. Renderer code is served by Vite for hot reload.

> If your terminal sandbox blocks running two concurrent child processes, run Vite and
> Electron in two separate terminals instead:
> ```bash
> npx vite
> npx electron .
> ```

### Build

```bash
npm run build:main       # compile the main process (tsc)
npm run build:renderer   # bundle the renderer (vite)
npm run build            # full production build + electron-builder installers
```

### Add your free keys
Open **Settings** in the app and paste any of your free keys:
- **Google AI Studio (Gemini)**
- **OpenRouter** (use `:free` models)
- **Groq**

Keys are stored via Electron `safeStorage` (OS keychain / encrypted file) — never in the
repo or in plain text. With **no keys**, the deterministic `offline` lane still runs the
pipelines end to end using library fallbacks.

---

## Project structure

```
src/
  main/                 # Electron main process (Node)
    ai/                 # providers, lanes, quota ledger, router, service
    agent/              # tools + agent loop
    quality/            # stage runner, website pipeline, verifier, critic, schema
    skills/             # library loader
    ui/                 # settings
    fs-workspace.ts     # workspace access, trash + backups (FR-13.3)
    ipc.ts              # typed IPC surface
    jobs.ts             # job manager (pause / resume / progress)
    preview-protocol.ts # private myide-ws:// protocol
    store.ts            # encrypted settings (safeStorage)
    main.ts             # app entry
  preload/              # safe typed bridge
  renderer/             # React UI (Monaco, chat, quota, settings, preview)
  shared/               # shared types (single source of truth for IPC)
resources/skills/       # hand-made design library packs
```

Runtime data (builds, verification, trash, backups, progress) lives under `.myide/` in the
workspace and is git-ignored.

---

## Free-Tier Efficiency & Architecture Upgrades (Phase 0 – Phase 8)

Nova IDE features an end-to-end efficiency layer designed specifically for low-RPM, low-TPM, and daily-capped free-tier model providers (Gemini free, Groq free, OpenRouter :free, and local Ollama/LM Studio):

1. **Batched Actions in the Agent Loop**: The model can return multiple tool calls in a single turn via `actions: [{ tool, args }, ...]`, executing contiguous read-only actions in parallel and halting at the first failure or approval denial.
2. **Single-Shot `<file>` Website Generation**: Emits responsive websites in a single model turn via `<file path="...">` blocks with unclosed EOF tolerance and targeted snippet-only repair loops.
3. **4-Tier Fuzzy `editFile` Matching**: Cascades through exact match, trailing whitespace + CRLF/LF normalization, indentation-relative scale matching, and 90% sliding similarity before failing.
4. **Context Optimization**:
   - `repo-map`: Workspace symbol outlines and import graph cached by `mtime` in `.myide/cache/repo-map.json` (~1,200 token budget).
   - `bm25`: Okapi BM25 retriever resolving `@file`, `@symbol`, and code identifiers into prompt context with zero model calls.
   - `working-memory`: Distills evicted turns into `[Working Memory]` and stubs older tool results to prevent 413s.
5. **Smart Router & Token-Bucket Ledger**:
   - Proactive token bucket (`canAfford`) pre-skips RPM/TPM-full lanes without wasting HTTP calls.
   - Malformed-JSON probation demotes lanes with >25% invalid schema output.
   - Task-class routing (`classify`, `summarize`, `plan`, `codegen`, `repair`, `chat`) routes light utility tasks to fast lanes.
6. **Local Model Adapter (Ollama & LM Studio)**:
   - Probes `http://127.0.0.1:11434` and `http://127.0.0.1:1234/v1`, registering unlimited local lanes.
   - Automatically handles utility tasks and simple edits locally for **0 cloud tokens**, reserving scarce cloud quota for hard codegen.
7. **Per-Run Checkpoints & Diff Viewer**:
   - Snapshots pre-run file states before writes/edits into `.myide/backups/runs/<runId>/`.
   - Side-by-side Monaco DiffEditor with single-file **Revert** and one-click **"Undo this run"**.
8. **Headless Browser Verification**:
   - Evaluates web builds in a sandboxed, hidden BrowserWindow, capturing runtime console exceptions and offscreen screenshots.

### Measured Benchmark Results (`npm run bench`)
| Suite | Model Calls | Total Tokens | Edit Failures |
| :--- | :--- | :--- | :--- |
| **Phase 0 Baseline** | 33 calls | 45,104 tokens | 1 failure |
| **Phase 8 Final** | **8 calls (-75.8%)** | **12,479 tokens (-72.3%)** | **0 failures** |

See [docs/PERF.md](docs/PERF.md) for the detailed benchmark breakdown and tuning guide.

---

## Status

MyIDE is under active development against the
[PRD v2](%20MyIDE%20-%20Product%20Requirements%20Document%20(PRD)%20v2.md) — Free models, premium results, no surprise failures.
Milestones M1–M5 (foundation, quota safety, reliable agent, quality core, critic & polish)
are implemented and type-check clean; parallel orchestra, media pipelines and packaging are
in progress.

---

## License

MIT.
