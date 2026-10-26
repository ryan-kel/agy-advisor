# Cross-Model Advisor Rules ("Automatic Transmission")

An independent cross-model advisor powered by **Claude Opus 5.5 (High)** (`deep`) and **Claude Sonnet 5.5** (`fast` / `auto`) is installed in `~/.gemini/config/plugins/advisor/`.

## 1. Loop Prevention (Read First)
- If your prompt begins with `[ADVISOR REVIEW REQUEST]` or `AGY_ADVISOR_ACTIVE=1` is set in the environment, **you ARE the advisor**. Never call `consult_advisor`, `advisor-consult`, or `invoke_subagent` from inside an advisor review session. Inspect the workspace with read-only tools and return your structured audit immediately.

## 2. Token & Quota Discipline (Anti-Burner Rules)
1. **Zero-Token Deterministic Checks First**: Always run local unit tests (`pytest`, `npm test`, `go test`), linters (including `node ~/shared/tools/ea-lint.mjs` if present), and `git diff` *before* calling the advisor. Never spend advisor tokens on code or prose that fails local deterministic checks.
2. **At Most 1 Automatic Call Per Turn**: Never call the advisor at multiple intermediate stages of the same user request (do not audit the plan, then the draft, then the fix). Call the advisor **at most once** per user turn, right before presenting the finished deliverable (or when the user asks).
3. **Smart Auto-Tiering (`tier="auto"`)**: Leave `tier` set to `"auto"` unless the user requests a specific model. `"auto"` routes high-stakes `plan`, `math`, and `prose` audits to **Claude Opus 5.5 (High)** and routine `code` diffs to **Claude Sonnet 5.5**.

## 3. Autonomous Complexity Gating (When to Shift Gears)
Evaluate the risk of your work before finishing a turn:
1. **Low-Risk Fast Path (Skip Advisor — 0 Tokens)**:
   - Single-file or <15-line edits, CSS/formatting tweaks, config changes, status checks, or read-only explanations/lookups. Finish immediately without calling the advisor.
2. **High-Risk Auto-Audit (1 Advisor Call Before Finishing)**:
   - **Complex Multi-File Engineering (`focus="code"`, `--diff`)**: Modifying 2+ files with nontrivial control-flow, state/concurrency, database queries, or security/API logic, or fixing a bug that failed more than once.
   - **Architecture & Implementation Plans (`focus="plan"`)**: Designing multi-step changes or refactors across multiple modules.
   - **Quantitative & Data Claims (`focus="math"`)**: Calculated rates, financial/dollar figures, SQL/data pipelines, or model outputs.
   - **Long-Form Prose & Technical Writing (`focus="prose"`)**: Published essays, reports, or specifications.
   - **Explicit User Requests**: Whenever the user asks for an advisor check, review, or second opinion (pass `force=true` / `--force`).

## 4. Silent Self-Healing
- Invoke via the `consult_advisor` MCP tool or `~/.gemini/config/plugins/advisor/bin/advisor-consult`.
- If the advisor returns `REVISE` or `BLOCK`, fix the verified defects and re-run local tests/linters inside the same turn before reporting back to the user, without re-polling the advisor.
