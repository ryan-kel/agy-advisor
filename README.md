# Cross-Model Goldfish & OMP Watchdog Advisor Plugin (`agy-advisor`)

Native Antigravity plugin (`v2.0.0`) that combines an independent, 1-shot cross-model **Goldfish** verification gate with the **OMP (`oh-my-pi`) Advisor & Watchdog** supervision architecture using your Antigravity subscription models (**Claude Sonnet 5.5**, **Claude Opus 5.5**, and **GPT-OSS 120B**).

Features deterministic `[Blocker | Concern | Nit]` (`[Major]` alias) verdict calibration, **`AdvisorEmissionGuard`** NFKC deduplication and severity budgeting, hierarchical **`WATCHDOG.md`** (`@path` import expansion) & **`WATCHDOG.yml`** multi-advisor rosters, incremental **`transcript.jsonl`** peer-shadow delta compression, non-blocking **`hooks.json`** (`PreInvocation`, `PostInvocation`, `Stop`) supervision, live 5-hour and weekly quota telemetry, and **no hourly caps, cooldowns, or rate limits**.

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

- **MCP Server (`mcp/advisor-server.mjs` & `mcp/advisor-core.mjs`)**: Exposes `consult_advisor` (`mcp_advisor_mcp_consult_advisor`, supporting `prompt`, `focus`, `tier`, `effort`, `advisor`, `workspace`, `files`, `include_git_diff`, `transcript_path`, `timeout_ms`, and `force`) and `check_advisor_quota` (`mcp_advisor_mcp_check_advisor_quota`) with `_meta: {"antigravity/alwaysLoad": true}`, timeout-bounded Language Server quota refresh (`RetrieveUserQuotaSummary` with `forceRefresh: true`), and `mtime` hot-reloading of `advisor-core.mjs`.
- **OMP Emission Guard (`mcp/emission-guard.mjs`)**: Implements `AdvisorEmissionGuard` with NFKC key normalization (`normalizeNoteKey`), content-free phrase filtering (`isContentFreeNoise`), 4,096-entry FIFO deduplication per workspace (`runEmissionGuard`, dropping repeated notes at equal/lower severity and allowing re-raise only when escalated to `[Blocker]`), `maxNotesPerUpdate` non-blocker budgeting (default `4`; blockers exempt), output quarantine (`inspectOutputQuarantine` for output-only destructive shell commands or 3+ hazard classes), and `<advisory advisor="..." severity="blocker|concern|nit" guidance="weigh, don't blindly obey">` XML formatting.
- **OMP Watchdog Discovery (`mcp/watchdog-config.mjs`)**: Discovers global (`~/.omp/agent/WATCHDOG.md`, `~/.gemini/config/WATCHDOG.md`) and ancestor (`WATCHDOG.md`, `.omp/WATCHDOG.md`, `.gemini/WATCHDOG.md` from git root to `cwd`) instructions with recursive `@relative/path` and `@~/path` file import expansion (up to 5 hops, skipping fenced/inline code and sensitive files) wrapped in `<attention location="...">` tags, plus zero-dependency `WATCHDOG.yml` / `WATCHDOG.yaml` multi-advisor roster & policy parsing.
- **Incremental Transcript Delta & Peer-Shadow Logs (`mcp/transcript-delta.mjs`)**: Builds incremental session deltas from Antigravity's `transcript.jsonl` since `lastReviewedStepIndex` (`buildTranscriptDelta`), obfuscates inline secrets (`obfuscateSecrets`), strips prior advisor echoes to prevent feedback loops, evicts stale investigative tool outputs (`read_file`/`grep_search`/`find_by_name`/`list_dir` older than recent turns), and appends each advisor turn to `__advisor[.<slug>].jsonl` (`appendAdvisorTranscript`, inspectable via `advisor-consult --dump`).
- **Non-Blocking Lifecycle Hooks (`hooks.json` & `bin/advisor-hook`)**:
  - `PreInvocation`: Fast (<10ms) inbox check that injects queued `<advisory>` XML notes via `injectSteps` (`ephemeralMessage`) before the agent's next invocation.
  - `PostInvocation`: Tracks `turnsSinceLastSteer` and `turnCount`, ages queued notes (`turns_ago`), and spawns a detached background worker when `reviewMode: "turn"` is active (`syncBacklog: off`).
  - `Stop`: Turn-end (`NO_TOOL_CALL`) gate that enforces `immuneTurns` (default `3`) and `continueSeverity` (`concern` or `blocker`), returning `{"decision": "continue", "reason": "<advisory ...>"}` when a qualifying issue requires attention before yielding.
- **CLI Tool (`bin/advisor-consult` / `~/.local/bin/advisor-consult`)**: Standalone executable script supporting `--status` / `--models` / `--log`, `--focus`, `--tier` / `--model`, `--effort`, `--advisor <name>`, `--workspace`, repeatable `--file`, `--diff`, `--transcript <path>`, `--dump`, `--dump-raw`, `--reset`, `--watchdog <on|off|turn|agent-end|status>`, `--timeout <sec>`, `--force`, and `-` stdin prompts.
- **1-Shot Goldfish & OMP Watchdog Engine Profile (`agents/advisor-engine.md`)**: Hidden zero-tool profile (`tools: []`, `excludeDefaultComponents: true`, `inheritCustomizations: false`, `inheritMcp: false`) with OMP `<conventions>`, `<critical>` anti-ceremony/anti-noise rules, and `<completeness>` `[Blocker | Concern | Nit]` calibration.
- **Custom Subagent (`agents/advisor.md`)**, **Skill (`skills/advisor-review/SKILL.md`)**, and **Always-On Rule (`rules/AGENTS.md`)**.

## Context, Guard & Execution Design

1. **1-Shot Pre-Attached Context (`96_000` Byte Budget, `0` Tool Loops)**:
   - Attaches up to **8 files** (`24_000` bytes / ~650 lines per file, with 1-based line numbers and optional `path:startLine-endLine`, `path#Lstart-Lend`, or single-line `path:line` slicing), up to **`24_000` bytes of user prompt**, **`32_000` bytes of git diff**, and **`28_000` bytes of incremental session transcript delta** directly in Node.js before invoking the model in a single turn.
   - Prioritizes attachment notes, transcript deltas, git diffs, and linter blocks ahead of supplementary files during `code` reviews so large file attachments never silently drop the diff, and surfaces any truncated/omitted blocks or `EmissionGuard` suppressions in the `> [!NOTE]` banner.
   - Blocks sensitive files and diff hunks (`.env*` except `.env.example`/`.sample`/`.template`, `/proc/*`, `/sys/*`, `/dev/*`, `.ssh/*`, `.gnupg/*`, `.aws/*`, `.azure/*`, `.config/gcloud`, `.config/gh`, `.kube/*`, `.docker/config.json`, `.dockercfg`, private keys/certs, any `*credentials*` or `service-account*` file, `secret`/`secrets[.*]`, `plugin-secrets.json`, `.vault-token`, `.htpasswd`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `.pgpass`, `*.tfstate*`, shell histories) and binary files from accidental attachment or `@path` expansion.
   - Uses dynamic backtick fences (`fenceFor`) so embedded files containing triple backticks cannot break prompt structure, and partially truncates the final block when >2.4 KB of budget remains rather than dropping it completely.
   - When `--diff` (`include_git_diff: true`) is run, it auto-attaches untracked workspace source files (skipping lockfiles and symlinks outside the workspace) when file slots remain, and if there are no uncommitted tracked modifications (`git diff HEAD` is empty), it automatically falls back to `git show HEAD` so the latest commit is audited.
   - Automatically runs `~/shared/tools/ea-lint.mjs` (or `$EA_LINT_PATH`) in parallel when `focus="prose"` or when the workspace/target files are under `~/sites/`.
2. **OMP Anti-Ceremony Rules, `AdvisorEmissionGuard` & `[Blocker | Concern | Nit]` Verdict Calibration**:
   - Enforces OMP's `<critical>` anti-ceremony mandates: never restates compiler/test/linter errors already visible in the input, never advises on user intent or git ceremony, never polices scope/ambition, and never demands unsolicited backwards-compatibility shims.
   - Enforces deterministic verdict thresholds: `BLOCK` (≥1 `[Blocker]`), `REVISE` (0 `[Blocker]`s, ≥1 `[Concern]`/`[Major]`), and `APPROVE` (0 `[Blocker]`s, 0 `[Concern]`s; `[Nit]`s allowed as non-blocking polish). If `AdvisorEmissionGuard` suppresses all `[Concern]` findings as duplicates of already-delivered notes (and `force` is not set), `REVISE` is automatically upgraded to `APPROVE` so the agent never loops on repeated notes.
   - `focus="plan"` runs EGM's 4 Goldfish lenses (`Zoom-Out` YAGNI/reuse, `Comprehension`, `Design Critic`, `Implementation Readiness`) in a single pass.
   - `focus="drift"` runs an EGM-style documentation-vs-code drift check across attached docs/schemas and source files.
3. **Smart Auto-Tiering (`--tier auto`, default) & Tier-Aware Timeouts**:
   - Routes `code`, `plan`, `drift`, and `general` reviews to **Claude Sonnet 5.5 (Medium)** (`claude-sonnet-5-5-medium`, 120s timeout), or to the model specified by the selected `WATCHDOG.yml` roster advisor.
   - Routes `math` and `prose` audits to **Claude Sonnet 5.5 (High)** (`claude-sonnet-5-5-high`, 180s timeout).
   - Supports explicit presets: `deep` / `opus` / `opus-medium` (`claude-opus-5-5-medium`, 240s), `opus-high` (`claude-opus-5-5-high`, 300s), `opus-low` (`claude-opus-5-5-low`, 150s), `fast` / `sonnet` / `sonnet-medium` (`claude-sonnet-5-5-medium`, 120s), `sonnet-high` (`claude-sonnet-5-5-high`, 180s), `sonnet-low` (`claude-sonnet-5-5-low`, 90s), `gpt-oss` (`gpt-oss-120b-medium`, 120s), or any custom `<model-id>`.
4. **Live 5-Hour & Weekly Quota Telemetry & Environment Overrides**:
   - Queries `RetrieveUserQuotaSummary` (`forceRefresh: true`) on the active Antigravity `language_server` (bounded by a 3s RPC timeout during runs) and logs all invocations to `~/.gemini/antigravity/plugin_data/advisor/advisor-log.jsonl` and `__advisor[.<slug>].jsonl` (overrideable via `PLUGIN_DATA`).
   - Supports optional environment overrides: `AGY_ADVISOR_ACTIVE=1` (recursion guard), `AGY_ADVISOR_NOTIFY=0` (suppress `notify-send` desktop toast), `EA_LINT_PATH`, and `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN`.
