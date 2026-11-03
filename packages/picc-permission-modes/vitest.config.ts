import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Pi supplies peers. Resolve their ESM entry points without assuming nested deps
// or relying on a CJS export (Pi 1.4 exposes import-only package exports).
const host = process.env.PI_HOST_DIR;
const require = createRequire(host ? join(host, "package.json") : import.meta.url);
const peers = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"];
function entry(name: string): string {
  if (name === "@earendil-works/pi-coding-agent") return join(host!, "dist/index.js");
  if (name === "typebox") return require.resolve(name);
  const found = require.resolve.paths(name)?.map((dir) => join(dir, name, "dist/index.js")).find(existsSync);
  if (!found) throw new Error(`Missing Pi peer ${name}; set PI_HOST_DIR to your Pi installation`);
  return found;
}
export default defineConfig({
  resolve: { alias: host ? [
    { find: "@earendil-works/pi-tui/dist/tui.js", replacement: join(entry("@earendil-works/pi-tui"), "../tui.js") },
    ...peers.map((name) => ({ find: new RegExp(`^${name}$`), replacement: entry(name) })),
  ] : [] },
  test: { globals: true, environment: "node", include: ["**/*.test.ts"] },
});
