---
name: anki-card-creation
description: "Turn a research paper, slide deck, or topic into reviewable Anki cards, output as a deltos JSONL batch for `dt notes add --jsonl`. Verifies each card against its source and de-duplicates against existing decks before writing anything. Use when the user says 'annotate <paper> <topic>', 'extract cards from <source>', 'make anki cards for <subject>', or 'create flashcards'. Produces a reviewable batch file; importing it is a separate, confirmed step. Assumes the deltos CLI (`dt`) is installed."
argument-hint: "<source path or topic>  [deck name]"
---

# Anki Card Creation

Produce high-quality Anki cards from a source, as a `deltos` JSONL batch the user reviews before import. The mechanics of insertion belong to `dt`; this skill owns the extraction, verification, and formatting.

## Workflow

1. **Read the source.** A PDF/markdown/slide path in `$ARGUMENTS`, or research a named topic. Read it fully before extracting — do not card-ify a skim.
2. **Extract the testable atoms.** One fact, definition, mechanism, or relationship per card. Prefer cards that ask *why* / *when* / *how* over bare recall where the material supports it. Skip the trivially obvious — YAGNI applies to cards too; a deck the user won't review is waste.
3. **Verify against the source.** Every back-of-card claim must be supported by the source text. Drop or flag anything you cannot ground; do not synthesize facts to fill a quota.
4. **De-duplicate.** Before writing, check existing decks for near-duplicates so review load does not bloat:

   ```bash
   dt notes list --deck "<deck>" --format json   # adjust to the installed dt's query syntax
   ```

   Merge or skip overlaps rather than adding a second phrasing of the same card.
5. **Write the batch** to a reviewable file (e.g. `cards.jsonl`), one card per line. Do not import yet.
6. **Show a short summary** — count, deck, tags, any cards flagged unverified — and ask before importing.

## Card format (deltos JSONL)

One JSON object per line:

```json
{"deck": "Psychology::Work Stress", "front": "What does the JD-R model claim drives burnout?", "back": "An imbalance of high job demands and low job resources.", "tags": ["demerouti-2001", "jd-r", "work-stress"], "type": "basic"}
```

- `type`: `basic` or `cloze` (use cloze for definitions and enumerations).
- For image-occlusion or diagram cards, hand off to `dt notes occlude` / `dt notes diagram` rather than encoding them here.

## Conventions

- **Deck naming:** `Author Year Topic` for sources (e.g. `Demerouti 2001 JD-R`); hierarchical with `::` for structure (`Psychology::Work Stress::Models`).
- **Tags:** consistent, hierarchical, lower-case-kebab; tag by source, topic, and type so cards are filterable later.

## Import (separate, confirmed step)

After the user approves the batch:

```bash
dt notes add --jsonl cards.jsonl
```

## Cost & scope

Cards cost review time forever, so be selective, not exhaustive — a tight deck of load-bearing cards beats a bloated one. Default to a sane batch size and ask before extracting hundreds. This skill creates and verifies cards; it does not prune existing decks (that is a separate review pass).
