import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensurePermissionModesConfig, resolvePermissionModesConfigPath } from "./config-path.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AutoMode, getAutoMode, setAutoMode } from "./auto-mode.ts";
import { loadAutoModeConfig } from "./auto-mode-config.ts";
import { loadUserPermissions } from "./permissionsConfig.ts";
import {
  addRepoPermissionRule,
  loadRepoPermissions,
} from "./repoPermissionsConfig.ts";
const CLASSIFIER_NOTE = "Allowed by auto mode classifier";
export const CLASSIFIER_NOTE_MARKER = `${CLASSIFIER_NOTE}`;
const ACCEPT_EDITS_HEX = "#ccb1ff";
const ACCEPT_EDITS_RGB = { r: 0xcc, g: 0xb1, b: 0xff };
const REQUIRES_USER_INTERACTION = new Set<string>([
  "AskUserQuestion",
]);
const READ_FAMILY = new Set<string>([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
]);
type ClassifierDecision =
  | { kind: "allow"; via: string }
  | { kind: "block"; via: string; reason: string };
/** Max pending decisions to keep. Bound prevents leak on tool cancellation /
 *  runtime crash — under normal operation `tool_result` always fires and
 *  clears the entry. */
const MAX_PENDING_CLASSIFIER_DECISIONS = 256;
const pendingClassifierDecisions: Map<string, ClassifierDecision> = new Map();
function rememberClassifierDecision(
  toolCallId: string,
  decision: ClassifierDecision,
): void {
  if (pendingClassifierDecisions.size >= MAX_PENDING_CLASSIFIER_DECISIONS) {
    const oldest = pendingClassifierDecisions.keys().next().value;
    if (oldest !== undefined) pendingClassifierDecisions.delete(oldest);
  }
  pendingClassifierDecisions.set(toolCallId, decision);
}
function takeClassifierDecision(
  toolCallId: string,
): ClassifierDecision | undefined {
  const entry = pendingClassifierDecisions.get(toolCallId);
  if (entry) pendingClassifierDecisions.delete(toolCallId);
  return entry;
}
function hexToAnsi256(r: number, g: number, b: number): number {
  const toCube = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
}
function truecolorSupported(): boolean {
  const tc = process.env.COLORTERM;
  if (tc && (tc.toLowerCase() === "truecolor" || tc.toLowerCase() === "24bit")) return true;
  return true;
}
function formatAcceptEditsText(
  theme: { fg: (color: string, text: string) => string },
  text: string,
): string {
  if (!text) return text;
  if (!truecolorSupported()) {
    try {
      return theme.fg("success", text);
    } catch {
      return text;
    }
  }
  const { r, g, b } = ACCEPT_EDITS_RGB;
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}
const AUTO_MODE_RGB = { r: 0xff, g: 0xc1, b: 0x07 };
function formatAutoModeText(
  theme: { fg: (color: string, text: string) => string },
  text: string,
): string {
  if (!text) return text;
  if (!truecolorSupported()) {
    try {
      return theme.fg("warning", text);
    } catch {
      return text;
    }
  }
  const { r, g, b } = AUTO_MODE_RGB;
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
  buildContext,
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  generateSuggestions,
  getFilePermissionOptions,
  getNextPermissionMode,
  isAcceptEditsBashCommand,
  isDangerousFilePath,
  matchingBashRule,
  pathInAllowedWorkingPath,
  type PermissionResult,
} from "./permissionContext.ts";
import { checkSedConstraints } from "./sedValidation.ts";
import { isBashCommandReadOnly } from "./readOnlyCommands.ts";
import { extractBashPaths } from "./pathExtractors.ts";
import { checkPathConstraints } from "./upstream/tools/BashTool/pathValidation.ts";
import { commandHasAnyCd } from "./upstream/tools/BashTool/bashPermissions.ts";
import {
  autoRejectMessage,
  buildEditDiff,
  clearPlanSlugs,
  ensurePlansDir,
  extractToolPath,
  getPlanFilePath,
  getPlanSlug,
  resolveToolPath,
  setPlanSlug,
  shortenPath,
  toRelativePath,
  type DiffLine,
} from "./utils.ts";
import { extractFirstBashPath } from "./pathExtractors.ts";
import {
  MODE_META,
  type AllowedPrompt,
  type ModesPersistedEntry,
  type PermissionMode,
  type PermissionUpdate,
} from "./types.ts";
import { makeEnterPlanModeTool } from "./enterPlanModeTool.ts";
import { makeExitPlanModeTool } from "./exitPlanModeTool.ts";
import { modeMetaTitle } from "./modeMeta.ts";
import {
  createFilePermissionDialogFactory,
  type FilePermissionChoice,
} from "./filePermissionDialog.ts";
const FULL_REMINDER_EVERY_N_ATTACHMENTS = 5;
function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}
function planModeInstructions(planPath: string, planExists: boolean): string {
  const planFileInfo = planExists
    ? `A plan file already exists at ${planPath}. You can read it and make incremental edits using the Edit tool.`
    : `No plan file exists yet. You should create your plan at ${planPath} using the Write tool.`;
  return `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.
## Plan File Info:
${planFileInfo}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.
## Plan Workflow
### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the Explore subagent type.
1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.
2. **Launch up to 3 Explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns
### Phase 2: Design
Goal: Design an implementation approach.
Launch Plan agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.
You can launch up to 1 agent(s) in parallel.
**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)
In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan
### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use AskUserQuestion to clarify any remaining questions with the user
### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Begin with a **Context** section: explain why this change is being made — the problem or need it addresses, what prompted it, and the intended outcome
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)
### Phase 5: Call ExitPlanMode
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ExitPlanMode to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode. Do not stop unless it's for these 2 reasons
**Important:** Use AskUserQuestion ONLY to clarify requirements or choose between approaches. Use ExitPlanMode to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ExitPlanMode.
NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the AskUserQuestion tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`;
}
function planModeSparseInstructions(planPath: string): string {
  return `Plan mode still active (see full instructions earlier in conversation). Read-only except plan file (${planPath}). Follow 5-phase workflow. End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). Never ask about plan approval via text or AskUserQuestion.`;
}
function planModeReentryInstructions(planPath: string): string {
  return `## Re-entering Plan Mode
You are returning to plan mode after having previously exited it. A plan file exists at ${planPath} from your previous planning session.
**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task—even if it's similar or related—start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections
4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ExitPlanMode
Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`;
}
const AUTO_MODE_INSTRUCTIONS_FULL = `## Auto Mode Active
Auto mode is active. The user chose continuous, autonomous execution. You should:
1. **Execute immediately** — Start implementing right away. Make reasonable assumptions and proceed on low-risk work.
2. **Minimize interruptions** — Prefer making reasonable assumptions over asking questions for routine decisions.
3. **Prefer action over planning** — Do not enter plan mode unless the user explicitly asks. When in doubt, start coding.
4. **Expect course corrections** — The user may provide suggestions or course corrections at any point; treat those as normal input.
5. **Do not take overly destructive actions** — Auto mode is not a license to destroy. Anything that deletes data or modifies shared or production systems still needs explicit user confirmation. If you reach such a decision point, ask and wait, or course correct to a safer method instead.
6. **Avoid data exfiltration** — Post even routine messages to chat platforms or work tickets only if the user has directed you to. You must not share secrets (e.g. credentials, internal documentation) unless the user has explicitly authorized both that specific secret and its destination.`;
const AUTO_MODE_INSTRUCTIONS_SPARSE = `Auto mode still active (see full instructions earlier in conversation). Execute autonomously, minimize interruptions, prefer action over planning.`;
interface ExtensionState {
  ctx: ReturnType<typeof buildContext>;
  planModeAttachmentCount: number;
  /** Counts auto-mode attachments since session start — drives the
   *  full/sparse reminder cadence. Reset to 0 on session_start. */
  autoModeAttachmentCount: number;
  /** Latched flag: after exiting plan mode, the next turn should inject the
   *  exit-attachment (`permission-modes:plan-mode-exit`). */
  needsPlanModeExitAttachment: boolean;
  /** Latched flag: set whenever the session leaves plan mode; cleared the
   *  first time a subsequent `EnterPlanMode` re-enters with a plan file on
   *  disk, in which case the one-time `plan_mode_reentry` attachment is
   *  injected. 
  hasExitedPlanMode: boolean;
  gitBranch: string;
  modelProfileConfig: Record<string, unknown> | null;
  activeProfile: string | undefined;
  /** Session-original cwd, captured on first session_start. Used by the
   *  acceptEdits bash fast-path so writes to the project directory
   *  remain auto-allowed even after the agent has `cd`'d elsewhere.
   *  Falls back to `process.cwd()` if no session has started yet
   *  (e.g. tests calling the gate before session_start). */
  originalCwd: string;
}
function emptyState(): ExtensionState {
  return {
    ctx: buildContext("default"),
    planModeAttachmentCount: 0,
    autoModeAttachmentCount: 0,
    needsPlanModeExitAttachment: false,
    hasExitedPlanMode: false,
    gitBranch: "",
    modelProfileConfig: null,
    activeProfile: undefined,
    originalCwd: process.cwd(),
  };
}
function cycleFromMode(
  current: PermissionMode,
  isBypassAvailable: boolean,
): PermissionMode {
  return getNextPermissionMode(
    buildContext(current, [], { isBypassPermissionsModeAvailable: isBypassAvailable }),
  );
}
function resolveAutoModeConfigPath(): string {
  return resolvePermissionModesConfigPath();
}
/** Local patch: `planMode.agentCanEnter: false` keeps plan mode user-only. The
 *  model-callable `EnterPlanMode` tool is not registered, so the agent cannot even
 *  ask to switch; `/plan`, `/mode plan` and Shift+Tab still work. Default true
 *  (upstream behavior) when the file, block or field is missing or invalid. */
export function loadAgentCanEnterPlanModeConfig(configPath: string): boolean {
  if (!existsSync(configPath)) return true;
  try {
    const raw = JSON.parse(stripJsonCommentsForConfig(readFileSync(configPath, "utf-8")));
    const block = (raw as Record<string, unknown> | null)?.planMode;
    if (!block || typeof block !== "object") return true;
    return (block as Record<string, unknown>).agentCanEnter !== false;
  } catch {
    return true;
  }
}
export function loadSubagentModeConfig(
  configPath: string,
): PermissionMode | undefined {
  if (!existsSync(configPath)) return undefined;
  let raw: unknown;
  try {
    const text = readFileSync(configPath, "utf-8");
    raw = JSON.parse(stripJsonCommentsForConfig(text));
  } catch {
    return undefined;
  }
  const block = (raw as Record<string, unknown> | null)?.subagent;
  if (!block || typeof block !== "object") return undefined;
  const mode = (block as Record<string, unknown>).mode;
  if (
    mode === "default" ||
    mode === "acceptEdits" ||
    mode === "bypassPermissions" ||
    mode === "auto"
  ) {
    return mode;
  }
  return undefined;
}
/** Minimal `//` and block-comment JSON stripper shared by config loaders.
 *  (auto-mode-config.ts keeps its own private copy; this one is exported for
 *  the subagent-mode loader so the two loaders stay independent.) */
function stripJsonCommentsForConfig(input: string): string {
  let output = "";
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    const next = input[i + 1] ?? "";
    if (char === "/" && next === "/") {
      const newline = input.indexOf("\n", i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = input.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const seg = consumeConfigString(input, i, char);
      output += seg.output;
      i = seg.nextIndex;
      continue;
    }
    output += char;
    i++;
  }
  return output;
}
interface ConfigScanSegment {
  output: string;
  nextIndex: number;
}
function consumeConfigString(
  input: string,
  start: number,
  quote: string,
): ConfigScanSegment {
  let out = quote;
  let i = start + 1;
  let escaped = false;
  while (i < input.length) {
    const c = input[i];
    out += c;
    i++;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === quote) break;
  }
  return { output: out, nextIndex: i };
}
function ensureAutoModeLogSink(
  logPath: string | undefined,
): ((line: string) => void) | undefined {
  if (!logPath) return undefined;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    return undefined;
  }
  return (line: string) => {
    try {
      appendFileSync(logPath, line + "\n", "utf-8");
    } catch {
    }
  };
}
function initializeAutoMode(): void {
  if (getAutoMode()) return;
  const resolvedConfigPath = resolveAutoModeConfigPath();
  const configPath = process.env.PICC_PERMISSION_MODES_CONFIG_PATH
    ? resolvedConfigPath
    : ensurePermissionModesConfig(resolvedConfigPath);
  const { config, issues } = loadAutoModeConfig(configPath);
  for (const issue of issues) {
    console.warn(`picc-permission-modes auto-mode: ${issue}`);
  }
  const logSink = ensureAutoModeLogSink(config.logPath);
  const orchestrator = new AutoMode({ config, ...(logSink ? { logSink } : {}) });
  setAutoMode(orchestrator);
}
let interactiveMode: PermissionMode | undefined;
export function setInteractiveModeForTests(mode: PermissionMode | undefined): void {
  interactiveMode = mode;
}
export default function permissionModesExtension(pi: ExtensionAPI): void {
  initializeAutoMode();
  const resolvedConfigPath = resolveAutoModeConfigPath();
  const permissionModesConfigPath = process.env.PICC_PERMISSION_MODES_CONFIG_PATH
    ? resolvedConfigPath
    : ensurePermissionModesConfig(resolvedConfigPath);
  const subagentModeOverride = loadSubagentModeConfig(permissionModesConfigPath);
  const agentCanEnterPlanMode = loadAgentCanEnterPlanModeConfig(permissionModesConfigPath);
  const state = emptyState();
  const userPermissions = loadUserPermissions();
  function applyUserPermissions(
    ctx: ReturnType<typeof emptyState>["ctx"],
  ): void {
    if (userPermissions.source === "none") return;
    if (userPermissions.allow.length > 0) {
      ctx.alwaysAllowRules.userSettings = [...userPermissions.allow];
    }
    if (userPermissions.deny.length > 0) {
      ctx.alwaysDenyRules.userSettings = [...userPermissions.deny];
    }
    if (userPermissions.ask.length > 0) {
      ctx.alwaysAskRules.userSettings = [...userPermissions.ask];
    }
  }
  applyUserPermissions(state.ctx);
  function applyRepoPermissions(cwd: string): void {
    const repoPerms = loadRepoPermissions(cwd);
    if (repoPerms.source === "none") return;
    if (repoPerms.allow.length > 0) {
      state.ctx.alwaysAllowRules.localSettings = [...repoPerms.allow];
    }
    if (repoPerms.deny.length > 0) {
      state.ctx.alwaysDenyRules.localSettings = [...repoPerms.deny];
    }
    if (repoPerms.ask.length > 0) {
      state.ctx.alwaysAskRules.localSettings = [...repoPerms.ask];
    }
  }
  let currentMode: PermissionMode = "default";
  // Headless / SDK hosts (e.g. picc-claude-shim driven by T3) build their pi
  // session via `createAgentSession` directly and never call `bindExtensions`,
  // so pi never fires `session_start` for them. That means `applyFlagOverride`
  // (which runs on session_start) never runs and this gate would stay on
  // "default" — auto-rejecting every non-allow tool call even when the host
  // selected "Full access". The shim hands the host-selected mode in via the
  // `PICC_PERMISSION_MODE` env var (set before extensions register), so apply
  // it here. `session_start` still runs `applyFlagOverride` for TUI hosts, so
  // an explicit `--permission-mode` flag there keeps working.
  applyHostModeFromEnv();
  /** Session id of the active session, captured at session_start. Used by
   *  `persistState` to record the session's plan-file slug so `/resume`
   *  reuses the same plan file. */
  let currentSessionId: string = "";
  // Local patch: status-chip colours. Override per mode in the user config
  // (~/.pi/agent/extensions/picc-permission-modes/config.json):
  //   "modeColors": { "bypassPermissions": "#ff5f5f", "plan": "#5fafff", ... }
  // A value may be "#rrggbb" or a pi theme colour name ("error", "accent", ...);
  // set "default" to a colour to also show a chip in default mode.
  const DEFAULT_MODE_COLORS: Record<PermissionMode, string | null> = {
    default: null,
    acceptEdits: "#ccb1ff",
    plan: "#5fafff",
    bypassPermissions: "#ff5f5f",
    auto: "#ffc107",
  };
  function loadModeColors(): Record<PermissionMode, string | null> {
    try {
      const raw = JSON.parse(readFileSync(resolvePermissionModesConfigPath(), "utf-8"));
      const user = raw?.modeColors;
      if (user && typeof user === "object") return { ...DEFAULT_MODE_COLORS, ...user };
    } catch {
    }
    return DEFAULT_MODE_COLORS;
  }
  function paintModeText(theme: any, color: string, text: string): string {
    const hex = /^#?([0-9a-f]{6})$/i.exec(color);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return `\u001b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}\u001b[39m`;
    }
    try {
      return theme ? theme.fg(color, text) : text;
    } catch {
      return text;
    }
  }
  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      const color = loadModeColors()[currentMode];
      if (!color) {
        ctx.ui.setStatus("permission-mode", undefined);
        return;
      }
      const meta = MODE_META[currentMode];
      const text = meta.symbol
        ? `${meta.symbol} ${meta.title.toLowerCase()}`
        : meta.title.toLowerCase();
      ctx.ui.setStatus("permission-mode", paintModeText((ctx.ui as any).theme, color, text));
    } catch {
    }
  }
  function persistState(): void {
    const entry: ModesPersistedEntry = {
      mode: currentMode,
      additionalWorkingDirectories: [...state.ctx.additionalWorkingDirectories.entries()],
      alwaysAllowRules: state.ctx.alwaysAllowRules,
      alwaysDenyRules: state.ctx.alwaysDenyRules,
      alwaysAskRules: state.ctx.alwaysAskRules,
      isBypassPermissionsModeAvailable: state.ctx.isBypassPermissionsModeAvailable,
      ...(state.ctx.prePlanMode !== undefined
        ? { prePlanMode: state.ctx.prePlanMode }
        : {}),
      ...(state.ctx.shouldAvoidPermissionPrompts !== undefined
        ? { shouldAvoidPermissionPrompts: state.ctx.shouldAvoidPermissionPrompts }
        : {}),
      planModeAttachmentCount: state.planModeAttachmentCount,
      ...(currentMode === "plan" && currentSessionId
        ? { planSlug: getPlanSlug(currentSessionId) }
        : {}),
    };
    try {
      pi.appendEntry("modes", entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("stale after session replacement")) {
        console.error("[picc-permission-modes] persistState appendEntry failed:", err);
      }
    }
  }
  function restoreState(ctx: ExtensionContext): void {
    try {
      const branchEntries = ctx.sessionManager.getBranch();
      const last = [...branchEntries]
        .reverse()
        .find(
          (e: any) => e?.type === "custom" && e?.customType === "modes",
        );
      if (!last?.data) return;
      const data = last.data as ModesPersistedEntry;
      const mode = data.mode;
      if (
        mode === "default" ||
        mode === "acceptEdits" ||
        mode === "plan" ||
        mode === "bypassPermissions" ||
        mode === "auto"
      ) {
        currentMode = mode;
      }
      publishMode(ctx);
      const map = new Map<string, { path: string; source: any }>();
      for (const [p, meta] of data.additionalWorkingDirectories ?? []) {
        map.set(p, meta);
      }
      state.ctx = {
        mode: currentMode,
        additionalWorkingDirectories: map,
        alwaysAllowRules: data.alwaysAllowRules ?? {},
        alwaysDenyRules: data.alwaysDenyRules ?? {},
        alwaysAskRules: data.alwaysAskRules ?? {},
        isBypassPermissionsModeAvailable: data.isBypassPermissionsModeAvailable ?? true,
        ...(data.prePlanMode !== undefined ? { prePlanMode: data.prePlanMode } : {}),
      };
      applyUserPermissions(state.ctx);
      state.planModeAttachmentCount = data.planModeAttachmentCount ?? 0;
      if (data.planSlug) {
        setPlanSlug(ctx.sessionManager.getSessionId(), data.planSlug);
      }
    } catch {
    }
  }
  async function setMode(
    next: PermissionMode,
    ctx: ExtensionContext,
    opts: { fromPlan?: boolean; prePlanMode?: PermissionMode } = {},
  ): Promise<void> {
    const previous = currentMode;
    currentMode = next;
    publishMode(ctx);
    state.ctx = applyPermissionUpdate(state.ctx, {
      type: "setMode",
      destination: "session",
      mode: next,
    });
    if (opts.prePlanMode !== undefined) {
      state.ctx = { ...state.ctx, prePlanMode: opts.prePlanMode };
    } else if (previous !== "plan" && next !== "plan") {
      const { prePlanMode: _, ...rest } = state.ctx;
      state.ctx = rest as typeof state.ctx;
    }
    if (previous === "plan" && next !== "plan") {
      state.needsPlanModeExitAttachment = true;
      state.hasExitedPlanMode = true;
    }
    pendingClassifierDecisions.clear();
    updateStatus(ctx);
    persistState();
  }
  function cycleMode(ctx: ExtensionContext): void {
    const next = cycleFromMode(currentMode, state.ctx.isBypassPermissionsModeAvailable);
    void setMode(next, ctx);
  }
  for (const m of [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "auto",
  ] as PermissionMode[]) {
    pi.registerCommand(m, {
      description: `Switch to ${MODE_META[m].title} mode`,
      handler: async (_args, ctx) => setMode(m, ctx),
    });
  }
  pi.registerCommand("mode", {
    description:
      "Show or set the permission mode (default | acceptEdits | plan | bypassPermissions | auto)",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (!arg) {
        if (!ctx.hasUI) return;
        const choice = await ctx.ui.select(
          "Select permission mode:",
          ["default", "acceptEdits", "plan", "bypassPermissions", "auto"].map(
            modeMetaTitle,
          ),
        );
        const picked = (
          [
            "default",
            "acceptEdits",
            "plan",
            "bypassPermissions",
            "auto",
          ] as PermissionMode[]
        ).find((m) => modeMetaTitle(m) === choice);
        if (picked) await setMode(picked, ctx);
        return;
      }
      const map: Record<string, PermissionMode> = {
        default: "default",
        accept: "acceptEdits",
        acceptedits: "acceptEdits",
        "accept-edits": "acceptEdits",
        plan: "plan",
        bypass: "bypassPermissions",
        bypasspermissions: "bypassPermissions",
        "bypass-permissions": "bypassPermissions",
        auto: "auto",
        ask: "default",
      };
      const resolved = map[arg];
      if (resolved) await setMode(resolved, ctx);
      else if (ctx.hasUI) ctx.ui.notify(`Unknown mode: ${arg}`, "error");
    },
  });
  pi.registerShortcut("shift+tab", {
    description: "Cycle permission mode",
    handler: async (ctx) => cycleMode(ctx),
  });
  pi.registerFlag("permission-mode", {
    description:
      "Start in a permission mode: default, acceptEdits, plan, bypassPermissions (or 'auto')",
    type: "string",
  });
  if (agentCanEnterPlanMode) pi.registerTool(
    makeEnterPlanModeTool({
      onEnterPlanMode: async (ctx) => {
        const previous = currentMode;
        state.ctx = {
          ...state.ctx,
          prePlanMode: previous,
        };
        await setMode("plan", ctx, {});
        // before_agent_start has already run when entry happens mid-turn.
        // Return the exact path and full workflow now, not on the next prompt.
        const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
        return wrapInSystemReminder(planModeInstructions(planPath, existsSync(planPath)));
      },
      onDeclinePlanMode: () => {},
    }),
  );
  function publishMode(ctx: ExtensionContext): void {
    if (ctx.hasUI) interactiveMode = currentMode;
  }
  function resolveSubagentMode(): PermissionMode {
    if (subagentModeOverride) return subagentModeOverride;
    const parent = interactiveMode;
    if (
      parent === "bypassPermissions" ||
      parent === "acceptEdits" ||
      parent === "auto"
    ) {
      return parent;
    }
    return "default";
  }
  function gateContext(callCtx: ExtensionContext): ReturnType<typeof buildContext> {
    if (callCtx.hasUI) return state.ctx;
    if (state.ctx.shouldAvoidPermissionPrompts) return state.ctx;
    return { ...state.ctx, shouldAvoidPermissionPrompts: true };
  }
  pi.on("tool_call", async (event, ctx): Promise<{ block: true; reason: string } | undefined> => {
    const tool = event.toolName;
    const input = (event.input ?? {}) as Record<string, unknown>;
    if (tool === "edit" || tool === "write") {
      const target = extractToolPath(input);
      const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
      if (target && resolveToolPath(ctx.cwd, target) === resolve(planPath)) {
        return undefined;
      }
    }
    if (currentMode === "auto") {
      if (tool === "edit" || tool === "write") {
        const target = extractToolPath(input);
        if (
          target !== "" &&
          pathInAllowedWorkingPath(target, state.ctx, ctx.cwd) &&
          !isDangerousFilePath(target)
        ) {
          rememberClassifierDecision(event.toolCallId, {
            kind: "allow",
            via: "safeAllowlist",
          });
          return undefined;
        }
      }
      const preDecision = computeDecision(
        tool,
        input,
        gateContext(ctx),
        "edit",
        ctx.cwd,
      );
      if (preDecision.behavior === "deny") {
        return { block: true, reason: preDecision.message };
      }
      if (preDecision.behavior === "allow") {
        rememberClassifierDecision(event.toolCallId, {
          kind: "allow",
          via: "safeAllowlist",
        });
        return undefined;
      }
      return askAutoClassifier(event.toolCallId, tool, input, ctx);
    }
    if (currentMode === "bypassPermissions") {
      return applyBypassGate(tool, input, ctx);
    }
    const decision = computeDecision(tool, input, gateContext(ctx), "edit", ctx.cwd);
    if (decision.behavior === "allow") return undefined;
    if (decision.behavior === "deny") {
      return { block: true, reason: decision.message };
    }
    if (currentMode === "plan") {
      return askAutoClassifier(event.toolCallId, tool, input, ctx);
    }
    return askUserPermission(decision, tool, input, ctx);
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "EnterPlanMode") {
      const details = (event as { details?: { entered?: boolean } }).details;
      if (details?.entered === true && state.hasExitedPlanMode) {
        const sessionId = ctx.sessionManager.getSessionId();
        const planPath = getPlanFilePath(sessionId);
        if (existsSync(planPath)) {
          state.hasExitedPlanMode = false;
          pi.sendMessage({
            customType: "permission-modes:plan-mode-reentry",
            content: wrapInSystemReminder(planModeReentryInstructions(planPath)),
            display: false,
          });
        }
      }
    }
    if (currentMode !== "auto" && currentMode !== "plan") return;
    const decision = takeClassifierDecision(event.toolCallId);
    if (!decision) return;
    if (decision.kind === "allow") {
      event.content.push({ type: "text", text: CLASSIFIER_NOTE_MARKER });
      return { content: event.content, isError: event.isError };
    }
    if (decision.via === "classify") {
      pi.sendMessage({
        customType: "permission-modes:auto-classifier-decision",
        content: "Denied by auto mode classifier · /feedback if incorrect",
        display: true,
        details: {
          toolCallId: event.toolCallId,
          kind: "block",
          via: decision.via,
          reason: decision.reason,
        },
      });
    }
  });
  pi.registerMessageRenderer(
    "permission-modes:auto-classifier-decision",
    (message, _options, theme) => {
      const styled = (() => {
        try {
          return theme.fg("dim", message.content);
        } catch {
          return message.content;
        }
      })();
      return new Text(styled, 0, 0);
    },
  );
  pi.on("context", (event) => {
    const messages = event.messages;
    let changed = false;
    const next = messages.map((msg) => {
      if ((msg as { role?: string }).role !== "toolResult") return msg;
      const toolResult = msg as {
        content: Array<{ type: string; text?: unknown }>;
      };
      if (!Array.isArray(toolResult.content)) return msg;
      let changedHere = false;
      const content = toolResult.content.map((block) => {
        if (block.type !== "text" || typeof block.text !== "string") {
          return block as { type: string; text?: string };
        }
        const idx = block.text.indexOf(CLASSIFIER_NOTE_MARKER);
        if (idx === -1) return block;
        changedHere = true;
        let text =
          block.text.slice(0, idx) +
          block.text.slice(idx + CLASSIFIER_NOTE_MARKER.length);
        text = text.replace(/\n{3,}/g, "\n\n");
        return { type: "text", text: text.trim() };
      });
      if (!changedHere) return msg;
      changed = true;
      return { ...toolResult, content } as (typeof messages)[number];
    });
    return changed ? { messages: next } : undefined;
  });
  function computeDecision(
    tool: string,
    input: Record<string, unknown>,
    ctx: ReturnType<typeof buildContext>,
    operationType: "read" | "edit",
    cwd: string = process.cwd(),
  ): PermissionResult {
    if (tool === "bash") {
      const cmd = String(input.command ?? "");
      const isReadOnly = isBashCommandReadOnly(cmd);
      const denyRule = matchingBashRule(cmd, "deny", ctx);
      if (denyRule) {
        return {
          behavior: "deny",
          message: `Permission to run bash command has been denied.\n  ${cmd}`,
          decisionReason: { type: "rule", rule: denyRule },
        };
      }
      const sedGate = checkSedConstraints(cmd, {
        allowFileWrites: currentMode === "acceptEdits",
      });
      if (sedGate.behavior === "ask") {
        return {
          behavior: "ask",
          message: sedGate.message,
          decisionReason: sedGate.decisionReason,
          suggestions: [],
        };
      }
      const writeBashPaths = extractBashPaths(cmd,  true);
      for (const p of writeBashPaths) {
        if (p && p !== "." && isDangerousFilePath(p)) {
          return {
            behavior: "ask",
            message: `Bash command targets a sensitive file: ${p}. This is a safety check (D4) and must be approved manually.`,
            decisionReason: {
              type: "safetyCheck",
              reason: "sensitive path",
              classifierApprovable: true,
            },
            suggestions: [],
          };
        }
      }
      const pathCheck = checkPathConstraints(
        { command: cmd },
        state.originalCwd,
        ctx,
        commandHasAnyCd(cmd),
      );
      if (pathCheck.behavior === "deny") {
        return {
          behavior: "deny",
          message: pathCheck.message,
          decisionReason: pathCheck.decisionReason,
        };
      }
      if (pathCheck.behavior === "ask") {
        return {
          behavior: "ask",
          message: pathCheck.message,
          blockedPath: pathCheck.blockedPath,
          decisionReason: pathCheck.decisionReason,
          suggestions: pathCheck.suggestions ?? [],
        };
      }
      if (currentMode === "acceptEdits") {
        if (isReadOnly) {
          return {
            behavior: "allow",
            decisionReason: { type: "mode", mode: "acceptEdits" },
          };
        }
        if (isAcceptEditsBashCommand(cmd, ctx, state.originalCwd)) {
          return {
            behavior: "allow",
            decisionReason: { type: "mode", mode: "acceptEdits" },
          };
        }
      }
      if (isReadOnly) {
        return {
          behavior: "allow",
          decisionReason: { type: "other", reason: "read-only command" },
        };
      }
      const askRule = matchingBashRule(cmd, "ask", ctx);
      if (askRule) {
        return {
          behavior: "ask",
          message: `Allow bash command?\n  ${cmd}`,
          decisionReason: { type: "rule", rule: askRule },
          suggestions: [],
        };
      }
      const allowRule = matchingBashRule(cmd, "allow", ctx);
      if (allowRule) {
        return {
          behavior: "allow",
          decisionReason: { type: "rule", rule: allowRule },
        };
      }
      if (ctx.shouldAvoidPermissionPrompts) {
        return {
          behavior: "deny",
          message: autoRejectMessage(tool),
          decisionReason: {
            type: "asyncAgent",
            reason: "Permission prompts are not available in this context",
          },
        };
      }
      const targetPath = extractBashPath(cmd);
      if (targetPath && /[\\/]/.test(targetPath)) {
        return operationType === "read"
          ? checkReadPermissionForTool(tool, targetPath, ctx, cwd)
          : checkWritePermissionForTool(tool, targetPath, ctx, cwd);
      }
      return {
        behavior: "ask",
        message: `Allow bash command?\n  ${cmd}`,
        decisionReason: { type: "other", reason: "bash command" },
        suggestions: [],
      };
    }
    if (tool === "edit" || tool === "write") {
      const path = extractToolPath(input);
      return checkWritePermissionForTool(tool, path, ctx, cwd);
    }
    if (READ_FAMILY.has(tool.toLowerCase())) {
      const path = extractToolPath(input);
      if (!path) {
        if (currentMode === "plan") {
          return checkReadPermissionForTool(tool, resolve(cwd), ctx, cwd);
        }
        return {
          behavior: "allow",
          decisionReason: {
            type: "other",
            reason: "no explicit path; defaults to cwd",
          },
        };
      }
      return checkReadPermissionForTool(tool, path, ctx, cwd);
    }
    return {
      behavior: "allow",
      decisionReason: { type: "other", reason: "no-path tool" },
    };
  }
  function applyBypassGate(
    tool: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ): { block: true; reason: string } | undefined {
    if (REQUIRES_USER_INTERACTION.has(tool)) return undefined;
    if (tool !== "edit" && tool !== "write" && tool !== "bash") return undefined;
    const decision = computeDecision(tool, input, state.ctx, "edit");
    if (decision.behavior === "allow") return undefined;
    if (decision.behavior === "deny") {
      return { block: true, reason: decision.message };
    }
    if (
      decision.behavior === "ask" &&
      decision.decisionReason?.type === "rule" &&
      decision.decisionReason.rule.ruleBehavior === "ask"
    ) {
      return askUserPermission(decision, tool, input, ctx);
    }
    if (decision.decisionReason?.type === "safetyCheck") {
      return askUserPermission(decision, tool, input, ctx);
    }
    return undefined;
  }
  async function askAutoClassifier(
    toolCallId: string,
    tool: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (ctx.hasUI) {
      ctx.ui.setStatus?.("auto-mode-classifying", "auto: classifying…");
    }
    const orchestrator = getAutoMode();
    if (!orchestrator) {
      if (ctx.hasUI) ctx.ui.setStatus("auto-mode-classifying", undefined);
      rememberClassifierDecision(toolCallId, {
        kind: "block",
        via: "classify",
        reason: "auto-mode orchestrator not initialized",
      });
      return {
        block: true,
        reason:
          "Auto classifier unavailable (auto-mode orchestrator not initialized). Fail-closed.",
      };
    }
    try {
      const result = await orchestrator.classify({
        toolName: tool,
        input,
        sessionMessages: collectSessionMessages(ctx),
        ctx,
      });
      if (ctx.hasUI) {
        ctx.ui.setStatus("auto-mode-classifying", undefined);
      }
      if (result.unavailable) {
        return askUserPermission(
          {
            behavior: "ask",
            message: `Auto classifier unavailable (${result.reason}); falling back to manual approval.`,
            decisionReason: {
              type: "other",
              reason: "auto-classifier-unavailable",
            },
            suggestions: [],
          },
          tool,
          input,
          ctx,
        );
      }
      if (result.shouldFallbackToPrompt) {
        return askUserPermission(
          {
            behavior: "ask",
            message: "Auto mode fell back to manual approval.",
            decisionReason: {
              type: "other",
              reason: "auto-classifier-denial-limit",
            },
            suggestions: [],
          },
          tool,
          input,
          ctx,
        );
      }
      if (result.block) {
        rememberClassifierDecision(toolCallId, {
          kind: "block",
          via: result.via,
          reason: result.reason ?? "",
        });
        return {
          block: true,
          reason:
            result.reason && result.reason.length > 0
              ? `Auto classifier: ${result.reason}`
              : "Auto classifier: blocked",
        };
      }
      rememberClassifierDecision(toolCallId, {
        kind: "allow",
        via: result.via,
      });
      return undefined;
    } catch (error) {
      if (ctx.hasUI) ctx.ui.setStatus("auto-mode-classifying", undefined);
      const message =
        error instanceof Error ? error.message : String(error);
      rememberClassifierDecision(toolCallId, {
        kind: "block",
        via: "classify",
        reason: `classifier unavailable: ${message}`,
      });
      return {
        block: true,
        reason: `Auto classifier unavailable (${message}). Fail-closed.`,
      };
    }
  }
  function collectSessionMessages(ctx: ExtensionContext): unknown[] {
    try {
      const sm = ctx.sessionManager as unknown as {
        buildSessionContext?: () => { messages: unknown[] };
      };
      if (typeof sm.buildSessionContext === "function") {
        return sm.buildSessionContext().messages ?? [];
      }
    } catch {
    }
    return [];
  }
  async function askUserPermission(
    decision: PermissionResult,
    tool: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (!ctx.hasUI) {
      const reason =
        decision.decisionReason?.type === "asyncAgent"
          ? decision.message
          : `Permission prompts are not available in this context; ${tool} cannot run without UI.`;
      return { block: true, reason };
    }
    const filePath =
      extractToolPath(input) || (decision.blockedPath ?? "");
    let options: string[];
    const isBashPrompt = tool === "bash" && !filePath;
    if (filePath) {
      const isRead =
        tool === "read" || tool === "grep" || tool === "find" || tool === "ls";
      options = getFilePermissionOptions(tool, filePath, state.ctx, isRead ? "read" : "write");
    } else if (isBashPrompt) {
      const base = extractBashBaseCommand(String(input.command ?? ""));
      options = [
        "Yes",
        `Yes, and don't ask again for: ${base} *`,
        "No",
      ];
    } else {
      options = ["Allow", "Block"];
    }
    const bashDescription =
      isBashPrompt && typeof input.description === "string"
        ? input.description
        : undefined;
    const bashCommand = isBashPrompt ? String(input.command ?? "") : undefined;
    const isFileWritePrompt = (tool === "edit" || tool === "write") && filePath !== "";
    let panel:
      | {
          title: string;
          subtitle: string;
          question: string;
          diffLines: DiffLine[];
          previewLines?: string[];
          showPanel: true;
        }
      | undefined;
    if (isFileWritePrompt) {
      const rel = toRelativePath(filePath, ctx.cwd);
      const newString =
        tool === "write"
          ? typeof input.content === "string"
            ? input.content
            : ""
          : typeof input.new_string === "string"
            ? input.new_string
            : "";
      if (tool === "write") {
        panel = {
          title: "Create file",
          subtitle: rel,
          question: `Do you want to create this file: ${rel}?`,
          diffLines: [],
          previewLines: newString.split("\n"),
          showPanel: true,
        };
      } else {
        const oldString =
          typeof input.old_string === "string" ? input.old_string : "";
        const diffLines = buildEditDiff(filePath, oldString, newString, ctx.cwd);
        panel = {
          title: "Edit file",
          subtitle: rel,
          question: `Do you want to make this edit to ${rel}?`,
          diffLines: diffLines ?? [],
          showPanel: true,
        };
      }
    }
    const choice = await ctx.ui.custom<FilePermissionChoice>(
      createFilePermissionDialogFactory({
        message: decision.message,
        description: bashDescription,
        options,
        ...(panel ?? {}),
        ...(isBashPrompt
          ? {
              showBashPanel: true,
              command: bashCommand ?? "",
              question: "Do you want to proceed?",
              ...(decision.message &&
              !decision.message.startsWith("Allow bash command?")
                ? { note: decision.message }
                : {}),
            }
          : {}),
      }),
      {
        overlay: true,
        overlayOptions: { anchor: "bottom-center", width: "100%" },
      },
    );
    if (!choice) return { block: true, reason: "user dismissed dialog" };
    if (choice === "Allow" || choice === "Yes") return undefined;
    if (isBashPrompt && choice.startsWith("Yes, and don't ask again for: ")) {
      const ruleContent = choice
        .slice("Yes, and don't ask again for: ".length)
        .trim();
      if (ruleContent.length > 0) {
        state.ctx = applyPermissionUpdate(state.ctx, {
          type: "addRules",
          destination: "localSettings",
          behavior: "allow",
          rules: [
            {
              toolName: "Bash",
              ruleContent,
            },
          ],
        });
        addRepoPermissionRule(state.originalCwd, "allow", `Bash(${ruleContent})`);
        persistState();
      }
      return undefined;
    }
    if (
      choice.includes("allow all") ||
      choice.includes("during this session")
    ) {
      const suggestions =
        decision.suggestions ?? generateSuggestions(tool, filePath, state.ctx);
      state.ctx = applyPermissionUpdates(state.ctx, suggestions);
      if (currentMode === "default" || currentMode === "plan") {
        await setMode("acceptEdits", ctx);
      } else {
        persistState();
      }
      const redecide = computeDecision(tool, input, state.ctx, "edit");
      if (redecide.behavior === "allow") return undefined;
      return undefined;
    }
    return { block: true, reason: decision.message ?? `${tool} blocked by user` };
  }
  function extractBashPath(cmd: string): string {
    return extractFirstBashPath(cmd);
  }
  function extractBashBaseCommand(cmd: string): string {
    const trimmed = cmd.trim();
    if (!trimmed) return "";
    const PRECOMMANDS = new Set(["command", "builtin", "noglob", "nocorrect"]);
    const tokens = trimmed.split(/\s+/);
    for (const token of tokens) {
      if (!token) continue;
      if (/^[A-Za-z_]\w*=/.test(token)) continue;
      if (PRECOMMANDS.has(token)) continue;
      return token;
    }
    return "";
  }
  async function applyPlanExit(
    next: PermissionMode,
    planText: string,
    ctx: ExtensionContext,
    allowedPrompts?: AllowedPrompt[],
  ): Promise<void> {
    const previous = currentMode;
    await setMode(next, ctx, { prePlanMode: previous });
    state.ctx = applyPermissionUpdate(state.ctx, {
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "Bash", ruleContent: "*" }],
    });
    if (allowedPrompts && allowedPrompts.length > 0) {
      state.ctx = applyPermissionUpdate(state.ctx, {
        type: "addRules",
        destination: "session",
        behavior: "allow",
        rules: allowedPrompts.map((p) => ({
          toolName: "Bash",
          ruleContent: `prompt: ${p.prompt.trim()}`,
        })),
      });
    }
    persistState();
  }
  async function applyPlanRefine(notes: string, _ctx: ExtensionContext): Promise<void> {
    pi.sendUserMessage(
      `Refine the plan based on this feedback:\n\n${notes}`,
      { deliverAs: "followUp" },
    );
  }
  async function readPlanFile(ctx: ExtensionContext): Promise<string> {
    const sessionId = ctx.sessionManager.getSessionId();
    const planPath = getPlanFilePath(sessionId);
    if (!existsSync(planPath)) return "";
    return readFileSync(planPath, "utf-8");
  }
  pi.registerTool(
    makeExitPlanModeTool({
      planText: async (ctx) => readPlanFile(ctx),
      applyExit: async (ctx, { mode, plan, allowedPrompts }) => {
        await applyPlanExit(mode, plan, ctx, allowedPrompts);
      },
      applyRefine: async (ctx, notes) => {
        await applyPlanRefine(notes, ctx);
      },
    }),
  );
  pi.on("before_agent_start", async (event, ctx) => {
    if (currentMode === "auto") {
      state.autoModeAttachmentCount =
        (state.autoModeAttachmentCount ?? 0) + 1;
      const isFull = state.autoModeAttachmentCount <= 1;
      const body = isFull
        ? AUTO_MODE_INSTRUCTIONS_FULL
        : AUTO_MODE_INSTRUCTIONS_SPARSE;
      return {
        message: {
          customType: "permission-modes:auto-mode",
          content: wrapInSystemReminder(body),
          display: false,
        },
      };
    }
    if (currentMode === "plan") {
      state.planModeAttachmentCount++;
      const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
      const isFull = (state.planModeAttachmentCount - 1) % FULL_REMINDER_EVERY_N_ATTACHMENTS === 0;
      const body = isFull
        ? planModeInstructions(planPath, existsSync(planPath))
        : planModeSparseInstructions(planPath);
      return {
        message: {
          customType: "permission-modes:plan-mode",
          content: wrapInSystemReminder(body),
          display: false,
        },
      };
    }
    if (state.needsPlanModeExitAttachment) {
      state.needsPlanModeExitAttachment = false;
      return {
        message: {
          customType: "permission-modes:plan-mode-exit",
          content: wrapInSystemReminder(
            `## Exited Plan Mode\n\nYou have exited plan mode. You can now make edits, run tools, and take actions.`,
          ),
          display: false,
        },
      };
    }
    return undefined;
  });
  // Local patch: do not take over the footer. The permission mode is published
  // as the "permission-mode" status chip (see updateStatus) so that the
  // pi-cc-extensions footer can render it (footerLine2Keys in pi-cc-extensions.json).
  function installFooter(_ctx: ExtensionContext): void {}
  async function onSessionStart(
    event: { reason?: string; previousSessionFile?: string } | undefined,
    ctx: ExtensionContext,
  ): Promise<void> {
    state.originalCwd = ctx.cwd;
    currentSessionId = ctx.sessionManager.getSessionId();
    const reason = event?.reason;
    const previousSessionFile = event?.previousSessionFile;
    if (reason === "resume" || reason === "fork") {
      let restoredFromPrevious = false;
      if (previousSessionFile) {
        restoredFromPrevious = restoreFromSessionFile(previousSessionFile, ctx);
      }
      if (!restoredFromPrevious) {
        restoreState(ctx);
      }
    } else if (reason === "new") {
      state.needsPlanModeExitAttachment = false;
      state.planModeAttachmentCount = 0;
      state.autoModeAttachmentCount = 0;
      state.hasExitedPlanMode = false;
      clearPlanSlugs();
    } else {
      restoreState(ctx);
    }
    applyRepoPermissions(state.originalCwd);
    applyFlagOverride();
    if (!ctx.hasUI) {
      const subMode = resolveSubagentMode();
      if (subMode !== currentMode) {
        currentMode = subMode;
        state.ctx = { ...state.ctx, mode: subMode };
      }
      publishMode(ctx);
    }
    await refreshSessionContext(ctx);
  }
  function restoreFromSessionFile(sessionFile: string, ctx: ExtensionContext): boolean {
    try {
      if (!existsSync(sessionFile)) return false;
      const sm = SessionManager.open(sessionFile, undefined, dirname(dirname(sessionFile)));
      const branch = sm.getBranch() as Array<{ type?: string; customType?: string; data?: any }>;
      const last = [...branch]
        .reverse()
        .find((e) => e?.type === "custom" && e?.customType === "modes");
      if (!last?.data) return false;
      const data = last.data as ModesPersistedEntry;
      const mode = data.mode;
      if (
        mode !== "default" &&
        mode !== "acceptEdits" &&
        mode !== "plan" &&
        mode !== "bypassPermissions" &&
        mode !== "auto"
      ) {
        return false;
      }
      currentMode = mode;
      publishMode(ctx);
      const map = new Map<string, { path: string; source: any }>();
      for (const [p, meta] of data.additionalWorkingDirectories ?? []) {
        map.set(p, meta);
      }
      state.ctx = {
        mode: currentMode,
        additionalWorkingDirectories: map,
        alwaysAllowRules: data.alwaysAllowRules ?? {},
        alwaysDenyRules: data.alwaysDenyRules ?? {},
        alwaysAskRules: data.alwaysAskRules ?? {},
        isBypassPermissionsModeAvailable: data.isBypassPermissionsModeAvailable ?? true,
        ...(data.prePlanMode !== undefined ? { prePlanMode: data.prePlanMode } : {}),
      };
      applyUserPermissions(state.ctx);
      if (data.planSlug && currentSessionId) {
        setPlanSlug(currentSessionId, data.planSlug);
      }
      return true;
    } catch {
      return false;
    }
  }
  async function onSessionTree(
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> {
    await refreshSessionContext(ctx);
  }
  function applyFlagOverride(): void {
    const flag = pi.getFlag("permission-mode");
    if (typeof flag !== "string") return;
    const m: Record<string, PermissionMode> = {
      default: "default",
      acceptEdits: "acceptEdits",
      "accept-edits": "acceptEdits",
      acceptedits: "acceptEdits",
      plan: "plan",
      bypassPermissions: "bypassPermissions",
      "bypass-permissions": "bypassPermissions",
      bypasspermissions: "bypassPermissions",
      bypass: "bypassPermissions",
      auto: "auto",
      ask: "default",
    };
    const resolved = m[flag.toLowerCase()];
    if (resolved && resolved !== currentMode) {
      currentMode = resolved;
      state.ctx = { ...state.ctx, mode: resolved };
      if (resolved !== "plan") {
        state.needsPlanModeExitAttachment = false;
      }
    }
  }
  function applyHostModeFromEnv(): void {
    const raw = process.env.PICC_PERMISSION_MODE;
    if (!raw || raw.trim().length === 0) return;
    const m: Record<string, PermissionMode> = {
      default: "default",
      acceptEdits: "acceptEdits",
      "accept-edits": "acceptEdits",
      acceptedits: "acceptEdits",
      plan: "plan",
      bypassPermissions: "bypassPermissions",
      "bypass-permissions": "bypassPermissions",
      bypasspermissions: "bypassPermissions",
      bypass: "bypassPermissions",
      auto: "auto",
      ask: "default",
      dontAsk: "default",
      "dont-ask": "default",
    };
    const resolved = m[raw.toLowerCase()];
    if (resolved && resolved !== currentMode) {
      currentMode = resolved;
      state.ctx = { ...state.ctx, mode: resolved };
      if (resolved !== "plan") {
        state.needsPlanModeExitAttachment = false;
      }
    }
  }
  async function refreshSessionContext(ctx: ExtensionContext): Promise<void> {
    try {
      state.gitBranch = (ctx.sessionManager as any).getGitBranch?.() ?? "";
    } catch {
    }
    ensurePlansDir();
    if (ctx.hasUI) {
      installFooter(ctx);
      updateStatus(ctx);
    }
    persistState();
  }
  pi.on("session_start", onSessionStart);
  pi.on("session_tree", onSessionTree);
}