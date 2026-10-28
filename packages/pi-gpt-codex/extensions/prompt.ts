import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ModelLike {
  provider?: string;
  api?: string;
  id?: string;
}

export interface PromptOptions {
  customPrompt?: string;
  selectedTools: string[];
  promptGuidelines: string[];
  sections: Record<string, string>;
}

const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const read = (name: string) => readFileSync(join(PROMPT_DIR, name), "utf8").trim();

export const GPT_PROMPT = read("gpt-codex.md");
export const TOOLS_CODEX = read("tools-codex.md");
export const TOOLS_PI = read("tools-pi.md");

// pi's default rules end with these; they fight the Codex prompt's writing and
// final-answer guidance, so the Codex section replaces them.
export const DROPPED_DEFAULT_GUIDELINES = new Set([
  "Be concise in your responses",
  "Show file paths clearly when working with files",
]);

/** GPT on the ChatGPT/Codex subscription route, or any OpenAI Responses GPT model. */
export function isGptModel(model: ModelLike | undefined): boolean {
  if (!model) return false;
  const id = (model.id ?? "").toLowerCase();
  if (model.provider === "openai-codex" || model.api === "openai-codex-responses") return true;
  return (model.api === "openai-responses" || model.api === "azure-openai-responses") && /^(gpt-|codex)/.test(id);
}

/**
 * Rewrite pi's structured prompt options in place for a GPT model: a Codex-style
 * preamble, a tools section matching the active tool set, and no conflicting
 * default rules. Project context, skills, cwd, and other extensions' sections stay.
 */
export function applyGptPrompt(options: PromptOptions): void {
  const codexTools = options.selectedTools.includes("apply_patch") || options.selectedTools.includes("exec_command");
  options.customPrompt = GPT_PROMPT;
  options.sections.gpt_tools = codexTools ? TOOLS_CODEX : TOOLS_PI;
  options.promptGuidelines = options.promptGuidelines.filter((rule) => !DROPPED_DEFAULT_GUIDELINES.has(rule));
}

const TRUNCATION_NOTICE = /\[Showing (?:last [^\]]* of line \d+|lines \d+-\d+ of \d+)[^\]]*Full output: ([^\]]+)\]/;

/**
 * pi's bash and Codex exec_command keep only the tail of long output, where Codex keeps
 * head and tail. Point the model at the saved full output so the first error is not lost.
 */
export function withTruncationHint(text: string): string | undefined {
  const match = TRUNCATION_NOTICE.exec(text);
  if (!match || text.includes("[Only the end of the output is shown")) return undefined;
  const path = match[1].trim();
  const hint =
    `[Only the end of the output is shown. The first error or failing test is often near the start: ` +
    `run \`head -n 80 ${path}\` or \`rg -n 'error|fail|warning' ${path}\` before concluding.]`;
  return text.replace(match[0], `${match[0]}\n${hint}`);
}
