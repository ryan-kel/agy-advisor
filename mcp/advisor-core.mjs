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

// Keep 1-shot prompt rich enough for full files/diffs while staying below Linux MAX_ARG_STRLEN (128 KB)
const MAX_PROMPT_BYTES = 96_000;
const MAX_FILE_SNIPPET_BYTES = 24_000;
const MAX_ATTACHED_FILES = 8;
const MAX_DIFF_BYTES = 32_000;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

// Strict Anti-Token-Burner Guardrails
const COOLDOWN_MS = 120 * 1000; // 2m minimum between automatic calls in the same workspace
const CACHE_TTL_MS = 60 * 60 * 1000; // 60m exact-match deduplication cache
const HOURLY_DOWNSHIFT_THRESHOLD = 3; // After 3 calls/hr, force sonnet-low
const HOURLY_HARD_CAP = 6; // Max 6 automatic advisor calls per hour
const QUOTA_FLOOR_FRACTION = 0.35; // Never run automatic advisor calls if Claude quota < 35%
const TRIVIAL_DIFF_CHANGED_LINES = 20; // Skip automatic code diff review if <20 changed lines

export const TIER_PRESETS = {
  deep: {
    model: "claude-opus-5-5-medium",
    effort: "medium",
    label: "Claude Opus 5.5 (Medium)",
  },
  "opus-high": {
    model: "claude-opus-5-5-high",
    effort: "high",
    label: "Claude Opus 5.5 (High)",
  },
  opus: {
    model: "claude-opus-5-5-medium",
    effort: "medium",
    label: "Claude Opus 5.5 (Medium)",
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
    model: "claude-sonnet-5-5-medium",
    effort: "medium",
    label: "Claude Sonnet 5.5 (Medium)",
  },
  sonnet: {
    model: "claude-sonnet-5-5-medium",
    effort: "medium",
    label: "Claude Sonnet 5.5 (Medium)",
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
    "1. Identify flawed assumptions, missing edge cases, race conditions, data-provenance gaps, or unnecessary complexity.",
    "2. Propose concrete simplifications or corrections before implementation starts.",
  ].join("\n"),
  code: [
    "Perform a concise, high-signal cross-model code review.",
    "1. Inspect the attached diff and file excerpts for logic bugs, off-by-one errors, unhandled failure modes, security issues, and regressions.",
    "2. Provide exact file/line references and drop-in fixes for every defect found.",
  ].join("\n"),
  math: [
    "Audit all quantitative claims, calculations, rates, and dollar figures.",
    "1. Check denominators, date ranges, unit conversions, rounding, and aggregation formulas.",
    "2. Flag any blended metrics or unverified claims.",
  ].join("\n"),
  prose: [
    "Audit this prose, documentation, or essay draft for clarity, factual precision, and structural rigor.",
    "1. Check that claims match attached evidence and that the tone matches the target audience.",
    "2. Flag any editorializing, internal workshop jargon, sensationalized titles, inline style attributes, or linter violations.",
  ].join("\n"),
  general: [
    "Provide a concise, independent second opinion on the problem, work, or question below.",
    "Identify mistakes or blind spots and state concrete recommendations.",
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
    const lines = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
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

let cachedLsConn = null;

async function discoverLsConnection() {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    return [
      {
        lsAddr: process.env.ANTIGRAVITY_LS_ADDRESS,
        csrf: process.env.ANTIGRAVITY_CSRF_TOKEN,
      },
    ];
  }
  if (cachedLsConn) return [cachedLsConn];

  try {
    const candidatePids = new Set([process.ppid]);
    const pgrepOut = await safeExecAsync("pgrep", ["-f", "language_server"], HOME, 2000);
    if (pgrepOut) {
      for (const p of pgrepOut.split(/\s+/)) {
        const num = Number(p);
        if (num > 0) candidatePids.add(num);
      }
    }

    const ssOut = await safeExecAsync("ss", ["-tlpn"], HOME, 2000);
    const candidates = [];

    for (const pid of candidatePids) {
      const cmdlinePath = `/proc/${pid}/cmdline`;
      if (!fs.existsSync(cmdlinePath)) continue;
      const cmdArgs = fs.readFileSync(cmdlinePath, "utf8").split("\0");
      const csrfIdx = cmdArgs.indexOf("--csrf_token");
      if (csrfIdx === -1 || !cmdArgs[csrfIdx + 1]) continue;
      const csrf = cmdArgs[csrfIdx + 1];

      if (ssOut) {
        for (const line of ssOut.split("\n")) {
          if (!line.includes(`pid=${pid},`)) continue;
          const m = line.match(/127\.0\.0\.1:(\d+)/);
          if (m) {
            candidates.push({ lsAddr: `127.0.0.1:${m[1]}`, csrf });
          }
        }
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

async function queryLiveQuotaPool() {
  const candidates = await discoverLsConnection();
  for (const { lsAddr, csrf } of candidates) {
    try {
      const res = await fetch(
        `http://${lsAddr}/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-codeium-csrf-token": csrf,
          },
          body: "{}",
          signal: AbortSignal.timeout(2000),
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      cachedLsConn = { lsAddr, csrf };
      const configs = data.clientModelConfigs || [];
      const claudeModel = configs.find((c) =>
        String(c.modelId || "").startsWith("claude-")
      );
      const geminiModel = configs.find((c) =>
        String(c.modelId || "").startsWith("gemini-")
      );
      return {
        claudeRemaining: claudeModel?.quotaInfo?.remainingFraction ?? null,
        claudeResetTime: claudeModel?.quotaInfo?.resetTime ?? null,
        geminiRemaining: geminiModel?.quotaInfo?.remainingFraction ?? null,
        geminiResetTime: geminiModel?.quotaInfo?.resetTime ?? null,
      };
    } catch {
      // Try next candidate port
    }
  }
  return null;
}

function sendDesktopToast(title, body) {
  try {
    const child = spawn(
      "notify-send",
      ["-a", "Antigravity Advisor", "-t", "5000", title, body],
      { stdio: "ignore", detached: true }
    );
    child.unref();
  } catch {
    // Ignore if notify-send is unavailable
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
  hourlyCallCount = 0,
  force = false
) {
  let key = String(tierOrModel || "auto").trim().toLowerCase();

  // Token-conscious auto-tiering:
  // - Default automatic checks use Claude Sonnet 5.5 (Medium) in 1-shot mode (~10x lighter on quota than Opus High)
  // - Use `deep` (Opus 5.5 Medium) or `opus-high` only when explicitly requested
  if (key === "auto") {
    if (focus === "math" || focus === "prose") {
      key = "sonnet-high";
    } else {
      key = "sonnet-medium";
    }
  }

  if (!force && hourlyCallCount >= HOURLY_DOWNSHIFT_THRESHOLD) {
    key = "sonnet-low";
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
    effort: explicitEffort || "medium",
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

  // Attach target file snippets directly in Node.js (0 model tool turns needed)
  const fileCapKb = Math.round(MAX_FILE_SNIPPET_BYTES / 1000);
  for (const filePath of resolvedFiles.slice(0, MAX_ATTACHED_FILES)) {
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const raw = fs.readFileSync(filePath, "utf8");
        const clipped =
          Buffer.byteLength(raw, "utf8") > MAX_FILE_SNIPPET_BYTES
            ? `${Buffer.from(raw, "utf8").subarray(0, MAX_FILE_SNIPPET_BYTES).toString("utf8")}\n... [truncated at ${fileCapKb} KB]`
            : raw;
        contextBlocks.push(
          `## File Content: ${filePath}\n\`\`\`\n${clipped}\n\`\`\``
        );
      }
    } catch {
      // Ignore unreadable files
    }
  }

  // Run deterministic ea-lint.mjs automatically if present and working under ~/sites
  const sitesWork =
    isUnderSites(resolvedWorkspace) || resolvedFiles.some((f) => isUnderSites(f));
  if ((focusKey === "prose" || sitesWork) && fs.existsSync(EA_LINT_PATH)) {
    const lintTargets =
      resolvedFiles.length > 0 ? resolvedFiles : [resolvedWorkspace];
    const lintOutputs = [];
    for (const target of lintTargets.slice(0, MAX_ATTACHED_FILES)) {
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
            `### ea-lint.mjs (${target})\n\`\`\`text\n${out.slice(0, 2500)}\n\`\`\``
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
      let [statusOut, untrackedOut, diffStatOut, diffOut] = await Promise.all([
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

      let diffLabel = "git diff HEAD";
      // If working tree has no tracked modifications (e.g. right after git commit or git pull),
      // automatically fall back to the latest commit (`git show HEAD`) so --diff still has real context.
      if (!diffOut && !untrackedOut) {
        const [headStatOut, headDiffOut] = await Promise.all([
          safeExecAsync(
            "git",
            ["show", "--stat", "--format=oneline", "HEAD"],
            resolvedWorkspace,
            5000
          ),
          safeExecAsync(
            "git",
            ["show", "--format=oneline", "HEAD"],
            resolvedWorkspace,
            6000
          ),
        ]);
        if (headDiffOut) {
          diffStatOut = headStatOut;
          diffOut = headDiffOut;
          diffLabel = "git show HEAD (working tree clean)";
        }
      }

      gitStatus = statusOut || "";
      gitUntracked = untrackedOut || "";
      gitDiff = diffOut || "";
      changedLineCount = countDiffChangedLines(gitDiff);

      const stateLines = [
        "## Workspace Git State",
        "```text",
        `git status --short:\n${gitStatus || "(clean)"}`,
        "",
        `${diffLabel} --stat:\n${diffStatOut || "(no tracked diff)"}`,
      ];
      if (gitUntracked) {
        stateLines.push("", `Untracked files:\n${gitUntracked}`);
      }
      stateLines.push("```");
      contextBlocks.push(stateLines.join("\n"));

      if (gitDiff) {
        const diffCapKb = Math.round(MAX_DIFF_BYTES / 1000);
        const clippedDiff =
          Buffer.byteLength(gitDiff, "utf8") > MAX_DIFF_BYTES
            ? `${Buffer.from(gitDiff, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n... [diff truncated at ${diffCapKb} KB]`
            : gitDiff;
        contextBlocks.push(
          [`## Git Diff Preview (${diffLabel})`, "```diff", clippedDiff, "```"].join(
            "\n"
          )
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
  contextBlocks,
}) {
  const coreSections = [
    "[ADVISOR REVIEW REQUEST — 1-SHOT MODE]",
    `Review Focus: ${focusKey.toUpperCase()} | Workspace: ${resolvedWorkspace}`,
    FOCUS_INSTRUCTIONS[focusKey],
    "",
    "## Task / Material Under Review",
    String(prompt || "").trim(),
    "",
    "## Required Output Format",
    "1. **Verdict**: `APPROVE`, `REVISE`, or `BLOCK` (1 sentence).",
    "2. **Mistakes & Risks Caught**: Numbered list ordered by severity (cite file/line or calculation).",
    "3. **Concrete Fixes**: Specific changes required.",
  ];

  let text = coreSections.join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
    const buf = Buffer.from(text, "utf8").subarray(0, MAX_PROMPT_BYTES - 128);
    return buf.toString("utf8") + "\n\n[Prompt truncated to fit byte budget.]";
  }

  for (const block of contextBlocks) {
    const candidate = `${text}\n\n${block}`;
    if (Buffer.byteLength(candidate, "utf8") > MAX_PROMPT_BYTES) {
      text += "\n\n[Additional context omitted to conserve token quota.]";
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
  timeoutMs = 60000,
  signal,
}) {
  if (process.env.AGY_ADVISOR_ACTIVE === "1") {
    return {
      isError: true,
      text: "Advisor recursion blocked: AGY_ADVISOR_ACTIVE=1 is already set in this environment.",
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
      text: `> [!NOTE] **Advisor Skipped (0 tokens used)** — Diff in \`${ctx.resolvedWorkspace}\` has ${ctx.changedLineCount} changed line(s) (<${TRIVIAL_DIFF_CHANGED_LINES}-line threshold).`,
    };
  }

  // Token Guard 2: Live Quota Floor Check (<35% remaining skips automatic calls)
  const preQuota = await queryLiveQuotaPool();
  if (
    !force &&
    preQuota &&
    typeof preQuota.claudeRemaining === "number" &&
    preQuota.claudeRemaining < QUOTA_FLOOR_FRACTION
  ) {
    const pct = (preQuota.claudeRemaining * 100).toFixed(1);
    return {
      isError: false,
      text: `> [!WARNING] **Advisor Quota Guard (0 tokens used)** — Claude subscription pool is at ${pct}% (<${QUOTA_FLOOR_FRACTION * 100}% floor). Skipping automatic advisor call to preserve your quota. Pass \`--force\` to override.`,
    };
  }

  // Check recent call history for rate limiting & cooldown
  const recentHourLogs = readRecentLogs(60 * 60 * 1000);

  // Token Guard 3: Hourly Hard Cap
  if (!force && recentHourLogs.length >= HOURLY_HARD_CAP) {
    return {
      isError: false,
      text: `> [!WARNING] **Advisor Hourly Cap Reached (0 tokens used)** — ${recentHourLogs.length}/${HOURLY_HARD_CAP} calls used in the last 60 minutes. Skipping automatic call. Pass \`--force\` to override.`,
    };
  }

  const { model, effort: resolvedEffort, label } = resolveTierAndModel(
    tier,
    effort,
    ctx.focusKey,
    recentHourLogs.length,
    force
  );

  // Token Guard 4: Exact-Match Deduplication Cache (0 tokens spent)
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
        text: `${cachedText}\n\n*(Served from 60m deduplication cache — 0 additional tokens used.)*`,
      };
    }

    // Token Guard 5: Per-Workspace Cooldown (120s)
    const lastWorkspaceCall = [...recentHourLogs]
      .reverse()
      .find((entry) => entry.workspace === ctx.resolvedWorkspace);
    if (lastWorkspaceCall && Date.now() - lastWorkspaceCall.ts < COOLDOWN_MS) {
      const agoSec = Math.round((Date.now() - lastWorkspaceCall.ts) / 1000);
      return {
        isError: false,
        text: `> [!NOTE] **Advisor Cooldown Active (0 tokens used)** — Audited \`${ctx.resolvedWorkspace}\` ${agoSec}s ago (cooldown: ${COOLDOWN_MS / 1000}s). Apply previous feedback without re-polling.`,
      };
    }
  }

  const fullPrompt = buildAdvisorPrompt({
    prompt,
    focusKey: ctx.focusKey,
    resolvedWorkspace: ctx.resolvedWorkspace,
    contextBlocks: ctx.contextBlocks,
  });

  const printTimeoutSec = Math.max(25, Math.floor(timeoutMs / 1000) - 5);
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
    `-p=${fullPrompt}`,
  ];

  // Fire visible desktop toast so the user sees immediately when the advisor runs
  sendDesktopToast(
    `Advisor Running: ${label}`,
    `Focus: ${ctx.focusKey} | ${path.basename(ctx.resolvedWorkspace)}`
  );

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

    child.on("close", async (code, exitSignal) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - startTime;
      const cleanOut = stdout.trim();
      const cleanErr = stderr.trim();

      const postQuota = await queryLiveQuotaPool();
      const claudeRemainingPct =
        postQuota && typeof postQuota.claudeRemaining === "number"
          ? `${(postQuota.claudeRemaining * 100).toFixed(1)}%`
          : null;
      const quotaDeltaPct =
        preQuota &&
        postQuota &&
        typeof preQuota.claudeRemaining === "number" &&
        typeof postQuota.claudeRemaining === "number"
          ? `${Math.max(0, (preQuota.claudeRemaining - postQuota.claudeRemaining) * 100).toFixed(2)}%`
          : null;

      const verdictMatch =
        cleanOut.match(
          /(?:\*\*Verdict\*\*|Verdict)\s*:\s*`?(APPROVE|REVISE|BLOCK)`?/i
        ) || cleanOut.match(/\b(APPROVE|REVISE|BLOCK)\b/);
      const verdict = aborted
        ? "ABORTED"
        : timedOut
          ? "TIMEOUT"
          : verdictMatch
            ? verdictMatch[1].toUpperCase()
            : "UNKNOWN";

      appendAuditLog({
        timestamp: new Date().toISOString(),
        model,
        effort: resolvedEffort,
        focus: ctx.focusKey,
        workspace: ctx.resolvedWorkspace,
        promptSummary: String(prompt).trim().replace(/\s+/g, " ").slice(0, 140),
        durationMs,
        exitCode: code,
        verdict,
        claudeRemainingPct,
        quotaDeltaPct,
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

      const quotaNote = claudeRemainingPct
        ? ` | Claude Quota: ${claudeRemainingPct} left${quotaDeltaPct ? ` (-${quotaDeltaPct})` : ""}`
        : "";
      const banner = [
        `> [!NOTE] **Advisor Called — ${label}**`,
        `> - **Focus**: \`${ctx.focusKey}\` | **Workspace**: \`${ctx.resolvedWorkspace}\` | **Time**: ${(durationMs / 1000).toFixed(1)}s${quotaNote}`,
        `> - **Why**: ${String(prompt).trim().replace(/\s+/g, " ").slice(0, 120)}`,
        `> - **Verdict**: \`${verdict}\``,
      ].join("\n");

      const fullResponse = `${banner}\n\n${cleanOut}`;
      writeResponseCache(cacheKey, fullResponse);
      resolve({
        isError: false,
        text: fullResponse,
      });
    });
  });
}

export async function checkAdvisorQuota() {
  const [rawModels, liveQuota] = await Promise.all([
    safeExecAsync(AGY_BIN, ["models"], HOME, 10000),
    queryLiveQuotaPool(),
  ]);

  const lines = (rawModels || "(failed to query agy models)")
    .split(/\r?\n/)
    .map((l) => l.replace(/^.*Fetching available models\.\.\.\s*/, "").trim())
    .filter(Boolean);

  const recentHourLogs = readRecentLogs(60 * 60 * 1000);
  const allRecentLogs = readRecentLogs(24 * 60 * 60 * 1000).slice(-10);

  const sections = ["### 1. Live Subscription Quota Status"];
  if (liveQuota) {
    const geminiPct =
      typeof liveQuota.geminiRemaining === "number"
        ? `${(liveQuota.geminiRemaining * 100).toFixed(1)}%`
        : "unknown";
    const claudePct =
      typeof liveQuota.claudeRemaining === "number"
        ? `${(liveQuota.claudeRemaining * 100).toFixed(1)}%`
        : "unknown";
    sections.push(
      `- **Gemini Pool** (Argon / Flash): **${geminiPct} remaining** (resets \`${liveQuota.geminiResetTime || "unknown"}\`)`,
      `- **Claude & Third-Party Pool** (Opus 5.5 / Sonnet 5.5 / GPT-OSS): **${claudePct} remaining** (resets \`${liveQuota.claudeResetTime || "unknown"}\`)`
    );
  } else {
    sections.push(
      "*(Run inside an active Antigravity session to read live percentage bars, or check `/quota` in `agy`.)*"
    );
  }

  sections.push(
    "",
    "### 2. Recent Advisor Calls (What Used Your Tokens)",
    `Calls in last 60 minutes: **${recentHourLogs.length}/${HOURLY_HARD_CAP}** (Floor guard: stops automatic calls below ${QUOTA_FLOOR_FRACTION * 100}% quota)`
  );

  if (allRecentLogs.length === 0) {
    sections.push("No advisor calls logged in the last 24 hours.");
  } else {
    sections.push(
      "",
      "| Time (UTC) | Model | Focus | Duration | Verdict | Quota Left (Delta) | What It Was Used On |",
      "| --- | --- | --- | --- | --- | --- | --- |"
    );
    for (const entry of allRecentLogs) {
      const timeStr = (entry.timestamp || "").slice(11, 19);
      const durStr = entry.durationMs
        ? `${(entry.durationMs / 1000).toFixed(1)}s`
        : "-";
      const quotaStr = entry.claudeRemainingPct
        ? `${entry.claudeRemainingPct}${entry.quotaDeltaPct ? ` (-${entry.quotaDeltaPct})` : ""}`
        : "(pre-telemetry)";
      const summary =
        entry.promptSummary || path.basename(entry.workspace || "unknown");
      sections.push(
        `| \`${timeStr}\` | \`${entry.model}\` | \`${entry.focus}\` | ${durStr} | \`${entry.verdict}\` | ${quotaStr} | ${summary} |`
      );
    }
  }

  sections.push(
    "",
    "### 3. Configured Tiers (`--tier`)",
    "- `auto` (Default, 1-shot no-tool mode): Uses `claude-sonnet-5-5-medium` for `code`/`plan`/`general` and `claude-sonnet-5-5-high` for `math`/`prose` (~10x lighter on quota than multi-turn Opus)",
    "- `deep` / `opus`: `claude-opus-5-5-medium` (1-shot Opus)",
    "- `opus-high`: `claude-opus-5-5-high` (Heavy Opus — use only when explicitly requested)",
    "- `fast` / `sonnet`: `claude-sonnet-5-5-medium`",
    "",
    "### 4. Available Subscription Models (`agy models`)",
    "```text",
    ...lines,
    "```"
  );

  return {
    isError: false,
    text: sections.join("\n"),
  };
}
