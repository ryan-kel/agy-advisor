---
name: advisor-review
description: >-
  Run a cross-model Goldfish advisor audit using Claude Sonnet 5.5, Claude Opus
  5.5, or GPT-OSS 120B to catch mistakes in implementation plans, code diffs,
  quantitative/data claims, long-form prose, or doc-to-code drift. Use at
  substantive checkpoints before finalizing deliverables, alongside EGM specs,
  or whenever the user asks for an advisor review or second opinion.
---

# Cross-Model Goldfish Advisor Workflow

Use the cross-model advisor to get an independent 1-shot Goldfish audit from **Claude Sonnet 5.5**, **Claude Opus 5.5**, or **GPT-OSS 120B** running in strict read-only `advisor-engine` mode with deterministic `[Blocker | Major | Nit]` verdict calibration.

## 1. Zero-Token Preflight (Always Do First)

Before calling the advisor, run deterministic local checks so you never waste subscription quota on obvious syntax or lint errors:
- Run the project's unit tests (`pytest`, `npm test`, etc.) and check `git status --short` / `git diff HEAD`.
- If working under `~/sites/` where `~/shared/tools/ea-lint.mjs` exists, run `node ~/shared/tools/ea-lint.mjs <path>` and fix all violations first.

## 2. Choose the Invocation Path

1. **MCP Tool (`consult_advisor` / `mcp_advisor_mcp_consult_advisor`)** — Preferred when loaded:
   - Pass `prompt`, `focus` (`plan` | `code` | `prose` | `math` | `drift` | `general`), `tier` (`auto` | `deep` | `opus-high` | `opus` | `opus-medium` | `opus-low` | `fast` | `sonnet` | `sonnet-high` | `sonnet-medium` | `sonnet-low` | `gpt-oss`), optional `effort` (`low` | `medium` | `high` | `xhigh` | `max`), `workspace`, `files`, and `include_git_diff`.
2. **CLI Helper (`advisor-consult`)** — Always available via `run_command` (supports `--focus`, `--tier`/`--model` including custom `<model-id>` strings, `--effort`, `--workspace`, repeatable `--file`, `--diff`, `--force`, and `-` to read prompt from stdin):
   ```bash
   ~/.gemini/config/plugins/advisor/bin/advisor-consult \
     --focus <plan|code|prose|math|drift|general> \
     --tier auto \
     --workspace /path/to/repo \
     --file /path/to/file1:1-200 \
     --diff \
     "Explain the plan, claims, or changes to audit"
   ```
3. **Background Subagent (`invoke_subagent` with `TypeName: "advisor"`)** — Best for async parallel audits when discovery is needed before calling `mcp_advisor_mcp_consult_advisor`.

## 3. Smart Auto-Tiering (No Rate Limits or Cooldowns)

Leave `--tier auto` (the default) unless a specific model is requested. There are **no hourly caps, cooldowns, or rate limits** — run the advisor whenever requested or needed:

| Checkpoint | `--focus` | Auto-Selected Model (1-Shot Mode) | Context Attached Automatically |
| --- | --- | --- | --- |
| **Implementation / EGM Spec Plan** | `plan` | `claude-sonnet-5-5-medium` (`medium`, 120s) | Target files (up to 8 files, 24 KB each; supports `path:start-end`, `path#Lstart-Lend`, `path:line`) |
| **Multi-File Code Changes / Bugfixes** | `code` | `claude-sonnet-5-5-medium` (`medium`, 120s) | `git status`, `git diff HEAD` (or `git show HEAD` when no tracked changes), and target files |
| **Quantitative / Data / SQL Claims** | `math` | `claude-sonnet-5-5-high` (`high`, 180s) | Target files and calculations |
| **Long-Form Prose / Specs** | `prose` | `claude-sonnet-5-5-high` (`high`, 180s) | Auto-attaches `ea-lint.mjs` output (for all `prose` calls and any work under `~/sites/`) and target files |
| **Doc-to-Code Drift Check** | `drift` | `claude-sonnet-5-5-medium` (`medium`, 120s) | Docs/READMEs/schemas + implementation files to detect contradicted or stale claims |
| **General Second Opinion** | `general` | `claude-sonnet-5-5-medium` (`medium`, 120s) | Target files and optional diff |

## 4. Using with the Elephant-Goldfish Model (`egm`)

- **Fast 1-Shot Cross-Model Spec Review**: After drafting a concept brief or design spec (`/egm-brainstorm` or `/egm-draft`), run `mcp_advisor_mcp_consult_advisor(focus="plan", files=["docs/designs/feature.md"])` to get a 4-lens Goldfish review (`Zoom-Out`, `Comprehension`, `Design Critic`, `Implementation Readiness`) from **Claude** in ~20–60s.
- **Full Dual-Channel Audit**: Run `mcp_advisor_mcp_consult_advisor` (cross-model 1-shot Claude) in parallel with EGM Goldfish subagents (`invoke_subagent`) when auditing multi-file repositories that benefit from interactive codebase search (`grep_search` / `read_file`).

## 5. Act on the `[Blocker | Major | Nit]` Verdict

- **`APPROVE`** (0 Blockers, 0 Majors; Nits optional): Present the final result to the user.
- **`REVISE` (≥1 Major) or `BLOCK` (≥1 Blocker)**: Evaluate each `[Blocker]` and `[Major]` finding (`APPLY FIX` vs. `CONTEST` if an intentional tradeoff), fix verified defects, and re-verify locally. If you run a re-audit pass, include any `CONTEST`ed tradeoffs in `prompt` so the stateless Goldfish advisor does not re-litigate settled decisions.
