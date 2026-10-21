import { existsSync } from "node:fs";
import { basename } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/** One place the fork can end, chosen from the active branch. */
export interface ForkPoint {
  label: string;
  leafId: string;
}

export interface SavedFork {
  id: string;
  file: string;
  name: string;
}

interface BranchEntry {
  id: string;
  type: string;
  message?: { role?: string; content?: unknown };
}

const PREVIEW_WIDTH = 60;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || (part as { type?: string }).type !== "text") return "";
      return String((part as { text?: unknown }).text ?? "");
    })
    .join(" ");
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_WIDTH ? `${line.slice(0, PREVIEW_WIDTH - 1)}…` : line;
}

/**
 * Fork points on the active branch: the current position first, then the end
 * of each earlier round (a user message plus everything up to the next user
 * message), newest first. The last round equals the current position.
 */
export function forkPoints(branch: readonly BranchEntry[]): ForkPoint[] {
  const leaf = branch[branch.length - 1];
  if (!leaf) return [];
  const rounds: { index: number; text: string }[] = [];
  branch.forEach((entry, index) => {
    if (entry.type !== "message" || entry.message?.role !== "user") return;
    const text = preview(messageText(entry.message.content)) || "（图片或空消息）";
    rounds.push({ index, text });
  });
  const points: ForkPoint[] = [{ label: "当前位置（完整复制当前分支）", leafId: leaf.id }];
  for (let r = rounds.length - 2; r >= 0; r--) {
    const end = branch[rounds[r + 1]!.index - 1]!;
    points.push({ label: `到第 ${r + 1} 轮为止：${rounds[r]!.text}`, leafId: end.id });
  }
  return points;
}

/** Normalize a user-supplied name the same way Pi stores session names. */
export function normalizeName(name: string): string {
  return name.replace(/[\r\n]+/g, " ").trim();
}

export function defaultForkName(sessionName: string | undefined, cwd: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${sessionName || basename(cwd) || "session"} · fork ${stamp}`;
}


/**
 * Copy root..leafId of the saved session file into a new session file in the
 * same session directory. The running session is not touched: a separate
 * SessionManager reads the file, so Pi's own branch extraction (labels,
 * compaction) is reused without switching the foreground session.
 */
export function saveFork(sourceFile: string, sessionDir: string, leafId: string, name: string): SavedFork {
  if (!existsSync(sourceFile)) throw new Error("当前会话还没有写入文件（需要至少一条对话消息），请稍后再试");
  const manager = SessionManager.open(sourceFile, sessionDir);
  if (!manager.getEntry(leafId)) {
    throw new Error("分叉点还没有写入会话文件，请等当前回复结束后再试");
  }
  const file = manager.createBranchedSession(leafId);
  if (!file) throw new Error("无法创建分叉会话文件");
  if (name) manager.appendSessionInfo(name);
  if (!existsSync(file)) throw new Error("分叉点之前还没有对话内容，无法保存");
  return { id: manager.getSessionId(), file, name };
}
