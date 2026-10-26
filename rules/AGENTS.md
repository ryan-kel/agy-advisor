# Cross-Model Advisor Rules ("Automatic Transmission")

An independent cross-model advisor powered by **Claude Sonnet 5.5** (`auto` / `fast`) and **Claude Opus 5.5** (`deep` / `opus-high`) is installed in `~/.gemini/config/plugins/advisor/`.

## 1. Loop Prevention (Read First)
- If your prompt begins with `[ADVISOR REVIEW REQUEST` or `AGY_ADVISOR_ACTIVE=1` is set in the environment, **you ARE the advisor**. Never call `consult_advisor`, `advisor-consult`, or `invoke_subagent`. Return your structured audit immediately.

## 2. Mandatory Visibility (Always Tell the User)
- **Never hide an advisor call.** Whenever you call `consult_advisor` or `advisor-consult` (or if a token guardrail skips it), you **MUST** include the `> [!NOTE] **Advisor Called — ...**` banner at the top of your response to the user showing:
  1. Which model was called (e.g., `Claude Sonnet 5.5 (Medium)`),
  2. What it was used on (`focus` and reason),
  3. Its verdict (`APPROVE` / `REVISE` / `BLOCK`) and what it caught, and
  4. The remaining Claude quota percentage reported by the tool.

## 3. Token & Quota Discipline (Anti-Burner Rules)
1. **Zero-Token Deterministic Checks First**: Always run local unit tests (`pytest`, `npm test`, `go test`), linters (including `node ~/shared/tools/ea-lint.mjs` if present), and `git diff` *before* calling the advisor.
2. **At Most 1 Automatic Call Per Turn**: Never call the advisor at multiple intermediate stages of the same user request. Call the advisor **at most once** per user turn, right before presenting the finished deliverable on high-risk work (or when the user asks).
3. **Leave `tier="auto"` by Default**: `"auto"` runs in lightweight 1-shot mode (`excludeDefaultComponents: true`, `tools: []`) using **Claude Sonnet 5.5** so it consumes <1% of the 5-hour quota pool per check. Only use `tier="deep"` or `tier="opus-high"` when the user explicitly asks for an Opus review.

## 4. Autonomous Complexity Gating (When to Shift Gears)
1. **Low-Risk Fast Path (Skip Advisor — 0 Tokens)**:
   - Single-file or <20-line edits, CSS/formatting tweaks, config/repo setup, status checks, or read-only explanations/lookups. Finish immediately without calling the advisor.
2. **High-Risk Auto-Audit (1 Advisor Call Before Finishing)**:
   - **Complex Multi-File Engineering (`focus="code"`, `--diff`)**: Modifying 2+ files with nontrivial control-flow, state/concurrency, database queries, or security/API logic, or fixing a bug that failed more than once.
   - **Quantitative & Data Claims (`focus="math"`)**: Calculated rates, financial/dollar figures, SQL/data pipelines, or model outputs.
   - **Long-Form Published Prose (`focus="prose"`)**: Published essays, reports, or specifications.
   - **Explicit User Requests**: Whenever the user asks for an advisor check, review, or second opinion (pass `force=true` / `--force`).
