import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { autoRejectMessage, commandTargetsOutsideCwd, splitBashSubcommands } from "./utils.ts";
import {
  type AdditionalWorkingDirectory,
  type PermissionAllowDecision,
  type PermissionAskDecision,
  type PermissionBehavior,
  type PermissionDecision,
  type PermissionDecisionReason,
  type PermissionDenyDecision,
  type PermissionMode,
  type PermissionResult,
  type PermissionRule,
  type PermissionRuleSource,
  type PermissionRuleValue,
  type PermissionUpdate,
  type PermissionUpdateDestination,
  type ToolPermissionContext,
  type ToolPermissionRulesBySource,
} from "./types.ts";
export const DANGEROUS_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".claude.json",
] as const;
export const DANGEROUS_DIRECTORIES = [
  ".git",
  ".vscode",
  ".idea",
  ".claude",
] as const;
export function hasSuspiciousWindowsPathPattern(pathStr: string): boolean {
  if (!pathStr) return false;
  const isWin = process.platform === "win32";
  const isWsl = !!process.env.WSL_DISTRO_NAME;
  if (isWin || isWsl) {
    const colonIndex = pathStr.indexOf(":", 2);
    if (colonIndex !== -1) return true;
  }
  if (/~\d/.test(pathStr)) return true;
  if (
    pathStr.startsWith("\\\\?\\") ||
    pathStr.startsWith("\\\\.\\") ||
    pathStr.startsWith("//?/") ||
    pathStr.startsWith("//./")
  ) {
    return true;
  }
  if (/[.\s]+$/.test(pathStr)) return true;
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(pathStr)) return true;
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(pathStr)) return true;
  if (/^\\\\[^\\]/.test(pathStr) || /^\/\/[^/]/.test(pathStr)) return true;
  return false;
}
export function isDangerousFilePath(pathStr: string): boolean {
  if (!pathStr) return false;
  if (hasSuspiciousWindowsPathPattern(pathStr)) return true;
  const expanded = path.resolve(
    pathStr.startsWith("~")
      ? pathStr.replace(/^~/, homedir())
      : pathStr,
  );
  const fileName = path.basename(expanded);
  if (fileName) {
    const lower = fileName.toLowerCase();
    if (
      (DANGEROUS_FILES as readonly string[]).some(
        (f) => f.toLowerCase() === lower,
      )
    ) {
      return true;
    }
  }
  const cwdResolved = path.resolve(process.cwd());
  const homeResolved = path.resolve(homedir());
  const trustedRoots = [cwdResolved, homeResolved];
  const normalizedExpanded = normalizeCaseForComparison(
    dirSepNorm(expanded),
  );
  let anchoredRoot: string | null = null;
  for (const root of trustedRoots) {
    const normalizedRoot = normalizeCaseForComparison(dirSepNorm(root));
    if (
      normalizedExpanded === normalizedRoot ||
      normalizedExpanded.startsWith(normalizedRoot + "/")
    ) {
      if (anchoredRoot === null) anchoredRoot = root;
    }
  }
  if (anchoredRoot === null) return false;
  const rel = path.relative(anchoredRoot, expanded);
  if (!rel || rel.startsWith("..")) return false;
  const segments = rel.split(path.sep).filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const lower = seg.toLowerCase();
    for (const dir of DANGEROUS_DIRECTORIES) {
      if (lower !== dir.toLowerCase()) continue;
      if (
        dir === ".claude" &&
        segments[i + 1]?.toLowerCase() === "worktrees"
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}
export function permissionRuleValueFromString(
  raw: string,
): PermissionRuleValue {
  const openIdx = raw.indexOf("(");
  if (openIdx < 0) return { toolName: raw };
  if (!raw.endsWith(")")) {
    return { toolName: raw };
  }
  const toolName = raw.slice(0, openIdx);
  const ruleContent = raw.slice(openIdx + 1, -1);
  if (!toolName) return { toolName: raw };
  return { toolName, ruleContent };
}
export function permissionRuleValueToString(value: PermissionRuleValue): string {
  if (value.ruleContent === undefined) return value.toolName;
  return `${value.toolName}(${value.ruleContent})`;
}
interface PatternParts {
  relativePattern: string;
  root: string | null;
}
function patternWithRoot(
  pattern: string,
  _cwd: string,
): PatternParts {
  if (pattern.startsWith("//")) {
    return {
      relativePattern: pattern.slice(1).replace(/^\/+/, ""),
      root: path.sep,
    };
  }
  if (pattern.startsWith("~/")) {
    return {
      relativePattern: pattern.slice(1).replace(/^\/+/, ""),
      root: homedir(),
    };
  }
  if (pattern.startsWith("/")) {
    return {
      relativePattern: pattern,
      root: null,
    };
  }
  let normalizedPattern = pattern;
  if (pattern.startsWith("./")) normalizedPattern = pattern.slice(2);
  return { relativePattern: normalizedPattern, root: null };
}
function dirSepNorm(p: string): string {
  return p.replace(/\\/g, "/");
}
function globMatch(pattern: string, candidate: string): boolean {
  let rx = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        rx += ".*";
        i += 2;
        if (pattern[i] === "/") i += 1;
      } else {
        rx += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      rx += "[^/]";
      i += 1;
    } else if (/[.+^$()|{}\[\]\\]/.test(c!)) {
      rx += `\\${c}`;
      i += 1;
    } else {
      rx += c!;
      i += 1;
    }
  }
  rx += "$";
  return new RegExp(rx).test(candidate);
}
function matchesPathPattern(
  ruleValue: PermissionRuleValue,
  absPath: string,
  originalTarget: string,
): boolean {
  const parts = patternWithRoot(ruleValue.ruleContent!, absPath);
  const normalizedPattern = parts.relativePattern
    .replace(/^\.\//, "")
    .replace(/\\/g, "/");
  if (parts.root !== null) {
    const absRoot = path.resolve(parts.root);
    const nAbsPath = dirSepNorm(absPath);
    const nAbsRoot = dirSepNorm(absRoot);
    const prefix = nAbsRoot.endsWith("/") ? nAbsRoot : `${nAbsRoot}/`;
    if (!(nAbsPath === nAbsRoot || nAbsPath.startsWith(prefix))) {
      return false;
    }
  }
  let candidate: string;
  if (parts.root !== null) {
    const absRoot = path.resolve(parts.root);
    candidate = dirSepNorm(absPath)
      .slice(dirSepNorm(absRoot).length)
      .replace(/^\/+/, "");
  } else if (path.isAbsolute(originalTarget)) {
    candidate = dirSepNorm(absPath);
  } else {
    candidate = originalTarget.replace(/^\.\//, "");
  }
  return globMatch(normalizedPattern, candidate);
}
function ruleMatches(
  ruleValue: PermissionRuleValue,
  toolName: string,
  absPath: string,
  ruleString: string,
  originalTarget: string,
): boolean {
  if (ruleValue.toolName.startsWith("mcp__")) {
    const ruleParts = ruleValue.toolName.split("__");
    const toolParts = toolName.split("__");
    if (
      ruleParts[0] !== toolParts[0] ||
      ruleParts[1] !== toolParts[1]
    ) {
      return false;
    }
    if (ruleParts.length === 2) {
      return true;
    }
    if (ruleParts[2] === "*") {
      return true;
    }
    return ruleParts[2] === toolParts[2];
  }
  if (ruleValue.toolName.toLowerCase() !== toolName.toLowerCase()) return false;
  if (ruleValue.ruleContent === undefined) return true;
  return matchesPathPattern(ruleValue, absPath, originalTarget);
}
function matchesReadRuleSpace(
  ruleValue: PermissionRuleValue,
  absPath: string,
  originalTarget: string,
): boolean {
  if (ruleValue.toolName.toLowerCase() !== "read") return false;
  if (ruleValue.ruleContent === undefined) return false;
  return matchesPathPattern(ruleValue, absPath, originalTarget);
}
function readRuleMatches(
  ruleValue: PermissionRuleValue,
  targetTool: string,
  absPath: string,
  originalTarget: string,
): boolean {
  if (
    ruleValue.ruleContent === undefined &&
    ruleValue.toolName.toLowerCase() === targetTool.toLowerCase()
  ) {
    return true;
  }
  return matchesReadRuleSpace(ruleValue, absPath, originalTarget);
}
export function matchingRuleForInput(
  targetTool: string,
  targetPath: string,
  toolType: "edit" | "read",
  behavior: PermissionBehavior,
  context: ToolPermissionContext,
): PermissionRule | null {
  const sources: PermissionRuleSource[] = [
    "userSettings",
    "projectSettings",
    "localSettings",
    "flagSettings",
    "policySettings",
    "cliArg",
    "command",
    "session",
  ];
  const rulesMap: ToolPermissionRulesBySource =
    behavior === "allow"
      ? context.alwaysAllowRules
      : behavior === "deny"
      ? context.alwaysDenyRules
      : context.alwaysAskRules;
  const absPath = path.resolve(
    targetPath.startsWith("~")
      ? targetPath.replace(/^~/, homedir())
      : targetPath,
  );
  for (const source of sources) {
    const ruleStrings = rulesMap[source];
    if (!ruleStrings) continue;
    for (const ruleString of ruleStrings) {
      const value = permissionRuleValueFromString(ruleString);
      const matched =
        toolType === "read"
          ? readRuleMatches(value, targetTool, absPath, targetPath)
          : ruleMatches(value, targetTool, absPath, ruleString, targetPath);
      if (!matched) {
        continue;
      }
      return {
        source,
        ruleBehavior: behavior,
        ruleValue: value,
      };
    }
  }
  return null;
}
export function matchingDenyRule(
  tool: string,
  targetPath: string,
  context: ToolPermissionContext,
): PermissionRule | null {
  return matchingRuleForInput(tool, targetPath, "edit", "deny", context);
}
export function matchingAskRule(
  tool: string,
  targetPath: string,
  context: ToolPermissionContext,
): PermissionRule | null {
  return matchingRuleForInput(tool, targetPath, "edit", "ask", context);
}
type ShellRule =
  | { type: "exact"; command: string }
  | { type: "prefix"; prefix: string }
  | { type: "wildcard"; pattern: string };
function shellRuleExtractPrefix(rule: string): string | null {
  const m = rule.match(/^(.+):\*$/);
  return m?.[1] ?? null;
}
function shellRuleHasWildcards(pattern: string): boolean {
  if (pattern.endsWith(":*")) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*") {
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && pattern[j] === "\\") {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) return true;
    }
  }
  return false;
}
function parseShellRule(rule: string): ShellRule {
  const prefix = shellRuleExtractPrefix(rule);
  if (prefix !== null) return { type: "prefix", prefix };
  if (shellRuleHasWildcards(rule)) return { type: "wildcard", pattern: rule };
  return { type: "exact", command: rule };
}
function matchShellWildcard(pattern: string, command: string): boolean {
  const trimmed = pattern.trim();
  const STAR = "\x00S\x00";
  const BSL = "\x00B\x00";
  let processed = "";
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    if (ch === "\\" && i + 1 < trimmed.length) {
      const nxt = trimmed[i + 1];
      if (nxt === "*") {
        processed += STAR;
        i += 2;
        continue;
      }
      if (nxt === "\\") {
        processed += BSL;
        i += 2;
        continue;
      }
    }
    processed += ch;
    i++;
  }
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");
  let regexPattern = escaped
    .replace(/\*/g, ".*")
    .replace(new RegExp(STAR, "g"), "\\*")
    .replace(new RegExp(BSL, "g"), "\\\\");
  const unescapedStars = (processed.match(/\*/g) || []).length;
  if (regexPattern.endsWith(" .*") && unescapedStars === 1) {
    regexPattern = regexPattern.slice(0, -3) + "( .*)?";
  }
  return new RegExp(`^${regexPattern}$`, "s").test(command);
}
function stripLeadingEnvVars(command: string): string {
  let rest = command.trimStart();
  for (;;) {
    const m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return rest;
}
function shellCommandMatchesRule(command: string, rule: ShellRule): boolean {
  const candidates = new Set<string>([command]);
  const stripped = stripLeadingEnvVars(command);
  if (stripped !== command) candidates.add(stripped);
  for (const cmd of candidates) {
    switch (rule.type) {
      case "exact":
        if (rule.command === cmd) return true;
        break;
      case "prefix":
        if (cmd === rule.prefix) return true;
        if (cmd.startsWith(rule.prefix + " ")) return true;
        break;
      case "wildcard":
        if (matchShellWildcard(rule.pattern, cmd)) return true;
        break;
    }
  }
  return false;
}
export function matchingBashRule(
  command: string,
  behavior: PermissionBehavior,
  context: ToolPermissionContext,
): PermissionRule | null {
  const rulesMap =
    behavior === "allow"
      ? context.alwaysAllowRules
      : behavior === "deny"
      ? context.alwaysDenyRules
      : context.alwaysAskRules;
  const sources: PermissionRuleSource[] = [
    "userSettings",
    "projectSettings",
    "localSettings",
    "flagSettings",
    "policySettings",
    "cliArg",
    "command",
    "session",
  ];
  const trimmed = command.trim();
  const subcommands = splitBashSubcommands(trimmed);
  const isCompound = subcommands.length > 1;
  for (const source of sources) {
    const ruleStrings = rulesMap[source];
    if (!ruleStrings) continue;
    for (const ruleString of ruleStrings) {
      const value = permissionRuleValueFromString(ruleString);
      if (value.toolName !== "Bash") continue;
      if (value.ruleContent === undefined) {
        return { source, ruleBehavior: behavior, ruleValue: value };
      }
      const rule = parseShellRule(value.ruleContent);
      if (!isCompound && shellCommandMatchesRule(trimmed, rule)) {
        return { source, ruleBehavior: behavior, ruleValue: value };
      }
      if (rule.type === "exact" && shellCommandMatchesRule(trimmed, rule)) {
        return { source, ruleBehavior: behavior, ruleValue: value };
      }
      for (const sub of subcommands) {
        if (shellCommandMatchesRule(sub, rule)) {
          return { source, ruleBehavior: behavior, ruleValue: value };
        }
      }
    }
  }
  return null;
}
function emptyRules(): ToolPermissionRulesBySource {
  return {};
}
export function buildContext(
  mode: ToolPermissionContext["mode"] = "default",
  additionalDirs: Array<[string, AdditionalWorkingDirectory]> = [],
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(additionalDirs),
    alwaysAllowRules: overrides.alwaysAllowRules ?? emptyRules(),
    alwaysDenyRules: overrides.alwaysDenyRules ?? emptyRules(),
    alwaysAskRules: overrides.alwaysAskRules ?? emptyRules(),
    isBypassPermissionsModeAvailable:
      overrides.isBypassPermissionsModeAvailable ?? true,
    ...(overrides.prePlanMode !== undefined ? { prePlanMode: overrides.prePlanMode } : {}),
    ...(overrides.shouldAvoidPermissionPrompts !== undefined
      ? { shouldAvoidPermissionPrompts: overrides.shouldAvoidPermissionPrompts }
      : {}),
    ...(overrides.strippedDangerousRules !== undefined
      ? { strippedDangerousRules: overrides.strippedDangerousRules }
      : {}),
  };
}
const SHIFT_TAB_CYCLE_WITH_BYPASS: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
];
const SHIFT_TAB_CYCLE_WITHOUT_BYPASS: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
];
export function getNextPermissionMode(
  context: ToolPermissionContext,
): PermissionMode {
  const cycle = context.isBypassPermissionsModeAvailable
    ? SHIFT_TAB_CYCLE_WITH_BYPASS
    : SHIFT_TAB_CYCLE_WITHOUT_BYPASS;
  const idx = cycle.indexOf(context.mode);
  if (idx < 0) return cycle[0]!;
  const nextIdx = (idx + 1) % cycle.length;
  return cycle[nextIdx]!;
}
function ruleStringKey(value: PermissionRuleValue): string {
  return permissionRuleValueToString(value);
}
function rulesForSource(
  rules: ToolPermissionRulesBySource,
  source: PermissionRuleSource,
): string[] {
  return rules[source] ? [...rules[source]] : [];
}
function setRulesForSource(
  rules: ToolPermissionRulesBySource,
  source: PermissionRuleSource,
  values: string[],
): ToolPermissionRulesBySource {
  const next: ToolPermissionRulesBySource = { ...rules };
  if (values.length === 0) {
    delete next[source];
  } else {
    next[source] = values;
  }
  return next;
}
export function applyPermissionUpdate(
  context: ToolPermissionContext,
  update: PermissionUpdate,
): ToolPermissionContext {
  const dest = update.destination as PermissionRuleSource;
  switch (update.type) {
    case "addRules": {
      const behavior = update.behavior;
      const target =
        behavior === "allow"
          ? context.alwaysAllowRules
          : behavior === "deny"
          ? context.alwaysDenyRules
          : context.alwaysAskRules;
      const existing = rulesForSource(target, dest);
      const existingSet = new Set(existing);
      for (const r of update.rules) {
        existingSet.add(ruleStringKey(r));
      }
      const next =
        behavior === "allow"
          ? setRulesForSource(context.alwaysAllowRules, dest, [...existingSet])
          : behavior === "deny"
          ? setRulesForSource(context.alwaysDenyRules, dest, [...existingSet])
          : setRulesForSource(context.alwaysAskRules, dest, [...existingSet]);
      return {
        ...context,
        alwaysAllowRules:
          behavior === "allow" ? next : context.alwaysAllowRules,
        alwaysDenyRules:
          behavior === "deny" ? next : context.alwaysDenyRules,
        alwaysAskRules: behavior === "ask" ? next : context.alwaysAskRules,
      };
    }
    case "replaceRules": {
      const strings = update.rules.map(ruleStringKey);
      const behavior = update.behavior;
      return {
        ...context,
        alwaysAllowRules:
          behavior === "allow"
            ? setRulesForSource(context.alwaysAllowRules, dest, strings)
            : context.alwaysAllowRules,
        alwaysDenyRules:
          behavior === "deny"
            ? setRulesForSource(context.alwaysDenyRules, dest, strings)
            : context.alwaysDenyRules,
        alwaysAskRules:
          behavior === "ask"
            ? setRulesForSource(context.alwaysAskRules, dest, strings)
            : context.alwaysAskRules,
      };
    }
    case "removeRules": {
      const behavior = update.behavior;
      const target =
        behavior === "allow"
          ? context.alwaysAllowRules
          : behavior === "deny"
          ? context.alwaysDenyRules
          : context.alwaysAskRules;
      const existing = rulesForSource(target, dest);
      const existingSet = new Set(existing);
      for (const r of update.rules) existingSet.delete(ruleStringKey(r));
      const next =
        behavior === "allow"
          ? setRulesForSource(context.alwaysAllowRules, dest, [...existingSet])
          : behavior === "deny"
          ? setRulesForSource(context.alwaysDenyRules, dest, [...existingSet])
          : setRulesForSource(context.alwaysAskRules, dest, [...existingSet]);
      return {
        ...context,
        alwaysAllowRules:
          behavior === "allow" ? next : context.alwaysAllowRules,
        alwaysDenyRules:
          behavior === "deny" ? next : context.alwaysDenyRules,
        alwaysAskRules: behavior === "ask" ? next : context.alwaysAskRules,
      };
    }
    case "setMode": {
      const nextMode = update.mode;
      if (dest === "session" || dest === "cliArg") {
        return { ...context, mode: nextMode };
      }
      return { ...context, mode: nextMode };
    }
    case "addDirectories": {
      const map = new Map(context.additionalWorkingDirectories);
      for (const dir of update.directories) {
        const abs = path.resolve(dir.startsWith("~") ? dir.replace(/^~/, homedir()) : dir);
        if (!map.has(abs)) {
          map.set(abs, { path: abs, source: dest as AdditionalWorkingDirectory["source"] });
        }
      }
      return { ...context, additionalWorkingDirectories: map };
    }
    case "removeDirectories": {
      const map = new Map(context.additionalWorkingDirectories);
      for (const dir of update.directories) {
        const abs = path.resolve(dir.startsWith("~") ? dir.replace(/^~/, homedir()) : dir);
        map.delete(abs);
      }
      return { ...context, additionalWorkingDirectories: map };
    }
  }
  return context;
}
export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[],
): ToolPermissionContext {
  let next = context;
  for (const u of updates) next = applyPermissionUpdate(next, u);
  return next;
}
export function normalizeCaseForComparison(pathStr: string): string {
  return pathStr.toLowerCase();
}
export function pathInAllowedWorkingPath(
  target: string,
  context: ToolPermissionContext,
  cwd: string = process.cwd(),
): boolean {
  const expanded = path.resolve(
    target.startsWith("~")
      ? target.replace(/^~/, homedir())
      : path.isAbsolute(target)
        ? target
        : path.join(cwd, target),
  );
  const allowedRoots: string[] = [path.resolve(cwd)];
  for (const dir of context.additionalWorkingDirectories.keys()) {
    allowedRoots.push(path.resolve(dir));
  }
  const normalizedExpanded = normalizeCaseForComparison(
    dirSepNorm(expanded),
  );
  for (const root of allowedRoots) {
    const normalizedRoot = normalizeCaseForComparison(dirSepNorm(root));
    if (
      normalizedExpanded === normalizedRoot ||
      normalizedExpanded.startsWith(normalizedRoot + "/")
    ) {
      return true;
    }
  }
  return false;
}
export function isInClaudeFolder(target: string): boolean {
  const cwd = process.cwd();
  const expanded = path.resolve(
    target.startsWith("~") ? target.replace(/^~/, homedir()) : target,
  );
  const claudeDir = path.join(cwd, ".claude");
  return (
    dirSepNorm(expanded).startsWith(dirSepNorm(claudeDir) + "/") ||
    expanded === claudeDir
  );
}
function sessionOnlyAllowDeny(
  context: ToolPermissionContext,
  tool: string,
  ruleContent: string,
): PermissionRule | null {
  const rule: PermissionRule = {
    source: "session",
    ruleBehavior: "allow",
    ruleValue: permissionRuleValueFromString(
      permissionRuleValueToString({ toolName: tool, ruleContent }),
    ),
  };
  if (ruleContent.includes("..") || !ruleContent.endsWith("/**")) return null;
  if (
    !ruleContent.startsWith("/.claude/") &&
    !ruleContent.startsWith("~/.claude/")
  ) {
    return null;
  }
  return rule;
}
export function checkWritePermissionForTool(
  tool: string,
  targetPath: string,
  context: ToolPermissionContext,
  cwd: string = process.cwd(),
): PermissionResult {
  if (!targetPath) {
    if (context.shouldAvoidPermissionPrompts) {
      return {
        behavior: "deny",
        message: autoRejectMessage(tool),
        decisionReason: {
          type: "asyncAgent",
          reason: "Permission prompts are not available in this context",
        },
      } satisfies PermissionDenyDecision;
    }
    return {
      behavior: "ask",
      message: `Pi requested permissions to use ${tool}, but you haven't granted it yet.`,
    };
  }
  const deny = matchingDenyRule(tool, targetPath, context);
  if (deny) {
    return {
      behavior: "deny",
      message: `Permission to edit ${targetPath} has been denied.`,
      decisionReason: { type: "rule", rule: deny },
    } satisfies PermissionDenyDecision;
  }
  if (isDangerousFilePath(targetPath)) {
    return {
      behavior: "ask",
      message: `Pi requested permissions to edit ${targetPath} which is a sensitive file.`,
      decisionReason: {
        type: "safetyCheck",
        reason: "sensitive path",
        classifierApprovable: true,
      },
    } satisfies PermissionAskDecision;
  }
  if (isInClaudeFolder(targetPath)) {
    const claudeFolder = sessionOnlyAllowDeny(
      context,
      tool,
      "/.claude/**",
    );
    if (claudeFolder) {
      return {
        behavior: "allow",
        decisionReason: {
          type: "rule",
          rule: claudeFolder,
        },
      } satisfies PermissionAllowDecision;
    }
  }
  const ask = matchingAskRule(tool, targetPath, context);
  if (ask) {
    return {
      behavior: "ask",
      message: `Pi requested permissions to write to ${targetPath}, but you haven't granted it yet.`,
      decisionReason: { type: "rule", rule: ask },
    } satisfies PermissionAskDecision;
  }
  if (context.mode === "acceptEdits" && pathInAllowedWorkingPath(targetPath, context, cwd)) {
    return {
      behavior: "allow",
      decisionReason: { type: "mode", mode: "acceptEdits" },
    } satisfies PermissionAllowDecision;
  }
  const allow = matchingRuleForInput(tool, targetPath, "edit", "allow", context);
  if (allow) {
    return {
      behavior: "allow",
      decisionReason: { type: "rule", rule: allow },
    } satisfies PermissionAllowDecision;
  }
  if (context.shouldAvoidPermissionPrompts) {
    return {
      behavior: "deny",
      message: autoRejectMessage(tool),
      decisionReason: {
        type: "asyncAgent",
        reason: "Permission prompts are not available in this context",
      },
    } satisfies PermissionDenyDecision;
  }
  return {
    behavior: "ask",
    message: `Pi requested permissions to write to ${targetPath}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(tool, targetPath, context),
    decisionReason: {
      type: "mode",
      mode: context.mode,
    },
  } satisfies PermissionAskDecision;
}
export function checkReadPermissionForTool(
  tool: string,
  targetPath: string,
  context: ToolPermissionContext,
  cwd: string = process.cwd(),
): PermissionResult {
  if (!targetPath) {
    return {
      behavior: "allow",
      decisionReason: { type: "other", reason: "no explicit path; defaults to cwd" },
    };
  }
  if (hasSuspiciousWindowsPathPattern(targetPath)) {
    return {
      behavior: "ask",
      message: `Pi requested permissions to read from ${targetPath}, which contains a suspicious Windows path pattern that requires manual approval.`,
      decisionReason: {
        type: "other",
        reason: "suspicious path",
      },
    } satisfies PermissionAskDecision;
  }
  const deny = matchingRuleForInput(tool, targetPath, "read", "deny", context);
  if (deny) {
    return {
      behavior: "deny",
      message: `Permission to read ${targetPath} has been denied.`,
      decisionReason: { type: "rule", rule: deny },
    } satisfies PermissionDenyDecision;
  }
  const ask = matchingRuleForInput(tool, targetPath, "read", "ask", context);
  if (ask) {
    return {
      behavior: "ask",
      message: `Pi requested permissions to read from ${targetPath}, but you haven't granted it yet.`,
      decisionReason: { type: "rule", rule: ask },
    } satisfies PermissionAskDecision;
  }
  const editDecision = checkWritePermissionForTool(tool, targetPath, context, cwd);
  if (editDecision.behavior === "allow") {
    return editDecision;
  }
  if (pathInAllowedWorkingPath(targetPath, context, cwd)) {
    return {
      behavior: "allow",
      decisionReason: { type: "mode", mode: "default" },
    } satisfies PermissionAllowDecision;
  }
  const allow = matchingRuleForInput(tool, targetPath, "read", "allow", context);
  if (allow) {
    return {
      behavior: "allow",
      decisionReason: { type: "rule", rule: allow },
    } satisfies PermissionAllowDecision;
  }
  if (context.shouldAvoidPermissionPrompts) {
    return {
      behavior: "allow",
      decisionReason: { type: "mode", mode: context.mode },
    } satisfies PermissionAllowDecision;
  }
  return {
    behavior: "ask",
    message: `Pi requested permissions to read from ${targetPath}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(tool, targetPath, context),
    decisionReason: {
      type: "workingDir",
      reason: "Path is outside allowed working directories",
    },
  } satisfies PermissionAskDecision;
}
export interface PathAllowedResult {
  allowed: boolean;
  decisionReason?:
    | { type: "rule"; rule: string }
    | { type: "other"; reason: string };
}
export function isPathAllowedAdaptor(
  resolvedPath: string,
  context: ToolPermissionContext,
  cwd: string,
  op: "read" | "write" | "create",
  _precomputedPathsToCheck?: readonly string[],
): PathAllowedResult {
  const BASH_TOOL = "Bash";
  if (op === "read") {
    const r = checkReadPermissionForTool(BASH_TOOL, resolvedPath, context, cwd);
    return adaptPiResult(r);
  }
  const w = checkWritePermissionForTool(BASH_TOOL, resolvedPath, context, cwd);
  if (w.behavior === "allow") {
    return adaptPiResult(w);
  }
  const readAllow = matchingRuleForInput(
    BASH_TOOL,
    resolvedPath,
    "read",
    "allow",
    context,
  );
  if (readAllow) {
    return {
      allowed: true,
      decisionReason: {
        type: "rule",
        rule: permissionRuleValueToString(readAllow.ruleValue),
      },
    };
  }
  return adaptPiResult(w);
}
function adaptPiResult(
  r: PermissionResult,
): PathAllowedResult {
  if (r.behavior === "allow") {
    return { allowed: true, decisionReason: reasonOfRule(r) };
  }
  if (r.behavior === "deny") {
    return {
      allowed: false,
      decisionReason: r.decisionReason?.type === "rule"
        ? {
            type: "rule",
            rule: permissionRuleValueToString(r.decisionReason.rule.ruleValue),
          }
        : { type: "other", reason: r.message },
    };
  }
  if (r.decisionReason?.type === "rule") {
    return {
      allowed: false,
      decisionReason: {
        type: "rule",
        rule: permissionRuleValueToString(r.decisionReason.rule.ruleValue),
      },
    };
  }
  return {
    allowed: false,
    decisionReason:
      r.decisionReason?.type === "other"
        ? { type: "other", reason: r.decisionReason.reason }
        : {
            type: "other",
            reason: "path not permitted by current permission rules",
          },
  };
}
function reasonOfRule(
  r: PermissionResult,
): { type: "rule"; rule: string } | undefined {
  if (r.behavior !== "allow") return undefined;
  if (r.decisionReason?.type === "rule") {
    return {
      type: "rule",
      rule: permissionRuleValueToString(r.decisionReason.rule.ruleValue),
    };
  }
  return undefined;
}
export function allWorkingDirectories(
  context: ToolPermissionContext,
  cwd: string,
): Set<string> {
  const set = new Set<string>([path.resolve(cwd)]);
  for (const dir of context.additionalWorkingDirectories.keys()) {
    set.add(path.resolve(dir));
  }
  return set;
}
export function generateSuggestions(
  tool: string,
  targetPath: string,
  context: ToolPermissionContext,
): PermissionUpdate[] {
  const expanded = path.resolve(
    targetPath.startsWith("~") ? targetPath.replace(/^~/, homedir()) : targetPath,
  );
  const dir = path.dirname(expanded);
  const dirName = path.basename(dir) || "this directory";
  const inCwd = pathInAllowedWorkingPath(targetPath, context);
  const suggestions: PermissionUpdate[] = [];
  if (inCwd) {
    suggestions.push({
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [
        {
          toolName: tool,
          ruleContent: `.${path.sep}**`,
        },
      ],
    });
    suggestions.push({
      type: "setMode",
      destination: "session",
      mode: "acceptEdits",
    });
  } else {
    suggestions.push({
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [
        {
          toolName: tool,
          ruleContent: `${dirName}${path.sep}**`,
        },
      ],
    });
    if (context.isBypassPermissionsModeAvailable) {
      suggestions.push({
        type: "setMode",
        destination: "session",
        mode: "bypassPermissions",
      });
    }
  }
  return suggestions;
}
const ACCEPT_EDITS_BASH_COMMANDS = new Set([
  "mkdir",
  "touch",
  "rm",
  "rmdir",
  "mv",
  "cp",
  "sed",
]);
export function isAcceptEditsBashCommand(
  command: string,
  _context: ToolPermissionContext,
  cwd: string = process.cwd(),
): boolean {
  if (!command || !command.trim()) return false;
  const subcommands = splitBashSubcommands(command);
  if (subcommands.length === 0) return false;
  for (const sub of subcommands) {
    const baseCmd = sub.trim().split(/\s+/)[0];
    if (!baseCmd) return false;
    if (!ACCEPT_EDITS_BASH_COMMANDS.has(baseCmd)) return false;
    if (commandTargetsOutsideCwd(sub, cwd)) return false;
  }
  return true;
}
export type FileOperationType = "read" | "write" | "create";
export function getFilePermissionOptions(
  toolName: string,
  filePath: string,
  context: ToolPermissionContext,
  operationType: FileOperationType = "write",
): string[] {
  if (operationType === "read") {
    const inCwd = pathInAllowedWorkingPath(filePath, context);
    if (inCwd) {
      return ["Yes", "Yes, during this session", "No"];
    }
    const dir = path.dirname(
      path.resolve(
        filePath.startsWith("~") ? filePath.replace(/^~/, homedir()) : filePath,
      ),
    );
    const dirName = path.basename(dir) || "this directory";
    return [
      "Yes",
      `Yes, allow reading from ${dirName}/ during this session`,
      "No",
    ];
  }
  const inCwd = pathInAllowedWorkingPath(filePath, context);
  if (inCwd) {
    return [
      "Yes",
      "Yes, allow all edits during this session (shift+tab)",
      "No",
    ];
  }
  const dir = path.dirname(
    path.resolve(
      filePath.startsWith("~") ? filePath.replace(/^~/, homedir()) : filePath,
    ),
  );
  const dirName = path.basename(dir) || "this directory";
  return [
    "Yes",
    `Yes, allow all edits in ${dirName}/ during this session (shift+tab)`,
    "No",
  ];
}
export { ALL_PERMISSION_RULE_SOURCES } from "./types.ts";
