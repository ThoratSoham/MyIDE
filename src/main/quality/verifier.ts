import fs from "fs";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import log from "electron-log";
import type { Browser, Page } from "puppeteer-core";
import { getSettings } from "../store";

// FR-9: the verifier is code only, no AI. It loads the built page in a real
// browser at three viewports and reports every issue with a stable id,
// severity, selector and fix hint (FR-9.2), saving screenshots to
// .myide/verify (FR-9.3).

export interface VerifyIssue {
  id: string;
  severity: "error" | "warning";
  viewport: string;
  selector?: string;
  message: string;
  fixHint: string;
}

export interface VerifyReport {
  ok: boolean;
  verified: boolean; // false when no browser was available
  issues: VerifyIssue[];
  screenshots: { viewport: string; file: string }[];
  textLength: number;
  pageWeightBytes: number;
  note?: string;
}

export const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
];

const PLACEHOLDER_WORDS = ["lorem", "ipsum", "todo", "your company", "example.com", "click here"];

export function findBrowserPath(): string | null {
  const configured = getSettings().chromePath;
  if (configured && fs.existsSync(configured)) return configured;

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          path.join(os.homedir(), "AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        ]
      : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/microsoft-edge",
        ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

interface RawPageReport {
  consoleErrors: string[];
  pageErrors: string[];
  scrollWidth: number;
  innerWidth: number;
  textLength: number;
  sectionsWithoutHeading: string[];
  sectionsThin: string[];
  hiddenRatio: number;
  hiddenSamples: { selector: string; reason: string }[];
  contrastViolations: { selector: string; ratio: number; text: string }[];
  smallTapTargets: { selector: string; w: number; h: number }[];
  bodyFontSize: number;
  h1Count: number;
  headingSkips: string[];
  imagesWithoutAlt: string[];
  placeholderHits: string[];
  totalBytes: number;
  cls: number;
  focusableCount: number;
  scrollP95: number;
  localRefs: { ref: string; tag: string }[];
}

export interface VerifyOptions {
  pagePath: string; // absolute path to the built index.html
  workspaceRoot: string;
  outDir: string; // .myide/verify
  onProgress?: (msg: string) => void;
}

export async function verifyWebsite(opts: VerifyOptions): Promise<VerifyReport> {
  const issues: VerifyIssue[] = [];
  const screenshots: { viewport: string; file: string }[] = [];
  const exe = findBrowserPath();

  if (!exe) {
    return {
      ok: false,
      verified: false,
      issues: [],
      screenshots: [],
      textLength: 0,
      pageWeightBytes: 0,
      note: "No Chrome, Edge or Brave was found. Set the browser path in Settings to enable verification (FR-9).",
    };
  }

  const puppeteer = (await import("puppeteer-core")).default;
  let browser: Browser | null = null;
  let textLength = 0;
  let pageWeightBytes = 0;

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: exe,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"],
    });

    fs.mkdirSync(opts.outDir, { recursive: true });
    const page = await browser.newPage();
    await page.setCacheEnabled(false);

    for (const vp of VIEWPORTS) {
      opts.onProgress?.(`verifying at ${vp.width}x${vp.height}`);
      const raw = await inspectViewport(page, vp, opts.pagePath);
      textLength = Math.max(textLength, raw.textLength);
      pageWeightBytes = Math.max(pageWeightBytes, raw.totalBytes);
      collectIssues(vp, raw, issues, path.dirname(opts.pagePath));

      const file = path.join(opts.outDir, `${vp.name}.png`);
      try {
        await page.screenshot({ path: file as any, fullPage: false });
        screenshots.push({ viewport: vp.name, file });
      } catch (e) {
        log.warn(`verify: screenshot failed at ${vp.name}`, e);
      }
    }
  } catch (e) {
    log.error("verify: browser run failed", e);
    return {
      ok: false,
      verified: false,
      issues,
      screenshots,
      textLength,
      pageWeightBytes,
      note: `Verification could not run: ${(e as Error).message}`,
    };
  } finally {
    await browser?.close().catch(() => {});
  }

  const errors = issues.filter((i) => i.severity === "error");
  return {
    ok: errors.length === 0,
    verified: true,
    issues,
    screenshots,
    textLength,
    pageWeightBytes,
  };
}

async function inspectViewport(
  page: Page,
  vp: { name: string; width: number; height: number },
  pagePath: string,
): Promise<RawPageReport> {
  await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const onConsole = (msg: any) => {
    if (msg.type() === "error") consoleErrors.push(String(msg.text()).slice(0, 200));
  };
  const onPageError = (err: Error) => pageErrors.push(String(err.message).slice(0, 200));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  // Record layout shift from the very start of the page life.
  await page.evaluateOnNewDocument(() => {
    (window as any).__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as any[]) {
          if (!entry.hadRecentInput) (window as any).__cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      /* not supported */
    }
  });

  const url = pathToFileURL(pagePath).href;
  await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 400));

  const raw = (await page.evaluate(
    (placeholderWords: string[]) => {
      const report: any = {
        consoleErrors: [],
        pageErrors: [],
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        textLength: 0,
        sectionsWithoutHeading: [],
        sectionsThin: [],
        hiddenRatio: 0,
        hiddenSamples: [],
        contrastViolations: [],
        smallTapTargets: [],
        bodyFontSize: 0,
        h1Count: 0,
        headingSkips: [],
        imagesWithoutAlt: [],
        placeholderHits: [],
        totalBytes: 0,
        cls: (window as any).__cls ?? 0,
        focusableCount: 0,
        scrollP95: 0,
        localRefs: [],
      };

      const sel = (el: Element): string => {
        if (!el) return "";
        const tag = el.tagName.toLowerCase();
        const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
        const cls = (el as HTMLElement).className && typeof (el as HTMLElement).className === "string"
          ? "." + (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
        return `${tag}${id}${cls}`;
      };

      const visible = (el: Element): boolean => {
        const s = getComputedStyle(el as HTMLElement);
        if (s.display === "none" || s.visibility === "hidden") return false;
        if (parseFloat(s.opacity || "1") < 0.05) return false;
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      // Text length
      report.textLength = (document.body.innerText || "").replace(/\s+/g, " ").trim().length;

      // Sections: heading + word count. Only content <section> elements are
      // judged — the nav <header> and site <footer> are chrome, not sections.
      const sections = Array.from(document.querySelectorAll("section"));
      for (const sec of sections) {
        const text = (sec as HTMLElement).innerText || "";
        const words = text.trim().split(/\s+/).filter(Boolean).length;
        if (!sec.querySelector("h1, h2, h3, h4, h5, h6") && words > 0) {
          report.sectionsWithoutHeading.push(sel(sec));
        }
        if (words > 0 && words < 20) report.sectionsThin.push(`${sel(sec)} (${words} words)`);
      }

      // Hidden elements
      const all = Array.from(document.querySelectorAll("body *"));
      const hidden = all.filter((el) => !visible(el));
      report.hiddenRatio = all.length ? hidden.length / all.length : 0;
      report.hiddenSamples = hidden.slice(0, 8).map((el) => {
        const s = getComputedStyle(el as HTMLElement);
        const r = (el as HTMLElement).getBoundingClientRect();
        const reason =
          s.display === "none" ? "display:none"
          : s.visibility === "hidden" ? "visibility:hidden"
          : parseFloat(s.opacity || "1") < 0.05 ? "opacity:0"
          : "zero size";
        return { selector: sel(el), reason };
      });

      // Contrast
      const lum = (c: number[]) => {
        const a = c.slice(0, 3).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
      };
      const parseColor = (s: string): number[] | null => {
        const m = /rgba?\(([^)]+)\)/.exec(s);
        if (!m) return null;
        return m[1].split(",").map((x) => parseFloat(x.trim()));
      };
      const bgOf = (el: Element): number[] | null => {
        let cur: Element | null = el;
        while (cur) {
          const c = parseColor(getComputedStyle(cur as HTMLElement).backgroundColor);
          if (c && (c.length < 4 || c[3] > 0.5)) return c;
          cur = cur.parentElement;
        }
        const b = parseColor(getComputedStyle(document.body).backgroundColor);
        return b ?? [255, 255, 255, 1];
      };
      const contrast = (a: number[], b: number[]) => {
        const l1 = lum(a);
        const l2 = lum(b);
        const hi = Math.max(l1, l2);
        const lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
      };
      const textEls = Array.from(document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, a, li, span, button, label, td, th, figcaption")).slice(0, 400);
      for (const el of textEls) {
        const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || "").trim().length > 1);
        if (!own) continue;
        const s = getComputedStyle(el as HTMLElement);
        const fg = parseColor(s.color);
        const bg = bgOf(el);
        if (!fg || !bg) continue;
        const ratio = contrast(fg, bg);
        const size = parseFloat(s.fontSize || "16");
        const bold = parseInt(s.fontWeight || "400", 10) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const need = large ? 3.0 : 4.5;
        if (ratio < need) {
          report.contrastViolations.push({ selector: sel(el), ratio: Math.round(ratio * 100) / 100, text: (el.textContent || "").trim().slice(0, 40) });
        }
      }

      // Tap targets + body font size
      report.bodyFontSize = parseFloat(getComputedStyle(document.body).fontSize || "16");
      const interactive = Array.from(document.querySelectorAll("a, button, input, select, textarea, [role=button]"));
      report.focusableCount = interactive.length;
      for (const el of interactive) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.width < 44 || r.height < 44) {
          report.smallTapTargets.push({ selector: sel(el), w: Math.round(r.width), h: Math.round(r.height) });
        }
      }

      // Headings
      report.h1Count = document.querySelectorAll("h1").length;
      const levels = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => parseInt(h.tagName[1], 10));
      let prev = 0;
      for (const l of levels) {
        if (prev && l > prev + 1) report.headingSkips.push(`h${prev} -> h${l}`);
        prev = l;
      }

      // Images
      for (const img of Array.from(document.querySelectorAll("img"))) {
        if (!img.getAttribute("alt")) report.imagesWithoutAlt.push(sel(img));
      }

      // Placeholder words
      const bodyText = (document.body.innerText || "").toLowerCase();
      for (const w of placeholderWords) if (bodyText.includes(w)) report.placeholderHits.push(w);

      // Local file references (checked by the caller against the filesystem)
      for (const el of Array.from(document.querySelectorAll("script[src], link[href], img[src], source[src], video[src], audio[src], iframe[src]"))) {
        const ref = el.getAttribute("src") || el.getAttribute("href") || "";
        if (ref && !/^(https?:|data:|blob:|#|mailto:|tel:)/i.test(ref)) {
          report.localRefs.push({ ref, tag: el.tagName.toLowerCase() });
        }
      }

      return report;
    },
    PLACEHOLDER_WORDS,
  )) as RawPageReport;

  // Scroll in steps and re-check for stuck-invisible content + frame timing.
  const afterScroll = (await page.evaluate(async () => {
    const frames: number[] = [];
    let last = performance.now();
    const step = Math.max(200, window.innerHeight * 0.8);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise<void>((r) =>
        requestAnimationFrame(() => {
          const now = performance.now();
          frames.push(now - last);
          last = now;
          r();
        }),
      );
    }
    window.scrollTo(0, 0);

    const visible = (el: Element): boolean => {
      const s = getComputedStyle(el as HTMLElement);
      if (s.display === "none" || s.visibility === "hidden") return false;
      if (parseFloat(s.opacity || "1") < 0.05) return false;
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const all = Array.from(document.querySelectorAll("body *"));
    const hidden = all.filter((el) => !visible(el));
    const sorted = frames.slice().sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    return { hiddenRatio: all.length ? hidden.length / all.length : 0, scrollP95: p95 };
  })) as { hiddenRatio: number; scrollP95: number };

  raw.hiddenRatio = Math.max(raw.hiddenRatio, afterScroll.hiddenRatio);
  raw.scrollP95 = afterScroll.scrollP95;

  // Measure resource weight.
  const bytes = await page.evaluate(() => {
    let total = document.documentElement.outerHTML.length;
    for (const el of Array.from(document.querySelectorAll("script[src], link[href], style"))) {
      const src = (el as HTMLElement).getAttribute("src") || (el as HTMLElement).getAttribute("href");
      if (src) total += src.length;
      else total += (el.textContent || "").length;
    }
    return total;
  });
  raw.totalBytes = bytes;

  raw.consoleErrors = consoleErrors;
  raw.pageErrors = pageErrors;

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  await page.goto("about:blank").catch(() => {});

  return raw;
}

function collectIssues(
  vp: { name: string; width: number; height: number },
  raw: RawPageReport,
  issues: VerifyIssue[],
  baseDir: string,
): void {
  const v = vp.name;
  const push = (i: Omit<VerifyIssue, "viewport">) => issues.push({ ...i, viewport: v });

  for (const e of raw.consoleErrors)
    push({ id: "console-error", severity: "error", message: `console error: ${e}`, fixHint: "Fix the script that logs this error." });
  for (const e of raw.pageErrors)
    push({ id: "uncaught-exception", severity: "error", message: `uncaught exception: ${e}`, fixHint: "Guard the failing code path." });

  // FR-9 / section 12: every local script, link, image and source must exist.
  for (const ref of raw.localRefs) {
    const clean = ref.ref.split("?")[0].split("#")[0];
    const abs = path.resolve(baseDir, clean);
    if (!fs.existsSync(abs)) {
      push({
        id: "missing-local-file",
        severity: "error",
        selector: ref.tag,
        message: `missing local file referenced by <${ref.tag}>: ${ref.ref}`,
        fixHint: "Remove the reference or add the file.",
      });
    }
  }

  if (raw.scrollWidth > raw.innerWidth + 1)
    push({
      id: "horizontal-scroll",
      severity: "error",
      message: `horizontal scrolling: content is ${raw.scrollWidth}px wide in a ${raw.innerWidth}px viewport`,
      fixHint: "Constrain widths (max-width: 100%) and avoid fixed px widths.",
    });

  if (raw.textLength < 600)
    push({
      id: "thin-content",
      severity: "error",
      message: `only ${raw.textLength} characters of visible text (need more than 600)`,
      fixHint: "Add real copy to each section.",
    });

  for (const s of raw.sectionsWithoutHeading.slice(0, 5))
    push({ id: "section-no-heading", severity: "error", selector: s, message: "section has no heading", fixHint: "Give the section an h2." });
  for (const s of raw.sectionsThin.slice(0, 5))
    push({ id: "section-too-thin", severity: "warning", selector: s, message: `section has fewer than 20 words`, fixHint: "Write at least 20 words for this section." });

  if (raw.hiddenRatio > 0.3)
    push({
      id: "content-hidden",
      severity: "error",
      message: `${Math.round(raw.hiddenRatio * 100)}% of elements stay invisible after scrolling`,
      fixHint: "Content must be visible without JS; check the reveal classes.",
    });
  else
    for (const h of raw.hiddenSamples)
      push({ id: "element-hidden", severity: "warning", selector: h.selector, message: `element is not visible (${h.reason})`, fixHint: "Confirm this element is meant to be hidden." });

  const contrastSeen = new Set<string>();
  for (const c of raw.contrastViolations) {
    if (contrastSeen.has(c.selector)) continue;
    contrastSeen.add(c.selector);
    push({
      id: "low-contrast",
      severity: "error",
      selector: c.selector,
      message: `contrast ${c.ratio}:1 is below 4.5 (text "${c.text}")`,
      fixHint: "Swap to a palette with stronger contrast or darken the text colour.",
    });
  }

  if (v === "mobile") {
    for (const t of raw.smallTapTargets.slice(0, 10))
      push({ id: "small-tap-target", severity: "error", selector: t.selector, message: `tap target is ${t.w}x${t.h}px (need at least 44x44)`, fixHint: "Increase the element's min-height and padding." });
    if (raw.bodyFontSize < 16)
      push({ id: "small-body-text", severity: "error", message: `body text is ${raw.bodyFontSize}px (need at least 16px)`, fixHint: "Raise the body font size." });
  }

  if (raw.h1Count !== 1)
    push({ id: "h1-count", severity: "error", message: `page has ${raw.h1Count} h1 elements (need exactly 1)`, fixHint: "Keep one h1 in the hero; use h2 for the rest." });
  for (const s of raw.headingSkips.slice(0, 5))
    push({ id: "heading-skip", severity: "error", message: `heading level jumps (${s})`, fixHint: "Do not skip heading levels." });
  for (const i of raw.imagesWithoutAlt.slice(0, 5))
    push({ id: "image-no-alt", severity: "error", selector: i, message: "image has no alt text", fixHint: "Add an alt attribute." });

  for (const p of raw.placeholderHits)
    push({ id: "placeholder-text", severity: "error", message: `placeholder word found: "${p}"`, fixHint: "Replace placeholder copy with real content." });

  if (raw.totalBytes > 3 * 1024 * 1024)
    push({ id: "page-too-heavy", severity: "error", message: `page weight ${Math.round(raw.totalBytes / 1024)}KB is over 3MB`, fixHint: "Remove large assets." });

  if (raw.cls > 0.1)
    push({ id: "layout-shift", severity: "warning", message: `layout shift ${Math.round(raw.cls * 1000) / 1000} is above 0.1`, fixHint: "Reserve space for media blocks." });

  if (raw.scrollP95 > 32)
    push({ id: "slow-scroll", severity: "warning", message: `scroll frame time p95 is ${Math.round(raw.scrollP95)}ms (over 32ms)`, fixHint: "Reduce expensive scroll effects." });
}
