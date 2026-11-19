import { test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../child-skills.ts";

test("discovering real immediate child skill roots requires opt-in and project trust", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-child-skills-"));
  try {
    for (const path of ["a/.pi/skills", "a/.agents/skills", "b/nested/.pi/skills"]) {
      mkdirSync(join(cwd, path), { recursive: true });
    }
    symlinkSync(join(cwd, "a"), join(cwd, "link"));
    mkdirSync(join(cwd, "linked-config"));
    symlinkSync(join(cwd, "a/.pi"), join(cwd, "linked-config/.pi"));
    mkdirSync(join(cwd, "linked-skills/.agents"), { recursive: true });
    symlinkSync(join(cwd, "a/.agents/skills"), join(cwd, "linked-skills/.agents/skills"));

    let optIn = false;
    let handler: (event: { cwd: string }, ctx: { isProjectTrusted: () => boolean }) => { skillPaths: string[] } | undefined;
    t.mock.method(process, "cwd", () => cwd);
    extension({
      registerFlag() {},
      getFlag: () => optIn,
      on: (_name: string, callback: typeof handler) => { handler = callback; },
    } as never);
    const discover = (trusted: boolean, dir = cwd) => handler!({ cwd: dir }, { isProjectTrusted: () => trusted });
    deepStrictEqual(discover(true), undefined);
    optIn = true;
    deepStrictEqual(discover(false), undefined);
    deepStrictEqual(discover(true, join(cwd, "a")), undefined);
    deepStrictEqual(discover(true)?.skillPaths.sort(), [
      join(cwd, "a/.agents/skills"),
      join(cwd, "a/.pi/skills"),
    ].sort());
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
