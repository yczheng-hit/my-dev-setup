import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWithHerdrLabels } from "./labels.mjs";

// npm:pi-subagents stays installed (and supplies its skills); only its factory is
// loaded here so this package can adapt that factory's private exec capability.
export default async function subagentsHerdrLabels(pi: ExtensionAPI) {
  let entry: string | undefined;
  // This adapter is a personal package: do not resolve arbitrary cwd/.pi/npm code
  // before Pi's project-trust gate. Project-local overrides must use their own entry.
  try {
    entry = createRequire(join(getAgentDir(), "npm", "package.json")).resolve("pi-subagents");
  } catch { /* Report a useful error below; never silently omit the extension. */ }
  if (!entry) throw new Error("pi-subagents-herdr-labels requires npm:pi-subagents to be installed (extensions: []). Run pi update --extensions, then restart Pi.");
  const upstream = await import(pathToFileURL(entry).href);
  if (typeof upstream.default !== "function") throw new Error("pi-subagents no longer exports an extension factory; update the Herdr labels adapter.");
  return registerWithHerdrLabels(pi, upstream.default);
}
