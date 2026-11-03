# Cross-Model Goldfish Advisor Plugin (`agy-advisor`)

Native Antigravity plugin that provides an independent, 1-shot cross-model **Goldfish** verification gate using your Antigravity subscription models (**Claude Sonnet 5.5**, **Claude Opus 5.5**, and **GPT-OSS 120B**) with deterministic `[Blocker | Major | Nit]` verdict calibration, live 5-hour and weekly quota telemetry, hot-reloading MCP execution, and **no hourly caps, cooldowns, or rate limits**.

Designed to work standalone or alongside Google's **Elephant-Goldfish Model (`egm`)** plugin (`~/.gemini/config/plugins/egm`).

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

- **MCP Server (`mcp/advisor-server.mjs` & `mcp/advisor-core.mjs`)**: Exposes `consult_advisor` (`mcp_advisor_mcp_consult_advisor`) and `check_advisor_quota` (`mcp_advisor_mcp_check_advisor_quota`) with `_meta: {"antigravity/alwaysLoad": true}`, timeout-bounded Language Server quota refresh (`RetrieveUserQuotaSummary` with `forceRefresh: true`), and `mtime` hot-reloading of `advisor-core.mjs`.
- **CLI Tool (`bin/advisor-consult` / `~/.local/bin/advisor-consult`)**: Standalone executable script (`advisor-consult --status` / `--models` / `--log` to inspect live 5h/weekly quota pools and recent audit logs; supports `--focus`, `--tier`, `--model`, `--effort`, `--workspace`, `--file`, `--diff`, `--force`, and `-` stdin prompts).
- **1-Shot Goldfish Engine Profile (`agents/advisor-engine.md`)**: Hidden zero-tool profile (`tools: []`, `excludeDefaultComponents: true`, `inheritCustomizations: false`, `inheritMcp: false`) that audits pre-attached line-numbered file excerpts and diffs in a single pass with `[Blocker | Major | Nit]` severity gating.
- **Custom Subagent (`agents/advisor.md`)**: Allows async delegation via `invoke_subagent(TypeName="advisor", ...)` using the synchronous `mcp_advisor_mcp_consult_advisor` tool.
- **Skill (`skills/advisor-review/SKILL.md`)**: Playbook for preparing high-signal review packets across `plan`, `code`, `prose`, `math`, `drift`, and `general` review modes and combining with `egm`.
- **Always-On Rule (`rules/AGENTS.md`)**: Requires a visible `> [!NOTE] **Advisor Called — ...**` banner in chat showing the model, focus, verdict, and live remaining quota.

## Context & Execution Design

1. **1-Shot Pre-Attached Context (`96_000` Byte Budget, `0` Tool Loops)**:
   - Attaches up to **8 files** (`24_000` bytes / ~650 lines per file, with 1-based line numbers and optional `path:startLine-endLine`, `path#Lstart-Lend`, or single-line `path:line` slicing), up to **`24_000` bytes of user prompt**, and **`32_000` bytes of git diff** directly in Node.js before invoking the model in a single turn.
   - Prioritizes git state/diff and linter blocks ahead of supplementary files during `code` reviews so large file attachments never silently drop the diff, and surfaces any truncated/omitted blocks in the `> [!NOTE]` banner.
   - Blocks sensitive files and diff hunks (`.env*`, `.ssh/*`, `.gnupg/*`, `.aws/*`, `.azure/*`, `.config/gcloud`, `.config/gh`, `.kube/config`, `.docker/config.json`, private keys/certs, any `*credentials*` file, `secret`/`secrets[.*]`, `plugin-secrets.json`, `.vault-token`, `.htpasswd`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`, `*.tfstate*`, shell histories) from accidental attachment.
   - Uses dynamic backtick fences (`fenceFor`) so embedded files containing triple backticks cannot break prompt structure.
   - When `--diff` (`include_git_diff: true`) is run and there are no uncommitted tracked modifications (`git diff HEAD` is empty, even if untracked files exist), it automatically falls back to `git show HEAD` so the latest commit is audited.
   - Automatically runs `~/shared/tools/ea-lint.mjs` (or `$EA_LINT_PATH`) in parallel when `focus="prose"` or when the workspace/target files are under `~/sites/`.
2. **EGM Goldfish Rubrics & `[Blocker | Major | Nit]` Verdict Calibration**:
   - Enforces deterministic verdict thresholds: `BLOCK` (≥1 `[Blocker]`), `REVISE` (0 `[Blocker]`s, ≥1 `[Major]`), and `APPROVE` (0 `[Blocker]`s, 0 `[Major]`s; `[Nit]`s allowed as non-blocking polish).
   - `focus="plan"` runs EGM's 4 Goldfish lenses (`Zoom-Out` YAGNI/reuse, `Comprehension`, `Design Critic`, `Implementation Readiness`) in a single pass.
   - `focus="drift"` runs an EGM-style documentation-vs-code drift check across attached docs/schemas and source files.
3. **Smart Auto-Tiering (`--tier auto`, default) & Tier-Aware Timeouts**:
   - Routes `code`, `plan`, `drift`, and `general` reviews to **Claude Sonnet 5.5 (Medium)** (`claude-sonnet-5-5-medium`, 120s timeout).
   - Routes `math` and `prose` audits to **Claude Sonnet 5.5 (High)** (`claude-sonnet-5-5-high`, 180s timeout).
   - Supports explicit presets: `deep` / `opus` / `opus-medium` (`claude-opus-5-5-medium`, 240s), `opus-high` (`claude-opus-5-5-high`, 300s), `opus-low` (`claude-opus-5-5-low`, 150s), `fast` / `sonnet` / `sonnet-medium` (`claude-sonnet-5-5-medium`, 120s), `sonnet-high` (`claude-sonnet-5-5-high`, 180s), `sonnet-low` (`claude-sonnet-5-5-low`, 90s), `gpt-oss` (`gpt-oss-120b-medium`, 120s), or any custom `<model-id>`.
4. **Live 5-Hour & Weekly Quota Telemetry & Environment Overrides**:
   - Queries `RetrieveUserQuotaSummary` (`forceRefresh: true`) on the active Antigravity `language_server` (bounded by a 3s RPC timeout during runs) and logs all invocations (including timeouts and non-zero exits) to `~/.gemini/antigravity/plugin_data/advisor/advisor-log.jsonl` (overrideable via `PLUGIN_DATA`).
   - Supports optional environment overrides: `AGY_ADVISOR_ACTIVE=1` (recursion guard), `AGY_ADVISOR_NOTIFY=0` (suppress `notify-send` desktop toast), `EA_LINT_PATH`, and `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN`.
