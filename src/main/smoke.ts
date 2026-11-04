import fs from "fs";
import type { BrowserWindow } from "electron";
import type { AIService } from "./ai/service";
import { traceLines } from "./trace";

// PART 1 / PART 5 test harness. When MYIDE_SMOKE=1 the app boots with a
// deterministic in-process provider (never the network), drives the real chat
// UI in a hidden window, prints a hop-by-hop trace and writes the result to
// .myide/verify/. This is how the chat path is proved end to end.

export type SmokeScenario = "ok" | "error" | "nokeys";

export function smokeEnabled(): boolean {
  return process.env.MYIDE_SMOKE === "1" || !!process.env.NOVA_UI_TOUR_OUT;
}

export function uiTourOutDir(): string | null {
  const v = process.env.NOVA_UI_TOUR_OUT?.trim();
  return v ? v : null;
}

export function smokeScenario(): SmokeScenario {
  const s = process.env.MYIDE_SMOKE_SCENARIO;
  return s === "error" || s === "nokeys" ? s : "ok";
}

export function smokeKind(): "website" | "agent" {
  return process.env.MYIDE_SMOKE_KIND === "agent" ? "agent" : "website";
}

export function makeSmokeAI(scenario: SmokeScenario): AIService {
  const fake = {
    onWaiting: undefined as unknown,
    // PART 1 point 4: a provider failure must surface as a visible error bubble.
    lastFailure:
      scenario === "error"
        ? { kind: "unauthorized", message: "401 unauthorized (smoke provider)" }
        : null,
    init: () => undefined,
    reload: () => undefined,
    save: () => undefined,
    isOfflineMode: () => scenario === "nokeys",
    providerLabels: () => ({ offline: "Offline library", gemini: "Google Gemini" }),
    quotaSnapshot: () => [],
    async complete() {
      await new Promise((r) => setTimeout(r, 25));
      if (scenario === "error") {
        return { ok: false, error: { kind: "unauthorized", message: "401 unauthorized (smoke provider)" } };
      }
      if (scenario === "nokeys") {
        return { ok: false, error: { kind: "unauthorized", message: "no key configured" }, pause: true };
      }
      return {
        ok: true,
        content: JSON.stringify({ thought: "Smoke reply", answer: "Hello from the smoke provider." }),
        laneUsed: { id: "offline:smoke", provider: "offline", model: "smoke" },
        promptTokens: 5,
        completionTokens: 5,
      };
    },
  };
  return fake as unknown as AIService;
}

export async function runSmoke(win: BrowserWindow, scenario: SmokeScenario, verifyDir: string): Promise<void> {
  const wc = win.webContents;
  const kind = smokeKind();
  const lines: string[] = [];
  const live = `${verifyDir}/chat-${kind}-${scenario}.live.txt`;
  try {
    fs.mkdirSync(verifyDir, { recursive: true });
    fs.writeFileSync(live, "", "utf8");
  } catch {
    /* best effort */
  }
  const say = (s: string) => {
    lines.push(s);
    console.log(`[smoke] ${s}`);
    try {
      fs.appendFileSync(live, `${s}\n`, "utf8");
    } catch {
      /* best effort */
    }
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Poll a boolean expression in the page until it is true or we run out of time.
  const poll = async (expr: string, ms: number, step = 150): Promise<boolean> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await wc.executeJavaScript(expr).catch(() => false);
      if (v) return true;
      if (Date.now() > deadline) return false;
      await sleep(step);
    }
  };
  // The real user path: type the text, then press the ONE primary button.
  const send = async (label: string, text: string): Promise<string> => {
    const result = await wc.executeJavaScript(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return 'NO TEXTAREA';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const btns = [...document.querySelectorAll('button')];
      const b = document.querySelector('[data-chat-send]')
        || btns.find((x) => ['send', 'start'].includes(x.textContent.trim().toLowerCase()))
        || btns.find((x) => /^(send|start)/i.test(x.textContent.trim()));
      if (!b) return 'NO START BUTTON :: ' + btns.map((x) => x.textContent.trim()).join(' | ');
      b.click();
      return 'clicked: ' + b.textContent.trim();
    })()`);
    say(`${label} result: ${result}`);
    return String(result);
  };
  const stats = () =>
    wc.executeJavaScript(`(() => {
      const log = document.querySelector('[data-chat-log]');
      const bubbles = log ? log.querySelectorAll('[data-msg]') : [];
      const roles = [];
      bubbles.forEach((b) => roles.push(b.getAttribute('data-msg')));
      return { count: bubbles.length, roles,
               buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()),
               hasError: !!document.querySelector('[data-msg="error"]'),
               hasThinking: !!document.querySelector('[data-thinking]') };
    })()`);

  // Any of these means the app answered instead of staying silent.
  const ANSWERED = '[data-msg="assistant"],[data-msg="error"],[data-msg="notice"]';

  try {
    wc.on("console-message", (...args: any[]) => {
      const message = typeof args[2] === "string" ? args[2] : String(args[1] ?? "");
      if (/\[chat /.test(message) || /\[smoke/.test(message) || /\[renderer/.test(message)) {
        say(`RENDERER-CONSOLE ${message}`);
      }
    });
    wc.on("did-finish-load", () => say("lifecycle: did-finish-load"));
    wc.on("did-fail-load", (_e, code, desc, url) => say(`lifecycle: did-fail-load code=${code} ${desc} ${url}`));
    wc.on("dom-ready", () => say("lifecycle: dom-ready"));
    wc.on("render-process-gone", (_e, d) => say(`lifecycle: render-process-gone ${JSON.stringify(d)}`));
    wc.on("preload-error", (_e, p, err) => say(`lifecycle: preload-error ${p} ${err && err.message}`));
    win.on("unresponsive", () => say("lifecycle: unresponsive"));

    say(`boot: scenario=${scenario} window=${win.id} url=${wc.getURL()} loading=${wc.isLoading()}`);

    // Wait for the document to be ready, but never hang forever.
    const ready = await Promise.race([
      new Promise<boolean>((r) => {
        if (!wc.isLoading()) return r(true);
        wc.once("did-finish-load", () => r(true));
        wc.once("did-fail-load", () => r(false));
      }),
      sleep(10000).then(() => "timeout" as const),
    ]);
    say(`load wait: ${ready} loading=${wc.isLoading()} url=${wc.getURL()}`);

    for (let i = 1; i <= 3; i++) {
      const probe = await wc
        .executeJavaScript(`(() => {
          const api = !!(window.electron && window.electron.jobs && window.electron.jobs.onEvent);
          return { title: document.title, bodyLen: (document.body && document.body.innerText || '').length,
                   hasElectron: api, textareas: document.querySelectorAll('textarea').length,
                   buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()) };
        })()`)
        .catch((e) => ({ error: String((e as Error).message) }));
      say(`probe ${i}: ${JSON.stringify(probe)}`);
      if ((probe as any).hasElectron) break;
      await sleep(1000);
    }
    await sleep(1000); // let React mount and subscribe to the event stream

    // Start each scenario from a clean chat ("New chat"), so a previous run's
    // saved history cannot be mistaken for this run's messages.
    const reset = await wc.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /new chat/i.test(x.textContent));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    say(`reset: New chat clicked -> ${reset}`);
    await sleep(400);

    // PART 1 test 6: send "hello" and expect a reply bubble within 2 seconds.
    // "hello" is unclear, so the right answer is one short question — the point
    // is that the app NEVER stays silent.
    say("step 1: type 'hello' and press Start (the real user path)");
    await send("step 1", "hello");

    const within2s = await poll(`!!document.querySelector('${ANSWERED}')`, 2000);
    say(`step 2: bubble within 2s -> ${within2s}`);
    if (!within2s) {
      const later = await poll(`!!document.querySelector('${ANSWERED}')`, 8000);
      say(`step 2b: bubble within 10s -> ${later}`);
    }
    say("chat text after message 1:\n" + (await chatText(wc)));
    const first = await stats();
    say("bubbles after message 1: " + JSON.stringify(first));

    // Step 3 exercises the real model reply path with a clearly-routed sentence.
    say("step 3: type 'explain this code' and press Start (clear intent -> chat only)");
    await send("step 3", "explain this code");
    await poll(`!!document.querySelector('[data-msg="assistant"]')`, 6000);
    await sleep(1200);
    const second = await stats();
    say("bubbles after message 2: " + JSON.stringify(second));

    // PART 1 test 6: two messages in a row must BOTH stay visible.
    const users = (second as any).roles.filter((r: string) => r === "user").length;
    say(`two-messages-visible: ${users >= 2} (user bubbles=${users})`);
    say("chat text after message 2:\n" + (await chatText(wc)));

    // PART 1 point 4: no keys must offer "Add an API key".
    if (scenario === "nokeys") {
      const hasSettings = (second as any).buttons.some((b: string) => /api key/i.test(b));
      say(`nokeys: "Add an API key" button present -> ${hasSettings}`);
    }
    if (scenario === "error") {
      say(`error: error bubble present -> ${(second as any).hasError}`);
    }

    // PART 1 DIAGNOSE: dump the whole numbered spine (main + renderer hops) so
    // a missing hop is obvious in the transcript.
    await sleep(300);
    for (const line of traceLines().filter((l) => l.startsWith("[chat ")).slice(-40)) {
      say(`TRACE ${line}`);
    }

    try {
      const png = await wc.capturePage();
      fs.writeFileSync(`${verifyDir}/chat-${kind}-${scenario}.png`, png.toPNG());
      say(`screenshot written: ${verifyDir}/chat-${kind}-${scenario}.png`);
    } catch (e) {
      say(`screenshot failed: ${(e as Error).message}`);
    }
  } catch (e) {
    say(`SMOKE ERROR: ${(e as Error).stack ?? String(e)}`);
  }

  try {
    fs.writeFileSync(`${verifyDir}/chat-${kind}-${scenario}.log`, lines.join("\n"), "utf8");
  } catch {
    /* best effort */
  }
  say("DONE");
}

async function chatText(wc: BrowserWindow["webContents"]): Promise<string> {
  return wc.executeJavaScript(`(() => {
    const el = document.querySelector('[data-chat-log]') || document.body;
    return el.innerText.split('\\n').slice(0, 30).join('\\n');
  })()`);
}

export async function runUiTour(win: BrowserWindow, outDir: string): Promise<void> {
  const wc = win.webContents;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  fs.mkdirSync(outDir, { recursive: true });

  await Promise.race([
    new Promise<boolean>((r) => {
      if (!wc.isLoading()) return r(true);
      wc.once("did-finish-load", () => r(true));
      wc.once("did-fail-load", () => r(false));
    }),
    sleep(10000),
  ]);
  await sleep(1600);

  const snap = async (fileName: string) => {
    await sleep(500);
    const png = await wc.capturePage();
    fs.writeFileSync(`${outDir}/${fileName}`, png.toPNG());
    console.log(`[ui-tour] wrote ${outDir}/${fileName}`);
  };

  // 1. Ensure Dark theme via settings, open index.html in Monaco & open Bottom Panel
  await wc.executeJavaScript(`(async () => {
    const s = await window.electron.settings.get();
    if (s.theme !== 'dark') {
      const btn = document.querySelector('button[aria-label*="dark theme"]');
      if (btn) btn.click();
    }
    for (let i = 0; i < 15; i++) {
      const treeBtns = [...document.querySelectorAll('[role="treeitem"] button[title]')];
      const fileBtn = treeBtns.find((el) => /index\\.html/i.test(el.textContent || ''))
        || treeBtns.find((el) => /\\.(ts|tsx|js|json|css|md)$/i.test((el.textContent || '').trim()));
      if (fileBtn) { fileBtn.click(); break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    const termBtn = [...document.querySelectorAll('footer button')].find((b) => /terminal/i.test(b.textContent || ''));
    if (termBtn && !document.querySelector('[data-bottom-panel]')) termBtn.click();
  })()`);
  await sleep(2400);
  await snap("m1-editor-dark.png");

  // 2. Command Palette open over Editor View
  await wc.executeJavaScript(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true }));
  })()`);
  await sleep(600);
  await snap("m1-command-palette.png");

  // 3. Close Command Palette, switch to Agent Manager (Mission Control)
  await wc.executeJavaScript(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const mgrTab = document.querySelector('[data-mode-tab="manager"]');
    if (mgrTab) mgrTab.click();
  })()`);
  await sleep(900);
  await snap("m1-mission-control.png");

  // 4. Switch back to Editor + Light Theme + Settings modal preview
  await wc.executeJavaScript(`(() => {
    const edTab = document.querySelector('[data-mode-tab="editor"]');
    if (edTab) edTab.click();
    const curTheme = document.documentElement.getAttribute('data-theme');
    if (curTheme !== 'light') {
      const themeBtn = document.querySelector('button[aria-label*="Switch to"]');
      if (themeBtn) themeBtn.click();
    }
  })()`);
  await sleep(1200);
  await snap("m1-editor-light.png");

  // Restore dark theme and close bottom panel so user state stays clean
  await wc.executeJavaScript(`(() => {
    if (document.documentElement.getAttribute('data-theme') !== 'dark') {
      const darkBtn = document.querySelector('button[aria-label*="Switch to"]');
      if (darkBtn) darkBtn.click();
    }
    const closeBottom = document.querySelector('[data-bottom-panel] button[aria-label="Hide bottom panel"]');
    if (closeBottom) closeBottom.click();
  })()`);
  await sleep(300);
}
