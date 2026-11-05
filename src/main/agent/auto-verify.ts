import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import log from "electron-log";
import { verifyWebsite } from "../quality/verifier";
import { currentTelemetry } from "../telemetry";
import { sanitizeTerminalEnv } from "../terminal/env";
import type { AgentState } from "./tools";

// PHASE 2C: Auto-verify after writes (zero extra planning tokens).
// Detects project configuration once and caches in `.myide/project.json`.
// Runs the cheapest local checks on modified files (`tsc --noEmit`, `eslint` on
// changed files, `verifyWebsite` on HTML, matching unit test files) and summarizes
// errors to at most 40 deduplicated `file:line:message` lines.

export const MAX_AUTO_VERIFY_LINES = 40;
const CHECK_TIMEOUT_MS = 15_000;

export interface CachedProjectConfig {
  detectedAt: number;
  packageManager: "pnpm" | "yarn" | "npm" | null;
  hasTypeScript: boolean;
  typecheckScript: string | null;
  hasEslint: boolean;
  testScript: string | null;
}

export interface AutoVerifyResult {
  ran: boolean;
  ok: boolean;
  checksRun: string[];
  errorLines: string[];
  formattedFeedback: string;
}

const ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];

export function detectProjectConfig(workspaceRoot: string, forceRefresh = false): CachedProjectConfig {
  const myideDir = path.join(workspaceRoot, ".myide");
  const cacheFile = path.join(myideDir, "project.json");

  if (!forceRefresh && fs.existsSync(cacheFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Partial<CachedProjectConfig>;
      if (parsed && typeof parsed.detectedAt === "number" && typeof parsed.hasTypeScript === "boolean") {
        return {
          detectedAt: parsed.detectedAt,
          packageManager: parsed.packageManager ?? null,
          hasTypeScript: parsed.hasTypeScript,
          typecheckScript: parsed.typecheckScript ?? null,
          hasEslint: Boolean(parsed.hasEslint),
          testScript: parsed.testScript ?? null,
        };
      }
    } catch {
      /* recompute */
    }
  }

  let packageManager: CachedProjectConfig["packageManager"] = null;
  if (fs.existsSync(path.join(workspaceRoot, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (fs.existsSync(path.join(workspaceRoot, "yarn.lock"))) packageManager = "yarn";
  else if (fs.existsSync(path.join(workspaceRoot, "package.json"))) packageManager = "npm";

  const hasTypeScript = fs.existsSync(path.join(workspaceRoot, "tsconfig.json"));

  let typecheckScript: string | null = null;
  let testScript: string | null = null;
  let pkgHasEslintConfig = false;

  const pkgPath = path.join(workspaceRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
        eslintConfig?: unknown;
      };
      if (pkg.scripts?.typecheck) typecheckScript = pkg.scripts.typecheck;
      if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
        testScript = pkg.scripts.test;
      }
      if (pkg.eslintConfig) pkgHasEslintConfig = true;
    } catch {
      /* ignore malformed package.json */
    }
  }

  const eslintBinJs = path.join(workspaceRoot, "node_modules", "eslint", "bin", "eslint.js");
  const hasEslint =
    fs.existsSync(eslintBinJs) &&
    (pkgHasEslintConfig || ESLINT_CONFIG_FILES.some((f) => fs.existsSync(path.join(workspaceRoot, f))));

  const config: CachedProjectConfig = {
    detectedAt: Date.now(),
    packageManager,
    hasTypeScript,
    typecheckScript,
    hasEslint,
    testScript,
  };

  try {
    fs.mkdirSync(myideDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(config, null, 2), "utf8");
  } catch (e) {
    log.warn("auto-verify: could not write .myide/project.json", e);
  }

  return config;
}

function resolveTscJs(workspaceRoot: string): string | null {
  const localTsc = path.join(workspaceRoot, "node_modules", "typescript", "bin", "tsc");
  if (fs.existsSync(localTsc)) return localTsc;

  // Fallback to Nova IDE's own bundled TypeScript compiler (strictly local, zero network).
  try {
    const bundled = require.resolve("typescript/bin/tsc");
    if (fs.existsSync(bundled)) return bundled;
  } catch {
    /* unavailable */
  }
  return null;
}

function runNodeScript(
  cwd: string,
  args: string[],
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const env = {
      ...sanitizeTerminalEnv(process.env),
      ELECTRON_RUN_AS_NODE: "1",
      CI: "1",
      FORCE_COLOR: "0",
    };

    const child = spawn(process.execPath, args, {
      cwd,
      windowsHide: true,
      env,
    });

    let out = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output: out });
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(124);
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < 32_000) out += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (out.length < 32_000) out += d.toString("utf8");
    });
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/**
 * Normalize raw compiler / linter / test lines into compact deduplicated
 * `file:line:message` lines capped at `maxLines` (default 40).
 */
export function summarizeVerifyErrors(rawLines: string[], maxLines = MAX_AUTO_VERIFY_LINES): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawLines) {
    for (const part of raw.split(/\r?\n/)) {
      const line = part.trim();
      if (!line) continue;
      // Skip noisy node:test runner summary chrome when individual failure lines exist
      if (/^[ℹ✔▶]/.test(line)) continue;

      // Normalize TypeScript `src/foo.ts(10,5): error TS2339: Msg` -> `src/foo.ts:10:5: TS2339: Msg`
      const tsMatch = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+:\s*.+)$/.exec(line);
      const compact = tsMatch
        ? `${tsMatch[1].replace(/\\/g, "/")}:${tsMatch[2]}:${tsMatch[3]}: ${tsMatch[4]}`
        : line.replace(/\\/g, "/").slice(0, 220);

      if (seen.has(compact)) continue;
      seen.add(compact);
      normalized.push(compact);
    }
  }

  if (normalized.length <= maxLines) {
    return normalized;
  }
  const kept = normalized.slice(0, maxLines - 1);
  kept.push(`... (+${normalized.length - kept.length} more error lines omitted)`);
  return kept;
}

function findMatchingNodeTests(workspaceRoot: string, changedRelPaths: string[]): string[] {
  const matched = new Set<string>();

  for (const rel of changedRelPaths) {
    const clean = rel.replace(/\\/g, "/");
    if (/\.(test|spec)\.(?:js|mjs|cjs)$/i.test(clean)) {
      if (fs.existsSync(path.join(workspaceRoot, clean))) matched.add(clean);
      continue;
    }
    const extMatch = /^(.+)\.(?:js|mjs|cjs|ts|tsx)$/i.exec(clean);
    if (!extMatch) continue;
    const stem = extMatch[1];
    const baseName = path.posix.basename(stem);
    const candidates = [
      `${stem}.test.js`,
      `${stem}.test.mjs`,
      `tests/${baseName}.test.js`,
      `tests/${baseName}.test.mjs`,
    ];
    for (const c of candidates) {
      if (fs.existsSync(path.join(workspaceRoot, c))) {
        matched.add(c);
      }
    }
  }

  return [...matched].slice(0, 4);
}

export async function runAutoVerifyAfterWrites(
  state: AgentState,
  changedRelPaths: string[],
): Promise<AutoVerifyResult> {
  if (changedRelPaths.length === 0) {
    return { ran: false, ok: true, checksRun: [], errorLines: [], formattedFeedback: "" };
  }

  const workspaceRoot = state.workspaceRoot;
  // Refresh project config if package.json or tsconfig.json was just created/edited
  const configTouched = changedRelPaths.some((p) => /(?:^|\/)(?:package|tsconfig)\.json$/i.test(p));
  const project = detectProjectConfig(workspaceRoot, configTouched);

  const checksRun: string[] = [];
  const rawErrors: string[] = [];

  // 1. TypeScript check (`tsc --noEmit`) when `.ts`/`.tsx` files changed and `tsconfig.json` exists
  const tsChanged = changedRelPaths.some((p) => /\.tsx?$/i.test(p));
  if (tsChanged && project.hasTypeScript) {
    const tscJs = resolveTscJs(workspaceRoot);
    if (tscJs) {
      checksRun.push("tsc");
      const res = await runNodeScript(workspaceRoot, [tscJs, "--noEmit", "--pretty", "false"]);
      if (res.code !== 0 && res.output.trim()) {
        rawErrors.push(res.output);
      }
    }
  }

  // 2. ESLint on changed JS/TS files only (if workspace has eslint + config)
  const jsTsFiles = changedRelPaths.filter(
    (p) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(p) && fs.existsSync(path.join(workspaceRoot, p)),
  );
  if (jsTsFiles.length > 0 && project.hasEslint) {
    const eslintJs = path.join(workspaceRoot, "node_modules", "eslint", "bin", "eslint.js");
    checksRun.push("eslint");
    const res = await runNodeScript(workspaceRoot, [eslintJs, "-f", "unix", ...jsTsFiles]);
    if (res.code !== 0 && res.output.trim()) {
      rawErrors.push(res.output);
    }
  }

  // 3. HTML verification (`verifyWebsite`) on modified HTML files
  const htmlFiles = changedRelPaths.filter(
    (p) => /\.html?$/i.test(p) && fs.existsSync(path.join(workspaceRoot, p)),
  );
  for (const relHtml of htmlFiles.slice(0, 2)) {
    const report = await verifyWebsite({
      pagePath: path.join(workspaceRoot, relHtml),
      workspaceRoot,
      outDir: path.join(state.myideDir, "verify"),
    });
    state.lastVerify = report;
    if (report.verified) {
      checksRun.push(`verifyWebsite(${relHtml})`);
      currentTelemetry()?.recordVerification(report.ok);
      if (report.ok) {
        state.verifyPassedSinceChange = true;
      } else {
        for (const issue of report.issues.filter((i) => i.severity === "error")) {
          const sel = issue.selector ? ` [${issue.selector}]` : "";
          rawErrors.push(`${relHtml}:${issue.viewport}${sel}: ${issue.message} (${issue.fixHint})`);
        }
      }
    }
  }

  // 4. Matching fast Node unit tests (`node --test`) if test script uses node --test
  const usesNodeTest = Boolean(project.testScript && /\bnode\s+--test\b/.test(project.testScript));
  if (usesNodeTest) {
    const matchingTests = findMatchingNodeTests(workspaceRoot, changedRelPaths);
    if (matchingTests.length > 0) {
      checksRun.push(`test(${matchingTests.join(",")})`);
      const res = await runNodeScript(workspaceRoot, ["--test", ...matchingTests], 10_000);
      if (res.code !== 0 && res.output.trim()) {
        rawErrors.push(res.output);
      }
    }
  }

  if (checksRun.length === 0) {
    return { ran: false, ok: true, checksRun: [], errorLines: [], formattedFeedback: "" };
  }

  const errorLines = summarizeVerifyErrors(rawErrors, MAX_AUTO_VERIFY_LINES);
  const ok = errorLines.length === 0;
  currentTelemetry()?.recordVerification(ok);

  if (ok) {
    return {
      ran: true,
      ok: true,
      checksRun,
      errorLines: [],
      // Zero extra turns: just a 1-line confirmation inside the existing tool result
      // so the model knows auto-verification already succeeded.
      formattedFeedback: `[Auto-verify passed (${checksRun.join(", ")}): 0 errors — auto-verified]`,
    };
  }

  return {
    ran: true,
    ok: false,
    checksRun,
    errorLines,
    formattedFeedback: [
      `[Auto-verify found ${errorLines.length} error line(s) via ${checksRun.join(", ")} — fix these]:`,
      ...errorLines,
    ].join("\n"),
  };
}
