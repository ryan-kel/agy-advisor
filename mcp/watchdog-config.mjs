import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const MAX_IMPORT_DEPTH = 5;
const MAX_WATCHDOG_FILE_BYTES = 16_000;

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

/**
 * Expand `@relative/path` and `@~/path` imports outside fenced code blocks and inline code spans,
 * up to MAX_IMPORT_DEPTH hops, skipping cycles and sensitive files.
 */
export function expandWatchdogImports(
  rawContent,
  baseDir,
  isSensitiveFilePath,
  visited = new Set(),
  depth = 0
) {
  if (depth >= MAX_IMPORT_DEPTH) return String(rawContent || "");
  const lines = String(rawContent || "").split(/\r?\n/);
  const outLines = [];
  let inCodeFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!inCodeFence) {
        inCodeFence = true;
        fenceMarker = fenceMatch[1];
      } else if (line.trimStart().startsWith(fenceMarker)) {
        inCodeFence = false;
        fenceMarker = "";
      }
      outLines.push(line);
      continue;
    }

    if (inCodeFence) {
      outLines.push(line);
      continue;
    }

    // Match standalone `@path` tokens not inside inline backticks
    // Preserve inline code spans by splitting on `...`
    const segments = line.split(/(`+[^`]*`+)/g);
    const expandedSegments = segments.map((seg, idx) => {
      if (idx % 2 === 1) return seg; // inline code span
      return seg.replace(
        /(^|\s)@((?:~\/|\.\.?\/|[a-zA-Z0-9_.-]+\/)[a-zA-Z0-9_./+-]+|[a-zA-Z0-9_.-]+\.(?:md|txt|ya?ml))(?=\s|$)/g,
        (fullMatch, leadingWs, rawImportPath) => {
          try {
            const resolved = rawImportPath.startsWith("~/")
              ? expandHome(rawImportPath)
              : path.resolve(baseDir, rawImportPath);
            if (!fs.existsSync(resolved)) return fullMatch;
            const real = fs.realpathSync(resolved);
            if (
              visited.has(real) ||
              (typeof isSensitiveFilePath === "function" &&
                (isSensitiveFilePath(resolved) || isSensitiveFilePath(real)))
            ) {
              return fullMatch;
            }
            const stat = fs.statSync(real);
            if (!stat.isFile() || stat.size > MAX_WATCHDOG_FILE_BYTES) {
              return fullMatch;
            }
            const nextVisited = new Set(visited);
            nextVisited.add(real);
            const importedRaw = fs.readFileSync(real, "utf8").replace(/\0/g, "");
            const expanded = expandWatchdogImports(
              importedRaw,
              path.dirname(real),
              isSensitiveFilePath,
              nextVisited,
              depth + 1
            );
            return `${leadingWs}${expanded.trim()}`;
          } catch {
            return fullMatch;
          }
        }
      );
    });
    outLines.push(expandedSegments.join(""));
  }

  return outLines.join("\n");
}

function findAncestorDirs(startDir) {
  const dirs = [];
  let cur = path.resolve(startDir);
  const stopAt = path.resolve(HOME);
  while (true) {
    dirs.push(cur);
    if (fs.existsSync(path.join(cur, ".git")) || cur === stopAt) {
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Order from farthest ancestor (repo root) down to leaf cwd so narrower directory guidance sits last
  return dirs.reverse();
}

export function discoverWatchdogMarkdownFiles(
  workspaceDir,
  isSensitiveFilePath
) {
  const resolvedWorkspace = path.resolve(expandHome(workspaceDir || process.cwd()));
  const candidates = [
    path.join(HOME, ".omp/agent/WATCHDOG.md"),
    path.join(HOME, ".gemini/config/WATCHDOG.md"),
  ];

  if (fs.existsSync(resolvedWorkspace)) {
    const ancestorDirs = findAncestorDirs(resolvedWorkspace);
    for (const dir of ancestorDirs) {
      const base = path.basename(dir);
      // Skip hidden owner directories unless inside .omp or .gemini
      if (
        base.startsWith(".") &&
        dir !== HOME &&
        base !== ".omp" &&
        base !== ".gemini"
      ) {
        continue;
      }
      candidates.push(
        path.join(dir, ".omp/WATCHDOG.md"),
        path.join(dir, ".gemini/WATCHDOG.md"),
        path.join(dir, "WATCHDOG.md")
      );
    }
  }

  const seenRealPaths = new Set();
  const blocks = [];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const real = fs.realpathSync(candidate);
      if (seenRealPaths.has(real)) continue;
      if (
        typeof isSensitiveFilePath === "function" &&
        (isSensitiveFilePath(candidate) || isSensitiveFilePath(real))
      ) {
        continue;
      }
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_WATCHDOG_FILE_BYTES) {
        continue;
      }
      seenRealPaths.add(real);
      const raw = fs.readFileSync(real, "utf8").replace(/\0/g, "");
      const expanded = expandWatchdogImports(
        raw,
        path.dirname(real),
        isSensitiveFilePath,
        new Set([real]),
        0
      ).trim();
      if (expanded) {
        blocks.push({
          source: candidate,
          content: [
            "Especially pay attention to:",
            "<attention>",
            expanded,
            "</attention>",
          ].join("\n"),
        });
      }
    } catch {
      // Ignore unreadable candidate
    }
  }

  return blocks;
}

function unquoteYamlScalar(val) {
  const trimmed = String(val || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseInlineList(val) {
  const trimmed = String(val || "").trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((s) => unquoteYamlScalar(s));
}

/**
 * Lightweight zero-dependency parser for OMP WATCHDOG.yml / WATCHDOG.yaml files.
 */
export function parseWatchdogYaml(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const doc = {
    instructions: "",
    maxNotesPerUpdate: undefined,
    reviewMode: undefined,
    reviewInterval: undefined,
    syncBacklog: undefined,
    immuneTurns: undefined,
    continueSeverity: undefined,
    includeReasoning: undefined,
    evictStaleResults: undefined,
    advisors: [],
  };

  let i = 0;
  let inAdvisors = false;
  let currentAdvisor = null;

  const readBlockScalar = (startIdx, parentIndent) => {
    const blockLines = [];
    let blockIndent = null;
    let idx = startIdx;
    while (idx < lines.length) {
      const l = lines[idx];
      if (!l.trim()) {
        blockLines.push("");
        idx++;
        continue;
      }
      const indent = l.match(/^(\s*)/)[1].length;
      if (indent <= parentIndent) break;
      if (blockIndent === null) blockIndent = indent;
      blockLines.push(l.slice(Math.min(indent, blockIndent)));
      idx++;
    }
    return { text: blockLines.join("\n").trim(), nextIdx: idx };
  };

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const indent = rawLine.match(/^(\s*)/)[1].length;

    if (indent === 0) {
      if (currentAdvisor) {
        doc.advisors.push(currentAdvisor);
        currentAdvisor = null;
      }
      inAdvisors = false;
      const kv = trimmed.match(/^([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
      if (kv) {
        const [, key, rest] = kv;
        if (key === "advisors") {
          inAdvisors = true;
          i++;
          continue;
        }
        if (key === "instructions") {
          if (rest === "|" || rest === ">") {
            const blk = readBlockScalar(i + 1, indent);
            doc.instructions = blk.text;
            i = blk.nextIdx;
            continue;
          }
          doc.instructions = unquoteYamlScalar(rest);
        } else if (key === "maxNotesPerUpdate") {
          const n = Number(unquoteYamlScalar(rest));
          if (Number.isFinite(n) && n >= 1) doc.maxNotesPerUpdate = Math.round(n);
        } else if (key === "reviewMode") {
          doc.reviewMode = unquoteYamlScalar(rest);
        } else if (key === "reviewInterval") {
          const n = Number(unquoteYamlScalar(rest));
          if (Number.isFinite(n) && n >= 1) doc.reviewInterval = Math.round(n);
        } else if (key === "syncBacklog") {
          doc.syncBacklog = unquoteYamlScalar(rest);
        } else if (key === "immuneTurns") {
          const n = Number(unquoteYamlScalar(rest));
          if (Number.isFinite(n) && n >= 0) doc.immuneTurns = Math.round(n);
        } else if (key === "continueSeverity") {
          doc.continueSeverity = unquoteYamlScalar(rest);
        } else if (key === "includeReasoning") {
          doc.includeReasoning = unquoteYamlScalar(rest) !== "false";
        } else if (key === "evictStaleResults") {
          doc.evictStaleResults = unquoteYamlScalar(rest) !== "false";
        }
      }
      i++;
      continue;
    }

    if (inAdvisors) {
      const itemStart = trimmed.match(/^-\s*([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
      if (itemStart) {
        if (currentAdvisor) doc.advisors.push(currentAdvisor);
        currentAdvisor = {
          name: "Advisor",
          enabled: true,
          model: undefined,
          focus: undefined,
          tools: ["read", "grep", "glob"],
          reviewMode: "turn",
          reviewInterval: 1,
          syncBacklog: undefined,
          scope: "all",
          includeReasoning: true,
          maxNotesPerUpdate: undefined,
          instructions: "",
        };
        const [, k, v] = itemStart;
        if (k === "name") currentAdvisor.name = unquoteYamlScalar(v);
        else if (k === "enabled") currentAdvisor.enabled = unquoteYamlScalar(v) !== "false";
        else if (k === "model" || k === "tier") currentAdvisor.model = unquoteYamlScalar(v);
        else if (k === "focus") currentAdvisor.focus = unquoteYamlScalar(v);
        i++;
        continue;
      }

      if (currentAdvisor) {
        const kv = trimmed.match(/^([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
        if (kv) {
          const [, k, rest] = kv;
          if (k === "name") currentAdvisor.name = unquoteYamlScalar(rest);
          else if (k === "enabled")
            currentAdvisor.enabled = unquoteYamlScalar(rest) !== "false";
          else if (k === "model" || k === "tier")
            currentAdvisor.model = unquoteYamlScalar(rest);
          else if (k === "focus") currentAdvisor.focus = unquoteYamlScalar(rest);
          else if (k === "reviewMode")
            currentAdvisor.reviewMode = unquoteYamlScalar(rest);
          else if (k === "reviewInterval") {
            const n = Number(unquoteYamlScalar(rest));
            if (Number.isFinite(n) && n >= 1)
              currentAdvisor.reviewInterval = Math.round(n);
          } else if (k === "syncBacklog")
            currentAdvisor.syncBacklog = unquoteYamlScalar(rest);
          else if (k === "scope") currentAdvisor.scope = unquoteYamlScalar(rest);
          else if (k === "includeReasoning")
            currentAdvisor.includeReasoning = unquoteYamlScalar(rest) !== "false";
          else if (k === "maxNotesPerUpdate") {
            const n = Number(unquoteYamlScalar(rest));
            if (Number.isFinite(n) && n >= 1)
              currentAdvisor.maxNotesPerUpdate = Math.round(n);
          } else if (k === "tools") {
            const list = parseInlineList(rest);
            if (list) currentAdvisor.tools = list;
          } else if (k === "instructions") {
            if (rest === "|" || rest === ">") {
              const blk = readBlockScalar(i + 1, indent);
              currentAdvisor.instructions = blk.text;
              i = blk.nextIdx;
              continue;
            }
            currentAdvisor.instructions = unquoteYamlScalar(rest);
          }
        }
      }
    }
    i++;
  }

  if (currentAdvisor) {
    doc.advisors.push(currentAdvisor);
  }
  return doc;
}

function slugifyAdvisorName(name) {
  return (
    String(name || "advisor")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "advisor"
  );
}

export function discoverWatchdogRoster(workspaceDir, isSensitiveFilePath) {
  const resolvedWorkspace = path.resolve(expandHome(workspaceDir || process.cwd()));
  const candidates = [
    path.join(HOME, ".omp/agent/WATCHDOG.yml"),
    path.join(HOME, ".omp/agent/WATCHDOG.yaml"),
    path.join(HOME, ".gemini/config/WATCHDOG.yml"),
    path.join(HOME, ".gemini/config/WATCHDOG.yaml"),
  ];

  if (fs.existsSync(resolvedWorkspace)) {
    const ancestorDirs = findAncestorDirs(resolvedWorkspace);
    for (const dir of ancestorDirs) {
      candidates.push(
        path.join(dir, ".omp/WATCHDOG.yml"),
        path.join(dir, ".omp/WATCHDOG.yaml"),
        path.join(dir, ".gemini/WATCHDOG.yml"),
        path.join(dir, ".gemini/WATCHDOG.yaml"),
        path.join(dir, "WATCHDOG.yml"),
        path.join(dir, "WATCHDOG.yaml")
      );
    }
  }

  const seenRealPaths = new Set();
  const sources = [];
  const sharedInstructions = [];
  const rosterBySlug = new Map();

  const mergedSettings = {
    maxNotesPerUpdate: 4,
    reviewMode: undefined,
    reviewInterval: 1,
    syncBacklog: "off",
    immuneTurns: 3,
    continueSeverity: "concern",
    includeReasoning: true,
    evictStaleResults: true,
  };

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const real = fs.realpathSync(candidate);
      if (seenRealPaths.has(real)) continue;
      if (
        typeof isSensitiveFilePath === "function" &&
        (isSensitiveFilePath(candidate) || isSensitiveFilePath(real))
      ) {
        continue;
      }
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_WATCHDOG_FILE_BYTES) {
        continue;
      }
      seenRealPaths.add(real);
      const raw = fs.readFileSync(real, "utf8").replace(/\0/g, "");
      const parsed = parseWatchdogYaml(raw);
      sources.push(candidate);

      if (parsed.instructions) {
        const expanded = expandWatchdogImports(
          parsed.instructions,
          path.dirname(real),
          isSensitiveFilePath,
          new Set([real]),
          0
        ).trim();
        if (expanded) sharedInstructions.push(expanded);
      }

      if (parsed.maxNotesPerUpdate !== undefined)
        mergedSettings.maxNotesPerUpdate = parsed.maxNotesPerUpdate;
      if (parsed.reviewMode) mergedSettings.reviewMode = parsed.reviewMode;
      if (parsed.reviewInterval !== undefined)
        mergedSettings.reviewInterval = parsed.reviewInterval;
      if (parsed.syncBacklog) mergedSettings.syncBacklog = parsed.syncBacklog;
      if (parsed.immuneTurns !== undefined)
        mergedSettings.immuneTurns = parsed.immuneTurns;
      if (parsed.continueSeverity)
        mergedSettings.continueSeverity = parsed.continueSeverity;
      if (parsed.includeReasoning !== undefined)
        mergedSettings.includeReasoning = parsed.includeReasoning;
      if (parsed.evictStaleResults !== undefined)
        mergedSettings.evictStaleResults = parsed.evictStaleResults;

      for (const adv of parsed.advisors) {
        const slug = slugifyAdvisorName(adv.name);
        const expandedInst = adv.instructions
          ? expandWatchdogImports(
              adv.instructions,
              path.dirname(real),
              isSensitiveFilePath,
              new Set([real]),
              0
            ).trim()
          : "";
        rosterBySlug.set(slug, {
          ...adv,
          slug,
          instructions: expandedInst,
          source: candidate,
        });
      }
    } catch {
      // Ignore invalid candidate
    }
  }

  return {
    sources,
    sharedInstructions: sharedInstructions.join("\n\n"),
    settings: mergedSettings,
    advisors: Array.from(rosterBySlug.values()),
  };
}

export function loadWatchdogRuntimeSettings(dataDir) {
  const filePath = path.join(dataDir, "watchdog-settings.json");
  const defaults = {
    enabled: false,
    reviewMode: "off",
    reviewInterval: 1,
    syncBacklog: "off",
    immuneTurns: 3,
    continueSeverity: "concern",
    maxNotesPerUpdate: 4,
    includeReasoning: true,
    evictStaleResults: true,
  };
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return { ...defaults, ...parsed };
    }
  } catch {
    // Use defaults
  }
  return defaults;
}

export function saveWatchdogRuntimeSettings(dataDir, updates) {
  const current = loadWatchdogRuntimeSettings(dataDir);
  const next = { ...current, ...updates };
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "watchdog-settings.json");
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
  return next;
}
