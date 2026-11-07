import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const MAX_DELTA_BYTES = 28_000;

const SECRET_PATTERNS = [
  /\b(sk-[a-zA-Z0-9_-]{20,})\b/g,
  /\b(gh[pousr]_[a-zA-Z0-9]{20,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{30,})\b/g,
  /\b(xox[baprs]-[0-9a-zA-Z-]{16,})\b/g,
  /\b(eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})\b/g,
  /(--csrf_token(?:=|\s+))([a-f0-9-]{16,})/gi,
  /(x-codeium-csrf-token["'\s:]+)([a-f0-9-]{16,})/gi,
];

export function obfuscateSecrets(str) {
  let out = String(str || "");
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, (full, g1, g2) => {
      if (typeof g2 === "string") return `${g1}[REDACTED_SECRET]`;
      return `${String(g1).slice(0, 5)}...[REDACTED_SECRET]`;
    });
  }
  return out;
}

export function stripPriorAdvisorBlocks(str) {
  return String(str || "")
    .replace(/<advisory\b[\s\S]*?<\/advisory>/gi, "[prior advisory omitted]")
    .replace(
      /(?:^|\n)> \[!NOTE\] \*\*Advisor Called[^\n]*(?:\n>[^\n]*)*/g,
      "\n[prior advisor banner omitted]"
    )
    .trim();
}

/**
 * Locate the active or most recent Antigravity transcript.jsonl if not explicitly provided.
 */
export function resolveTranscriptPath(explicitTranscriptPath, conversationId) {
  if (explicitTranscriptPath && fs.existsSync(explicitTranscriptPath)) {
    return explicitTranscriptPath;
  }
  const brainDir = path.join(HOME, ".gemini/antigravity/brain");
  if (conversationId) {
    const candidate = path.join(
      brainDir,
      conversationId,
      ".system_generated/logs/transcript.jsonl"
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Render an OMP-style incremental transcript delta from Antigravity's transcript.jsonl.
 * - Filters out prior advisor injections (<advisory> and Advisor Called banners)
 * - Obfuscates credentials/tokens
 * - Evicts stale read/grep/find tool results from older steps when evictStaleResults is true
 * - Marks whether the primary agent is [in progress — more steps follow] or [turn yielded]
 */
export function buildTranscriptDelta({
  transcriptPath,
  sinceStepIndex = 0,
  includeReasoning = true,
  evictStaleResults = true,
  maxSteps = 24,
  maxBytes = MAX_DELTA_BYTES,
}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(transcriptPath, "utf8");
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return null;

    const steps = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.step_index === "number") {
          steps.push(parsed);
        }
      } catch {
        // Ignore malformed JSONL line
      }
    }

    if (steps.length === 0) return null;

    const latestStepIndex = steps[steps.length - 1].step_index;
    const filtered = steps
      .filter((s) => s.step_index > sinceStepIndex)
      .slice(-maxSteps);

    if (filtered.length === 0) {
      return {
        latestStepIndex,
        hasMutatingToolCalls: false,
        hasAdvisorCallInDelta: false,
        inProgress: false,
        deltaText: "",
      };
    }

    // Identify the boundary of the latest planner turn for stale tool-result eviction
    let lastPlannerIdx = -1;
    for (let i = filtered.length - 1; i >= 0; i--) {
      if (filtered[i].type === "PLANNER_RESPONSE") {
        lastPlannerIdx = i;
        break;
      }
    }

    let hasMutatingToolCalls = false;
    let hasAdvisorCallInDelta = false;
    let lastStepAllInvestigative = false;
    let lastInvestigativeLabel = "investigative";
    const INVESTIGATIVE_SET = new Set([
      "read_file",
      "grep_search",
      "find_by_name",
      "list_dir",
    ]);

    const renderedEntries = [];

    for (let i = 0; i < filtered.length; i++) {
      const step = filtered[i];
      const isOlderTurn = lastPlannerIdx !== -1 && i < lastPlannerIdx;

      if (step.type === "USER_INPUT") {
        lastStepAllInvestigative = false;
        const content = obfuscateSecrets(stripPriorAdvisorBlocks(step.content));
        if (content) {
          renderedEntries.push(
            `[Step ${step.step_index} | USER]: ${content.slice(0, 1200)}`
          );
        }
        continue;
      }

      if (step.type === "PLANNER_RESPONSE") {
        const parts = [];
        if (includeReasoning && step.thinking) {
          const cleanThinking = obfuscateSecrets(
            stripPriorAdvisorBlocks(step.thinking)
          );
          if (cleanThinking) {
            const limit = isOlderTurn && evictStaleResults ? 240 : 800;
            parts.push(`_thinking:_ ${cleanThinking.slice(0, limit)}`);
          }
        }
        if (step.content) {
          const cleanContent = obfuscateSecrets(
            stripPriorAdvisorBlocks(step.content)
          );
          if (cleanContent) {
            parts.push(`response: ${cleanContent.slice(0, 1200)}`);
          }
        }
        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
          const callSummaries = [];
          let allInvestigative = true;
          const names = [];
          for (const tc of step.tool_calls) {
            const name = tc.name || "unknown_tool";
            names.push(name);
            if (!INVESTIGATIVE_SET.has(name)) {
              allInvestigative = false;
            }
            if (
              name === "edit_file" ||
              name === "write_file" ||
              name === "run_command"
            ) {
              hasMutatingToolCalls = true;
            }
            if (
              name.includes("consult_advisor") ||
              (name === "run_command" &&
                String(tc.args?.CommandLine || "").includes("advisor-consult"))
            ) {
              hasAdvisorCallInDelta = true;
            }
            const argsPreview = obfuscateSecrets(
              JSON.stringify(tc.args || {})
            ).slice(0, 260);
            callSummaries.push(`${name}(${argsPreview})`);
          }
          lastStepAllInvestigative = allInvestigative;
          lastInvestigativeLabel = Array.from(new Set(names)).join("+");
          parts.push(`tool_calls: ${callSummaries.join(", ")}`);
        } else {
          lastStepAllInvestigative = false;
        }
        if (parts.length > 0) {
          renderedEntries.push(
            `[Step ${step.step_index} | AGENT]:\n  ${parts.join("\n  ")}`
          );
        }
        continue;
      }

      if (step.type === "GENERIC" && step.content) {
        if (evictStaleResults && isOlderTurn && lastStepAllInvestigative) {
          renderedEntries.push(
            `[Step ${step.step_index} | Tool result]: [stale ${lastInvestigativeLabel} output evicted]`
          );
          continue;
        }
        const cleanResult = obfuscateSecrets(
          stripPriorAdvisorBlocks(step.content)
        );
        if (cleanResult) {
          const clipped =
            cleanResult.length > 900
              ? `${cleanResult.slice(0, 900)}... [elided]`
              : cleanResult;
          renderedEntries.push(
            `[Step ${step.step_index} | Tool result]: ${clipped}`
          );
        }
      }
    }

    const tailStep = filtered[filtered.length - 1];
    const inProgress =
      tailStep.type === "PLANNER_RESPONSE" &&
      Array.isArray(tailStep.tool_calls) &&
      tailStep.tool_calls.length > 0;
    const statusHeader = inProgress
      ? "[in progress — more steps follow]"
      : "[turn yielded — terminal or checkpoint boundary]";

    let body = `${statusHeader}\n${renderedEntries.join("\n\n")}`;
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      const prefix = `${statusHeader}\n... [earlier steps elided]\n`;
      const prefixBytes = Buffer.byteLength(prefix, "utf8");
      const tailBudget = Math.max(256, maxBytes - prefixBytes);
      const buf = Buffer.from(body, "utf8");
      let startOffset = Math.max(0, buf.length - tailBudget);
      // Advance past any UTF-8 continuation bytes (10xxxxxx) so we start on a valid codepoint boundary
      while (startOffset < buf.length && (buf[startOffset] & 0xc0) === 0x80) {
        startOffset++;
      }
      body = `${prefix}${buf.subarray(startOffset).toString("utf8")}`;
    }

    return {
      latestStepIndex,
      hasMutatingToolCalls,
      hasAdvisorCallInDelta,
      inProgress,
      deltaText: body,
    };
  } catch {
    return null;
  }
}

export function appendAdvisorTranscript(dataDir, advisorSlug, entry) {
  try {
    // Support both (dataDir, advisorSlug, entry) and (dataDir, entry, advisorSlug)
    let resolvedEntry = entry;
    let resolvedSlug = advisorSlug;
    if (advisorSlug && typeof advisorSlug === "object" && !entry) {
      resolvedEntry = advisorSlug;
      resolvedSlug = null;
    } else if (advisorSlug && typeof advisorSlug === "object" && typeof entry === "string") {
      resolvedEntry = advisorSlug;
      resolvedSlug = entry;
    }
    const dir = path.join(dataDir, "transcripts");
    fs.mkdirSync(dir, { recursive: true });
    const safeSlug = resolvedSlug
      ? String(resolvedSlug)
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "")
      : "";
    const filename = safeSlug
      ? `__advisor.${safeSlug}.jsonl`
      : "__advisor.jsonl";
    const filePath = path.join(dir, filename);
    fs.appendFileSync(filePath, JSON.stringify(resolvedEntry) + "\n", "utf8");
  } catch {
    // Ignore transcript persistence errors
  }
}

export function dumpAdvisorTranscript(
  dataDir,
  advisorOrOpts = null,
  rawArg = false,
  limitArg = 10
) {
  let raw = Boolean(rawArg);
  let limit = Number(limitArg) || 10;
  let advisorSlug = null;
  if (advisorOrOpts && typeof advisorOrOpts === "object") {
    raw = Boolean(advisorOrOpts.raw);
    limit = Number(advisorOrOpts.limit) || 10;
    advisorSlug = advisorOrOpts.advisorSlug || null;
  } else if (typeof advisorOrOpts === "string") {
    advisorSlug = advisorOrOpts;
  }

  const dir = path.join(dataDir, "transcripts");
  if (!fs.existsSync(dir)) {
    return "No advisor transcripts recorded yet.";
  }
  const safeSlug = advisorSlug
    ? String(advisorSlug)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
    : null;
  const files = fs
    .readdirSync(dir)
    .filter((f) =>
      safeSlug
        ? f === `__advisor.${safeSlug}.jsonl`
        : f.startsWith("__advisor") && f.endsWith(".jsonl")
    )
    .sort();
  if (files.length === 0) {
    return "No matching advisor transcripts found.";
  }

  const out = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const lines = fs
      .readFileSync(full, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit);
    if (!raw) {
      out.push(`### Transcript: \`${file}\` (last ${lines.length} entries)`);
    }
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (raw) {
          out.push(JSON.stringify(entry));
        } else {
          out.push(
            `- **\`${entry.timestamp}\`** | **Advisor**: \`${entry.advisor || "default"}\` (\`${entry.model}\`) | **Focus**: \`${entry.focus}\` | **Verdict**: \`${entry.verdict}\` | **Workspace**: \`${entry.workspace}\``
          );
          const list = entry.acceptedFindings || entry.advisories || [];
          if (Array.isArray(list) && list.length > 0) {
            for (const adv of list) {
              out.push(`  - \`[${adv.severity}]\` ${String(adv.text || "").split("\n")[0]}`);
            }
          } else {
            out.push("  - *(silent / clean pass)*");
          }
        }
      } catch {
        // Ignore malformed line
      }
    }
  }
  return out.join("\n");
}
