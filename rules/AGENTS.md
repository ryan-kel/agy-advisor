# Cross-Model Advisor & EGM Rules ("Automatic Transmission")

An independent cross-model Goldfish advisor powered by **Claude Sonnet 5.5** (`auto` / `fast` / `sonnet` / `sonnet-high` / `sonnet-medium` / `sonnet-low`), **Claude Opus 5.5** (`deep` / `opus` / `opus-high` / `opus-medium` / `opus-low`), and **GPT-OSS 120B** (`gpt-oss`) is installed in `~/.gemini/config/plugins/advisor/` alongside Google's **Elephant-Goldfish Model (`egm`)** in `~/.gemini/config/plugins/egm/`.

You operate in **Automatic Transmission** mode: the user does **not** need to type slash commands (`/advisor-review`, `/egm-review`, etc.). Trigger the advisor and/or EGM Goldfish subagents proactively from natural conversation.

## 1. Loop Prevention (Read First)
- If your prompt begins with `[ADVISOR REVIEW REQUEST` or `AGY_ADVISOR_ACTIVE=1` is set in the environment, **you ARE the advisor**. Never call `consult_advisor`, `advisor-consult`, or `invoke_subagent`. Return your structured audit immediately.

## 2. Mandatory Visibility (Always Tell the User)
- **Never hide an advisor call.** Each `consult_advisor` (`mcp_advisor_mcp_consult_advisor`) or `advisor-consult` run automatically fires a desktop toast pop-up (`notify-send`) and returns a `> [!NOTE] **Advisor Called — ...**` banner. You **MUST** include that `> [!NOTE]` banner at the top of your response to the user showing:
  1. Which model was called (e.g., `Claude Sonnet 5.5 (Medium)`),
  2. What it was used on (`focus` and reason),
  3. Its verdict (`APPROVE` / `REVISE` / `BLOCK`) and what `[Blocker | Major | Nit]` findings it caught, and
  4. The remaining Claude quota percentage reported by the tool.

## 3. Execution, Tier Selection & Convergence (No Rate Limits or Cooldowns)
1. **Deterministic Checks First**: Run local unit tests (`pytest`, `npm test`, `go test`), linters (including `node ~/shared/tools/ea-lint.mjs` if present), and `git diff` so the advisor gets clean, high-signal context.
2. **No Hourly Caps, Cooldowns, or Rate Limits**: Never refuse or skip an advisor review due to call count or recency. Run the advisor whenever requested or on substantive engineering, quantitative, prose, or spec deliverables.
3. **Leave `tier="auto"` by Default**: `"auto"` runs in 1-shot Goldfish mode (`excludeDefaultComponents: true`, `tools: []`) using **Claude Sonnet 5.5** (`Medium` for `code`/`plan`/`drift`/`general`, `High` for `math`/`prose`). Use `tier="deep"` or `tier="opus-high"` when an Opus review is requested.
4. **Severity & Convergence Discipline**: Findings are tagged `[Blocker]`, `[Major]`, or `[Nit]` (use plain-text tags, no emojis). `Nit`s never block `APPROVE`. When addressing a `REVISE` or `BLOCK` verdict, fix verified `[Blocker]`/`[Major]` defects (or note `CONTEST`ed tradeoffs in the prompt if re-auditing) rather than looping on minor nits.

## 4. When to Call the Advisor & EGM Automatically (No Slash Commands Required)
- **Explicit or Natural-Language Requests ("review this", "check my work", "second opinion", "brainstorm/spec this")**: Always run immediately without requiring slash commands.
- **Architecture & Feature Plans (`focus="plan"`)**: Call `mcp_advisor_mcp_consult_advisor(focus="plan")` to audit plans or specs across EGM's 4 Goldfish lenses (`Zoom-Out`, `Comprehension`, `Design Critic`, `Implementation Readiness`). For greenfield spec drafting or multi-file codebase exploration, you may also invoke the `egm-*` Goldfish subagents (`egm-zoom-out`, `egm-design`, `egm-comprehension`, `egm-implementation-readiness`, `egm-codebase-details`) or skills in `~/.gemini/config/plugins/egm/skills/`.
- **Multi-File Engineering (`focus="code"`, `include_git_diff=true`)**: Modifying 2+ files with nontrivial control-flow, state/concurrency, database queries, or security/API logic.
- **Quantitative & Data Claims (`focus="math"`)**: Calculated rates, financial/dollar figures, SQL/data pipelines, or model outputs.
- **Long-Form Published Prose (`focus="prose"`)**: Published essays, reports, or specifications.
- **Doc-to-Code Drift (`focus="drift"`)**: Checking `README.md`, `AGENTS.md`, or specs against live code implementation.
