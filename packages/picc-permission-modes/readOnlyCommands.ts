import { checkReadOnlyConstraints } from "./upstream/tools/BashTool/readOnlyValidation.ts";
import {
  commandHasAnyCd,
  isNormalizedCdCommand,
  isNormalizedGitCommand,
} from "./upstream/tools/BashTool/bashPermissions.ts";
import { splitCommand_DEPRECATED } from "./upstream/utils/bash/commands.ts";
export type {
  FlagArgType,
  ExternalCommandConfig,
} from "./upstream/utils/shell/readOnlyCommandValidation.ts";
export interface CommandConfig {
  safeFlags: Record<string, import("./upstream/utils/shell/readOnlyCommandValidation.ts").FlagArgType>;
  regex?: RegExp;
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean;
  respectsDoubleDash?: boolean;
}
export { validateFlags } from "./upstream/utils/shell/readOnlyCommandValidation.ts";
export function isCommandSafeViaFlagParsing(command: string): boolean {
  const input = { command };
  const result = checkReadOnlyConstraints(input, false);
  return result.behavior === "allow";
}
export function isCommandReadOnly(command: string): boolean {
  const trimmed = command.endsWith(" 2>&1")
    ? command.slice(0, -5).trim()
    : command;
  const input = { command: trimmed };
  const hasCd = commandHasAnyCd(trimmed);
  const result = checkReadOnlyConstraints(input, hasCd);
  return result.behavior === "allow";
}
export function isBashCommandReadOnly(command: string): boolean {
  if (!command || !command.trim()) return true;
  const subcommands = splitCommand_DEPRECATED(command);
  if (subcommands.length === 0) return true;
  const cdCommands = subcommands.filter((sub) => isNormalizedCdCommand(sub));
  if (cdCommands.length > 1) return false;
  const compoundCommandHasCd = cdCommands.length > 0;
  if (
    compoundCommandHasCd &&
    subcommands.some((sub) => isNormalizedGitCommand(sub.trim()))
  ) {
    return false;
  }
  return subcommands.every((sub) => {
    const result = checkReadOnlyConstraints(
      { command: sub },
      commandHasAnyCd(sub),
    );
    return result.behavior === "allow";
  });
}
