import { existsSync, readFileSync } from "node:fs";
export interface AutoModeClassifierConfig {
  mode: "active" | "fixed";
  provider?: string;
  model?: string;
  timeoutMs: number;
  onUnavailable: "ask" | "deny";
  failureThreshold: number;
  cooldownMs: number;
}
export interface AutoModeLimits {
  maxConsecutive: number;
  maxTotal: number;
}
export interface AutoModeConfig {
  classifier?: AutoModeClassifierConfig;
  allow: string[];
  softDeny: string[];
  hardDeny: string[];
  environment: string[];
  classifyAllShell: boolean;
  safeToolAllowlist: string[];
  denialLimits: AutoModeLimits;
  transcriptMaxChars: number;
  logPath?: string;
}
export interface AutoModeLoadResult {
  config: AutoModeConfig;
  issues: string[];
  loadedFrom: string;
}
const DEFAULT_LIMITS: AutoModeLimits = {
  maxConsecutive: 3,
  maxTotal: 20,
};
const DEFAULT_ALLOW: string[] = [
  "Standard read-only file inspection inside the working directory.",
  "Standard search/grep/glob operations in the working directory.",
  "Running tests, linters, and formatters.",
  "Editing files inside the current working directory.",
  "git add/commit/diff/log/status/fetch within the repository.",
];
const DEFAULT_SOFT_DENY: string[] = [
  "Force pushes (git push -f, git push --force, git push --force-with-lease).",
  "rm -rf outside the working directory.",
  "Editing files outside the working directory without explicit authorization.",
  "Network egress to non-trusted external endpoints.",
  "git push to a branch that is not the session's working branch.",
];
const DEFAULT_HARD_DENY: string[] = [
  "rm -rf /, rm -rf $HOME, or equivalent filesystem-wide destructive deletes.",
  "Force push to main / master / the repository default branch.",
  "DROP DATABASE / DROP SCHEMA without explicit user confirmation.",
  "Disabling safety tooling, audit logs, or git hooks.",
  "Systematic scanning of credential stores (.env, ~/.aws/, keychains, etc.).",
  "Disabling or removing .agents/ or .pi/ settings, hooks, or rules.",
];
const DEFAULT_ENVIRONMENT: string[] = [
  "An autonomous coding agent running inside the user's pi session.",
];
const DEFAULT_SAFE_TOOL_ALLOWLIST = new Set<string>([
  "read", "Read", "grep", "Grep", "glob", "Glob", "find", "ls", "LSP",
  "TodoWrite", "TaskGet", "TaskList", "TaskOutput",
]);
export function loadAutoModeConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): AutoModeLoadResult {
  const issues: string[] = [];
  if (!existsSync(configPath)) {
    return {
      config: defaultAutoModeConfig(),
      issues: [`Auto-mode config not found at '${configPath}'. Using defaults — reviewer follows the active Pi model.`],
      loadedFrom: configPath,
    };
  }
  let raw: unknown;
  try {
    const text = readFileSync(configPath, "utf-8");
    raw = JSON.parse(stripJsonComments(text));
  } catch (error) {
    return {
      config: defaultAutoModeConfig(),
      issues: ["Failed to parse auto-mode config; check JSON syntax (contents omitted)"],
      loadedFrom: configPath,
    };
  }
  const record = (raw ?? {}) as Record<string, unknown>;
  const block = record.autoMode;
  if (!block || typeof block !== "object") {
    return {
      config: defaultAutoModeConfig(),
      issues: [],
      loadedFrom: configPath,
    };
  }
  const defaults = defaultAutoModeConfig();
  const blockR = block as Record<string, unknown>;
  if (blockR.provider !== undefined) issues.push("autoMode.provider is obsolete and ignored. Configure classifier.provider/model in Pi; credentials belong in Pi models/auth, not this file.");
  const cfg: AutoModeConfig = {
    classifier: readClassifier(blockR.classifier, defaults.classifier!, issues),
    allow: readStringArray(blockR.allow, defaults.allow, issues, "autoMode.allow"),
    softDeny: readStringArray(
      blockR.softDeny ?? blockR.soft_deny,
      defaults.softDeny,
      issues,
      "autoMode.softDeny",
    ),
    hardDeny: readStringArray(
      blockR.hardDeny ?? blockR.hard_deny,
      defaults.hardDeny,
      issues,
      "autoMode.hardDeny",
    ),
    environment: readStringArray(
      blockR.environment,
      defaults.environment,
      issues,
      "autoMode.environment",
    ),
    classifyAllShell: readBool(
      blockR.classifyAllShell ?? blockR.classify_all_shell,
      defaults.classifyAllShell,
    ),
    safeToolAllowlist: readStringArray(
      blockR.safeToolAllowlist ?? blockR.safe_tool_allowlist,
      Array.from(DEFAULT_SAFE_TOOL_ALLOWLIST),
      issues,
      "autoMode.safeToolAllowlist",
    ),
    denialLimits: readLimits(
      (blockR.denialLimits as Record<string, unknown> | undefined) ?? {},
      defaults.denialLimits,
      issues,
    ),
    transcriptMaxChars: readPositiveInt(
      blockR.transcriptMaxChars ?? blockR.transcript_max_chars,
      defaults.transcriptMaxChars,
      issues,
    ),
    ...(typeof blockR.logPath === "string"
      ? { logPath: blockR.logPath }
      : {}),
  };
  return { config: cfg, issues, loadedFrom: configPath };
}
function defaultAutoModeConfig(): AutoModeConfig {
  return {
    classifier: defaultClassifierConfig(),
    allow: DEFAULT_ALLOW,
    softDeny: DEFAULT_SOFT_DENY,
    hardDeny: DEFAULT_HARD_DENY,
    environment: DEFAULT_ENVIRONMENT,
    classifyAllShell: false,
    safeToolAllowlist: Array.from(DEFAULT_SAFE_TOOL_ALLOWLIST),
    denialLimits: { ...DEFAULT_LIMITS },
    transcriptMaxChars: 80_000,
  };
}
export function defaultClassifierConfig(): AutoModeClassifierConfig {
  return { mode: "active", timeoutMs: 15000, onUnavailable: "ask", failureThreshold: 3, cooldownMs: 30000 };
}
function readClassifier(raw: unknown, defaults: AutoModeClassifierConfig, issues: string[]): AutoModeClassifierConfig {
  if (raw === undefined) return { ...defaults };
  if (!raw || typeof raw !== "object") { issues.push("autoMode.classifier must be an object"); return { ...defaults, mode: "fixed" }; }
  const value = raw as Record<string, unknown>;
  const fixed = value.mode === "fixed" || value.provider !== undefined || value.model !== undefined;
  const result: AutoModeClassifierConfig = {
    mode: fixed ? "fixed" : "active",
    timeoutMs: value.timeoutMs === undefined ? defaults.timeoutMs : readPositiveInt(value.timeoutMs, defaults.timeoutMs, issues),
    onUnavailable: value.onUnavailable === "deny" ? "deny" : "ask",
    failureThreshold: value.failureThreshold === undefined ? defaults.failureThreshold : readPositiveInt(value.failureThreshold, defaults.failureThreshold, issues),
    cooldownMs: value.cooldownMs === undefined ? defaults.cooldownMs : readPositiveInt(value.cooldownMs, defaults.cooldownMs, issues),
  };
  if (typeof value.provider === "string") result.provider = value.provider.trim();
  if (typeof value.model === "string") result.model = value.model.trim();
  if (fixed && (!result.provider || !result.model)) issues.push("Fixed auto reviewer requires classifier.provider and classifier.model; review will fail closed.");
  if (value.mode !== undefined && value.mode !== "active" && value.mode !== "fixed") {
    issues.push("Invalid classifier.mode; review disabled until corrected.");
    result.mode = "fixed"; delete result.provider; delete result.model;
  }
  return result;
}
function readLimits(
  raw: Record<string, unknown>,
  defaults: AutoModeLimits,
  issues: string[],
): AutoModeLimits {
  const maxConsecutive = readPositiveInt(
    raw.maxConsecutive ?? raw.max_consecutive,
    defaults.maxConsecutive,
    issues,
  );
  const maxTotal = readPositiveInt(
    raw.maxTotal ?? raw.max_total,
    defaults.maxTotal,
    issues,
  );
  return { maxConsecutive, maxTotal };
}
function readBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function readPositiveInt(
  v: unknown,
  fallback: number,
  issues: string[],
): number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  issues.push(
    `expected positive integer, got ${JSON.stringify(v)} — using default ${fallback}`,
  );
  return fallback;
}
function readStringArray(
  v: unknown,
  fallback: string[],
  issues: string[],
  fieldName: string,
): string[] {
  if (!Array.isArray(v)) {
    if (v !== undefined) {
      issues.push(`${fieldName} must be an array — using default.`);
    }
    return fallback;
  }
  const cleaned: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim().length > 0) {
      cleaned.push(item.trim());
    } else if (item !== undefined && item !== null) {
      issues.push(`${fieldName} contains a non-string entry — skipping.`);
    }
  }
  return cleaned.length > 0 ? cleaned : fallback;
}
function stripJsonComments(input: string): string {
  let output = "";
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    const next = input[i + 1] ?? "";
    if (char === "/" && next === "/") {
      const newline = input.indexOf("\n", i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = input.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const seg = consumeString(input, i, char);
      output += seg.output;
      i = seg.nextIndex;
      continue;
    }
    output += char;
    i++;
  }
  return output;
}
interface ScanSegment {
  output: string;
  nextIndex: number;
}
function consumeString(input: string, start: number, quote: string): ScanSegment {
  let out = quote;
  let i = start + 1;
  let escaped = false;
  while (i < input.length) {
    const c = input[i];
    out += c;
    i++;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === quote) break;
  }
  return { output: out, nextIndex: i };
}
export function defaultAutoModeConfigPath(_importMetaUrl: string, agentDir: string): string {
  return `${agentDir.replace(/[\\/]+$/, "")}/extensions/picc-permission-modes/config.json`;
}
export function isSafeAllowlistedTool(
  toolName: string,
  allowlist: string[],
): boolean {
  const needle = toolName.toLowerCase();
  for (const entry of allowlist) {
    const pat = entry.toLowerCase();
    if (pat.endsWith("*")) {
      if (needle.startsWith(pat.slice(0, -1))) return true;
    } else if (pat === needle) {
      return true;
    }
  }
  return false;
}
