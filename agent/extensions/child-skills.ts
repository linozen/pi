import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("child-skills", {
    description: "Load skills from immediate child projects of the trusted launch directory",
    type: "boolean",
    default: false,
  });
  const launchDir = process.cwd();

  pi.on("resources_discover", (event, ctx) => {
    if (!pi.getFlag("child-skills") || !ctx.isProjectTrusted() || event.cwd !== launchDir) return;
    // Pi treats extension-contributed paths like explicit skills, which can override --no-skills.
    if (process.argv.some((arg) => arg === "--no-skills" || arg === "-ns")) return;
    const skillPaths: string[] = [];
    for (const child of readdirSync(event.cwd, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      for (const config of [".pi", ".agents"]) {
        const configDir = join(event.cwd, child.name, config);
        if (!lstatSync(configDir, { throwIfNoEntry: false })?.isDirectory()) continue;
        const skillsDir = join(configDir, "skills");
        if (lstatSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()) skillPaths.push(skillsDir);
      }
    }
    return { skillPaths };
  });
}
