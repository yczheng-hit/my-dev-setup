import { splitCommand } from "./bashParser.ts";
import { tryParseShellCommand } from "./shellQuote.ts";
export type SedConstraintDecision =
  | { behavior: "passthrough" }
  | {
      behavior: "ask";
      message: string;
      decisionReason: { type: "other"; reason: string };
    };
const ALLOWED_LINE_PRINT_FLAGS = new Set([
  "-n",
  "--quiet",
  "--silent",
  "-E",
  "--regexp-extended",
  "-r",
  "--posix",
  "-z",
  "--zero-terminated",
]);
const ALLOWED_SUBSTITUTION_BASE_FLAGS = new Set([
  "-E",
  "--regexp-extended",
  "-r",
  "--posix",
]);
const ALLOWED_SUBSTITUTION_FILE_WRITE_FLAGS = new Set([
  "-i",
  "--in-place",
]);
const PRINT_COMMAND_RE = /^(?:\d+|\d+,\d+)?p$/;
function validateFlagsAgainstAllowlist(
  flags: string[],
  allowedFlags: Set<string>,
): boolean {
  for (const flag of flags) {
    if (flag.startsWith("-") && !flag.startsWith("--") && flag.length > 2) {
      for (let i = 1; i < flag.length; i++) {
        if (!allowedFlags.has("-" + flag[i])) return false;
      }
    } else {
      if (!allowedFlags.has(flag)) return false;
    }
  }
  return true;
}
function extractSedExpressions(command: string): string[] {
  const expressions: string[] = [];
  const sedMatch = command.match(/^\s*sed\s+/);
  if (!sedMatch) return expressions;
  const withoutSed = command.slice(sedMatch[0].length);
  if (/-e[wWe]/.test(withoutSed) || /-w[eE]/.test(withoutSed)) {
    throw new Error("dangerous flag combination");
  }
  const parseResult = tryParseShellCommand(withoutSed);
  if (!parseResult.success) {
    throw new Error(`malformed shell syntax: ${parseResult.error}`);
  }
  const parsed = parseResult.tokens;
  let foundEFlag = false;
  let foundExpression = false;
  for (let i = 0; i < parsed.length; i++) {
    const arg = parsed[i];
    if (typeof arg !== "string") continue;
    if ((arg === "-e" || arg === "--expression") && i + 1 < parsed.length) {
      foundEFlag = true;
      const nextArg = parsed[i + 1];
      if (typeof nextArg === "string") {
        expressions.push(nextArg);
        i++;
      }
      continue;
    }
    if (arg.startsWith("--expression=")) {
      foundEFlag = true;
      expressions.push(arg.slice("--expression=".length));
      continue;
    }
    if (arg.startsWith("-e=")) {
      foundEFlag = true;
      expressions.push(arg.slice("-e=".length));
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (!foundEFlag && !foundExpression) {
      expressions.push(arg);
      foundExpression = true;
      continue;
    }
    break;
  }
  return expressions;
}
function hasFileArgs(command: string): boolean {
  const sedMatch = command.match(/^\s*sed\s+/);
  if (!sedMatch) return false;
  const withoutSed = command.slice(sedMatch[0].length);
  const parseResult = tryParseShellCommand(withoutSed);
  if (!parseResult.success) return true;
  const parsed = parseResult.tokens;
  try {
    let argCount = 0;
    let hasEFlag = false;
    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i];
      if (
        typeof arg === "object" &&
        arg !== null &&
        "op" in arg &&
        (arg as { op: string }).op === "glob"
      ) {
        return true;
      }
      if (typeof arg !== "string") continue;
      if ((arg === "-e" || arg === "--expression") && i + 1 < parsed.length) {
        hasEFlag = true;
        i++;
        continue;
      }
      if (arg.startsWith("--expression=")) {
        hasEFlag = true;
        continue;
      }
      if (arg.startsWith("-e=")) {
        hasEFlag = true;
        continue;
      }
      if (arg.startsWith("-")) continue;
      argCount++;
      if (hasEFlag) return true;
      if (argCount > 1) return true;
    }
    return false;
  } catch {
    return true;
  }
}
function containsDangerousOperations(expression: string): boolean {
  const cmd = expression.trim();
  if (!cmd) return false;
  if (/[^\x01-\x7F]/.test(cmd)) return true;
  if (cmd.includes("{") || cmd.includes("}") || cmd.includes("\n")) return true;
  const hashIndex = cmd.indexOf("#");
  if (hashIndex !== -1 && !(hashIndex > 0 && cmd[hashIndex - 1] === "s")) {
    return true;
  }
  if (/^!/.test(cmd) || /[/\d$]!/.test(cmd)) return true;
  if (/\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d/.test(cmd)) return true;
  if (/^,/.test(cmd)) return true;
  if (/,\s*[+-]/.test(cmd)) return true;
  if (/s\\/.test(cmd) || /\\[|#%@]/.test(cmd)) return true;
  if (/\\\/.*[wW]/.test(cmd)) return true;
  if (/\/[^/]*\s+[wWeE]/.test(cmd)) return true;
  if (/^s\//.test(cmd) && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(cmd)) {
    return true;
  }
  if (/^s./.test(cmd) && /[wWeE]$/.test(cmd)) {
    const properSubst = /^s([^\\\n]).*?\1.*?\1[^wWeE]*$/.test(cmd);
    if (!properSubst) return true;
  }
  if (
    /^[wW]\s*\S+/.test(cmd) ||
    /^\d+\s*[wW]\s*\S+/.test(cmd) ||
    /^\$\s*[wW]\s*\S+/.test(cmd) ||
    /^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) ||
    /^\d+,\d+\s*[wW]\s*\S+/.test(cmd) ||
    /^\d+,\$\s*[wW]\s*\S+/.test(cmd) ||
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd)
  ) {
    return true;
  }
  if (
    /^e/.test(cmd) ||
    /^\d+\s*e/.test(cmd) ||
    /^\$\s*e/.test(cmd) ||
    /^\/[^/]*\/[IMim]*\s*e/.test(cmd) ||
    /^\d+,\d+\s*e/.test(cmd) ||
    /^\d+,\$\s*e/.test(cmd) ||
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*e/.test(cmd)
  ) {
    return true;
  }
  const substitutionMatch = cmd.match(/s([^\\\n]).*?\1.*?\1(.*?)$/);
  if (substitutionMatch) {
    const flags = substitutionMatch[2] || "";
    if (flags.includes("w") || flags.includes("W")) return true;
    if (flags.includes("e") || flags.includes("E")) return true;
  }
  const yCommandMatch = cmd.match(/y([^\\\n])/);
  if (yCommandMatch) {
    if (/[wWeE]/.test(cmd)) return true;
  }
  return false;
}
function isLinePrintingCommand(
  command: string,
  expressions: string[],
): boolean {
  const sedMatch = command.match(/^\s*sed\s+/);
  if (!sedMatch) return false;
  const withoutSed = command.slice(sedMatch[0].length);
  const parseResult = tryParseShellCommand(withoutSed);
  if (!parseResult.success) return false;
  const parsed = parseResult.tokens;
  const flags: string[] = [];
  for (const arg of parsed) {
    if (typeof arg === "string" && arg.startsWith("-") && arg !== "--") {
      flags.push(arg);
    }
  }
  if (!validateFlagsAgainstAllowlist(flags, ALLOWED_LINE_PRINT_FLAGS)) {
    return false;
  }
  let hasNFlag = false;
  for (const flag of flags) {
    if (flag === "-n" || flag === "--quiet" || flag === "--silent") {
      hasNFlag = true;
      break;
    }
    if (flag.startsWith("-") && !flag.startsWith("--") && flag.includes("n")) {
      hasNFlag = true;
      break;
    }
  }
  if (!hasNFlag) return false;
  if (expressions.length === 0) return false;
  for (const expr of expressions) {
    const parts = expr.split(";");
    for (const part of parts) {
      if (!PRINT_COMMAND_RE.test(part.trim())) return false;
    }
  }
  return true;
}
function isSubstitutionCommand(
  command: string,
  expressions: string[],
  hasFileArguments: boolean,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false;
  if (!allowFileWrites && hasFileArguments) return false;
  const sedMatch = command.match(/^\s*sed\s+/);
  if (!sedMatch) return false;
  const withoutSed = command.slice(sedMatch[0].length);
  const parseResult = tryParseShellCommand(withoutSed);
  if (!parseResult.success) return false;
  const parsed = parseResult.tokens;
  const flags: string[] = [];
  for (const arg of parsed) {
    if (typeof arg === "string" && arg.startsWith("-") && arg !== "--") {
      flags.push(arg);
    }
  }
  const allowedFlags = new Set(ALLOWED_SUBSTITUTION_BASE_FLAGS);
  if (allowFileWrites) {
    for (const f of ALLOWED_SUBSTITUTION_FILE_WRITE_FLAGS) {
      allowedFlags.add(f);
    }
  }
  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) return false;
  if (expressions.length !== 1) return false;
  const expr = expressions[0].trim();
  if (!expr.startsWith("s")) return false;
  const substitutionMatch = expr.match(/^s\/(.*?)$/);
  if (!substitutionMatch) return false;
  const rest = substitutionMatch[1];
  let delimiterCount = 0;
  let lastDelimiterPos = -1;
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === "\\") {
      i += 2;
      continue;
    }
    if (rest[i] === "/") {
      delimiterCount++;
      lastDelimiterPos = i;
    }
    i++;
  }
  if (delimiterCount !== 2) return false;
  const exprFlags = rest.slice(lastDelimiterPos + 1);
  if (!/^[gpimIM]*[1-9]?[gpimIM]*$/.test(exprFlags)) return false;
  return true;
}
function sedCommandIsAllowedByAllowlist(
  command: string,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false;
  let expressions: string[];
  try {
    expressions = extractSedExpressions(command);
  } catch {
    return false;
  }
  const hasFileArguments = hasFileArgs(command);
  let isPattern1 = false;
  let isPattern2 = false;
  if (allowFileWrites) {
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments, {
      allowFileWrites: true,
    });
  } else {
    isPattern1 = isLinePrintingCommand(command, expressions);
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments);
  }
  if (!isPattern1 && !isPattern2) return false;
  for (const expr of expressions) {
    if (isPattern2 && expr.includes(";")) return false;
  }
  for (const expr of expressions) {
    if (containsDangerousOperations(expr)) return false;
  }
  return true;
}
export function checkSedConstraints(
  command: string,
  options?: { allowFileWrites?: boolean },
): SedConstraintDecision {
  const allowFileWrites = options?.allowFileWrites ?? false;
  const subcommands = splitCommand(command);
  for (const sub of subcommands) {
    const trimmed = sub.trim();
    const baseCmd = trimmed.split(/\s+/)[0];
    if (baseCmd !== "sed") continue;
    if (!sedCommandIsAllowedByAllowlist(trimmed, { allowFileWrites })) {
      return {
        behavior: "ask",
        message:
          "sed command requires approval (contains potentially dangerous operations)",
        decisionReason: {
          type: "other",
          reason:
            "sed command contains operations that require explicit approval (e.g., write commands, execute commands)",
        },
      };
    }
  }
  return { behavior: "passthrough" };
}