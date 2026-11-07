#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SERVER_INFO as DEFAULT_SERVER_INFO,
  TOOLS as DEFAULT_TOOLS,
} from "./advisor-core.mjs";

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
    controller.abort("server-exit");
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
    const core = await loadAdvisorCore();
    const requested = params && params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requested)
      ? requested
      : "2024-11-05";
    sendResult(id, {
      protocolVersion,
      capabilities: {
        tools: {},
      },
      serverInfo: (core && core.SERVER_INFO) || DEFAULT_SERVER_INFO,
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
    const core = await loadAdvisorCore();
    sendResult(id, { tools: (core && core.TOOLS) || DEFAULT_TOOLS });
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
          advisor: args.advisor || null,
          workspace: args.workspace,
          files: Array.isArray(args.files) ? args.files : [],
          includeGitDiff: Boolean(args.include_git_diff),
          transcriptPath: args.transcript_path || null,
          timeoutMs: Number.isFinite(args.timeout_ms)
            ? Math.min(Math.max(Math.round(args.timeout_ms), 5000), 600000)
            : undefined,
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
