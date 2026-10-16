export {
  splitCommand_DEPRECATED as splitCommandInternal,
  splitCommandWithOperators,
  filterControlOperators,
  extractOutputRedirections,
  isUnsafeCompoundCommand_DEPRECATED,
  isHelpCommand,
  clearCommandPrefixCaches,
} from "./upstream/utils/bash/commands.ts";
import { splitCommand_DEPRECATED } from "./upstream/utils/bash/commands.ts";
const SHELL_OPERATORS = new Set<string>([
  "&&", "||", ";", ";;", "|", "|&", ">", ">>", ">&", "&",
]);
export function splitCommand(command: string): string[] {
  return splitCommand_DEPRECATED(command).filter(
    (token) => !SHELL_OPERATORS.has(token),
  );
}
