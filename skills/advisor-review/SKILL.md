---
name: advisor-review
description: >-
  Run a cross-model advisor audit using Claude Opus 5.5 (High) or Claude Sonnet
  5.5 to catch mistakes in implementation plans, code diffs, quantitative/data
  claims, or long-form prose. Use at substantive checkpoints before finalizing
  deliverables, or whenever the user asks for an advisor review or second
  opinion.
---

# Cross-Model Advisor Workflow

Use the cross-model advisor to get an independent audit from **Claude Opus 5.5 (High)** or **Claude Sonnet 5.5** running in strict read-only `advisor-engine` mode.

## 1. Zero-Token Preflight (Always Do First)

Before calling the advisor, run deterministic local checks so you never waste subscription quota on obvious syntax or lint errors:
- Run the project's unit tests (`pytest`, `npm test`, etc.) and check `git status --short` / `git diff HEAD`.
- If working under `~/sites/` where `~/shared/tools/ea-lint.mjs` exists, run `node ~/shared/tools/ea-lint.mjs <path>` and fix all violations first.

## 2. Choose the Invocation Path

1. **MCP Tool (`consult_advisor` / `advisor_mcp_consult_advisor`)** — Preferred when loaded:
   - Pass `prompt`, `focus` (`plan` | `code` | `prose` | `math` | `general`), `tier` (`auto` | `deep` | `fast`), `workspace`, `files`, `include_git_diff`, and `force` (true only when the user explicitly requests a review).
2. **CLI Helper (`advisor-consult`)** — Always available via `run_command`:
   ```bash
   ~/.gemini/config/plugins/advisor/bin/advisor-consult \
     --focus <plan|code|prose|math|general> \
     --tier auto \
     --workspace /path/to/repo \
     --file /path/to/file1 \
     --diff \
     "Explain the plan, claims, or changes to audit"
   ```
3. **Background Subagent (`invoke_subagent` with `TypeName: "advisor"`)** — Best for async parallel audits.

## 3. Smart Auto-Tiering & Token Guards

Leave `--tier auto` (the default) unless a specific model is requested:

| Checkpoint | `--focus` | Auto-Selected Model | Built-in Token Guard |
| --- | --- | --- | --- |
| **Implementation / Architecture Plan** | `plan` | `claude-opus-5-5-high` (`high`) | 30m exact-match cache + 60s workspace cooldown |
| **Quantitative / Data / SQL Claims** | `math` | `claude-opus-5-5-high` (`high`) | 30m exact-match cache + 60s workspace cooldown |
| **Long-Form Prose / Specs** | `prose` | `claude-opus-5-5-high` (`high`) | Auto-attaches `ea-lint.mjs` (if present) + 60s cooldown |
| **Multi-File Code Changes / Bugfixes** | `code` | `claude-sonnet-5-5-medium` (<150 lines) or `claude-sonnet-5-5-high` (>=150 lines) | Skips automatically (`0 tokens`) if diff is <12 lines with no untracked files |

## 4. Act on the Verdict (Max 1 Call Per Turn)

- **`APPROVE`**: Present the final result to the user.
- **`REVISE` or `BLOCK`**: Fix every verified defect or style violation and re-verify locally inside the same turn. Do **not** re-poll the advisor in a loop after applying its fixes.
