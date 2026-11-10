# Global Workspace Orientation & Rules

Ryan E. Kelly's development environment. See `~/shared/docs/workspace-routing.md` for full routing and operational details.

## Directory Layout
Canonical paths live under `~/dev/`; see `~/dev/INDEX.md` for the generated per-project index (rerun `bash ~/work/reorg-2026-11-08/gen-index.sh` to refresh).
- `~/dev/sites/` (`~/sites`): Electoral Analytics website hub (`electoralanalytics-site`), `nys-voter-enrollment`, `predictions`, and sibling civic/data repositories.
- `~/dev/box/`: Box-suite forensic/security tools (`flowbox`, `sleuthbox`, `triagebox`, `battlebox`, `chainbox`, `charmbox`, `canary-tokens`, `box-mascots`).
- `~/dev/labs/`: Standalone applications and experiments. `~/dev/infra/`: local infrastructure (`local-ai-stack`, `pi-config`). `~/dev/archive/`: dormant projects.
- Use canonical `~/dev/...` paths in new work. The 2026-11-08 compatibility symlinks were mostly retired after a reference audit; only `~/dev/nyc-8bit`, `~/dev/kathy_work`, `~/dev/projects/{kathy-routes,resume}`, and `~/dev/sites/electoral-analytics` remain.
- `~/shared/`: Cross-project Electoral Analytics linter (`~/shared/tools/ea-lint.mjs`) and shared docs (`~/shared/docs/`). `~/work/`: non-code deliverables and reports (spreadsheets, resume, asset packs, reviews).

## Truth Hierarchy & Working Rules
1. **Verify in strict order:** (1) Live code, tests, manifests, and server state; (2) project-local `AGENTS.md` and `README.md`; (3) shared standards in `~/shared/docs/`; (4) old notes/handoffs/memories as leads only.
2. Read the active project's `AGENTS.md` and `README.md` before modifying it.
3. Keep changes scoped to the active project or shared file requested.
4. Do not run `git commit`, `git push`, or deployment scripts unless explicitly asked.
5. For UI or visual work, render the page and inspect it visually before calling it done.

## Electoral Analytics (`~/sites/` only)
- Use the `ea-prose` skill for Track A/B/C writing, calibrators, and `ea-lint.mjs` checks, and the `ea-publish` skill for hub publishing and `ea-server` deployment.
- Every published number requires a traceable primary/agency source; never put inline `style` attributes on links or tables.

## System Stability & Tool Routing (`Antigravity` + `MuseCode`)
- **Hands off hardware/network state:** Never run `iw`, `nmcli`, `ethtool`, `rfkill`, `udevadm`, or `systemctl` network/display restarts unless explicitly asked (`mt7925e` on `wlp11s0` wedges on `nl80211` dumps).
- **Sequential execution (no process storms):** Run heavy builds (`cargo`, `11ty`, `pytest`), browser checks, and shell tasks sequentially—never in concurrent bursts that contend with `kwin_wayland` or GPU workloads. Keep threads scoped to one project/task.
- **Use `MuseCode` (`~/.local/bin/muse`) for heavy sweeps & second opinions:** Delegate repo-wide refactors, multi-project git/file surgery, batch codebase cleanups, and on-demand codebase audits to `~/.local/bin/muse exec` (`muse-wonder-full-1.0`) while keeping architecture, UI/visual work, prose, and interactive product iteration in Antigravity.

## Communication
- Be direct and specific; show tradeoffs when they matter.
- Avoid filler, do not validate weak assumptions, and do not use emojis unless requested.
