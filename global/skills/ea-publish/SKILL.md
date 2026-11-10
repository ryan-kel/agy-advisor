---
name: ea-publish
description: >-
  Runbook for verifying, building, and publishing Electoral Analytics projects
  to electoralanalytics-site and deploying to ea-server. Use when preparing a
  project for publication, checking deploy readiness, or running VPS deploys.
---

# Electoral Analytics Publish & Deploy Runbook

Follow these verification gates when publishing a sibling project under `~/sites/` into `~/sites/electoralanalytics-site` or preparing a release for `ea-server`.

## 1. Preflight & Registry Verification

1. Read `~/sites/electoralanalytics-site/docs/ops.md`.
2. Check that `~/sites/electoralanalytics-site` has a clean working tree (`git status --porcelain --untracked-files=all`).
3. Confirm the project is registered in:
   - `~/sites/electoralanalytics-site/src/_data/projects.json`
   - `~/sites/electoralanalytics-site/publish/projects/<slug>.json`
   - `~/shared/docs/ea-project-slate.md`

## 2. Sibling Project Build & Lint

In the sibling project repository (`~/sites/<slug>`):

1. Run the project's test suite (`pytest` or `python3 -m unittest discover -s tests -p 'test_*.py'`).
2. Run the house prose linter:
   ```bash
   node ~/shared/tools/ea-lint.mjs .
   ```
3. Verify generated artifacts (`site/main.html`, charts, provenance manifests) match primary data sources.

## 3. Hub Publish & Unified Verification

In `~/sites/electoralanalytics-site`:

1. Preview and run the publish into the local hub:
   ```bash
   npm run publish:project -- <slug> --dry-run
   npm run publish:project -- <slug>
   ```
2. Run the unified verification suite and deploy contract check:
   ```bash
   npm test && npm run verify:deploy-ready
   ```
3. Render the page (`npx @11ty/eleventy --serve`) and visually inspect layout, typography, and tabs before calling the work complete.

## 4. VPS Deployment (Only When Explicitly Requested)

- Never edit live release directories on `ea-server` in place.
- Only committed, verified source ships through:
  ```bash
  bash scripts/deploy-vps.sh
  ```
