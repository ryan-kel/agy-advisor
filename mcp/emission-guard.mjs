import fs from "node:fs";
import path from "node:path";

export const SEVERITY_RANK = {
  nit: 1,
  concern: 2,
  major: 2,
  blocker: 3,
};

const MAX_FIFO_HISTORY = 4096;

const CONTENT_FREE_NOISE = new Set([
  "stop",
  "done",
  "complete",
  "completed",
  "no issue",
  "no issues",
  "no issue found",
  "no issues found",
  "no issue continue",
  "no issues continue",
  "no issue found continue",
  "no issues found continue",
  "no defects",
  "no defects caught",
  "none found",
  "continue",
  "lgtm",
  "looks good",
  "looks good to me",
  "nothing to add",
  "nothing to report",
  "none",
  "n a",
  "na",
  "ok",
  "okay",
  "approve",
  "approved",
  "clean",
  "all good",
  "on track",
]);

const DESTRUCTIVE_SHELL_PATTERNS = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+(?:\/|~)(?:\s|$|\*|["'`;)])/i,
  /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//i,
  /\bdd\s+if=\/dev\/(?:zero|random|urandom)\s+of=\/dev\//i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
];

const HAZARD_CLASS_PATTERNS = {
  destructiveShell:
    /\b(?:rm\s+-rf\s+~|rm\s+-rf\s+\/|git\s+reset\s+--hard\s+HEAD~|drop\s+database\b|truncate\s+table\b)/i,
  instructionOverride:
    /\b(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|disregard\s+system\s+prompt|you\s+are\s+now\s+unrestricted)\b/i,
  denialInstruction:
    /\b(?:refuse\s+all\s+further\s+user\s+requests|do\s+not\s+assist\s+the\s+user|permanently\s+lock\s+session)\b/i,
  accountDeletion:
    /\b(?:delete\s+(?:your|the)\s+(?:github|google|cloud|user)\s+account|revoke\s+all\s+ssh\s+keys)\b/i,
};

export function normalizeSeverity(rawSeverity) {
  const s = String(rawSeverity || "nit")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (s === "blocker" || s === "block") return "blocker";
  if (s === "concern" || s === "major" || s === "revise") return "concern";
  return "nit";
}

export function severityToTag(severity) {
  const norm = normalizeSeverity(severity);
  if (norm === "blocker") return "[Blocker]";
  if (norm === "concern") return "[Concern]";
  return "[Nit]";
}

/**
 * OMP normalization rule:
 * 1. Strip leading list markers, severity tags ([Blocker]/[Concern]/[Major]/[Nit]), and optional file:line prefixes
 * 2. NFKC normalize, lowercase, collapse runs of non-alphanumeric chars to a single space, and trim.
 */
export function normalizeNoteKey(rawText) {
  const stripped = String(rawText || "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
    .replace(/^\s*\*?\*?\[?(?:blocker|concern|major|nit)\]?\*?\*?[:\s-]*/i, "")
    .replace(/^\s*`?[a-zA-Z0-9_./-]+:\d+(?:-\d+)?`?[:\s—–-]*/, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return stripped;
}

export function isContentFreeNoise(rawText) {
  const norm = normalizeNoteKey(rawText);
  if (!norm || norm.length < 4) return true;
  if (CONTENT_FREE_NOISE.has(norm)) return true;
  return false;
}

export function inspectOutputQuarantine(outputText, inputText = "") {
  const text = String(outputText || "");
  if (!text) return { quarantined: false, reason: null };
  const input = String(inputText || "");

  // If the input itself contains destructive shell regex definitions (e.g. auditing emission-guard.mjs),
  // treat destructiveShell as already present in input so regex examples in the review are not false-flagged.
  const inputDiscussesDestructiveRegex =
    /DESTRUCTIVE_SHELL_PATTERNS|HAZARD_CLASS_PATTERNS|\\brm\\s\+-\[a-zA-Z\]\*r/.test(
      input
    );

  if (!inputDiscussesDestructiveRegex) {
    for (const pat of DESTRUCTIVE_SHELL_PATTERNS) {
      if (pat.test(text) && !pat.test(input)) {
        return {
          quarantined: true,
          reason: "output-only destructive shell directive detected",
        };
      }
    }
  }

  let matchedClasses = 0;
  for (const [clsName, pat] of Object.entries(HAZARD_CLASS_PATTERNS)) {
    if (clsName === "destructiveShell" && inputDiscussesDestructiveRegex) {
      continue;
    }
    if (pat.test(text) && !pat.test(input)) {
      matchedClasses++;
    }
  }
  if (matchedClasses >= 3) {
    return {
      quarantined: true,
      reason: `${matchedClasses} output-only hazard classes matched`,
    };
  }
  if (
    HAZARD_CLASS_PATTERNS.instructionOverride.test(text) &&
    !HAZARD_CLASS_PATTERNS.instructionOverride.test(input) &&
    HAZARD_CLASS_PATTERNS.destructiveShell.test(input)
  ) {
    return {
      quarantined: true,
      reason: "instruction override paired with destructive command in input",
    };
  }

  return { quarantined: false, reason: null };
}

/**
 * Extract structured findings from advisor markdown or <advisory> XML blocks.
 */
export function extractAdvisorFindings(rawOutput) {
  const text = String(rawOutput || "");
  const findings = [];

  // 1. Parse explicit <advisory ...>...</advisory> blocks if present
  const advisoryRegex =
    /<advisory\b([^>]*)>([\s\S]*?)<\/advisory>/gi;
  let match;
  while ((match = advisoryRegex.exec(text)) !== null) {
    const attrs = match[1] || "";
    const body = (match[2] || "").trim();
    const sevMatch = attrs.match(/\bseverity=["']?(blocker|concern|major|nit)["']?/i);
    const advMatch = attrs.match(/\badvisor=["']?([^"'>\s]+)["']?/i);
    const severity = normalizeSeverity(sevMatch ? sevMatch[1] : "nit");
    if (body) {
      findings.push({
        severity,
        rank: SEVERITY_RANK[severity],
        advisor: advMatch ? advMatch[1] : undefined,
        text: body,
        key: normalizeNoteKey(body),
      });
    }
  }

  // 2. Parse markdown bullet/numbered lines tagged with [Blocker], [Concern], [Major], or [Nit]
  const lines = text.split(/\r?\n/);
  let currentFinding = null;
  let inDefectsSection = false;

  for (const line of lines) {
    if (/^#{1,3}\s+.*(?:Defects Caught|Findings|Advisories)/i.test(line) || /^\s*2\.\s+\*\*Defects Caught\*\*/i.test(line)) {
      inDefectsSection = true;
      continue;
    }
    if (inDefectsSection && (/^#{1,3}\s+.*(?:Concrete Fixes|Resolution)/i.test(line) || /^\s*3\.\s+\*\*Concrete Fixes\*\*/i.test(line))) {
      if (currentFinding) {
        findings.push(currentFinding);
        currentFinding = null;
      }
      inDefectsSection = false;
      continue;
    }

    const tagMatch = line.match(
      /^\s*(?:[-*+]|\d+[.)])?\s*\*?\*?\[(Blocker|Concern|Major|Nit)\]\*?\*?\s*(.+)$/i
    );
    if (tagMatch) {
      if (currentFinding) {
        findings.push(currentFinding);
      }
      const severity = normalizeSeverity(tagMatch[1]);
      const body = tagMatch[2].trim();
      currentFinding = {
        severity,
        rank: SEVERITY_RANK[severity],
        text: body,
        key: normalizeNoteKey(body),
      };
    } else if (
      currentFinding &&
      inDefectsSection &&
      /^\s{2,}(?:[-*+]|\*\*|[a-zA-Z0-9`])/.test(line)
    ) {
      currentFinding.text += `\n${line.trim()}`;
    } else if (currentFinding && line.trim() === "") {
      findings.push(currentFinding);
      currentFinding = null;
    }
  }
  if (currentFinding) {
    findings.push(currentFinding);
  }

  // Deduplicate identical keys within the same raw output, keeping highest severity
  const byKey = new Map();
  for (const f of findings) {
    if (!f.key || isContentFreeNoise(f.text)) continue;
    const prev = byKey.get(f.key);
    if (!prev || f.rank > prev.rank) {
      byKey.set(f.key, f);
    }
  }
  return Array.from(byKey.values());
}

function getEmissionStatePath(dataDir) {
  return path.join(dataDir, "emission-state.json");
}

export function loadEmissionState(dataDir) {
  const filePath = getEmissionStatePath(dataDir);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    }
  } catch {
    // Ignore corrupted state
  }
  return { workspaces: {} };
}

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  try {
    Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
  } catch {
    // Fallback if Atomics.wait is unavailable
  }
}

function mergeWorkspaceEntry(diskWs = {}, memWs = {}) {
  const diskHist = Array.isArray(diskWs.history) ? diskWs.history : [];
  const memHist = Array.isArray(memWs.history) ? memWs.history : [];
  const histByKey = new Map();
  for (const item of [...diskHist, ...memHist]) {
    if (!item || !item.key) continue;
    const prev = histByKey.get(item.key);
    if (!prev || (item.rank || 1) >= (prev.rank || 1)) {
      histByKey.set(item.key, item);
    }
  }
  const mergedHistory = Array.from(histByKey.values()).slice(-MAX_FIFO_HISTORY);
  return {
    ...diskWs,
    ...memWs,
    history: mergedHistory,
    lastReviewedStepIndex: Math.max(
      diskWs.lastReviewedStepIndex || 0,
      memWs.lastReviewedStepIndex || 0
    ),
    turnCount: Math.max(diskWs.turnCount || 0, memWs.turnCount || 0),
  };
}

function acquireStateLock(lockPath, maxWaitMs = 1200) {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, token, "utf8");
      fs.closeSync(fd);
      return token;
    } catch (err) {
      if (err && err.code && err.code !== "EEXIST") {
        return null;
      }
      try {
        const st1 = fs.statSync(lockPath);
        if (Date.now() - st1.mtimeMs > 5000) {
          const staleTmp = `${lockPath}.stale.${process.pid}.${Date.now()}`;
          try {
            fs.renameSync(lockPath, staleTmp);
            const moved = fs.statSync(staleTmp);
            if (moved.ino !== st1.ino || moved.mtimeMs !== st1.mtimeMs) {
              try {
                fs.linkSync(staleTmp, lockPath);
              } catch {}
            }
          } catch {} finally {
            try {
              if (fs.existsSync(staleTmp)) fs.unlinkSync(staleTmp);
            } catch {}
          }
          continue;
        }
      } catch {
        // Lock was just released; retry immediately
        continue;
      }
      sleepSync(15);
    }
  }
  return null;
}

function releaseStateLock(lockPath, token) {
  if (!token) return;
  try {
    if (fs.existsSync(lockPath)) {
      const current = fs.readFileSync(lockPath, "utf8").trim();
      if (current === token) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // Ignore release error
  }
}

export function updateEmissionState(dataDir, mutator) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = getEmissionStatePath(dataDir);
  const lockPath = `${filePath}.lock`;
  const token = acquireStateLock(lockPath);
  try {
    const state = loadEmissionState(dataDir);
    if (!state.workspaces) state.workspaces = {};
    const beforeKeys = new Set(Object.keys(state.workspaces));
    mutator(state);
    const removedKeys = [...beforeKeys].filter((k) => !(k in state.workspaces));

    let toWrite = state;
    if (!token) {
      // If lock timed out, merge field-wise with latest on-disk state before rename
      const latestOnDisk = loadEmissionState(dataDir);
      const mergedWorkspaces =
        Object.keys(state.workspaces).length === 0 && beforeKeys.size > 0
          ? {}
          : { ...(latestOnDisk.workspaces || {}) };
      for (const rk of removedKeys) {
        delete mergedWorkspaces[rk];
      }
      for (const [wsKey, wsVal] of Object.entries(state.workspaces)) {
        if (!wsVal) {
          delete mergedWorkspaces[wsKey];
        } else {
          mergedWorkspaces[wsKey] = mergeWorkspaceEntry(
            mergedWorkspaces[wsKey],
            wsVal
          );
        }
      }
      toWrite = { ...latestOnDisk, ...state, workspaces: mergedWorkspaces };
    }

    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
    return toWrite;
  } catch {
    return loadEmissionState(dataDir);
  } finally {
    releaseStateLock(lockPath, token);
  }
}

export function saveEmissionState(dataDir, state) {
  updateEmissionState(dataDir, (current) => {
    if (!state || !state.workspaces) return;
    for (const [wsKey, wsVal] of Object.entries(state.workspaces)) {
      if (!wsVal) {
        delete current.workspaces[wsKey];
      } else {
        current.workspaces[wsKey] = mergeWorkspaceEntry(
          current.workspaces[wsKey],
          wsVal
        );
      }
    }
  });
}

export function resetEmissionState(dataDir, workspaceKey = null) {
  updateEmissionState(dataDir, (state) => {
    if (workspaceKey) {
      delete state.workspaces[workspaceKey];
    } else {
      state.workspaces = {};
    }
  });
}

export function getRecentDeliveredAdvisories(dataDir, workspaceKey, limit = 8) {
  const state = loadEmissionState(dataDir);
  const ws = state.workspaces?.[workspaceKey];
  if (!ws || !Array.isArray(ws.history)) return [];
  return ws.history.slice(-limit);
}

/**
 * OMP AdvisorEmissionGuard:
 * 1. Canonical NFKC normalization
 * 2. Content-free phrase filter
 * 3. Severity-aware deduplication (FIFO 4096 entries; only re-raises if escalated to higher severity, e.g. concern -> blocker)
 * 4. Per-update rank budget (maxNotesPerUpdate non-blockers, default 4; blockers exempt, higher severity displaces lowest pending non-blocker)
 */
export function runEmissionGuard({
  dataDir,
  workspaceKey,
  findings,
  maxNotesPerUpdate = 4,
}) {
  const acceptedBlockers = [];
  const candidateNonBlockers = [];
  let acceptedNonBlockers = [];
  let accepted = [];
  const suppressedDuplicates = [];
  const suppressedBudget = [];
  const suppressedNoise = [];

  // First deduplicate within the same call (keeping the highest severity per normalized key)
  const dedupedCallMap = new Map();
  for (const finding of findings) {
    if (!finding || isContentFreeNoise(finding.text)) {
      suppressedNoise.push(finding);
      continue;
    }
    const key = finding.key || normalizeNoteKey(finding.text);
    if (!key) {
      suppressedNoise.push(finding);
      continue;
    }
    const severity = normalizeSeverity(finding.severity);
    const rank = SEVERITY_RANK[severity] || 1;
    const existing = dedupedCallMap.get(key);
    if (!existing || rank > existing.rank) {
      if (existing) {
        suppressedDuplicates.push({
          ...existing,
          reason: `same-call duplicate of ${severity}`,
        });
      }
      dedupedCallMap.set(key, { ...finding, severity, key, rank });
    } else {
      suppressedDuplicates.push({
        ...finding,
        reason: `same-call duplicate of ${existing.severity}`,
      });
    }
  }

  updateEmissionState(dataDir, (state) => {
    if (!state.workspaces[workspaceKey]) {
      state.workspaces[workspaceKey] = {
        history: [],
        quarantineCount: 0,
        turnsSinceLastSteer: 999,
        turnCount: 0,
        lastReviewedStepIndex: 0,
      };
    }
    const wsState = state.workspaces[workspaceKey];
    if (!Array.isArray(wsState.history)) wsState.history = [];

    const historyMap = new Map();
    for (const item of wsState.history) {
      if (item && item.key) {
        historyMap.set(item.key, item);
      }
    }

    for (const finding of dedupedCallMap.values()) {
      const { key, rank } = finding;
      const prev = historyMap.get(key);

      // OMP dedupe rule: drop repeated normalized note at equal or lower severity.
      // Permit re-raising prior non-blocker advice only when escalated (e.g. to blocker).
      if (prev && rank <= (prev.rank || 1)) {
        suppressedDuplicates.push({
          ...finding,
          reason: `duplicate of prior ${prev.severity}`,
        });
        continue;
      }

      if (finding.severity === "blocker") {
        acceptedBlockers.push(finding);
      } else {
        candidateNonBlockers.push(finding);
      }
    }

    // Sort non-blockers by rank descending (concern before nit)
    candidateNonBlockers.sort((a, b) => b.rank - a.rank);

    const budgetCap = Math.min(Math.max(Number(maxNotesPerUpdate) || 4, 1), 32);
    acceptedNonBlockers = candidateNonBlockers.slice(0, budgetCap);
    if (candidateNonBlockers.length > budgetCap) {
      suppressedBudget.push(...candidateNonBlockers.slice(budgetCap));
    }

    accepted = [...acceptedBlockers, ...acceptedNonBlockers];
    const nowIso = new Date().toISOString();

    for (const item of accepted) {
      const existingIdx = wsState.history.findIndex((h) => h.key === item.key);
      if (existingIdx !== -1) {
        wsState.history.splice(existingIdx, 1);
      }
      wsState.history.push({
        key: item.key,
        severity: item.severity,
        rank: item.rank,
        summary: item.text.split("\n")[0].slice(0, 220),
        timestamp: nowIso,
      });
    }

    if (wsState.history.length > MAX_FIFO_HISTORY) {
      wsState.history = wsState.history.slice(-MAX_FIFO_HISTORY);
    }
  });

  return {
    accepted,
    acceptedBlockers,
    acceptedConcerns: acceptedNonBlockers.filter((f) => f.severity === "concern"),
    acceptedNits: acceptedNonBlockers.filter((f) => f.severity === "nit"),
    suppressedDuplicates,
    suppressedBudget,
    suppressedNoise,
  };
}

function escapeXmlAttr(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatAdvisoryXml(finding, defaultAdvisorName = null) {
  const severity = normalizeSeverity(finding.severity);
  const advisorName = finding.advisor || defaultAdvisorName;
  const advisorAttr = advisorName
    ? ` advisor="${escapeXmlAttr(advisorName)}"`
    : "";
  const turnsAgoAttr =
    typeof finding.turnsAgo === "number" && finding.turnsAgo > 0
      ? ` turns_ago="${finding.turnsAgo}"`
      : "";
  return [
    `<advisory${advisorAttr} severity="${severity}"${turnsAgoAttr} guidance="weigh, don't blindly obey">`,
    String(finding.text || "").trim(),
    `</advisory>`,
  ].join("\n");
}
