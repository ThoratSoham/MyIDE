# MyIDE - Product Requirements Document (PRD) v2

Version 2.0 | November 1, 2026 | Status: Draft | Replaces: MyIDE PRD v1

## 1. Summary

MyIDE is a desktop AI IDE for Windows, Mac and Linux (Electron, React, TypeScript, Tailwind CSS). It works with FREE AI keys only: Google AI Studio (Gemini), OpenRouter and Groq.

Its main job is to make weak, free models give premium results. It does this in three ways:

1. It splits every job into small steps, and code checks every step.
2. It uses a hand-made library of designs, colors and animations. The model picks and fills in; it does not invent from nothing.
3. It tests every result with code before it says done.

It also protects the free daily quota. It knows each limit, counts usage, and plans work around it.

**One-line pitch:** Free models, premium results, no surprise failures.

## 2. Background: what went wrong in v1

These problems were seen in real test logs.

| Problem seen | Cause | Fixed by |
| --- | --- | --- |
| Chat only replied, no files were made | Gemini was a stub. Tools were sent in the wrong format. Chat never started the agent | FR-2, FR-5 |
| Website showed only the clinic name | The JS file was never written. Content started hidden. The AI said done without checking | FR-5.6, FR-7, FR-9 |
| Run died with All providers failed | No waiting. Timeout was only 30 s | FR-3.5, FR-3.6 |
| Groq error 413 again and again | Groq free allows 8,000 tokens per minute. Prompts were bigger. Trimming did nothing | FR-2.6 |
| All Gemini models rate limited in a loop | Daily request budget used up. Router retried every 60 s | FR-2.3 to FR-2.5 |
| OpenRouter back in 1126m | Daily limit (50 per day) used up | FR-2.5 |
| Loop detected twice, run stopped | Same failing call repeated. Detector too strict. Old history shortened too much | FR-6 |
| Basic, ugly websites | One giant request for everything. No design library. No review step | FR-7, FR-8, FR-10 |

## 3. Goals and non-goals

### Goals

| ID | Goal | How we measure it |
| --- | --- | --- |
| G1 | A run always finishes or pauses safely. It never dies with only an error | 0 dead runs in 50 test runs |
| G2 | Websites look premium with free keys | Rubric score 8 or more out of 10 in Balanced mode |
| G3 | Never send a request that is known to fail | 0 requests sent over a lane's size or quota limit |
| G4 | A normal website uses few requests | 40 requests or fewer |
| G5 | Everything is free | No paid API needed |
| G6 | The user always knows what is happening | Model name on every message. Quota panel always visible |
| G7 | Every AI change can be undone | Trash and backups for 100% of deletes and overwrites |

### Non-goals (version 1)

- No cloud accounts and no team features.
- No mobile app.
- No AI video-generation APIs. Videos are made from code.
- No full replacement for VS Code extensions.
- No tricks to beat the limits (no fake accounts, no extra projects made to get more quota).

## 4. Users

| User | Needs |
| --- | --- |
| Student or beginner | Free tools, simple setup, clear messages |
| Freelancer or indie developer | Fast good-looking sites, no lock-in to one provider |
| Motion designer who codes | Scroll animations, 3D scenes, MP4 export |
| Teacher | Animated science explainers (for example photosynthesis in Three.js) |

## 5. Constraints: free-tier facts

These numbers were checked in October and November 2026. They change often, and some sources disagree. MyIDE must read the real limits from error messages and headers. This table is only the editable default.

| Provider | Free limits (defaults) | Best use in MyIDE |
| --- | --- | --- |
| Gemini full Flash (3.5, 3.6, 3.8) | About 5 requests per minute and about 20 per day. Very large context | Hard steps: plan, hero, critic (can see images) |
| Gemini Flash-Lite | About 10 per minute and about 500 per day | Default worker for most steps |
| Gemini Pro | 0 on free | Never use |
| OpenRouter free models (:free) | 20 per minute. 50 per day (1,000 per day only if the user ever bought 10 dollars of credit; never required). Models change and some return 403 | Backup and second opinions |
| Groq | 30 per minute. 8,000 tokens per minute per model. A single request over 8,000 tokens always fails with 413 | Tiny jobs under 5,500 tokens: picks, repairs, short copy |

**Key idea:** Gemini and OpenRouter limit REQUESTS. Groq limits TOKENS. So big prompts go to Gemini, small prompts go to Groq, and we send fewer, bigger requests.

**Parallel use does not add quota.** It adds speed, variety (different models try the same job) and judging (one model scores another's work).

## 6. Product principles

1. **Smart child with a checklist.** Small step, strict format, code validates.
2. **The intelligence lives in the library,** not in the model.
3. **Code verifies, the model only suggests.**
4. **Never trust model output.** Validate before it touches the disk.
5. **Degrade quality steps first** (extra candidates, extra critic rounds). Never starve required steps.
6. **Always resumable.** State is saved after every step.
7. **Be honest.** Show quota, models, and what was skipped.
8. **Safe by default.** Workspace only, approvals, trash, backups.

## 7. System overview

| Part | What it does |
| --- | --- |
| Main process (Node) | File access, lanes and quota ledger, router, orchestra, agent loop, pipelines, verifier (puppeteer-core), FFmpeg, job manager, key storage |
| Preload | Small safe bridge with typed IPC channels |
| Renderer (React) | Monaco editor, file tree, chat and pipeline view, preview, quota panel, settings |

Folders in src/main: ai (providers, lanes, ledger, router), orchestra (scheduler, patterns, calibration), agent (tools, loop, progress), quality (stage runner, pipelines, verifier, critic, ratchet), render (video), skills loader. Library packs are in resources/skills.

**Data flow for a website job:**

1. User asks in chat. The job planner estimates requests and shows the mode (Fast, Balanced, Best).
2. The pipeline runs small stages. Each stage goes through the scheduler, which picks a lane by role, size and quota.
3. Code assembles files from the library. The verifier tests them. The critic suggests safe fixes. The ratchet keeps only changes that improve the score.
4. The UI shows progress, screenshots and the final score.

## 8. Functional requirements

Priority: **P0** = must have, **P1** = should have, **P2** = later.

### 8.1 Workspace and editor (FR-1)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-1.1 | Open a folder. Restore the last folder at start-up | P0 |
| FR-1.2 | File tree with new file, new folder, delete (delete goes to trash) | P0 |
| FR-1.3 | Monaco editor with tabs, one model per file, language by extension, workers set up for Vite | P0 |
| FR-1.4 | Tree, open tabs and preview refresh when files change on disk | P0 |
| FR-1.5 | Resizable panels, dark and light theme, command palette | P1 |
| FR-1.6 | Inline autocomplete using the fastest small lane | P2 |

### 8.2 Providers, lanes and quota ledger (FR-2)

A lane is one provider plus one model.

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-2.1 | Find usable models from each provider's model list. Keep a small fallback list | P0 |
| FR-2.2 | Never use Gemini Pro, customtools, or any model with limit 0. Use Flash-Lite for workers and Flash for hard steps | P0 |
| FR-2.3 | Ledger: requests used today per lane, and tokens in the last minute for Groq. Saved to disk | P0 |
| FR-2.4 | Learn real limits from 429 text, Groq x-ratelimit headers, and OpenRouter key info | P0 |
| FR-2.5 | When a daily quota is used, remove that lane until its reset time. Never poll it before then | P0 |
| FR-2.6 | Size-aware routing. Estimate tokens (characters / 3.5 + output). Never send more than 5,500 tokens to Groq. No failed try and no log line | P0 |
| FR-2.7 | A model that returns 403 or 404 is dead for 24 hours | P0 |
| FR-2.8 | Keys encrypted with the OS (safeStorage). Window sees only the last 4 characters. Test my keys button | P0 |
| FR-2.9 | Quota panel: used and left per lane, reset time, tokens this minute | P1 |
| FR-2.10 | Small calibration test ranks lanes per role. Runs every 7 days or on a button | P1 |

### 8.3 Router and failover (FR-3)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-3.1 | Chain order depends on task class: reasoning, general, autocomplete | P0 |
| FR-3.2 | Follow the error rules in section 11 | P0 |
| FR-3.3 | Timeouts: 75 s for the first byte, 90 s between pieces. Stop cancels at once | P0 |
| FR-3.4 | An empty answer counts as a retryable error | P0 |
| FR-3.5 | If all lanes are blocked, wait for the shortest REAL reset. If it is longer than 10 minutes, pause and save. Show Resume at HH:MM and an auto-resume switch | P0 |
| FR-3.6 | At most 3 retries per request per lane. No endless loops. Same log line is shown once with a counter | P0 |
| FR-3.7 | Inside one pipeline run, keep the same model for the same stage class. Switch only on failure. Show the model name on every message | P1 |

### 8.4 Parallel orchestra (FR-4)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-4.1 | Task graph scheduler with a limiter and max concurrency per lane | P1 |
| FR-4.2 | Patterns: fanOut, bestOfN, vote, crossReview, tournament, hedge (only if daily budget is above 50%), split | P1 |
| FR-4.3 | The judge is never the same lane as the candidate | P1 |
| FR-4.4 | Work stealing: if a lane is busy or cooling, move the task to the next best lane | P1 |
| FR-4.5 | One writer per output slot. Validate before writing. Write to a temp file, then rename | P0 |
| FR-4.6 | Cache results by hash of stage, input, schema and lane class | P1 |
| FR-4.7 | Optional tasks run only when the lane has more than 30% of its daily budget left | P1 |

### 8.5 Agent loop and tools (FR-5)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-5.1 | Chat starts the agent. It runs in the main process and keeps going when the user switches tabs | P0 |
| FR-5.2 | Tools: listDir, readFile, writeFile, editFile, deleteFile, moveFile, createDir, executeCommand, renderVideo, getAnimationTemplate, verifyWebsite, openPreview, updatePlan, markComplete | P0 |
| FR-5.3 | All paths stay inside the workspace. .env files cannot be read. Protected folders | P0 |
| FR-5.4 | Commands need approval: Allow once, Always allow, Deny. Dangerous commands are always blocked. Timeout and process-tree kill | P0 |
| FR-5.5 | The model may make several tool calls in one turn. Each gets one result | P0 |
| FR-5.6 | markComplete is refused if an HTML file changed and verifyWebsite has not passed after the last change | P0 |
| FR-5.7 | Text-only answer to an action request: nudge once. A real question is accepted | P1 |
| FR-5.8 | The user can send a note while the agent works. It is read before the next step | P1 |
| FR-5.9 | Safety limits (max steps, max errors in a row) pause the run. They never kill it | P0 |

### 8.6 Loop detection, progress ledger and resume (FR-6)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-6.1 | A loop means the same tool, arguments and result 3 times in a row. Reads include the file hash, so reading a changed file is not a loop | P0 |
| FR-6.2 | First detection: send a recovery message and try one stronger model. Second detection: pause with buttons (Tell the AI, Skip step, Stronger model, Stop). Always show the cause | P0 |
| FR-6.3 | Progress ledger built by code in .myide/progress.json (steps and files). A block of at most 400 tokens is added to every request | P0 |
| FR-6.4 | Every tool error says what to do next | P0 |
| FR-6.5 | History compaction: keep the last 6 messages whole. Shorten old results to 300 characters. Old file contents become a short note with the first line and the ids and classes | P0 |
| FR-6.6 | Save the run after every step (temp file, then rename). After a crash, add a fake result to unfinished tool calls and offer Resume | P0 |

### 8.7 Quality Engine and pipelines (FR-7)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-7.1 | Stage runner: JSON schema check, repair loop (max 3, with the exact error), then library fallback. No tool calling in pipelines | P0 |
| FR-7.2 | JSON repair handles code fences, text around JSON, trailing commas, smart quotes | P0 |
| FR-7.3 | Website stages: S0 intake, S1 style vote, S2 sitemap, S3 copy per section, S4 motion pick, S5 assemble (code), S6 verify (code), S7 critic and ratchet, S8 polish (code), S9 report | P0 |
| FR-7.4 | Copy is one small request per section, with a shared facts sheet. Filler words are rejected (lorem, your text here, Company Name) | P0 |
| FR-7.5 | Files are assembled by code only, from templates, tokens and recipes. Text is escaped | P0 |
| FR-7.6 | If the models return garbage, the pipeline still outputs a page that passes the verifier from library defaults | P0 |
| FR-7.7 | Three modes: Fast, Balanced, Best. The request estimate is shown before start | P0 |
| FR-7.8 | Animation pipeline: storyboard JSON, runtime with \_\_seek, sample-frame check, critic, renderVideo | P1 |
| FR-7.9 | 3D explainer pipeline: outline, per-scene recipe and captions, science check by a different lane, verify | P1 |
| FR-7.10 | Scroll-animation recipe set: shapes, big typography, topographic contour lines, pinned chapters | P1 |
| FR-7.11 | Job planner splits a big job across days at chapter edges, with a checkpoint after each chapter | P1 |

### 8.8 Skill packs: the library (FR-8)

A pack contains skill.json, tokens, templates, recipes, examples and rubric.md. The loader checks every pack at start-up.

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-8.1 | Loader finds missing files, bad JSON and unknown slots and shows them in the Logs panel | P0 |
| FR-8.2 | web-core: 10 palettes that pass WCAG AA, 8 font pairs, spacing and type scales, section templates with 2 to 3 variants each (navbar, hero, logo strip, features, stats, process, services, pricing, testimonials, team, gallery, FAQ, CTA, contact, footer) | P0 |
| FR-8.3 | web-motion recipes: fade-up on scroll, stagger, count-up, text reveal, parallax, gradient blob, marquee, card tilt, magnetic button, scroll progress, sticky scrub, cursor glow, page intro. All respect reduced motion. None hide content if JS fails | P0 |
| FR-8.4 | three-core: one shared canvas, scene manager, recipes (particles, floating shapes, molecules, cross-section, flow along a curve, glow) | P1 |
| FR-8.5 | topo-core: contour lines by marching squares, draw-in, parallax, elevation sweep | P1 |
| FR-8.6 | video-core: storyboard runtime that exposes \_\_seek and \_\_duration | P1 |
| FR-8.7 | A preview screenshot for every template and palette | P1 |
| FR-8.8 | Users can add their own packs | P2 |

### 8.9 Verifier: code only, no AI (FR-9)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-9.1 | Test at 1440x900, 768x1024 and 390x844 with the checks in section 12 | P0 |
| FR-9.2 | Every issue has a stable id, severity, selector and fix hint | P0 |
| FR-9.3 | Save screenshots to .myide/verify | P0 |
| FR-9.4 | Reuse one browser with several pages. Max parallel jobs = min(3, CPU cores - 1) | P1 |

### 8.10 Critic and ratchet (FR-10)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-10.1 | Critic scores the rubric (1 to 10) and returns at most 5 fixes. Allowed changes: swap palette, swap variant, change copy, add or remove recipe, adjust token, reorder sections. The model never writes raw HTML or CSS | P0 |
| FR-10.2 | Vision critic on Gemini (sees screenshots). Text critic as fallback | P1 |
| FR-10.3 | Ratchet: apply fix, rebuild, verify, score. Keep it only if the score goes up and errors do not. Otherwise revert. Max 3 rounds. Always keep the best build | P0 |
| FR-10.4 | Merge fix lists from several critics. Rank by agreement and severity | P1 |

### 8.11 Preview, video and 3D (FR-11)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-11.1 | Preview HTML, images and video through a private myide-ws:// protocol that serves only workspace files | P0 |
| FR-11.2 | renderVideo captures by seeking, not by recording. Finds Chrome, Edge or Brave. Falls back to a hidden Electron window. Pipes PNG frames into bundled FFmpeg. Outputs MP4, WebM or GIF | P0 |
| FR-11.3 | Animation page contract: window.\_\_seek(t) and window.\_\_duration. GSAP is copied next to the page for offline use | P0 |
| FR-11.4 | Three.js and model-viewer preview | P1 |

### 8.12 User interface (FR-12)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-12.1 | Chat shows the plan, tool steps, approval cards, progress bar and a waiting banner with a countdown | P0 |
| FR-12.2 | Pipeline view: each stage with status, time and model | P1 |
| FR-12.3 | Quota panel and lanes panel. Timeline of parallel tasks | P1 |
| FR-12.4 | After a build: score badge, desktop and mobile screenshots, issue list, before and after of each round | P1 |
| FR-12.5 | Buttons: Improve, Regenerate section, Change style (no model call), Lock section | P1 |
| FR-12.6 | Loop pause dialog with the buttons from FR-6.2 | P0 |
| FR-12.7 | Banner: Resume interrupted run | P0 |
| FR-12.8 | Settings: keys, Test my keys, Chrome path, default mode, editable limits table | P0 |

### 8.13 Security and safety (FR-13)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-13.1 | contextIsolation on, nodeIntegration off, typed IPC only | P0 |
| FR-13.2 | Keys are never sent to the window and never written to logs | P0 |
| FR-13.3 | Deleted files go to .myide/trash. Overwritten files are copied to .myide/backups | P0 |
| FR-13.4 | Preview runs in a sandboxed iframe | P0 |
| FR-13.5 | File content is treated as data, not as instructions (prompt injection). Commands need approval | P0 |
| FR-13.6 | No telemetry. Logs stay on the computer | P0 |

### 8.14 Training hooks (FR-14, later)

| ID | Requirement | Pri |
| --- | --- | --- |
| FR-14.1 | Job manager for local Python scripts with streamed logs, queued, running, done, failed | P2 |
| FR-14.2 | Kaggle kernels using the user's kaggle.json | P2 |
| FR-14.3 | Colab: export a notebook only (no official public API) | P2 |

## 9. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Reliability | No run is lost in a crash. Resume works from the last saved step |
| Quota safety | 0 requests sent to a lane that is known to be over quota or over size |
| Performance | App starts in under 5 seconds. UI never freezes while a run is active |
| Speed | Balanced website build in 3 to 8 minutes when quota is available |
| Verifier speed | Three viewports in under 20 seconds |
| Compatibility | Windows 10 and up, macOS 12 and up, Ubuntu 22.04 and up |
| Packaging | Installers: NSIS, DMG, AppImage. FFmpeg and GSAP unpacked from the asar archive |
| Accessibility | Keyboard shortcuts. Good contrast in both themes. Generated sites pass the checks in section 12 |
| Privacy | Prompts go only to the providers the user turned on. Free tiers may use prompts to improve their products, and the Settings page says so |
| Maintainability | Strict TypeScript. Limits and model rankings live in one config file |

## 10. Local data layout

Inside each workspace, a .myide folder holds:

- runs/ : saved run state, one JSON per run
- progress.json : plan steps and file list (written by code)
- task.md : the user's long brief, kept out of every request
- build/ : pipeline stage outputs, and best/ for the best build
- verify/ : screenshots and reports
- cache/ : cached model outputs
- trash/ and backups/ : recoverable files
- allowed-commands.json : commands the user chose to always allow

In the app data folder: settings.enc (encrypted keys), ledger.json (usage counts), lanes.json (health and calibration).

## 11. Error handling matrix

| Event | What MyIDE does |
| --- | --- |
| 429 per minute | Lane sleeps for the Retry-After time. Task moves to the next lane |
| 429 per day (text says PerDay, or wait is very long) | Lane removed until its reset time. Shown in the Quota panel |
| 5xx, network error, timeout | Retry same lane up to 2 times with backoff and jitter, then next lane |
| 413 (too big) | Shrink the prompt to 60% and retry once. Still 413: skip this lane for this request only. Never send the same prompt twice |
| 400 | Skip this model for this request |
| 401, or missing key | Skip the whole provider. Tell the user once |
| 403 or 404 on a model | Mark the model dead for 24 hours |
| Empty or invalid answer | Repair prompt with the exact error (max 3), then other lane, then library fallback |
| All lanes blocked | Wait for the shortest real reset. Over 10 minutes: pause, save, show Resume at HH:MM |
| Tool error | Return a clear message with the next action. Count toward the error limit |
| Loop detected | Recovery message, then pause with options |

## 12. Verifier checks and quality rubric

### Verifier checks (code)

- Every local script, link, image and source file exists.
- 0 console errors and 0 uncaught exceptions.
- No horizontal scrolling at any of the 3 sizes.
- Visible text over 600 characters. Each section has a heading and at least 20 words.
- After scrolling in steps, no section stays invisible (opacity 0, hidden, zero size). More than 30% hidden elements is a fail.
- Text contrast at least 4.5 (3.0 for large text), measured against the real background.
- Tap targets at least 44 by 44 px on mobile. Body text at least 16 px.
- Exactly one h1. Headings do not skip levels. Images have alt text.
- Page weight under 3 MB. Layout shift under 0.1. Scroll frame time p95 under 32 ms (warning).
- Buttons and links are keyboard focusable with a visible focus style.
- Placeholder words: lorem, ipsum, TODO, Your Company, example.com, Click here.

### Rubric (critic, 1 to 10 each)

Visual hierarchy, spacing and rhythm, color and contrast, typography, icons and imagery, motion quality, content quality (specific, no filler), responsiveness, consistency, overall polish.

**Pass mark:** verifier has no errors and overall score is 8.0 or more (6.0 or more when only library fallback was possible).

## 13. Success metrics

| Metric | Target |
| --- | --- |
| Runs that end in done or a safe pause | 100% |
| Requests sent to a lane over its size or quota limit | 0 |
| Average requests for a website in Balanced mode | 40 or fewer |
| Websites with verifier pass and rubric 8 or more | 80% or more with free keys |
| Dumb-model test (all models return garbage): page still passes verifier | 100% |
| Time from install to first working site | Under 10 minutes |
| Crashes per 100 hours | Under 1 |

## 14. Test strategy and acceptance tests

**Unit tests (fake lanes and fake clock):**

1. Limiter never exceeds a lane's per-minute limit.
2. Daily-limit 429 removes the lane until reset. It is not called again.
3. A 12,000-token request is never sent to Groq. No log spam.
4. A 413 is retried once with a smaller prompt, then skipped for that request.
5. Work stealing moves tasks without loss or duplication.
6. bestOfN: the judge is never the candidate's lane. vote: majority wins.
7. JSON repair handles fences, extra text and trailing commas.
8. Loop detection: reading a changed file is not a loop. A model that repeats a failing call gets one recovery message.
9. History compaction keeps a long run under 5,500 tokens.
10. Resume after a kill continues without repeating finished work.

**Pipeline tests:**

11. Dumb model test: all lanes return garbage, and the site still passes the verifier.
12. One-lane test: two lanes are dead and the build still finishes.
13. Verifier catches: missing script, content stuck at opacity 0, overflow at 390 px, low contrast, two h1 tags.
14. Ratchet reverts a fix that lowers the score.
15. Every template renders with every palette without verifier errors.

**Acceptance tests (with real free keys):**

1. Ask: make a website for a dentist. Get a multi-section animated site that passes the verifier.
2. Ask: rename the title, delete a file, add a pricing section. The files change and the delete is in trash.
3. Ask for a 5 second logo animation. Get a playing MP4.
4. Ask for the photosynthesis Three.js explainer. All scenes show and the science check passes.
5. Use up the Gemini quota in the middle of a run. The run pauses with a reset time and resumes by itself.
6. Close the app during a run. On restart, Resume continues from the last step.

## 15. Milestones

| Milestone | Scope | Done when |
| --- | --- | --- |
| M1 Foundation | Workspace, editor, preview, keys, real providers, router with error rules | Chat creates, edits and deletes files |
| M2 Quota safety | Ledger, size-aware routing, daily reset handling, pause and resume | No 413 loops. No retry spam. Quota panel works |
| M3 Reliable agent | Tools, approvals, progress ledger, loop recovery, history compaction | Long runs finish or pause safely |
| M4 Quality core | Stage runner, web-core library, website pipeline, verifier | Dumb-model test passes |
| M5 Critic and polish | Critic, ratchet, motion recipes, UI for scores and screenshots | Score of 8 or more on sample briefs |
| M6 Parallel orchestra | Scheduler, patterns, calibration, lanes panel | Faster builds with no extra quota use |
| M7 Media | Video export, animation and 3D explainer pipelines, topo and scroll packs | All acceptance tests pass |
| M8 Ship | Installers, auto-update (optional), docs, training hooks | Installs and runs on 3 operating systems |

## 16. Risks and fixes

| Risk | Fix |
| --- | --- |
| Free limits change without notice | Editable limits table. Learn real limits from errors and headers |
| Free models are weak or rotate out | Library does the design work. Calibration ranks lanes. Fallback lists |
| All daily quotas used at once | Job planner, budget modes, pause and resume at reset time, split jobs across days |
| Model writes broken or unsafe code | Validate before write. Assemble from library. Verifier and ratchet |
| Loops waste requests | Smarter detection, recovery message, pause with options |
| The library is basic | Write it by hand with a senior designer's care. Review every template with preview screenshots |
| Prompt injection from files | Treat file text as data. Approval for commands. Workspace-only paths |
| Chrome or FFmpeg missing in the installer | asarUnpack. Electron fallback. Test the packaged app on all 3 systems |
| Free-tier data use (prompts may be used by providers) | Clear notice in Settings. User can turn providers off |

## 17. Open questions

1. Which operating system should be the first test target?
2. Should the default mode be Balanced or Fast?
3. Should auto-resume at quota reset be on by default?
4. Should Ollama (local models) become a fourth provider? It would add free quota with no limits, but needs a strong computer.
5. Who writes and reviews the first library packs?

## 18. Glossary

- **Lane:** one provider plus one model.
- **Quota ledger:** the saved count of requests and tokens used.
- **RPM, RPD, TPM:** requests per minute, requests per day, tokens per minute.
- **Pipeline:** a fixed list of small stages with checks in between.
- **Skill pack:** a folder of hand-made templates, tokens and recipes.
- **Ratchet:** keep a change only if the score improves.
- **Best-of-N:** several models try the same task and a judge picks the best.
- **Hedge:** send the same request to two lanes and use the first valid answer.
- **Verifier:** code that tests a page without using AI.
- **Fallback:** a safe default from the library when a model fails.
