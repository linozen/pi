import { test } from "node:test";
import { deepStrictEqual } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../child-skills.ts";

test("discovers only immediate real child skill directories", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-child-skills-"));
  try {
    for (const path of ["a/.pi/skills", "a/.agents/skills", "b/nested/.pi/skills"]) {
      mkdirSync(join(cwd, path), { recursive: true });
    }
    symlinkSync(join(cwd, "a"), join(cwd, "link"));
    let handler: (event: { cwd: string }) => { skillPaths: string[] };
    extension({ on: (_name: string, callback: typeof handler) => { handler = callback; } } as never);
    deepStrictEqual(handler!({ cwd }).skillPaths.sort(), [
      join(cwd, "a/.agents/skills"),
      join(cwd, "a/.pi/skills"),
    ].sort());
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
