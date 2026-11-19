import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", (event) => {
    if (process.argv.some((arg) => ["--no-approve", "-na", "--no-skills", "-ns"].includes(arg))) return;
    const skillPaths: string[] = [];
    for (const child of readdirSync(event.cwd, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      for (const config of [".pi", ".agents"]) {
        const path = join(event.cwd, child.name, config, "skills");
        try {
          if (statSync(path).isDirectory()) skillPaths.push(path);
        } catch (error) {
          if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
    }
    return { skillPaths };
  });
}
