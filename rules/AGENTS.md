# Cross-Model Advisor Rules ("Automatic Transmission")

An independent cross-model advisor powered by **Claude Sonnet 5.5** (`auto` / `fast`) and **Claude Opus 5.5** (`deep` / `opus-high`) is installed in `~/.gemini/config/plugins/advisor/`.

## 1. Loop Prevention (Read First)
- If your prompt begins with `[ADVISOR REVIEW REQUEST` or `AGY_ADVISOR_ACTIVE=1` is set in the environment, **you ARE the advisor**. Never call `consult_advisor`, `advisor-consult`, or `invoke_subagent`. Return your structured audit immediately.

## 2. Mandatory Visibility (Always Tell the User)
- **Never hide an advisor call.** Whenever you call `consult_advisor` or `advisor-consult`, you **MUST** include the `> [!NOTE] **Advisor Called — ...**` banner at the top of your response to the user showing:
  1. Which model was called (e.g., `Claude Sonnet 5.5 (Medium)`),
  2. What it was used on (`focus` and reason),
  3. Its verdict (`APPROVE` / `REVISE` / `BLOCK`) and what it caught, and
  4. The remaining Claude quota percentage reported by the tool.

## 3. Execution & Tier Selection (No Rate Limits or Cooldowns)
1. **Deterministic Checks First**: Run local unit tests (`pytest`, `npm test`, `go test`), linters (including `node ~/shared/tools/ea-lint.mjs` if present), and `git diff` so the advisor gets clean, high-signal context.
2. **No Hourly Caps, Cooldowns, or Rate Limits**: Never refuse or skip an advisor review due to call count or recency. Run the advisor whenever requested (including `/advisor-review`) or on substantive engineering, quantitative, or prose deliverables.
3. **Leave `tier="auto"` by Default**: `"auto"` runs in 1-shot mode (`excludeDefaultComponents: true`, `tools: []`) using **Claude Sonnet 5.5** (`Medium` for `code`/`plan`/`general`, `High` for `math`/`prose`). Use `tier="deep"` or `tier="opus-high"` when an Opus review is requested.

## 4. When to Call the Advisor
- **Explicit User Requests (`/advisor-review`, second opinion, audit)**: Always run immediately.
- **Multi-File Engineering (`focus="code"`, `--diff`)**: Modifying 2+ files with nontrivial control-flow, state/concurrency, database queries, or security/API logic.
- **Quantitative & Data Claims (`focus="math"`)**: Calculated rates, financial/dollar figures, SQL/data pipelines, or model outputs.
- **Long-Form Published Prose (`focus="prose"`)**: Published essays, reports, or specifications.
