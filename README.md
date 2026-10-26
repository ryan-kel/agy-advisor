# Cross-Model Advisor Plugin (`agy-advisor`)

Native Antigravity plugin that provides an independent cross-model verification gate using your Antigravity subscription models (**Claude Opus 5.5 (High)** and **Claude Sonnet 5.5**) with automatic complexity gating and strict anti-token-burner guardrails.

## Quick Install on Any Machine

```bash
git clone https://github.com/ryan-kel/agy-advisor.git ~/projects/agy-advisor
bash ~/projects/agy-advisor/install.sh
```

Or to update an existing checkout:

```bash
cd ~/projects/agy-advisor && git pull && bash install.sh
```

## Bundled Components

- **MCP Server (`mcp/advisor-server.mjs`)**: Exposes `consult_advisor` and `check_advisor_quota` with `_meta: {"antigravity/alwaysLoad": true}`.
- **CLI Tool (`bin/advisor-consult` / `~/.local/bin/advisor-consult`)**: Standalone executable script that runs `agy --agent advisor-engine --mode plan --sandbox --model <model> --effort <effort>`.
- **Read-Only Engine Profile (`agents/advisor-engine.md`)**: Hidden read-only profile (`read_file`, `grep_search`, `find_by_name`, `list_dir` only; `inheritMcp: false`) with a hard 1-2 turn tool cap.
- **Custom Subagent (`agents/advisor.md`)**: Allows async delegation via `invoke_subagent(TypeName="advisor", ...)`.
- **Skill (`skills/advisor-review/SKILL.md`)**: Playbook for preparing high-signal review packets across `plan`, `code`, `prose`, `math`, and `general` review modes.
- **Always-On Rule (`rules/AGENTS.md`)**: "Automatic Transmission" complexity gate that skips trivial work and runs at most 1 advisor audit per turn on high-risk work.

## Built-in Anti-Token-Burner Protections

1. **Smart Auto-Tiering (`--tier auto`, default)**:
   - Routes `plan`, `math`, and `prose` audits to **Claude Opus 5.5 (High)**.
   - Routes `code` and `general` reviews to **Claude Sonnet 5.5 (Medium)** for diffs under 150 lines and **Claude Sonnet 5.5 (High)** for larger diffs.
2. **Trivial Diff Skip (`0 tokens`)**: If `--focus code --diff` is run on a git diff with `< 12` changed lines and no untracked files, it returns an instant fast-path pass without spawning a model session.
3. **30-Minute Exact-Match Deduplication Cache (`0 tokens`)**: Identical `(model, focus, workspace, files, prompt, gitStatus, gitDiff)` requests return the cached audit from `~/.gemini/antigravity/plugin_data/advisor/advisor-cache.json`.
4. **60-Second Workspace Cooldown (`0 tokens`)**: Prevents Gemini from calling the advisor multiple times in a fix-review-fix loop within the same workspace.
5. **Hourly Rate Limiter & Auto-Downshift**: Automatically downshifts `opus-high` to `sonnet-medium` after 5 calls in 60 minutes, and caps automatic calls at 10 per hour (pass `--force` to override any guard when you explicitly ask for a review).
6. **Hard 2-Turn Tool Budget & 85s Print Timeout**: Keeps advisor sessions focused on the pre-attached diff and target files instead of wandering the repository.
