import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import log from "electron-log";
import { BrowserWindow } from "electron";
import { getSettings } from "../store";
import { verifyWebsite, type VerifyOptions, type VerifyReport, type VerifyIssue } from "./verifier";

export interface HeadlessVerifyOptions extends VerifyOptions {
  timeoutMs?: number;
}

/**
 * PHASE 8: Headless Browser Verify for Website Builds.
 * Behind getSettings().headlessBrowserVerify === true, loads the built index.html
 * in a strictly sandboxed, hidden Electron BrowserWindow (offscreen / show: false),
 * captures console errors, page exceptions, failed local resource requests, and a PNG screenshot,
 * feeding only real errors back to the model repair loop.
 *
 * If headlessBrowserVerify is false or running in an environment without Electron BrowserWindow
 * (e.g. headless unit tests), cleanly delegates to static verifyWebsite.
 */
export async function runHeadlessBrowserVerify(opts: HeadlessVerifyOptions): Promise<VerifyReport> {
  const settings = getSettings();
  if (settings.headlessBrowserVerify !== true) {
    return verifyWebsite(opts);
  }

  // Check if Electron BrowserWindow is available at runtime
  if (typeof BrowserWindow === "undefined") {
    return verifyWebsite(opts);
  }

  const issues: VerifyIssue[] = [];
  const screenshots: { viewport: string; file: string }[] = [];
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const baseDir = path.dirname(opts.pagePath);

  fs.mkdirSync(opts.outDir, { recursive: true });

  const viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ];

  let maxTextLength = 0;
  let maxWeightBytes = 0;

  for (const vp of viewports) {
    opts.onProgress?.(`headless browser verify at ${vp.width}x${vp.height}`);
    let win: BrowserWindow | null = null;

    try {
      win = new BrowserWindow({
        width: vp.width,
        height: vp.height,
        show: false,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });

      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];

      win.webContents.on("console-message", (_event, level, message) => {
        if (level >= 3) {
          // 3 = error level
          consoleErrors.push(message.slice(0, 200));
        }
      });

      win.webContents.session.webRequest.onErrorOccurred((details) => {
        if (details.url && !details.url.startsWith("devtools:")) {
          failedRequests.push(`${details.url} (${details.error})`);
        }
      });

      const fileUrl = pathToFileURL(opts.pagePath).href;

      await Promise.race([
        win.loadURL(fileUrl),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout loading page after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      // Brief settling pause
      await new Promise((r) => setTimeout(r, 400));

      for (const err of consoleErrors) {
        issues.push({
          id: "headless-console-error",
          severity: "error",
          viewport: vp.name,
          message: `Browser console error: ${err}`,
          fixHint: "Fix JavaScript syntax or runtime error.",
        });
      }

      for (const req of failedRequests) {
        issues.push({
          id: "headless-failed-request",
          severity: "error",
          viewport: vp.name,
          message: `Failed to load resource: ${req}`,
          fixHint: "Ensure local paths exist and have correct relative paths.",
        });
      }

      // Check for broken local script/link/img tags
      const missingRefs = await win.webContents.executeJavaScript(`
        (() => {
          const refs = [];
          for (const el of document.querySelectorAll('script[src], link[href], img[src]')) {
            const r = el.getAttribute('src') || el.getAttribute('href') || '';
            if (r && !/^(https?:|data:|blob:|#|mailto:|tel:)/i.test(r)) {
              refs.push({ ref: r, tag: el.tagName.toLowerCase() });
            }
          }
          return refs;
        })()
      `) as Array<{ ref: string; tag: string }>;

      for (const m of missingRefs) {
        const clean = m.ref.split("?")[0].split("#")[0];
        const abs = path.resolve(baseDir, clean);
        if (!fs.existsSync(abs)) {
          issues.push({
            id: "missing-local-file",
            severity: "error",
            viewport: vp.name,
            selector: m.tag,
            message: `Missing local file referenced by <${m.tag}>: ${m.ref}`,
            fixHint: "Create the file or remove the broken tag.",
          });
        }
      }

      // Check text length
      const textLen = (await win.webContents.executeJavaScript(`
        (document.body.innerText || '').replace(/\\s+/g, ' ').trim().length
      `)) as number;
      maxTextLength = Math.max(maxTextLength, textLen);
      if (textLen < 300) {
        issues.push({
          id: "thin-content",
          severity: "error",
          viewport: vp.name,
          message: `Only ${textLen} characters of visible body text rendered in headless browser.`,
          fixHint: "Add complete content sections instead of minimal stubs.",
        });
      }

      // Capture offscreen native screenshot
      const image = await win.webContents.capturePage();
      const screenFile = path.join(opts.outDir, `headless-${vp.name}.png`);
      fs.writeFileSync(screenFile, image.toPNG());
      screenshots.push({ viewport: vp.name, file: screenFile });

      const htmlBytes = fs.statSync(opts.pagePath).size;
      maxWeightBytes = Math.max(maxWeightBytes, htmlBytes);
    } catch (e) {
      log.warn(`headless-verify: error at viewport ${vp.name}`, e);
      // Fallback to static verifyWebsite if BrowserWindow fails
      return verifyWebsite(opts);
    } finally {
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  return {
    ok: errors.length === 0,
    verified: true,
    issues,
    screenshots,
    textLength: maxTextLength,
    pageWeightBytes: maxWeightBytes,
    note: "Verified via Electron headless BrowserWindow with offscreen screenshots and console capture.",
  };
}

