import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const AGY_BIN = fs.existsSync(path.join(HOME, ".local/bin/agy"))
  ? path.join(HOME, ".local/bin/agy")
  : "agy";
const NODE_BIN = fs.existsSync(path.join(HOME, ".local/bin/node"))
  ? path.join(HOME, ".local/bin/node")
  : process.execPath;
const EA_LINT_PATH = path.join(HOME, "shared/tools/ea-lint.mjs");
const SHARED_DIR = path.join(HOME, "shared");
const EA_STYLE_DIR = path.join(HOME, "sites/electoralanalytics-site/docs/style");

// Keep argv prompt well under Linux MAX_ARG_STRLEN (131,072 bytes)
const MAX_PROMPT_BYTES = 96_000;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

// Token-protection constants
const COOLDOWN_MS = 60 * 1000; // 60s minimum between automatic calls in the same workspace
const CACHE_TTL_MS = 30 * 60 * 1000; // 30m exact-match deduplication cache
const HOURLY_DOWNSHIFT_THRESHOLD = 5; // After 5 calls/hr, auto-downshift opus-high -> sonnet-medium
const HOURLY_HARD_CAP = 10; // After 10 calls/hr, block non-forced calls
const TRIVIAL_DIFF_CHANGED_LINES = 12; // Skip code diff review if <12 changed lines and no untracked files

export const TIER_PRESETS = {
  deep: {
    model: "claude-opus-5-5-high",
    effort: "high",
    label: "Claude Opus 5.5 (High)",
  },
  opus: {
    model: "claude-opus-5-5-high",
    effort: "high",
    label: "Claude Opus 5.5 (High)",
  },
  "opus-high": {
    model: "claude-opus-5-5-high",
    effort: "high",
    label: "Claude Opus 5.5 (High)",
  },
  "opus-medium": {
    model: "claude-opus-5-5-medium",
    effort: "medium",
    label: "Claude Opus 5.5 (Medium)",
  },
  "opus-low": {
    model: "claude-opus-5-5-low",
    effort: "low",
    label: "Claude Opus 5.5 (Low)",
  },
  fast: {
    model: "claude-sonnet-5-5-high",
    effort: "high",
    label: "Claude Sonnet 5.5 (High)",
  },
  sonnet: {
    model: "claude-sonnet-5-5-high",
    effort: "high",
    label: "Claude Sonnet 5.5 (High)",
  },
  "sonnet-high": {
    model: "claude-sonnet-5-5-high",
    effort: "high",
    label: "Claude Sonnet 5.5 (High)",
  },
  "sonnet-medium": {
    model: "claude-sonnet-5-5-medium",
    effort: "medium",
    label: "Claude Sonnet 5.5 (Medium)",
  },
  "sonnet-low": {
    model: "claude-sonnet-5-5-low",
    effort: "low",
    label: "Claude Sonnet 5.5 (Low)",
  },
  "gpt-oss": {
    model: "gpt-oss-120b-medium",
    effort: "medium",
    label: "GPT-OSS 120B (Medium)",
  },
};

const FOCUS_INSTRUCTIONS = {
  plan: [
    "Audit this implementation or architectural plan.",
    "1. Check whether the plan violates any local AGENTS.md, README.md, or ~/shared/docs/workspace-routing.md constraints.",
    "2. Identify flawed assumptions, missing edge cases, race conditions, data-provenance gaps, or unnecessary complexity.",
    "3. Propose concrete simplifications or corrections before implementation starts.",
  ].join("\n"),
  code: [
    "Perform a rigorous cross-model code review.",
    "1. Inspect the modified files and git diff for logic bugs, off-by-one errors, unhandled failure modes, security issues, and regressions.",
    "2. Verify that existing tests, contracts, and documentation integrity are preserved.",
    "3. Provide exact file/line references and drop-in fixes for every defect found.",
  ].join("\n"),
  math: [
    "Audit all quantitative claims, calculations, rates, and dollar figures.",
    "1. Trace every number back to the underlying data/ files, scripts, and primary government/agency sources.",
    "2. Check denominators, date ranges, unit conversions, rounding, and aggregation formulas.",
    "3. Flag any blended metrics (e.g., incompatible measurement systems) or unverified claims.",
  ].join("\n"),
  prose: [
    "Audit this prose, documentation, or essay draft for clarity, factual precision, and structural rigor.",
    "1. Check that claims are backed by linked primary sources or workspace evidence and that the tone matches the target audience.",
    "2. If ~/shared/docs/agent-lessons.md or ~/sites/electoralanalytics-site/docs/style/ exists on this machine, also enforce Track A/B/C voice compliance, calibrator alignment, and inline-style bans.",
    "3. Flag any editorializing, internal workshop jargon, sensationalized titles, or linter violations.",
  ].join("\n"),
  general: [
    "Provide a rigorous, independent second opinion on the problem, work, or question below.",
    "Verify claims directly against workspace files where applicable, identify mistakes or blind spots, and state concrete recommendations.",
  ].join("\n"),
};

function getDataDir() {
  const dir =
    process.env.PLUGIN_DATA ||
    path.join(HOME, ".gemini/antigravity/plugin_data/advisor");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readRecentLogs(windowMs = 60 * 60 * 1000) {
  try {
    const logPath = path.join(getDataDir(), "advisor-log.jsonl");
    if (!fs.existsSync(logPath)) return [];
    const cutoff = Date.now() - windowMs;
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const recent = [];
    for (const line of lines.slice(-100)) {
      try {
        const entry = JSON.parse(line);
        const ts = Date.parse(entry.timestamp);
        if (!Number.isNaN(ts) && ts >= cutoff && entry.exitCode === 0) {
          recent.push({ ...entry, ts });
        }
      } catch {
        // Ignore malformed line
      }
    }
    return recent;
  } catch {
    return [];
  }
}

function checkResponseCache(cacheKey) {
  try {
    const cachePath = path.join(getDataDir(), "advisor-cache.json");
    if (!fs.existsSync(cachePath)) return null;
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const hit = cache[cacheKey];
    if (hit && Date.now() - hit.ts <= CACHE_TTL_MS) {
      return hit.text;
    }
    return null;
  } catch {
    return null;
  }
}

function writeResponseCache(cacheKey, text) {
  try {
    const cachePath = path.join(getDataDir(), "advisor-cache.json");
    let cache = {};
    if (fs.existsSync(cachePath)) {
      try {
        cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) || {};
      } catch {
        cache = {};
      }
    }
    const now = Date.now();
    // Prune expired or excess entries (keep at most 20)
    const entries = Object.entries(cache)
      .filter(([, v]) => v && now - v.ts <= CACHE_TTL_MS)
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, 19);
    const nextCache = Object.fromEntries(entries);
    nextCache[cacheKey] = { ts: now, text };
    fs.writeFileSync(cachePath, JSON.stringify(nextCache, null, 2), "utf8");
  } catch {
    // Ignore cache write errors
  }
}

function resolveTierAndModel(
  tierOrModel = "auto",
  explicitEffort,
  focus = "general",
  changedLineCount = null,
  hourlyCallCount = 0,
  force = false
) {
  let key = String(tierOrModel || "auto").trim().toLowerCase();

  // Smart auto-tiering:
  // - High-stakes reasoning (plan, math, prose) -> Claude Opus 5.5 (High)
  // - Code / general -> Claude Sonnet 5.5 (Medium for <150 changed lines, High for >=150 lines)
  if (key === "auto") {
    if (focus === "plan" || focus === "math" || focus === "prose") {
      key = "opus-high";
    } else if (
      changedLineCount !== null &&
      changedLineCount > 0 &&
      changedLineCount < 150
    ) {
      key = "sonnet-medium";
    } else {
      key = "sonnet-high";
    }
  }

  // Automatic quota downshift if hourly call volume is high
  if (
    !force &&
    hourlyCallCount >= HOURLY_DOWNSHIFT_THRESHOLD &&
    (key === "deep" || key === "opus" || key === "opus-high")
  ) {
    key = "sonnet-medium";
  }

  if (TIER_PRESETS[key]) {
    return {
      model: TIER_PRESETS[key].model,
      effort: explicitEffort || TIER_PRESETS[key].effort,
      label: TIER_PRESETS[key].label,
    };
  }
  return {
    model: key,
    effort: explicitEffort || "high",
    label: key,
  };
}

async function safeExecAsync(
  cmd,
  args,
  cwd,
  timeoutMs = 8000,
  { allowNonZero = false } = {}
) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return (stdout || "").trim();
  } catch (err) {
    if (allowNonZero && typeof err.code === "number") {
      return [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    }
    return null;
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return path.resolve(p);
}

function isUnderSites(p) {
  if (!p) return false;
  return /(?:^|\/)(?:dev\/)?sites(?:\/|$)/.test(p);
}

function countDiffChangedLines(diffText) {
  if (!diffText) return 0;
  let count = 0;
  for (const line of diffText.split("\n")) {
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      count++;
    }
  }
  return count;
}

async function gatherWorkspaceContext({
  focus = "general",
  workspace,
  files = [],
  includeGitDiff = false,
}) {
  const focusKey = FOCUS_INSTRUCTIONS[focus] ? focus : "general";
  const resolvedWorkspace = expandHome(workspace || process.cwd());
  const resolvedFiles = files.map((f) => {
    const expanded = expandHome(f);
    return path.isAbsolute(expanded)
      ? expanded
      : path.resolve(resolvedWorkspace, expanded);
  });

  const contextBlocks = [];
  let gitDiff = "";
  let gitStatus = "";
  let gitUntracked = "";
  let changedLineCount = null;

  // Run deterministic ea-lint.mjs automatically when focus is prose or files are under ~/sites
  const sitesWork =
    isUnderSites(resolvedWorkspace) || resolvedFiles.some((f) => isUnderSites(f));
  if ((focusKey === "prose" || sitesWork) && fs.existsSync(EA_LINT_PATH)) {
    const lintTargets =
      resolvedFiles.length > 0 ? resolvedFiles : [resolvedWorkspace];
    const lintOutputs = [];
    for (const target of lintTargets.slice(0, 6)) {
      if (fs.existsSync(target)) {
        const out = await safeExecAsync(
          NODE_BIN,
          [EA_LINT_PATH, target],
          resolvedWorkspace,
          8000,
          { allowNonZero: true }
        );
        if (out) {
          lintOutputs.push(
            `### ea-lint.mjs (${target})\n\`\`\`text\n${out.slice(0, 3000)}\n\`\`\``
          );
        }
      }
    }
    if (lintOutputs.length > 0) {
      contextBlocks.push(
        ["## Deterministic Linter Output (ea-lint.mjs)", ...lintOutputs].join("\n")
      );
    }
  }

  if (includeGitDiff && fs.existsSync(resolvedWorkspace)) {
    const isGitRepo = await safeExecAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      resolvedWorkspace,
      4000
    );
    if (isGitRepo === "true") {
      const [statusOut, untrackedOut, diffStatOut, diffOut] = await Promise.all([
        safeExecAsync("git", ["status", "--short"], resolvedWorkspace, 5000),
        safeExecAsync(
          "git",
          ["ls-files", "--others", "--exclude-standard"],
          resolvedWorkspace,
          5000
        ),
        safeExecAsync("git", ["diff", "--stat", "HEAD"], resolvedWorkspace, 5000),
        safeExecAsync("git", ["diff", "HEAD"], resolvedWorkspace, 6000),
      ]);

      gitStatus = statusOut || "";
      gitUntracked = untrackedOut || "";
      gitDiff = diffOut || "";
      changedLineCount = countDiffChangedLines(gitDiff);

      const stateLines = [
        "## Workspace Git State",
        "```text",
        `git status --short:\n${gitStatus || "(clean)"}`,
        "",
        `git diff --stat HEAD:\n${diffStatOut || "(no tracked diff)"}`,
      ];
      if (gitUntracked) {
        stateLines.push(
          "",
          `Untracked files (inspect with read_file if relevant):\n${gitUntracked}`
        );
      }
      stateLines.push("```");
      contextBlocks.push(stateLines.join("\n"));

      if (gitDiff) {
        const clippedDiff =
          Buffer.byteLength(gitDiff, "utf8") > 14000
            ? `${Buffer.from(gitDiff, "utf8").subarray(0, 14000).toString("utf8")}\n... [diff truncated at 14 KB; use read_file on modified files if needed]`
            : gitDiff;
        contextBlocks.push(
          ["## Git Diff Preview", "```diff", clippedDiff, "```"].join("\n")
        );
      }
    }
  }

  return {
    focusKey,
    resolvedWorkspace,
    resolvedFiles,
    contextBlocks,
    gitStatus,
    gitUntracked,
    gitDiff,
    changedLineCount,
  };
}

function buildAdvisorPrompt({
  prompt,
  focusKey,
  resolvedWorkspace,
  resolvedFiles,
  contextBlocks,
}) {
  const coreSections = [
    "[ADVISOR REVIEW REQUEST]",
    "You are acting as the independent Cross-Model Advisor reviewing work or plans produced by Gemini.",
    "CRITICAL CONSTRAINTS:",
    "1. Do NOT call `consult_advisor`, `advisor-consult`, or `invoke_subagent`. You ARE the advisor.",
    "2. TOKEN DISCIPLINE: Rely on the diff/context below first. Make at most 1-2 targeted `read_file` calls only if required to verify surrounding lines or data sources.",
    "",
    `## Review Focus (${focusKey.toUpperCase()})`,
    FOCUS_INSTRUCTIONS[focusKey],
    "",
    `## Active Workspace`,
    resolvedWorkspace,
  ];

  if (resolvedFiles.length > 0) {
    coreSections.push(
      "",
      "## Target Files to Inspect",
      ...resolvedFiles.map((f) => `- ${f}`)
    );
  }

  coreSections.push(
    "",
    "## Task / Material Under Review",
    String(prompt || "").trim(),
    "",
    "## Required Output Format",
    "Respond concisely with:",
    "1. **Verdict**: `APPROVE`, `REVISE`, or `BLOCK` (with a 1-sentence summary).",
    "2. **Mistakes & Risks Caught**: Numbered list ordered by severity (cite exact file paths, line numbers, or calculations).",
    "3. **Concrete Fixes**: Specific changes or corrections required.",
    "4. **Unchecked Assumptions**: Anything that still needs primary-source or test verification."
  );

  let text = coreSections.join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
    const buf = Buffer.from(text, "utf8").subarray(0, MAX_PROMPT_BYTES - 256);
    return (
      buf.toString("utf8") +
      "\n\n[Prompt truncated to fit argv byte budget; inspect target files directly with read_file.]"
    );
  }

  for (const block of contextBlocks) {
    const candidate = `${text}\n\n${block}`;
    if (Buffer.byteLength(candidate, "utf8") > MAX_PROMPT_BYTES) {
      text +=
        "\n\n[Additional context omitted to stay within byte budget; inspect files directly with read_file.]";
      break;
    }
    text = candidate;
  }

  return text;
}

function appendAuditLog(entry) {
  try {
    const logPath = path.join(getDataDir(), "advisor-log.jsonl");
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Ignore logging errors
  }
}

export async function runAdvisorConsult({
  prompt,
  focus = "general",
  tier = "auto",
  effort,
  workspace,
  files = [],
  includeGitDiff = false,
  force = false,
  timeoutMs = 90000,
  signal,
}) {
  if (process.env.AGY_ADVISOR_ACTIVE === "1") {
    return {
      isError: true,
      text: "Advisor recursion blocked: AGY_ADVISOR_ACTIVE=1 is already set in this environment. Perform the review directly without re-invoking the advisor.",
    };
  }

  if (!prompt || !String(prompt).trim()) {
    return {
      isError: true,
      text: "Error: `prompt` is required when consulting the advisor.",
    };
  }

  const ctx = await gatherWorkspaceContext({
    focus,
    workspace,
    files,
    includeGitDiff,
  });

  // Token Guard 1: Trivial Diff Skip Gate (0 tokens spent)
  if (
    !force &&
    ctx.focusKey === "code" &&
    includeGitDiff &&
    ctx.changedLineCount !== null &&
    ctx.changedLineCount < TRIVIAL_DIFF_CHANGED_LINES &&
    !ctx.gitUntracked &&
    files.length <= 1
  ) {
    return {
      isError: false,
      text: `### Advisor Fast-Path Skip (0 tokens used)\n**Verdict**: \`APPROVE\` — Git diff in \`${ctx.resolvedWorkspace}\` has only ${ctx.changedLineCount} changed line(s) (<${TRIVIAL_DIFF_CHANGED_LINES} line threshold) and no untracked files. Skipping cross-model call to conserve quota. Pass \`--force\` to override.`,
    };
  }

  // Check recent call history for rate limiting & cooldown
  const recentHourLogs = readRecentLogs(60 * 60 * 1000);

  // Token Guard 2: Hourly Hard Cap
  if (!force && recentHourLogs.length >= HOURLY_HARD_CAP) {
    return {
      isError: false,
      text: `### Advisor Quota Guard (0 tokens used)\n**Verdict**: \`APPROVE\` (Skipped) — ${recentHourLogs.length} advisor calls have already run in the last 60 minutes (hourly cap: ${HOURLY_HARD_CAP}). Skipping automatic advisor call to protect subscription quota. Pass \`--force\` if an explicit review is needed.`,
    };
  }

  const { model, effort: resolvedEffort, label } = resolveTierAndModel(
    tier,
    effort,
    ctx.focusKey,
    ctx.changedLineCount,
    recentHourLogs.length,
    force
  );

  // Token Guard 3: Exact-Match Deduplication Cache (0 tokens spent)
  const cacheKey = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        model,
        focus: ctx.focusKey,
        workspace: ctx.resolvedWorkspace,
        files: ctx.resolvedFiles,
        prompt: String(prompt).trim(),
        gitStatus: ctx.gitStatus,
        gitDiff: ctx.gitDiff,
      })
    )
    .digest("hex");

  if (!force) {
    const cachedText = checkResponseCache(cacheKey);
    if (cachedText) {
      return {
        isError: false,
        text: `${cachedText}\n\n*(Served from 30m deduplication cache — 0 additional tokens used.)*`,
      };
    }

    // Token Guard 4: Per-Workspace Cooldown (60s)
    const lastWorkspaceCall = [...recentHourLogs]
      .reverse()
      .find((entry) => entry.workspace === ctx.resolvedWorkspace);
    if (lastWorkspaceCall && Date.now() - lastWorkspaceCall.ts < COOLDOWN_MS) {
      const agoSec = Math.round((Date.now() - lastWorkspaceCall.ts) / 1000);
      return {
        isError: false,
        text: `### Advisor Cooldown Active (0 tokens used)\nAdvisor already audited \`${ctx.resolvedWorkspace}\` ${agoSec}s ago (cooldown: ${COOLDOWN_MS / 1000}s, max 1 advisor call per task). Apply the previous audit feedback and complete the turn without re-polling the advisor, or pass \`--force\` to override.`,
      };
    }
  }

  const fullPrompt = buildAdvisorPrompt({
    prompt,
    focusKey: ctx.focusKey,
    resolvedWorkspace: ctx.resolvedWorkspace,
    resolvedFiles: ctx.resolvedFiles,
    contextBlocks: ctx.contextBlocks,
  });

  const addDirs = new Set();
  if (fs.existsSync(ctx.resolvedWorkspace)) {
    addDirs.add(ctx.resolvedWorkspace);
  }
  if (fs.existsSync(SHARED_DIR)) {
    addDirs.add(SHARED_DIR);
  }
  if (ctx.focusKey === "prose" && fs.existsSync(EA_STYLE_DIR)) {
    addDirs.add(EA_STYLE_DIR);
  }
  for (const abs of ctx.resolvedFiles) {
    try {
      const dir =
        fs.existsSync(abs) && fs.statSync(abs).isDirectory()
          ? abs
          : path.dirname(abs);
      if (fs.existsSync(dir)) {
        addDirs.add(dir);
      }
    } catch {
      // Ignore inaccessible file paths
    }
  }

  const printTimeoutSec = Math.max(30, Math.floor(timeoutMs / 1000) - 5);
  const args = [
    "--agent",
    "advisor-engine",
    "--model",
    model,
    "--effort",
    resolvedEffort,
    "--mode",
    "plan",
    "--sandbox",
    "--print-timeout",
    `${printTimeoutSec}s`,
  ];
  for (const d of addDirs) {
    args.push("--add-dir", d);
  }
  args.push(`-p=${fullPrompt}`);

  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn(AGY_BIN, args, {
      cwd: fs.existsSync(ctx.resolvedWorkspace) ? ctx.resolvedWorkspace : HOME,
      env: {
        ...process.env,
        AGY_ADVISOR_ACTIVE: "1",
        PATH: `${path.join(HOME, ".local/bin")}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const killChildWithEscalation = () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChildWithEscalation();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      clearTimeout(timer);
      killChildWithEscalation();
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (str) => {
      stdout += str;
    });

    child.stderr.on("data", (str) => {
      stderr += str;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        isError: true,
        text: `Failed to spawn agy (${AGY_BIN}): ${err.message}`,
      });
    });

    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - startTime;
      const cleanOut = stdout.trim();
      const cleanErr = stderr.trim();

      const verdictMatch =
        cleanOut.match(/(?:\*\*Verdict\*\*|Verdict)\s*:\s*`?(APPROVE|REVISE|BLOCK)`?/i) ||
        cleanOut.match(/\b(APPROVE|REVISE|BLOCK)\b/);

      appendAuditLog({
        timestamp: new Date().toISOString(),
        model,
        effort: resolvedEffort,
        focus: ctx.focusKey,
        workspace: ctx.resolvedWorkspace,
        durationMs,
        exitCode: code,
        exitSignal: exitSignal || undefined,
        verdict: aborted
          ? "ABORTED"
          : timedOut
            ? "TIMEOUT"
            : verdictMatch
              ? verdictMatch[1].toUpperCase()
              : "UNKNOWN",
      });

      if (aborted) {
        resolve({
          isError: true,
          text: `Advisor (${label}) request was cancelled.`,
        });
        return;
      }

      if (timedOut) {
        resolve({
          isError: true,
          text: `Advisor (${label}) timed out after ${Math.round(timeoutMs / 1000)}s.\nPartial output:\n${cleanOut || cleanErr}`,
        });
        return;
      }

      if (code !== 0) {
        const detail = [cleanOut, cleanErr].filter(Boolean).join("\n");
        resolve({
          isError: true,
          text: `Advisor (${label}) exited with ${code !== null ? `code ${code}` : `signal ${exitSignal}`}:\n${detail || "(no output)"}`,
        });
        return;
      }

      const header = `### Advisor Audit — ${label} [focus: ${ctx.focusKey}, effort: ${resolvedEffort}, ${(durationMs / 1000).toFixed(1)}s]`;
      const fullResponse = `${header}\n\n${cleanOut}`;
      writeResponseCache(cacheKey, fullResponse);
      resolve({
        isError: false,
        text: fullResponse,
      });
    });
  });
}

export async function checkAdvisorQuota() {
  const raw =
    (await safeExecAsync(AGY_BIN, ["models"], HOME, 10000)) ||
    "(failed to query agy models)";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^.*Fetching available models\.\.\.\s*/, "").trim())
    .filter(Boolean);

  const recentHourLogs = readRecentLogs(60 * 60 * 1000);

  return {
    isError: false,
    text: [
      "### Available Antigravity Subscription Models (`agy models`)",
      "```text",
      ...lines,
      "```",
      "",
      "**Configured Advisor Tiers (`--tier`):**",
      "- `auto` (Default): Smart routing — uses `claude-opus-5-5-high` for `plan`/`math`/`prose`, and `claude-sonnet-5-5-medium` (<150 lines) or `claude-sonnet-5-5-high` (>=150 lines) for `code`/`general`",
      "- `deep` / `opus`: `claude-opus-5-5-high` (Claude Opus 5.5 High)",
      "- `fast` / `sonnet`: `claude-sonnet-5-5-high` (Claude Sonnet 5.5 High)",
      "- `opus-medium`: `claude-opus-5-5-medium` (Claude Opus 5.5 Medium)",
      "- `sonnet-medium`: `claude-sonnet-5-5-medium` (Claude Sonnet 5.5 Medium)",
      "",
      `**Token Guardrails Active:** ${recentHourLogs.length}/${HOURLY_HARD_CAP} calls used in last 60m · 60s workspace cooldown · 30m exact-match cache · <${TRIVIAL_DIFF_CHANGED_LINES}-line trivial diff skip`,
    ].join("\n"),
  };
}
