import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AgentsContextFile { path: string; content: string }
const AGENTS_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"];

/** Reject Claude Code sources in both the visible and canonical path. */
export function isClaudeSource(file: string): boolean {
  const forbidden = (p: string) => p.split(/[\\/]/).some(part => part.toLowerCase() === ".claude") || /^claude\.md$/i.test(basename(p));
  if (forbidden(file)) return true;
  try { return forbidden(realpathSync(file)); } catch { return false; }
}
function readInstruction(file: string): AgentsContextFile | undefined {
  if (isClaudeSource(file)) return;
  try {
    if (statSync(file).isFile()) return { path: file, content: readFileSync(file, "utf8").replace(/^\uFEFF/, "") };
  } catch { /* Missing/unreadable/racing optional instructions are ignored. */ }
}
function firstInstruction(dir: string): AgentsContextFile | undefined {
  for (const name of AGENTS_NAMES) {
    const file = readInstruction(join(dir, name));
    if (file) return file;
  }
}
export function ancestorDirectories(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd);; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === dirname(dir)) return dirs;
  }
}
/** Match Pi's nested linked-worktree shadowing without invoking Git or reading CLAUDE. */
function shadowedContextFile(cwd: string): string | undefined {
  try {
    for (const dir of ancestorDirectories(cwd).reverse()) {
      const git = join(dir, ".git");
      if (!existsSync(git)) continue;
      if (!statSync(git).isFile()) return;
      const pointer = readFileSync(git, "utf8").trim();
      if (!pointer.startsWith("gitdir: ")) return;
      const gitDir = resolve(dir, pointer.slice(8));
      if (!existsSync(join(gitDir, "HEAD")) || !existsSync(join(gitDir, "commondir"))) return;
      const common = realpathSync(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
      const main = dirname(common);
      if (!realpathSync(dir).startsWith(`${main}${sep}`) || realpathSync(join(main, ".git")) !== common) return;
      const own = firstInstruction(dir);
      return own ? join(main, basename(own.path)) : undefined;
    }
  } catch { /* Not a usable linked-worktree layout. */ }
}
/** Shared by the main prompt and reviewer, including project-trust and canonical dedup. */
export function loadAgentsContextFiles(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): AgentsContextFile[] {
  const files: AgentsContextFile[] = [];
  const seen = new Set<string>();
  const shadowed = projectTrusted ? shadowedContextFile(cwd) : undefined;
  for (const dir of [agentDir, ...(projectTrusted ? ancestorDirectories(cwd) : [])]) {
    const file = firstInstruction(dir);
    if (!file) continue;
    try {
      if (dir !== agentDir && join(realpathSync(dir), basename(file.path)) === shadowed) continue;
      const canonical = realpathSync(file.path);
      if (!seen.has(canonical)) { seen.add(canonical); files.push(file); }
    } catch { /* Removed during discovery. */ }
  }
  return files;
}
/** Rules never execute code. Hidden files and recursive/root symlinks are not followed. */
export function loadAgentsRules(cwd: string, projectTrusted: boolean, home = homedir()): AgentsContextFile[] {
  const roots = [join(home, ".agents", "rules")];
  if (projectTrusted) roots.push(...ancestorDirectories(cwd).map(dir => join(dir, ".agents", "rules")));
  const seen = new Set<string>();
  const files: AgentsContextFile[] = [];
  function walk(dir: string, root: string): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(dir, entry.name);
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) walk(file, root);
        else if (entry.isFile() && entry.name.endsWith(".md") && !isClaudeSource(file)) {
          const canonical = realpathSync(file), rel = relative(root, canonical);
          if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || seen.has(canonical)) continue;
          const instruction = readInstruction(file);
          if (instruction) { seen.add(canonical); files.push(instruction); }
        }
      }
    } catch { /* A rule can disappear during a refresh. */ }
  }
  for (const root of new Set(roots)) {
    try { if (!lstatSync(root).isSymbolicLink() && !isClaudeSource(root)) walk(root, realpathSync(root)); } catch {}
  }
  return files;
}
export function loadAgentsInstructions(cwd: string, projectTrusted: boolean, agentDir = getAgentDir(), home = homedir()): AgentsContextFile[] {
  const seen = new Set<string>();
  return [...loadAgentsContextFiles(cwd, projectTrusted, agentDir), ...loadAgentsRules(cwd, projectTrusted, home)].filter(file => {
    try { const canonical = realpathSync(file.path); if (seen.has(canonical)) return false; seen.add(canonical); return true; } catch { return false; }
  });
}
export function formatAgentsInstructions(files: AgentsContextFile[]): string {
  return files.map(file => `## ${file.path}\n${file.content}`).join("\n\n");
}
