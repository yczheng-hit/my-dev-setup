import { homedir } from "os";
import {
  checkDangerousRemovalPaths,
  formatDirectoryList,
  getDirectoryForPath,
} from "../../utils/permissions/bashPathHelpers.ts";
import { validatePath } from "../../utils/permissions/pathValidation.ts";
import {
  allWorkingDirectories,
  isPathAllowedAdaptor,
} from "../../../permissionContext.ts";
import type {
  PermissionResult,
  PermissionUpdate,
  ToolPermissionContext,
} from "../../../types.ts";
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from "../../utils/bash/commands.ts";
import { tryParseShellCommand } from "../../utils/bash/shellQuote.ts";
import { stripSafeWrappers } from "./bashPermissions.ts";
import { sedCommandIsAllowedByAllowlist } from "./sedValidation.ts";
export type FileOperationType = "read" | "write" | "create";
export type PathCommand =
  | "cd"
  | "ls"
  | "find"
  | "mkdir"
  | "touch"
  | "rm"
  | "rmdir"
  | "mv"
  | "cp"
  | "cat"
  | "head"
  | "tail"
  | "sort"
  | "uniq"
  | "wc"
  | "cut"
  | "paste"
  | "column"
  | "tr"
  | "file"
  | "stat"
  | "diff"
  | "awk"
  | "strings"
  | "hexdump"
  | "od"
  | "base64"
  | "nl"
  | "grep"
  | "rg"
  | "sed"
  | "git"
  | "jq"
  | "sha256sum"
  | "sha1sum"
  | "md5sum";
function filterOutFlags(args: string[]): string[] {
  const result: string[] = [];
  let afterDoubleDash = false;
  for (const arg of args) {
    if (afterDoubleDash) {
      result.push(arg);
    } else if (arg === "--") {
      afterDoubleDash = true;
    } else if (!arg?.startsWith("-")) {
      result.push(arg);
    }
  }
  return result;
}
function parsePatternCommand(
  args: string[],
  flagsWithArgs: Set<string>,
  defaults: string[] = [],
): string[] {
  const paths: string[] = [];
  let patternFound = false;
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined || arg === null) continue;
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      const flag = arg.split("=")[0];
      if (flag && ["-e", "--regexp", "-f", "--file"].includes(flag)) {
        patternFound = true;
      }
      if (flag && flagsWithArgs.has(flag) && !arg.includes("=")) {
        i++;
      }
      continue;
    }
    if (!patternFound) {
      patternFound = true;
      continue;
    }
    paths.push(arg);
  }
  return paths.length > 0 ? paths : defaults;
}
export const PATH_EXTRACTORS: Record<PathCommand, (args: string[]) => string[]> = {
  cd: (args) => (args.length === 0 ? [homedir()] : [args.join(" ")]),
  ls: (args) => {
    const paths = filterOutFlags(args);
    return paths.length > 0 ? paths : ["."];
  },
  find: (args) => {
    const paths: string[] = [];
    const pathFlags = new Set([
      "-newer",
      "-anewer",
      "-cnewer",
      "-mnewer",
      "-samefile",
      "-path",
      "-wholename",
      "-ilname",
      "-lname",
      "-ipath",
      "-iwholename",
    ]);
    const newerPattern = /^-newer[acmBt][acmtB]$/;
    let foundNonGlobalFlag = false;
    let afterDoubleDash = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg) continue;
      if (afterDoubleDash) {
        paths.push(arg);
        continue;
      }
      if (arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (arg.startsWith("-")) {
        if (["-H", "-L", "-P"].includes(arg)) continue;
        foundNonGlobalFlag = true;
        if (pathFlags.has(arg) || newerPattern.test(arg)) {
          const nextArg = args[i + 1];
          if (nextArg) {
            paths.push(nextArg);
            i++;
          }
        }
        continue;
      }
      if (!foundNonGlobalFlag) {
        paths.push(arg);
      }
    }
    return paths.length > 0 ? paths : ["."];
  },
  mkdir: (args) => filterOutFlags(args),
  touch: (args) => filterOutFlags(args),
  rm: (args) => filterOutFlags(args),
  rmdir: (args) => filterOutFlags(args),
  mv: (args) => filterOutFlags(args),
  cp: (args) => filterOutFlags(args),
  cat: (args) => filterOutFlags(args),
  head: (args) => filterOutFlags(args),
  tail: (args) => filterOutFlags(args),
  sort: (args) => filterOutFlags(args),
  uniq: (args) => filterOutFlags(args),
  wc: (args) => filterOutFlags(args),
  cut: (args) => filterOutFlags(args),
  paste: (args) => filterOutFlags(args),
  column: (args) => filterOutFlags(args),
  tr: (args) => {
    const hasDelete = args.some(
      (a) =>
        a === "-d" ||
        a === "--delete" ||
        (a.startsWith("-") && a.includes("d")),
    );
    const nonFlags = filterOutFlags(args);
    return nonFlags.slice(hasDelete ? 1 : 2);
  },
  file: (args) => filterOutFlags(args),
  stat: (args) => filterOutFlags(args),
  diff: (args) => filterOutFlags(args),
  awk: (args) => filterOutFlags(args),
  strings: (args) => filterOutFlags(args),
  hexdump: (args) => filterOutFlags(args),
  od: (args) => filterOutFlags(args),
  base64: (args) => filterOutFlags(args),
  nl: (args) => filterOutFlags(args),
  grep: (args) => {
    const flags = new Set([
      "-e",
      "--regexp",
      "-f",
      "--file",
      "--exclude",
      "--include",
      "--exclude-dir",
      "--include-dir",
      "-m",
      "--max-count",
      "-A",
      "--after-context",
      "-B",
      "--before-context",
      "-C",
      "--context",
    ]);
    const paths = parsePatternCommand(args, flags);
    if (
      paths.length === 0 &&
      args.some((a) => ["-r", "-R", "--recursive"].includes(a))
    ) {
      return ["."];
    }
    return paths;
  },
  rg: (args) => {
    const flags = new Set([
      "-e",
      "--regexp",
      "-f",
      "--file",
      "-t",
      "--type",
      "-T",
      "--type-not",
      "-g",
      "--glob",
      "-m",
      "--max-count",
      "--max-depth",
      "-r",
      "--replace",
      "-A",
      "--after-context",
      "-B",
      "--before-context",
      "-C",
      "--context",
    ]);
    return parsePatternCommand(args, flags, ["."]);
  },
  sed: (args) => {
    const paths: string[] = [];
    let skipNext = false;
    let scriptFound = false;
    let afterDoubleDash = false;
    for (let i = 0; i < args.length; i++) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      const arg = args[i];
      if (!arg) continue;
      if (!afterDoubleDash && arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && arg.startsWith("-")) {
        if (["-f", "--file"].includes(arg)) {
          const scriptFile = args[i + 1];
          if (scriptFile) {
            paths.push(scriptFile);
            skipNext = true;
          }
          scriptFound = true;
        }
        else if (["-e", "--expression"].includes(arg)) {
          skipNext = true;
          scriptFound = true;
        }
        else if (arg.includes("e") || arg.includes("f")) {
          scriptFound = true;
        }
        continue;
      }
      if (!scriptFound) {
        scriptFound = true;
        continue;
      }
      paths.push(arg);
    }
    return paths;
  },
  jq: (args) => {
    const paths: string[] = [];
    const flagsWithArgs = new Set([
      "-e",
      "--expression",
      "-f",
      "--from-file",
      "--arg",
      "--argjson",
      "--slurpfile",
      "--rawfile",
      "--args",
      "--jsonargs",
      "-L",
      "--library-path",
      "--indent",
      "--tab",
    ]);
    let filterFound = false;
    let afterDoubleDash = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined || arg === null) continue;
      if (!afterDoubleDash && arg === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (!afterDoubleDash && arg.startsWith("-")) {
        const flag = arg.split("=")[0];
        if (flag && ["-e", "--expression"].includes(flag)) {
          filterFound = true;
        }
        if (flag && flagsWithArgs.has(flag) && !arg.includes("=")) {
          i++;
        }
        continue;
      }
      if (!filterFound) {
        filterFound = true;
        continue;
      }
      paths.push(arg);
    }
    return paths;
  },
  git: (args) => {
    if (args.length >= 1 && args[0] === "diff") {
      if (args.includes("--no-index")) {
        const filePaths = filterOutFlags(args.slice(1));
        return filePaths.slice(0, 2);
      }
    }
    return [];
  },
  sha256sum: (args) => filterOutFlags(args),
  sha1sum: (args) => filterOutFlags(args),
  md5sum: (args) => filterOutFlags(args),
};
export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {
  cd: "read",
  ls: "read",
  find: "read",
  mkdir: "create",
  touch: "create",
  rm: "write",
  rmdir: "write",
  mv: "write",
  cp: "write",
  cat: "read",
  head: "read",
  tail: "read",
  sort: "read",
  uniq: "read",
  wc: "read",
  cut: "read",
  paste: "read",
  column: "read",
  tr: "read",
  file: "read",
  stat: "read",
  diff: "read",
  awk: "read",
  strings: "read",
  hexdump: "read",
  od: "read",
  base64: "read",
  nl: "read",
  grep: "read",
  rg: "read",
  sed: "write",
  git: "read",
  jq: "read",
  sha256sum: "read",
  sha1sum: "read",
  md5sum: "read",
};
const SUPPORTED_PATH_COMMANDS = Object.keys(PATH_EXTRACTORS) as PathCommand[];
const ACTION_VERBS: Record<PathCommand, string> = {
  cd: "change directories to",
  ls: "list files in",
  find: "search files in",
  mkdir: "create directories in",
  touch: "create or modify files in",
  rm: "remove files from",
  rmdir: "remove directories from",
  mv: "move files to/from",
  cp: "copy files to/from",
  cat: "concatenate files from",
  head: "read the beginning of files from",
  tail: "read the end of files from",
  sort: "sort contents of files from",
  uniq: "filter duplicate lines from files in",
  wc: "count lines/words/bytes in files from",
  cut: "extract columns from files in",
  paste: "merge files from",
  column: "format files from",
  tr: "transform text from files in",
  file: "examine file types in",
  stat: "read file stats from",
  diff: "compare files from",
  awk: "process text from files in",
  strings: "extract strings from files in",
  hexdump: "display hex dump of files from",
  od: "display octal dump of files from",
  base64: "encode/decode files from",
  nl: "number lines in files from",
  grep: "search for patterns in files from",
  rg: "search for patterns in files from",
  sed: "edit files in",
  git: "access files with git from",
  jq: "process JSON from files in",
  sha256sum: "compute SHA-256 checksums for files in",
  sha1sum: "compute SHA-1 checksums for files in",
  md5sum: "compute MD5 checksums for files in",
};
const COMMAND_VALIDATOR: Partial<
  Record<PathCommand, (args: string[]) => boolean>
> = {
  mv: (args: string[]) => !args.some((arg) => arg?.startsWith("-")),
  cp: (args: string[]) => !args.some((arg) => arg?.startsWith("-")),
};
function createReadRuleSuggestion(dirPath: string) {
  const pathForPattern = dirPath.replace(/\\/g, "/");
  if (pathForPattern === "/") return undefined;
  const ruleContent = pathForPattern.startsWith("/")
    ? `/${pathForPattern}/**`
    : `${pathForPattern}/**`;
  return {
    type: "addRules",
    rules: [{ toolName: "Read", ruleContent }],
    behavior: "allow" as const,
    destination: "session" as const,
  };
}
function parseCommandArguments(cmd: string): string[] {
  const parseResult = tryParseShellCommand(cmd, (env) => `$${env}`);
  if (!parseResult.success) {
    return [];
  }
  const parsed = parseResult.tokens;
  const extractedArgs: string[] = [];
  for (const arg of parsed) {
    if (typeof arg === "string") {
      extractedArgs.push(arg);
    } else if (
      typeof arg === "object" &&
      arg !== null &&
      "op" in arg &&
      arg.op === "glob" &&
      "pattern" in arg
    ) {
      extractedArgs.push(String(arg.pattern));
    }
  }
  return extractedArgs;
}
function validateCommandPaths(
  command: PathCommand,
  args: string[],
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  operationTypeOverride?: FileOperationType,
): PermissionResult {
  const extractor = PATH_EXTRACTORS[command];
  const paths = extractor(args);
  const operationType =
    operationTypeOverride ?? COMMAND_OPERATION_TYPE[command];
  const validator = COMMAND_VALIDATOR[command];
  if (validator && !validator(args)) {
    return {
      behavior: "ask",
      message: `${command} with flags requires manual approval to ensure path safety. For security, Pi cannot automatically validate ${command} commands that use flags, as some flags like --target-directory=PATH can bypass path validation.`,
      decisionReason: {
        type: "other",
        reason: `${command} command with flags requires manual approval`,
      },
      suggestions: [],
    };
  }
  if (compoundCommandHasCd && operationType !== "read") {
    return {
      behavior: "ask",
      message: `Commands that change directories and perform write operations require explicit approval to ensure paths are evaluated correctly. For security, Pi cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: "other",
        reason:
          "Compound command contains cd with write operation - manual approval required to prevent path resolution bypass",
      },
      suggestions: [],
    };
  }
  for (const p of paths) {
    const { allowed, resolvedPath, decisionReason } = validatePath(
      p,
      cwd,
      toolPermissionContext,
      operationType,
      isPathAllowedAdaptor,
    );
    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext, cwd),
      );
      const dirListStr = formatDirectoryList(workingDirs);
      const message =
        decisionReason?.type === "other"
          ? decisionReason.reason
          : `${command} in '${resolvedPath}' was blocked. For security, Pi may only ${ACTION_VERBS[command]} the allowed working directories for this session: ${dirListStr}.`;
      if (decisionReason?.type === "rule") {
        return {
          behavior: "deny",
          message,
          decisionReason,
        };
      }
      return {
        behavior: "ask",
        message,
        blockedPath: resolvedPath,
        decisionReason,
        suggestions: [],
      };
    }
  }
  return {
    behavior: "passthrough",
    message: `Path validation passed for ${command} command`,
  };
}
export function createPathChecker(
  command: PathCommand,
  operationTypeOverride?: FileOperationType,
) {
  return (
    args: string[],
    cwd: string,
    context: ToolPermissionContext,
    compoundCommandHasCd?: boolean,
  ): PermissionResult => {
    const result = validateCommandPaths(
      command,
      args,
      cwd,
      context,
      compoundCommandHasCd,
      operationTypeOverride,
    );
    if (result.behavior === "deny") {
      return result;
    }
    if (command === "rm" || command === "rmdir") {
      const dangerousPathResult = checkDangerousRemovalPaths(
        command,
        args,
        cwd,
        (a: string[]) => PATH_EXTRACTORS[command](a),
      );
      if (dangerousPathResult.behavior !== "passthrough") {
        return dangerousPathResult;
      }
    }
    if (result.behavior === "passthrough") {
      return result;
    }
    if (result.behavior === "ask") {
      const operationType =
        operationTypeOverride ?? COMMAND_OPERATION_TYPE[command];
      const suggestions: PermissionUpdate[] = [];
      if (result.blockedPath) {
        if (operationType === "read") {
          const dirPath = getDirectoryForPath(result.blockedPath, cwd);
          const suggestion = createReadRuleSuggestion(dirPath);
          if (suggestion) {
            suggestions.push(suggestion);
          }
        } else {
          suggestions.push({
            type: "addDirectories",
            directories: [getDirectoryForPath(result.blockedPath, cwd)],
            destination: "session",
          });
        }
      }
      if (
        operationType === "write" ||
        operationType === "create"
      ) {
        suggestions.push({
          type: "setMode",
          mode: "acceptEdits",
          destination: "session",
        });
      }
      const askResult = result;
      askResult.suggestions = suggestions;
    }
    return result;
  };
}
function validateSinglePathCommand(
  cmd: string,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  const strippedCmd = stripSafeWrappers(cmd);
  const extractedArgs = parseCommandArguments(strippedCmd);
  if (extractedArgs.length === 0) {
    return {
      behavior: "passthrough",
      message: "Empty command - no paths to validate",
    };
  }
  const [baseCmd, ...args] = extractedArgs;
  if (!baseCmd || !SUPPORTED_PATH_COMMANDS.includes(baseCmd as PathCommand)) {
    return {
      behavior: "passthrough",
      message: `Command '${baseCmd}' is not a path-restricted command`,
    };
  }
  const operationTypeOverride =
    baseCmd === "sed" && sedCommandIsAllowedByAllowlist(strippedCmd)
      ? ("read" as FileOperationType)
      : undefined;
  const pathChecker = createPathChecker(
    baseCmd as PathCommand,
    operationTypeOverride,
  );
  return pathChecker(args, cwd, toolPermissionContext, compoundCommandHasCd);
}
function validateOutputRedirections(
  redirections: Array<{ target: string; operator: ">" | ">>" }>,
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  if (compoundCommandHasCd && redirections.length > 0) {
    return {
      behavior: "ask",
      message: `Commands that change directories and write via output redirection require explicit approval to ensure paths are evaluated correctly. For security, Pi cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: "other",
        reason:
          "Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass",
      },
      suggestions: [],
    };
  }
  for (const { target } of redirections) {
    if (target === "/dev/null") {
      continue;
    }
    const { allowed, resolvedPath, decisionReason } = validatePath(
      target,
      cwd,
      toolPermissionContext,
      "create",
      isPathAllowedAdaptor,
    );
    if (!allowed) {
      const workingDirs = Array.from(
        allWorkingDirectories(toolPermissionContext, cwd),
      );
      const dirListStr = formatDirectoryList(workingDirs);
      const message =
        decisionReason?.type === "other"
          ? decisionReason.reason
          : decisionReason?.type === "rule"
            ? `Output redirection to '${resolvedPath}' was blocked by a deny rule.`
            : `Output redirection to '${resolvedPath}' was blocked. For security, Pi may only write to files in the allowed working directories for this session: ${dirListStr}.`;
      if (decisionReason?.type === "rule") {
        return {
          behavior: "deny",
          message,
          decisionReason,
        };
      }
      return {
        behavior: "ask",
        message,
        blockedPath: resolvedPath,
        decisionReason,
        suggestions: [
          {
            type: "addDirectories",
            directories: [getDirectoryForPath(resolvedPath, cwd)],
            destination: "session",
          },
        ],
      };
    }
  }
  return {
    behavior: "passthrough",
    message: "No unsafe redirections found",
  };
}
export function checkPathConstraints(
  input: { command: string },
  cwd: string,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
): PermissionResult {
  if (/>>\s*>\s*\(|>\s*>\s*\(|<\s*\(/.test(input.command)) {
    return {
      behavior: "ask",
      message:
        "Process substitution (>(...) or <(...)) can execute arbitrary commands and requires manual approval",
      decisionReason: {
        type: "other",
        reason: "Process substitution requires manual approval",
      },
      suggestions: [],
    };
  }
  const { redirections, hasDangerousRedirection } =
    extractOutputRedirections(input.command);
  if (hasDangerousRedirection) {
    return {
      behavior: "ask",
      message: "Shell expansion syntax in paths requires manual approval",
      decisionReason: {
        type: "other",
        reason: "Shell expansion syntax in paths requires manual approval",
      },
      suggestions: [],
    };
  }
  const redirectionResult = validateOutputRedirections(
    redirections,
    cwd,
    toolPermissionContext,
    compoundCommandHasCd,
  );
  if (redirectionResult.behavior !== "passthrough") {
    return redirectionResult;
  }
  const commands = splitCommand_DEPRECATED(input.command);
  for (const cmd of commands) {
    const result = validateSinglePathCommand(
      cmd,
      cwd,
      toolPermissionContext,
      compoundCommandHasCd,
    );
    if (result.behavior === "ask" || result.behavior === "deny") {
      return result;
    }
  }
  return {
    behavior: "passthrough",
    message: "All path commands validated successfully",
  };
}
