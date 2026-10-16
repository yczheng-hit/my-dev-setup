import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Diagnostics only: every caller (upstream/utils/bash/shellQuote.ts) already reports the failure.
 * Never write to stdout/stderr — under Pi's TUI raw writes land on top of the screen (seen:
 * "[picc-permission-modes] Bad substitution: new" over the editor and the HUD footer).
 * Set PICC_DEBUG to an absolute file path to append them there.
 */
export function logError(error: unknown): void {
  const target = process.env.PICC_DEBUG;
  if (!target || !isAbsolute(target)) return;
  try {
    const message = error instanceof Error ? error.message : String(error);
    appendFileSync(target, `${new Date().toISOString()} [picc-permission-modes] ${message}\n`);
  } catch {
  }
}
export function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}
export function feature(_name: string): boolean {
  return false;
}
export function logEvent(
  _name: string,
  _metadata?: Record<string, unknown>,
): void {
}
export type CommandPrefixResult = {
  commandPrefix: string
  reasoning?: string
}
export type CommandSubcommandPrefixResult = CommandPrefixResult & {
  hasUserSufficientPermissions?: boolean
}
