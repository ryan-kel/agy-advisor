---
name: ea-prose
description: >-
  Electoral Analytics prose workflow: pick Track A/B/C, read 1 live calibrator
  to lock structure and tone, write direct Strunk & White prose grounded in
  verified numbers, and run ea-lint.mjs afterward.
---

# Electoral Analytics Prose Workflow

Follow this lean 3-step sequence when writing or editing Electoral Analytics prose—do **not** pre-load half a dozen style manuals before drafting.

## 1. Pick the Voice Track & Open 1 Calibrator

| Track | Deliverable | Voice & Framing |
| --- | --- | --- |
| **Track A: Website** | `electoralanalytics.net` (`site/main.html`, Nunjucks pages) | Direct institutional third person ("Electoral Analytics", "this analysis", or the concrete subject/agency). Active verbs; let verified numbers carry the argument without moralizing ("the mayor must") or workshop labels ("What this page reports"). |
| **Track B: Civic Essay** | Outbound print/Word essay (`output/*.docx`) | Local or first-person civic framing allowed here only (never copy onto `site/main.html`). See `~/sites/electoralanalytics-site/docs/style/civic-essay.md` only when drafting Track B. |
| **Track C: Site Identity** | `/about/`, `/contact/`, founder bio | Complete sentences, founder perspective, affirmative standards. |

- Before writing a new page or essay, open **1 matching live calibrator** listed in `~/sites/electoralanalytics-site/docs/style/calibrators.md` to match its layout and rhythm.

## 2. Draft with Clear English & Verified Numbers

- **Verify math first:** Check counts, rates, and dollar figures against `data/` and primary agency sources before writing.
- **Lock one thesis sentence:** Lead with the finding and who acted or paid; let ratios, counts, and dollar amounts state magnitude instead of adverbs ("fell sharply").
- **Clear English wins:** Follow Strunk & White—active voice, concrete nouns, positive form, zero throat-clearing.

## 3. Run Deterministic Lint After Drafting

Instead of memorizing mechanical bans while writing, write naturally and then run:

```bash
node ~/shared/tools/ea-lint.mjs <path>
```

(`ea-lint.mjs` deterministically catches em dashes `—`, `%` in body prose, `~` approximations, sentence-initial numerals, filler phrases, missing `rel="noopener noreferrer"`, and inline `style` attributes on `<a>`/`<td>`/`<th>`.)
