# Cross-Model Advisor Plugin (`agy-advisor`)

Native Antigravity plugin that provides an independent, 1-shot cross-model verification gate using your Antigravity subscription models (**Claude Sonnet 5.5** and **Claude Opus 5.5**) with live quota telemetry, hot-reloading MCP execution, and **no hourly caps, cooldowns, or rate limits**.

## Quick Install on Any Machine

```bash
git clone git@github.com:ryan-kel/agy-advisor.git ~/dev/projects/agy-advisor
bash ~/dev/projects/agy-advisor/install.sh
```

Or to update an existing checkout:

```bash
cd ~/dev/projects/agy-advisor && git pull && bash install.sh
```

## Bundled Components

- **MCP Server (`mcp/advisor-server.mjs` & `mcp/advisor-core.mjs`)**: Exposes `consult_advisor` and `check_advisor_quota` with `_meta: {"antigravity/alwaysLoad": true}`, automatic Language Server quota discovery, and live `mtime` hot-reloading of `advisor-core.mjs`.
- **CLI Tool (`bin/advisor-consult` / `~/.local/bin/advisor-consult`)**: Standalone executable script (`advisor-consult --status` to inspect live quota pools and recent audit logs).
- **1-Shot Engine Profile (`agents/advisor-engine.md`)**: Hidden zero-tool profile (`tools: []`, `excludeDefaultComponents: true`, `inheritMcp: false`) that audits pre-attached file excerpts and diffs in a single pass (~0.3%–0.5% of the 5-hour Claude quota pool per call).
- **Custom Subagent (`agents/advisor.md`)**: Allows async delegation via `invoke_subagent(TypeName="advisor", ...)`.
- **Skill (`skills/advisor-review/SKILL.md`)**: Playbook for preparing high-signal review packets across `plan`, `code`, `prose`, `math`, and `general` review modes.
- **Always-On Rule (`rules/AGENTS.md`)**: Requires a visible `> [!NOTE] **Advisor Called — ...**` banner in chat showing the model, focus, verdict, and live remaining quota.

## Context & Execution Design

1. **1-Shot Pre-Attached Context (`96 KB` Budget, `0` Tool Loops)**:
   - Attaches up to **8 files** (`24 KB` / ~650 lines per file) and **`32 KB` of git diff** directly in Node.js before invoking the model in a single turn.
   - If `--diff` (`include_git_diff: true`) is run when the working tree is clean (e.g., right after `git commit` or `git pull`), it automatically falls back to `git show HEAD` so the latest commit is audited.
2. **Smart Auto-Tiering (`--tier auto`, default)**:
   - Routes `code`, `plan`, and `general` reviews to **Claude Sonnet 5.5 (Medium)** (`claude-sonnet-5-5-medium`).
   - Routes `math` and `prose` audits to **Claude Sonnet 5.5 (High)** (`claude-sonnet-5-5-high`).
   - Supports `--tier deep` (`claude-opus-5-5-medium`) and `--tier opus-high` (`claude-opus-5-5-high`) when an explicit Opus review is requested.
3. **Zero Rate Limits or Cooldowns**: No hourly call limits, per-workspace cooldowns, quota floors, or diff-size skips are enforced. Every invocation executes immediately.
4. **Live Quota Telemetry**: Auto-discovers the active Antigravity `language_server` port and CSRF token (even in background MCP mode) and logs before/after quota deltas to `~/.gemini/antigravity/plugin_data/advisor/advisor-log.jsonl`.
