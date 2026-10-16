import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const DEFAULT_CONFIG = {
  autoMode: {
    provider: {
      apiKey: "${ANTHROPIC_AUTH_TOKEN}",
      maxContextChars: 80_000,
    },
    allow: [
      "Standard read-only file inspection inside the working directory.",
      "Standard search/grep/glob operations in the working directory.",
      "Running tests, linters, and formatters.",
      "Editing files inside the current working directory.",
      "git add/commit/diff/log/status/fetch within the repository.",
    ],
    softDeny: [
      "Force pushes (git push -f, git push --force, git push --force-with-lease).",
      "rm -rf outside the working directory.",
      "Editing files outside the working directory without explicit authorization.",
      "Network egress to non-trusted external endpoints.",
      "git push to a branch that is not the session's working branch.",
    ],
    hardDeny: [
      "rm -rf /, rm -rf $HOME, or equivalent filesystem-wide destructive deletes.",
      "Force push to main / master / the repository default branch.",
      "DROP DATABASE / DROP SCHEMA without explicit user confirmation.",
      "Disabling safety tooling, audit logs, or git hooks.",
      "Systematic scanning of credential stores (.env, ~/.aws/, keychains, etc.).",
      "Disabling or removing .claude/ settings, hooks, or rules.",
    ],
    environment: [
      "An autonomous coding agent running inside the user's pi session.",
    ],
    classifyAllShell: false,
    denialLimits: {
      maxConsecutive: 3,
      maxTotal: 20,
    },
    transcriptMaxChars: 80_000,
  },
  permissions: {
    allow: [],
    deny: [],
    ask: [],
  },
};

/** Resolve the user-editable config, rather than the installed npm package. */
export function resolvePermissionModesConfigPath(
  agentDir: string = getAgentDir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.PICC_PERMISSION_MODES_CONFIG_PATH) {
    return env.PICC_PERMISSION_MODES_CONFIG_PATH;
  }
  return join(agentDir, "extensions", "picc-permission-modes", "config.json");
}

/** Create a starter configuration on first load without overwriting user edits. */
export function ensurePermissionModesConfig(configPath: string): string {
  if (existsSync(configPath)) return configPath;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
  } catch {
    // The loader will report the missing or unreadable config with its usual warning.
  }
  return configPath;
}
