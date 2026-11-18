// Links this folder into Foundry's modules, so edits only need an F5 in Foundry.
// Set FOUNDRY_MODULES to your Data/modules folder if it isn't in the default place.
import { existsSync, lstatSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modules = process.env.FOUNDRY_MODULES ?? (process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA ?? "", "FoundryVTT", "Data", "modules")
  : process.platform === "darwin"
    ? path.join(process.env.HOME ?? "", "Library", "Application Support", "FoundryVTT", "Data", "modules")
    : path.join(process.env.HOME ?? "", ".local", "share", "FoundryVTT", "Data", "modules"));
const target = path.join(modules, "pum-companion-bridge");

if (!existsSync(modules)) {
  console.error(`No modules folder at ${modules}. Set FOUNDRY_MODULES to it.`);
  process.exit(1);
}
if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
  console.log(`Already there: ${target}`);
  process.exit(0);
}
// A junction on Windows needs no admin rights.
symlinkSync(root, target, process.platform === "win32" ? "junction" : "dir");
console.log(`Linked ${target} -> ${root}`);
