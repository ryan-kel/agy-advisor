# Cross-Model Advisor Rules (On-Demand Second Opinion)

An independent cross-model advisor powered by **MuseCode (`muse-wonder-full-1.0`)**, **Claude Opus 5.5** (`deep` / `opus` / `opus-high` / `opus-medium` / `opus-low`), **Claude Sonnet 5.5** (`sonnet` / `sonnet-high` / `sonnet-medium` / `sonnet-low`), and **GPT-OSS 120B** (`gpt-oss`) is installed in `~/.gemini/config/plugins/advisor/`.

## 1. Loop Prevention (Read First)
- If your prompt begins with `[ADVISOR REVIEW REQUEST` or `AGY_ADVISOR_ACTIVE=1` is set in the environment, **you ARE the advisor**. Never call `consult_advisor`, `advisor-consult`, or `invoke_subagent`. Return your structured audit immediately.

## 2. Strictly On-Demand (Never Run Automatically)
1. **Explicit User Request Only**: Call `mcp_advisor_mcp_consult_advisor` (or `~/.local/bin/advisor-consult`) **ONLY** when the user explicitly asks for a review, second opinion, or advisor check (e.g., *"ask advisor"*, *"run opus on this"*, *"review this with muse"*). Never run it automatically at the end of normal tasks.
2. **Strict 1-Pass Cap (Never Loop for `APPROVE`)**: When requested, call the advisor **at most ONCE** per request. Treat findings as `<advisory guidance="weigh, don't blindly obey">`—fix real bugs or math errors, ignore speculative edge-case nitpicks, and never loop chasing `APPROVE`.
3. **Model Tiering**:
   - `tier="auto"` (default): Uses **`muse-wonder-full-1.0`** via standalone `muse exec` when `~/.local/bin/muse` is authenticated (zero load on Antigravity's `language_server`), falling back to **Claude Sonnet 5.5** if `muse` is not installed.
   - `tier="muse"` / `tier="muse-xhigh"`: Explicitly routes to **`muse-wonder-full-1.0`** (`high` / `xhigh`).
   - `tier="deep"` / `tier="opus"` / `tier="opus-high"`: Explicitly routes to **Claude Opus 5.5** (`medium` / `high`).

## 3. Mandatory Visibility
- Whenever you call `consult_advisor` or `advisor-consult`, include its `> [!NOTE] **Advisor Called — ...**` banner at the top of your response.
