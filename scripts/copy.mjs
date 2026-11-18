// Gathers what the release zip holds into dist/, the same on every platform.
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const entries = ["module.json", "pum-companion-bridge.js", "vendor", "README.md", "CHANGELOG.md", "LICENSE.md", "THANKS.txt"];

rmSync(dist, { recursive: true, force: true });
for (const entry of entries) {
  cpSync(path.join(root, entry), path.join(dist, entry), { recursive: true });
  console.log(`Copied ${entry}`);
}
