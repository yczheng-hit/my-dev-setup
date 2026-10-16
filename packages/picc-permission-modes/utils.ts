import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import path from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { structuredPatch } from "diff";
import { splitCommand } from "./bashParser.ts";
import { isBashCommandReadOnly } from "./readOnlyCommands.ts";
export function extractToolPath(input: Record<string, unknown>): string {
  if (typeof input.path === "string" && input.path) return input.path;
  if (typeof input.file_path === "string" && input.file_path) {
    return input.file_path;
  }
  return "";
}
export function resolveToolPath(baseDir: string, p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    const rest = p.slice(2).replace(/\\/g, "/");
    return path.join(homedir(), rest);
  }
  return path.resolve(baseDir, p);
}
export interface DiffLine {
  type: "add" | "del" | "context";
  oldNo: number;
  newNo: number;
  text: string;
}
export interface DiffRenderLine {
  type: "add" | "del" | "context";
  plain: string;
}
const DIFF_CONTEXT_LINES = 3;
const DIFF_AMP_TOKEN = "<<:DIFF_AMP:>>";
const DIFF_DOLLAR_TOKEN = "<<:DIFF_DOLLAR:>>";
function escapeForDiff(s: string): string {
  return s.replaceAll("&", DIFF_AMP_TOKEN).replaceAll("$", DIFF_DOLLAR_TOKEN);
}
function unescapeFromDiff(s: string): string {
  return s
    .replaceAll(DIFF_AMP_TOKEN, "&")
    .replaceAll(DIFF_DOLLAR_TOKEN, "$");
}
function readExistingFileContent(filePath: string, cwd: string): string {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    return readFileSync(abs, "utf8").replaceAll("\r\n", "\n");
  } catch {
    return "";
  }
}
export function buildEditDiff(
  filePath: string,
  oldString: string,
  newString: string,
  cwd: string,
): DiffLine[] | null {
  try {
    const existing = readExistingFileContent(filePath, cwd);
    const oldContent =
      oldString !== "" || existing === "" ? oldString : existing;
    const newContent = newString;
    if (oldContent === newContent) return [];
    const patch = structuredPatch(
      filePath,
      filePath,
      escapeForDiff(oldContent),
      escapeForDiff(newContent),
      undefined,
      undefined,
      { context: DIFF_CONTEXT_LINES },
    );
    if (!patch) return [];
    const lines: DiffLine[] = [];
    for (const hunk of patch.hunks) {
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      for (const rawLine of hunk.lines) {
        if (rawLine.startsWith("\\")) continue;
        const text = rawLine === "" ? "" : unescapeFromDiff(rawLine.slice(1));
        if (rawLine.startsWith("+")) {
          lines.push({ type: "add", oldNo: 0, newNo: newNo++, text });
        } else if (rawLine.startsWith("-")) {
          lines.push({ type: "del", oldNo: oldNo++, newNo: 0, text });
        } else {
          lines.push({ type: "context", oldNo: oldNo++, newNo: newNo++, text });
        }
      }
    }
    return lines;
  } catch {
    return null;
  }
}
export function renderDiffLines(lines: DiffLine[], width: number): DiffRenderLine[] {
  if (lines.length === 0) return [];
  let maxNo = 1;
  for (const l of lines) {
    if (l.oldNo > maxNo) maxNo = l.oldNo;
    if (l.newNo > maxNo) maxNo = l.newNo;
  }
  const gutterW = String(maxNo).length;
  const contentW = Math.max(1, width - gutterW - 3);
  const out: DiffRenderLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (i > 0) {
      const prev = lines[i - 1];
      const prevNew = Math.max(prev.newNo, prev.oldNo);
      const curNew = Math.max(l.newNo, l.oldNo);
      if (curNew - prevNew > 1) {
        out.push({ type: "context", plain: "…" });
      }
    }
    const marker = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
    const num = l.type === "del" ? l.oldNo : l.newNo;
    const content = l.text.length > contentW ? l.text.slice(0, contentW) : l.text;
    const numStr = String(num).padStart(gutterW, " ");
    out.push({ type: l.type, plain: `${numStr} ${marker} ${content}` });
  }
  return out;
}
export function toRelativePath(filePath: string, cwd: string): string {
  if (!filePath) return "";
  let abs = filePath;
  if (abs === "~") return abs;
  if (abs.startsWith("~/") || abs.startsWith("~\\")) {
    abs = path.join(homedir(), abs.slice(2).replace(/\\/g, "/"));
  } else if (!path.isAbsolute(abs)) {
    abs = path.resolve(cwd, abs);
  }
  const rel = path.relative(cwd, abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  return path.basename(abs);
}
export function isReadOnlyCommand(command: string): boolean {
  return isBashCommandReadOnly(command);
}
export function splitBashSubcommands(command: string): string[] {
  return splitCommand(command);
}
export function commandTargetsOutsideCwd(command: string, cwd: string): boolean {
  if (!command || !command.trim()) return false;
  if (!cwd) return false;
  if (/(^|[\s;&|('])(\/[A-Za-z0-9_\-])/.test(command)) return true;
  if (/(^|[\s;&|(])(~|\$HOME|\$TMPDIR|\$TMP|\$PWD\b)/.test(command)) return true;
  if (/(^|[\s;&|(])\.\.($|[\s/&|)])/.test(command)) return true;
  return false;
}
export function isOutsideCwd(targetPath: string, cwd: string): boolean {
  if (!targetPath) return false;
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd, targetPath);
  const cwdAbs = path.resolve(cwd);
  if (resolved === cwdAbs) return false;
  return !resolved.startsWith(cwdAbs + path.sep);
}
const ADJECTIVES = [
  "gleaming",
  "cosmic",
  "velvet",
  "brisk",
  "quiet",
  "amber",
  "swift",
  "gentle",
  "bold",
  "lively",
  "mellow",
  "bright",
  "sunny",
  "cool",
  "eager",
  "calm",
  "fuzzy",
  "crisp",
  "witty",
  "sturdy",
  "shiny",
  "humble",
  "vivid",
  "jolly",
  "sly",
  "kind",
  "noble",
  "plucky",
  "roguish",
  "stately",
];
const VERBS = [
  "brewing",
  "pondering",
  "wandering",
  "soaring",
  "drifting",
  "milling",
  "humming",
  "twirling",
  "gliding",
  "strolling",
  "sparking",
  "blossoming",
  "mending",
  "mapping",
  "weaving",
  "shaping",
  "gathering",
  "kindling",
  "tending",
  "savoring",
];
const NOUNS = [
  "phoenix",
  "lighthouse",
  "orchard",
  "meadow",
  "cottage",
  "harbor",
  "valley",
  "willow",
  "fountain",
  "canyon",
  "magnet",
  "lantern",
  "prairie",
  "cedar",
  "beacon",
  "grove",
  "stream",
  "blossom",
  "meadow",
  "comet",
  "dune",
  "ember",
  "fern",
  "glade",
  "halo",
  "isle",
  "jade",
  "kelp",
  "ledge",
  "moss",
];
function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
export function generateWordSlug(): string {
  return `${pickRandom(ADJECTIVES)}-${pickRandom(VERBS)}-${pickRandom(NOUNS)}`;
}
let plansDirCache: string | undefined;
export function getPlansDir(): string {
  if (plansDirCache) return plansDirCache;
  const dir = path.join(getAgentDir(), "extensions", "picc-permission-modes", "plans");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
    }
  }
  plansDirCache = dir;
  return dir;
}
const MAX_PLAN_SLUG_CACHE = 256;
const planSlugBySession = new Map<string, string>();
function rememberPlanSlug(sessionId: string, slug: string): void {
  if (planSlugBySession.size >= MAX_PLAN_SLUG_CACHE) {
    const oldest = planSlugBySession.keys().next().value;
    if (oldest !== undefined) planSlugBySession.delete(oldest);
  }
  planSlugBySession.set(sessionId, slug);
}
export function getPlanSlug(sessionId: string): string {
  const cached = planSlugBySession.get(sessionId);
  if (cached) return cached;
  const dir = getPlansDir();
  let slug = generateWordSlug();
  for (let i = 0; i < 10; i++) {
    if (!existsSync(path.join(dir, `${slug}.md`))) break;
    slug = generateWordSlug();
  }
  rememberPlanSlug(sessionId, slug);
  return slug;
}
export function setPlanSlug(sessionId: string, slug: string): void {
  if (sessionId && slug) rememberPlanSlug(sessionId, slug);
}
export function clearPlanSlugs(): void {
  planSlugBySession.clear();
}
export function getPlanFilePath(sessionId: string): string {
  return path.join(getPlansDir(), `${getPlanSlug(sessionId)}.md`);
}
export function ensurePlansDir(): string {
  return getPlansDir();
}
export function shortenPath(p: string): string {
  if (!p) return p;
  const home = homedir();
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}
const DENIAL_WORKAROUND_GUIDANCE =
  `IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, ` +
  `e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, ` +
  `e.g. do not use your ability to run tests to execute non-test actions. ` +
  `You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. ` +
  `If you believe this capability is essential to complete the user's request, STOP and explain to the user ` +
  `what you were trying to do and why you need this permission. Let the user decide how to proceed.`;
export function autoRejectMessage(toolName: string): string {
  return `Permission to use ${toolName} has been denied. ${DENIAL_WORKAROUND_GUIDANCE}`;
}
export { dirname };