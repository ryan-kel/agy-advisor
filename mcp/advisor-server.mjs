#!/usr/bin/env node
import readline from "node:readline";
import { runAdvisorConsult, checkAdvisorQuota } from "./advisor-core.mjs";

const SERVER_INFO = {
  name: "advisor-mcp",
  version: "1.2.0",
};

const SUPPORTED_PROTOCOLS = new Set(["2025-03-26", "2024-11-05"]);
const inflight = new Map();

const TOOLS = [
  {
    name: "consult_advisor",
    description:
      "Consult the cross-model advisor in 1-shot read-only mode to audit implementation plans, code diffs, quantitative/data claims, or prose/documentation. Uses smart auto-tiering by default (Claude Sonnet 5.5 Medium for code/plan/general; Claude Sonnet 5.5 High for math/prose) with live quota telemetry and token-saving guards.",
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
          enum: ["plan", "code", "prose", "math", "general"],
          description:
            "Review focus mode: 'plan' for architecture/implementation plans, 'code' for code changes/diffs, 'prose' for essays/docs/specs, 'math' for quantitative/source audits, 'general' for second opinions.",
        },
        tier: {
          type: "string",
          enum: [
            "auto",
            "deep",
            "fast",
            "opus-high",
            "opus-medium",
            "sonnet-high",
            "sonnet-medium",
            "gpt-oss",
          ],
          description:
            "Advisor model tier: 'auto' (default, 1-shot Claude Sonnet 5.5 Medium for code/plan/general and High for math/prose), 'deep' (Claude Opus 5.5 Medium), 'opus-high' (Claude Opus 5.5 High), or 'fast' (Claude Sonnet 5.5 Medium).",
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
            "Optional list of specific file paths (up to 8 files, 24 KB each) for the advisor to read and verify.",
        },
        include_git_diff: {
          type: "boolean",
          description:
            "Set true to automatically attach `git status --short` and `git diff HEAD` (or `git show HEAD` if working tree is clean) from the workspace.",
        },
        force: {
          type: "boolean",
          description:
            "Set true only when the user explicitly requests an advisor review and wants to bypass the 120s cooldown, 35% quota floor, cache, or trivial-diff skip.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "check_advisor_quota",
    description:
      "List available cross-model advisor models in the user's Antigravity subscription and show configured model tiers and active token guardrails.",
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
      const res = await checkAdvisorQuota();
      sendResult(id, {
        content: [{ type: "text", text: res.text }],
        isError: res.isError,
      });
      return;
    }

    if (toolName === "consult_advisor") {
      const controller = new AbortController();
      if (id !== undefined) {
        inflight.set(id, controller);
      }
      try {
        const res = await runAdvisorConsult({
          prompt: args.prompt,
          focus: args.focus || "general",
          tier: args.tier || "auto",
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

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    handleRequest(parsed).catch((err) => {
      if (parsed && parsed.id !== undefined) {
        sendError(parsed.id, -32603, err.message || "Internal error");
      }
    });
  } catch {
    // Ignore non-JSON lines
  }
});

rl.on("close", abortAllAndExit);
