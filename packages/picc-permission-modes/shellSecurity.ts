import { hasShellQuoteSingleQuoteBug } from "./upstream/utils/bash/shellQuote.ts";
import { containsUnquotedExpansion } from "./upstream/tools/BashTool/readOnlyValidation.ts";
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
export function hasControlCharacters(command: string): boolean {
  return CONTROL_CHAR_RE.test(command);
}
export { hasShellQuoteSingleQuoteBug, containsUnquotedExpansion };
