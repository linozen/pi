---
name: align
description: "A relentless interview that stress-tests a plan or design until you and the user reach shared understanding, before any code is written. Asks one question at a time, each with a recommended answer, walking the design tree and resolving dependencies between decisions one by one. Use when the user says 'align', 'grill me', 'grill this', 'stress-test the plan', 'poke holes in this', or wants a design pinned down before building. Opt-in; reserve it for non-trivial or ambiguous work."
argument-hint: "[plan, design, or feature to align on — defaults to the current conversation]"
---

# Align

Interview the user relentlessly about every aspect of the plan until you reach a shared understanding of the design. The goal is to surface hidden assumptions, ambiguities, and unmade decisions before a line of code commits you to them.

## Rules

- **One question at a time.** Wait for the answer before asking the next. Asking several at once is bewildering and produces shallow answers.
- **Recommend an answer with every question.** State your recommended default and the reasoning in one line, so the user can confirm cheaply instead of composing an answer from scratch.
- **Explore before asking.** If a question can be answered by reading the codebase, read it — do not ask the user what the code already states.
- **Walk the design tree.** Resolve decisions in dependency order: settle the choice that downstream choices hinge on first, then descend. Note when one answer closes or reopens later branches.
- **Probe with concrete scenarios.** Stress-test fuzzy claims with specific edge cases that force precision ("what happens when the cart is empty?", "two writers, same key, same millisecond?").
- **Challenge vague terms.** When a word is overloaded, pin it down ("'account' — the Customer or the login User? they are different things").

## Cost discipline

This is opt-in and proportional. Skip it for small, clear tasks — clarify minimally and proceed. Stop as soon as the design is settled; do not manufacture questions past the point of shared understanding.

## When the design is settled

Summarize the agreed design in a few lines: the decisions made and the assumptions they rest on. Then hand off — to `/tdd` or implementation for code, or to a planning step for larger work.

Offer to record an ADR **only** when all three hold:

1. **Hard to reverse** — changing your mind later carries real cost.
2. **Surprising without context** — a future reader will ask "why this way?".
3. **A genuine trade-off** — real alternatives existed and one was chosen for stated reasons.

If any is missing, skip the ADR; the conversation summary is enough.
