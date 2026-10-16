export {
  tryParseShellCommand,
  tryQuoteShellArgs,
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  quote,
} from "./upstream/utils/bash/shellQuote.ts";
export type { ParseEntry } from "./upstream/utils/bash/shellQuote.ts";
export type {
  ShellParseResult,
  ShellQuoteResult,
} from "./upstream/utils/bash/shellQuote.ts";
