---
name: tdd
description: "Drive a feature with a lightweight Red-Green-Refactor loop: write a failing test, write the minimal code to pass it, optionally tidy, repeat. Opt-in only — invoked by /tdd or when the user explicitly asks for TDD. Use for logic worth pinning down before writing it: parsers, state machines, money/security paths, tricky algorithms, regression fixes. Skip it for trivial code, glue, and throwaway scripts. TDD multiplies model turns and token cost, so keep increments coarse and narration minimal."
argument-hint: "[plan-file.md | inline feature description]"
---

# TDD (lightweight)

Tests drive the code: no production line is written before a test that fails without it. This is the heavier, proactive sibling of the "leave one runnable check" rule in `AGENTS.md` — reach for it only when the logic earns it.

## Cost discipline (read first)

TDD multiplies turns and tokens. Keep it cheap:

- **Use it selectively.** Non-trivial logic only. Trivial one-liners, glue, and config get a single check or none — YAGNI applies to tests too.
- **Coarse increments.** A handful of meaningful behaviors, not one assertion per turn. Decompose only as far as each step is independently testable.
- **Minimal narration.** No per-step essays. One line per phase transition.
- **Run narrowly in the loop.** Run only the test(s) for the current increment during RED/GREEN; run the full suite once at the end.

## Setup

1. Read the input: a plan file path in `$ARGUMENTS`, or an inline description, or the current task.
2. Detect the language and existing test framework. Reuse whatever the repo already uses; do not add a test dependency (see *Dependency minimalism*). If none exists, use the language's built-in assert / `__main__` self-check.
3. List the *behaviors* to test — not implementation steps — one line each, ordered by priority. You cannot test everything; with the user, focus on critical paths and complex logic over exhaustive edge cases. Get one approval before starting. This is the only mandatory pause.

## Loop (per increment)

Work in **vertical slices (tracer bullets)**, never horizontal: one test → the code that passes it → repeat. Do not write all the tests first and then all the code. Tests authored in bulk verify *imagined* behavior — they test the shape of things, pass while real behavior breaks, and commit you to a structure before you understand the implementation. Each test should respond to what the previous cycle taught you.

**RED** — Write one failing test directly to the real test file. Run it. Confirm it fails for the expected reason. Pause only if it passes unexpectedly (the test is wrong or the behavior already exists).

**GREEN** — Write the minimal code to pass it — the simplest thing that works, per the Minimal-Code Discipline ladder. Run the increment's test. If it fails, fix and rerun; pause if still failing after a reasonable attempt.

**REFACTOR** — Only if there is a concrete improvement (dedupe, rename, inline). Never refactor while RED — get to GREEN first, then improve against passing tests. Rerun the test after. Skip silently when there is nothing to do — do not invent refactors.

**NEXT** — One-line completion note, move on. No pause.

Write directly to real files — no temp files, no asking the user to relocate code. The user has git for undo.

## Test quality

Test behavior, not implementation — what the code does, not how. A test that breaks on a harmless rename is testing the wrong thing.

## Wrap-up

Run the full suite once. Report: increments completed, total test count, pass/fail, and any behavior left untested worth a follow-up. Keep it to a few lines.

## Boundaries

Opt-in. Does not change unrelated code. If the user says "stop tdd" or "just write it", revert to writing the code with a single check left behind per the `AGENTS.md` rule.
