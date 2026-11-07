# Cross-Model Advisor Rules (1-Pass High-Taste Partner)

An independent cross-model advisor powered by **Claude Opus 5.5** (`deep` / `opus` / `opus-high` / `opus-medium` / `opus-low`), **Claude Sonnet 5.5** (`auto` / `fast` / `sonnet` / `sonnet-high` / `sonnet-medium` / `sonnet-low`), and **GPT-OSS 120B** (`gpt-oss`) is installed in `~/.gemini/config/plugins/advisor/`.

## 1. Loop Prevention (Read First)
- If your prompt begins with `[ADVISOR REVIEW REQUEST` or `AGY_ADVISOR_ACTIVE=1` is set in the environment, **you ARE the advisor**. Never call `consult_advisor`, `advisor-consult`, or `invoke_subagent`. Return your structured audit immediately.

## 2. The 1-Pass Rule (`implement-and-review` Pattern)
1. **Deterministic Checks First**: Before calling the advisor, run local unit tests (`pytest`, `npm test`, `go test`), linters (including `node ~/shared/tools/ea-lint.mjs` if under `~/sites/`), and `git diff`.
2. **Strict 1-Pass Cap (Never Loop for `APPROVE`)**: Call `mcp_advisor_mcp_consult_advisor` **at most ONCE per deliverable**.
   - **Implement -> Verify Locally -> Consult Advisor Once -> Weigh & Finish.**
   - Treat advisor findings as `<advisory guidance="weigh, don't blindly obey">`: fix verified `[Blocker]` bugs, math errors, or prose/UI slop; ignore speculative edge-case nitpicks or false alarms caused by unattached files; and **never** re-call the advisor in a retry loop chasing an `APPROVE` badge.
3. **Anti-Slop & Simplification Mandate**: Never respond to an advisor review by bolting on unrequested fallback shims, legacy migration branches, or defensive scaffolding. Prefer deleting unnecessary code and keeping implementations small and readable.
4. **Model Tiering**:
   - `tier="auto"` (default): Uses **Claude Sonnet 5.5 (High)** for `plan`, `math`, and `prose`, and **Claude Sonnet 5.5 (Medium)** for `code`, `drift`, and `general`.
   - Use `tier="deep"` (**Claude Opus 5.5 Medium**) or `tier="opus-high"` (**Claude Opus 5.5 High**) when the user asks for a deep review, architectural simplification, or high-taste editorial critique.

## 3. Mandatory Visibility (Always Tell the User)
- Whenever you call `consult_advisor` (`mcp_advisor_mcp_consult_advisor`) or `advisor-consult`, include its `> [!NOTE] **Advisor Called — ...**` banner at the top of your response showing the model used, `focus`, verdict, findings applied vs. skipped, and remaining Claude quota.

## 4. When to Call the Advisor (1 Pass Only)
- **Explicit Requests ("review this", "second opinion", "simplify this")**: Run immediately.
- **Substantive Deliverables (1 Final Check Before Finishing)**:
  - **Architecture & Plans (`focus="plan"`)**: Before executing a major multi-file design or refactor.
  - **Multi-File Code (`focus="code"`, `include_git_diff=true`)**: Once after implementing nontrivial multi-file logic and passing local tests.
  - **Quantitative & Data Claims (`focus="math"`)**: Once to verify denominators, rates, SQL, and dollar figures.
  - **Published Prose & UI Copy (`focus="prose"`)**: Once after `ea-lint.mjs` is clean to check voice, clarity, and anti-slop quality.
