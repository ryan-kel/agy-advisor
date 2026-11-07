---
name: advisor-review
description: >-
  Run a 1-pass cross-model advisor review using Claude Opus 5.5, Claude Sonnet
  5.5, or GPT-OSS 120B to catch bugs, simplify over-engineered code, verify
  math/data claims, and cut prose/UI slop. Use once per deliverable or whenever
  the user asks for a review or second opinion.
---

# Cross-Model Advisor Workflow (1-Pass High-Taste Partner)

Use the cross-model advisor to get an independent 1-shot review from **Claude Opus 5.5**, **Claude Sonnet 5.5**, or **GPT-OSS 120B** running in strict read-only `advisor-engine` mode with deterministic `[Blocker | Concern | Nit]` calibration, `AdvisorEmissionGuard` NFKC deduplication, and `WATCHDOG.md` / `WATCHDOG.yml` project rule discovery.

## 1. Zero-Token Preflight (Always Do First)

Before calling the advisor, run deterministic local checks so you never waste subscription quota on obvious syntax or lint errors:
- Run the project's unit tests (`pytest`, `npm test`, `go test`) and check `git status --short` / `git diff HEAD`.
- If working under `~/sites/` where `~/shared/tools/ea-lint.mjs` exists, run `node ~/shared/tools/ea-lint.mjs <path>` and fix all violations first.

## 2. The 1-Pass Rule (`implement-and-review` Pattern)

- Call `mcp_advisor_mcp_consult_advisor` **at most once per deliverable**:
  1. **Implement** the requested work and pass local deterministic checks.
  2. **Review once** via `mcp_advisor_mcp_consult_advisor`.
  3. **Weigh & finish**: treat `<advisory guidance="weigh, don't blindly obey">` notes with engineering judgment—fix verified `[Blocker]` bugs, math errors, or prose/UI slop; ignore speculative edge-case nitpicks or false alarms caused by unattached files; and **never** loop on repeat advisor calls chasing an `APPROVE` badge.
- Use `tier="deep"` (`Claude Opus 5.5 Medium`) or `tier="opus-high"` (`Claude Opus 5.5 High`) when reviewing flagship architecture, simplification plans, or editorial prose.

## 3. Auto-Tiering (`--tier auto`, Default)

| Checkpoint | `--focus` | Auto-Selected Model (1-Shot Mode) | Context Attached Automatically |
| --- | --- | --- | --- |
| **Architecture / Simplification Plan** | `plan` | `claude-sonnet-5-5-high` (`high`, 180s) | `WATCHDOG.md`/`WATCHDOG.yml` rules + target files (up to 8 files, 24 KB each; supports `path:start-end`, `path#Lstart-Lend`, `path:line`) |
| **Multi-File Code Changes / Bugfixes** | `code` | `claude-sonnet-5-5-medium` (`medium`, 120s) | `WATCHDOG.md`/`WATCHDOG.yml`, optional incremental transcript delta, `git status`, `git diff HEAD` (or `git show HEAD`), and target files |
| **Quantitative / Data / SQL Claims** | `math` | `claude-sonnet-5-5-high` (`high`, 180s) | Target files and calculations |
| **Long-Form Prose / Specs** | `prose` | `claude-sonnet-5-5-high` (`high`, 180s) | Auto-attaches `ea-lint.mjs` output (for all `prose` calls and any work under `~/sites/`) and target files |
| **Doc-to-Code Drift Check** | `drift` | `claude-sonnet-5-5-medium` (`medium`, 120s) | Docs/READMEs/schemas + implementation files to detect contradicted or stale claims |
| **General Second Opinion** | `general` | `claude-sonnet-5-5-medium` (`medium`, 120s) | Target files and optional diff |
