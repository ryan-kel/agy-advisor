#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_INFO = {
  name: "advisor-mcp",
  version: "1.5.0",
};

const SUPPORTED_PROTOCOLS = new Set(["2025-03-26", "2024-11-05"]);
const inflight = new Map();

let cachedCoreModule = null;
let cachedCoreMtimeMs = 0;

async function loadAdvisorCore() {
  const localCore = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "advisor-core.mjs"
  );
  const installedCore = path.join(
    os.homedir(),
    ".gemini/config/plugins/advisor/mcp/advisor-core.mjs"
  );
  const targetPath = fs.existsSync(localCore) ? localCore : installedCore;
  try {
    const stat = fs.statSync(targetPath);
    // Avoid importing a file mid-write if it was modified within the last 150ms
    if (
      cachedCoreModule &&
      stat.mtimeMs !== cachedCoreMtimeMs &&
      Date.now() - stat.mtimeMs < 150
    ) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const freshStat = fs.statSync(targetPath);
    if (!cachedCoreModule || freshStat.mtimeMs !== cachedCoreMtimeMs) {
      const mod = await import(
        `${pathToFileURL(targetPath).href}?v=${freshStat.mtimeMs}`
      );
      cachedCoreModule = mod;
      cachedCoreMtimeMs = freshStat.mtimeMs;
    }
    return cachedCoreModule;
  } catch (err) {
    process.stderr.write(
      `[advisor-mcp] reload failed: ${err.message || err}\n`
    );
    if (cachedCoreModule) return cachedCoreModule;
    return import("./advisor-core.mjs");
  }
}

const TOOLS = [
  {
    name: "consult_advisor",
    description:
      "Consult the cross-model Goldfish advisor in 1-shot read-only mode to audit implementation plans, code diffs, quantitative/data claims, prose/documentation, or doc-to-code drift. Uses smart auto-tiering by default (Claude Sonnet 5.5 Medium for code/plan/drift/general; Claude Sonnet 5.5 High for math/prose) with [Blocker | Major | Nit] verdict calibration, live 5h/weekly quota telemetry, and no rate limits or cooldowns.",
    _meta: {
      "antigravity/alwaysLoad": true,
    },
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The plan, draft summary, specific calculations, or engineering question you want the advisor to audit.",
        },
        focus: {
          type: "string",
          enum: ["plan", "code", "prose", "math", "drift", "general"],
          description:
            "Review focus mode: 'plan' for 4-lens EGM spec/architecture audits, 'code' for code changes/diffs, 'prose' for essays/docs, 'math' for quantitative/source audits, 'drift' for doc-vs-code drift checks, 'general' for second opinions.",
        },
        tier: {
          type: "string",
          enum: [
            "auto",
            "deep",
            "opus-high",
            "opus",
            "opus-medium",
            "opus-low",
            "fast",
            "sonnet",
            "sonnet-high",
            "sonnet-medium",
            "sonnet-low",
            "gpt-oss",
          ],
          description:
            "Advisor model tier: 'auto' (default, 1-shot Claude Sonnet 5.5 Medium for code/plan/drift/general and High for math/prose), 'deep'/'opus'/'opus-medium' (Claude Opus 5.5 Medium), 'opus-high' (Claude Opus 5.5 High), 'opus-low' (Claude Opus 5.5 Low), 'fast'/'sonnet'/'sonnet-medium' (Claude Sonnet 5.5 Medium), 'sonnet-high' (Claude Sonnet 5.5 High), 'sonnet-low' (Claude Sonnet 5.5 Low), or 'gpt-oss' (GPT-OSS 120B Medium).",
        },
        effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh", "max"],
          description:
            "Optional reasoning effort override ('low', 'medium', 'high', 'xhigh', 'max'). Defaults to the selected tier's preset.",
        },
        workspace: {
          type: "string",
          description:
            "Absolute path to the active repository or project directory so the advisor can inspect files and git state directly.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of specific file paths (up to 8 files, 24 KB each; supports optional 'path:startLine-endLine', 'path#Lstart-Lend', or single-line 'path:line' slicing) for the advisor to read and verify.",
        },
        include_git_diff: {
          type: "boolean",
          description:
            "Set true to automatically attach `git status --short` and `git diff HEAD` (or `git show HEAD` when there are no uncommitted tracked changes) from the workspace.",
        },
        force: {
          type: "boolean",
          description:
            "Optional compatibility flag (no rate limits or cooldowns are enforced).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "check_advisor_quota",
    description:
      "List available cross-model advisor models in the user's Antigravity subscription and show configured model tiers and live 5-hour + weekly quota status.",
    _meta: {
      "antigravity/alwaysLoad": true,
    },
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function sendMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id, code, message) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function abortAllAndExit() {
  for (const controller of inflight.values()) {
    controller.abort();
  }
  inflight.clear();
  process.exit(0);
}

process.stdout.on("error", abortAllAndExit);
process.on("SIGTERM", abortAllAndExit);
process.on("SIGINT", abortAllAndExit);

async function handleRequest(req) {
  if (!req || typeof req !== "object") return;
  const { id, method, params } = req;

  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requested)
      ? requested
      : "2024-11-05";
    sendResult(id, {
      protocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return;
  }

  if (method === "notifications/cancelled") {
    const reqId = params && params.requestId;
    if (reqId !== undefined && inflight.has(reqId)) {
      inflight.get(reqId).abort();
      inflight.delete(reqId);
    }
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};

    if (toolName === "check_advisor_quota") {
      const { checkAdvisorQuota } = await loadAdvisorCore();
      const res = await checkAdvisorQuota();
      sendResult(id, {
        content: [{ type: "text", text: res.text }],
        isError: res.isError,
      });
      return;
    }

    if (toolName === "consult_advisor") {
      const { runAdvisorConsult } = await loadAdvisorCore();
      const controller = new AbortController();
      if (id !== undefined) {
        inflight.set(id, controller);
      }
      try {
        const res = await runAdvisorConsult({
          prompt: args.prompt,
          focus: args.focus || "general",
          tier: args.tier || "auto",
          effort: args.effort,
          workspace: args.workspace,
          files: Array.isArray(args.files) ? args.files : [],
          includeGitDiff: Boolean(args.include_git_diff),
          force: Boolean(args.force),
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          sendResult(id, {
            content: [{ type: "text", text: res.text }],
            isError: res.isError,
          });
        }
      } finally {
        if (id !== undefined) {
          inflight.delete(id);
        }
      }
      return;
    }

    sendError(id, -32602, `Unknown tool: ${toolName}`);
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

let activeHandlers = 0;
let stdinClosed = false;

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    activeHandlers++;
    handleRequest(parsed)
      .catch((err) => {
        if (parsed && parsed.id !== undefined) {
          sendError(parsed.id, -32603, err.message || "Internal error");
        }
      })
      .finally(() => {
        activeHandlers--;
        if (stdinClosed && activeHandlers === 0) {
          abortAllAndExit();
        }
      });
  } catch {
    // Ignore non-JSON lines
  }
});

rl.on("close", () => {
  stdinClosed = true;
  if (activeHandlers === 0) {
    abortAllAndExit();
  }
});
