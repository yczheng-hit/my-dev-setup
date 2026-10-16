import {
  getAgentDir,
  loadProjectContextFiles,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  AutoModeConfig,
  AutoModeLimits,
  AutoModeProviderConfig,
  ResolvedAutoModeProviderConfig,
} from "./auto-mode-config.ts";
import { isSafeAllowlistedTool } from "./auto-mode-config.ts";
import {
  parseXmlBlock,
  parseXmlReason,
  stage2Suffix,
  buildAutoModeSystemPrompt,
} from "./auto-mode-prompts.ts";
import {
  ClassifierHttpError,
  ClassifierTimeoutError,
  sendClassifierMessage,
  type ClassifierProviderConfig,
} from "./auto-mode-provider.ts";
export interface AutoModeToolCallRequest {
  toolName: string;
  input: Record<string, unknown>;
  sessionMessages: ReadonlyArray<unknown>;
  /** Live pi context — used to resolve the active model when `config.provider`
   *  is partial or absent. The modes extension passes the same ctx it
   *  received in the tool_call handler. */
  ctx?: ExtensionContext;
}
export type AutoModeDecision =
  | { allow: true; reason?: string; via: "safeAllowlist" | "classify" }
  | {
      block: true;
      reason: string;
      via: "classify" | "fallbackPrompt";
      shouldFallbackToPrompt: boolean;
    }
  | {
      unavailable: true;
      reason: string;
    };
export interface AutoModeDeps {
  /** Long-lived config; orchestrator reads `provider` (partial override),
   *  rule lists, and limits off this. */
  config: AutoModeConfig;
  sendFn?: typeof sendClassifierMessage;
  /** Optional decision log sink. The local extension wires this to
   *  `appendFileSync(config.logPath, line + "\n")`. */
  logSink?: (line: string) => void;
}
const instructionCache = new Map<string, string>();
export class AutoMode {
  private consecutiveDenials = 0;
  private totalDenials = 0;
  private totalCalls = 0;
  constructor(private readonly deps: AutoModeDeps) {
  }
  /** Per-session reset hooks (used by the orchestrator to zero counters
   *  when the user resumes a fresh session). */
  resetCounters(): void {
    this.consecutiveDenials = 0;
    this.totalDenials = 0;
    this.totalCalls = 0;
  }
  counters(): { consecutive: number; total: number; calls: number } {
    return {
      consecutive: this.consecutiveDenials,
      total: this.totalDenials,
      calls: this.totalCalls,
    };
  }
  async classify(req: AutoModeToolCallRequest): Promise<AutoModeDecision> {
    this.totalCalls++;
    const cfg = this.deps.config;
    if (isSafeAllowlistedTool(req.toolName, cfg.safeToolAllowlist)) {
      this.recordSuccess();
      return {
        allow: true,
        via: "safeAllowlist",
      };
    }
    let resolvedCfg: ResolvedAutoModeProviderConfig | null = null;
    try {
      resolvedCfg = await resolveProviderConfig(cfg.provider, req.ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.unavailable(`provider resolution failed: ${message}`);
    }
    if (!resolvedCfg) {
      return this.unavailable(
        "Classifier provider unconfigured (no active pi model and no provider block in config.json#autoMode).",
      );
    }
    let decision: Exclude<AutoModeDecision, { unavailable: true }>;
    try {
      decision = await runClassifier(
        req,
        cfg,
        resolvedCfg,
        this.deps.sendFn ?? sendClassifierMessage,
      );
    } catch (error) {
      return this.unavailable(classifierErrorReason(error));
    }
    if (decision.block) {
      this.recordDenial();
      this.log({
        tool: req.toolName,
        decision: "block",
        via: decision.via,
        reason: decision.reason,
      });
      if (this.exceedsLimit(cfg.denialLimits)) {
        if (this.totalDenials >= cfg.denialLimits.maxTotal) {
          this.totalDenials = 0;
        }
        return {
          block: true,
          via: "fallbackPrompt",
          shouldFallbackToPrompt: true,
          reason: `${decision.reason} (auto mode denial limit reached — ${this.denialLimitSummary(cfg.denialLimits)})`,
        };
      }
    } else {
      this.recordSuccess();
      this.log({
        tool: req.toolName,
        decision: "allow",
        via: decision.via,
        reason: decision.reason,
      });
    }
    return decision;
  }
  private unavailable(reason: string): AutoModeDecision {
    this.log({ tool: "*", decision: "unavailable", via: "unavailable", reason });
    return { unavailable: true, reason };
  }
  private recordDenial(): void {
    this.consecutiveDenials++;
    this.totalDenials++;
  }
  private recordSuccess(): void {
    this.consecutiveDenials = 0;
  }
  private exceedsLimit(limits: AutoModeLimits): boolean {
    return (
      this.consecutiveDenials >= limits.maxConsecutive ||
      this.totalDenials >= limits.maxTotal
    );
  }
  private denialLimitSummary(limits: AutoModeLimits): string {
    const parts: string[] = [];
    if (this.consecutiveDenials >= limits.maxConsecutive) {
      parts.push(`${this.consecutiveDenials}/${limits.maxConsecutive} consecutive`);
    }
    if (this.totalDenials >= limits.maxTotal) {
      parts.push(`${this.totalDenials}/${limits.maxTotal} total`);
    }
    return parts.join(", ") || "denied";
  }
  private log(entry: {
    tool: string;
    decision: "allow" | "block" | "unavailable";
    via: string;
    reason?: string;
  }): void {
    const sink = this.deps.logSink;
    if (!sink) return;
    const record = {
      ts: new Date().toISOString(),
      sessionCall: this.totalCalls,
      consecutiveDenials: this.consecutiveDenials,
      totalDenials: this.totalDenials,
      ...entry,
    };
    try {
      sink(JSON.stringify(record));
    } catch {
    }
  }
}
let singleton: AutoMode | null = null;
export function setAutoMode(instance: AutoMode): void {
  if (singleton && singleton !== instance) {
    throw new Error(
      "AutoMode: orchestrator already registered. Refusing to swap instances.",
    );
  }
  singleton = instance;
}
export function getAutoMode(): AutoMode | null {
  return singleton;
}
export function resetAutoMode(): void {
  if (singleton) singleton.resetCounters();
  singleton = null;
}
async function runClassifier(
  req: AutoModeToolCallRequest,
  cfg: AutoModeConfig,
  resolvedProvider: ResolvedAutoModeProviderConfig,
  sendFn: typeof sendClassifierMessage,
): Promise<Exclude<AutoModeDecision, { unavailable: true }>> {
  const rules = {
    allow: cfg.allow,
    softDeny: cfg.softDeny,
    hardDeny: cfg.hardDeny,
    environment: cfg.environment,
  };
  const system = buildAutoModeSystemPrompt(rules, "xml") + stage2Suffix();
  const userText = buildUserMessage(req, cfg, resolvedProvider);
  const res = await sendFn(buildProvider(resolvedProvider), {
    model: resolvedProvider.model,
    system,
    user: userText,
    maxTokens: 4096,
    stopSequences: ["</block>"],
  });
  return decisionFromXmlResponse(res);
}
function decisionFromXmlResponse(res: {
  text?: string;
  toolInput?: unknown;
}): Exclude<AutoModeDecision, { unavailable: true }> {
  if (res.toolInput) {
    return decisionFromToolInput(res.toolInput);
  }
  const text = (res.text ?? "").trim();
  if (text.length === 0) {
    return {
      block: true,
      reason: "Classifier returned no parseable response",
      via: "classify",
      shouldFallbackToPrompt: false,
    };
  }
  const block = parseXmlBlock(text);
  const reason =
    parseXmlReason(text) ?? "Classifier returned no reason";
  if (block === false) {
    return { allow: true, via: "classify" };
  }
  if (block === true) {
    return {
      block: true,
      reason,
      via: "classify",
      shouldFallbackToPrompt: false,
    };
  }
  return {
    block: true,
    reason: `Classifier returned no parseable response (${reason})`,
    via: "classify",
    shouldFallbackToPrompt: false,
  };
}
function decisionFromToolInput(input: unknown): Exclude<
  AutoModeDecision,
  { unavailable: true }
> {
  if (!input || typeof input !== "object") {
    return {
      block: true,
      reason: "Classifier returned non-object tool input",
      via: "classify",
      shouldFallbackToPrompt: false,
    };
  }
  const obj = input as Record<string, unknown>;
  const shouldBlock = obj.shouldBlock;
  const reason =
    typeof obj.reason === "string" && obj.reason.trim().length > 0
      ? obj.reason.trim()
      : undefined;
  if (shouldBlock === true) {
    return {
      block: true,
      reason: reason ?? "Classifier blocked the action",
      via: "classify",
      shouldFallbackToPrompt: false,
    };
  }
  if (shouldBlock === false) {
    return { allow: true, via: "classify", ...(reason ? { reason } : {}) };
  }
  return {
    block: true,
    reason: reason ?? "Classifier returned invalid tool input",
    via: "classify",
    shouldFallbackToPrompt: false,
  };
}
function buildProvider(
  resolved: ResolvedAutoModeProviderConfig,
): ClassifierProviderConfig {
  return {
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    anthropicVersion: resolved.anthropicVersion,
    ...(Object.keys(resolved.extraHeaders).length > 0
      ? { extraHeaders: resolved.extraHeaders }
      : {}),
  };
}
async function resolveProviderConfig(
  partial: AutoModeProviderConfig | undefined,
  ctx: ExtensionContext | undefined,
): Promise<ResolvedAutoModeProviderConfig | null> {
  let baseUrl = partial?.baseUrl;
  let model: string | undefined = partial?.model;
  let apiKey = partial?.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN;
  let anthropicVersion = partial?.anthropicVersion ?? "2023-06-01";
  const extraHeaders: Record<string, string> = {
    ...(partial?.extraHeaders ?? {}),
  };
  if (ctx) {
    const active = ctx.model;
    if (active) {
      const modelAny = active as unknown as { baseUrl?: string; id?: string };
      if (!baseUrl && typeof modelAny.baseUrl === "string") {
        baseUrl = modelAny.baseUrl;
      }
      if (!model) {
        model =
          (modelAny as unknown as { id?: string }).id ??
          (typeof active === "object" && active && "id" in active
            ? String((active as { id: unknown }).id)
            : undefined);
      }
      if (!apiKey) {
        try {
          const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(
            active,
          );
          if (resolved.ok) {
            if (resolved.apiKey) apiKey = resolved.apiKey;
            if (resolved.headers) {
              for (const [k, v] of Object.entries(resolved.headers)) {
                if (!(k in extraHeaders)) extraHeaders[k] = v;
              }
            }
          }
        } catch {
        }
      }
    }
  }
  if (!baseUrl || !model || !apiKey) {
    return null;
  }
  return {
    baseUrl,
    apiKey,
    anthropicVersion,
    model,
    extraHeaders,
    ...(partial?.maxContextChars ? { maxContextChars: partial.maxContextChars } : {}),
  };
}
function loadInstructions(cwd: string): string {
  const cached = instructionCache.get(cwd);
  if (cached !== undefined) return cached;
  let content = "";
  try {
    const files = loadProjectContextFiles({
      cwd,
      agentDir: getAgentDir(),
    });
    content = files
      .map((f) => `## ${f.path}\n${f.content}`)
      .join("\n\n");
  } catch {
    content = "";
  }
  instructionCache.set(cwd, content);
  return content;
}
function buildUserMessage(
  req: AutoModeToolCallRequest,
  cfg: AutoModeConfig,
  resolvedProvider: ResolvedAutoModeProviderConfig,
): string {
  const sections: string[] = [];
  const maxChars =
    resolvedProvider.maxContextChars ?? cfg.transcriptMaxChars ?? 80_000;
  const instructions = req.ctx ? loadInstructions(req.ctx.cwd) : "";
  if (instructions.length > 0) {
    sections.push("<user_instructions>");
    sections.push(instructions);
    sections.push("</user_instructions>");
  }
  if (req.sessionMessages.length > 0) {
    const lines: string[] = [];
    for (const msg of req.sessionMessages) {
      const line = compactMessage(msg);
      if (line) lines.push(line);
    }
    let transcript = lines.join("\n");
    while (transcript.length > maxChars && lines.length > 1) {
      lines.shift();
      transcript = lines.join("\n");
    }
    if (transcript.length > 0) {
      sections.push("<transcript>");
      sections.push(transcript);
      sections.push("</transcript>");
    }
  }
  sections.push("Proposed action:");
  sections.push(JSON.stringify({ tool: req.toolName, input: req.input }));
  return sections.join("\n");
}
function compactMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "";
  const content = m.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && role === "user") {
        return JSON.stringify({ user: b.text });
      }
      if (b.type === "tool_use" && role === "assistant") {
        const name = typeof b.name === "string" ? b.name : "tool";
        const input =
          b.input && typeof b.input === "object"
            ? (b.input as Record<string, unknown>)
            : {};
        return JSON.stringify({ [name]: input });
      }
      if (b.type === "tool_result") {
        const c =
          typeof b.content === "string"
            ? b.content
            : JSON.stringify(b.content ?? "");
        return JSON.stringify({
          tool_result:
            typeof b.tool_use_id === "string" ? b.tool_use_id : "",
          content: c.slice(0, 4000),
        });
      }
    }
    return "";
  }
  if (typeof content === "string" && role === "user") {
    return JSON.stringify({ user: content });
  }
  return "";
}
function classifierErrorReason(error: unknown): string {
  if (error instanceof ClassifierTimeoutError) {
    return `Classifier timed out after ${error.timeoutMs}ms`;
  }
  if (error instanceof ClassifierHttpError) {
    return `Classifier HTTP ${error.status}`;
  }
  if (error instanceof Error) return error.message;
  return "Classifier unavailable";
}
