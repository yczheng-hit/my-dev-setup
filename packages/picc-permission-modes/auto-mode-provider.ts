export interface ClassifierProviderConfig {
  baseUrl: string;
  apiKey: string;
  anthropicVersion?: string;
  extraHeaders?: Record<string, string>;
}
export interface ClassifierMessageRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  tools?: unknown[];
  stopSequences?: string[];
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface ClassifierMessageResponse {
  id: string;
  stopReason: string | null;
  text: string;
  toolInput?: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}
export class ClassifierHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(`classifier HTTP ${status}: ${bodyText.slice(0, 240)}`);
    this.name = "ClassifierHttpError";
  }
}
export class ClassifierTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`classifier HTTP timeout after ${timeoutMs}ms`);
    this.name = "ClassifierTimeoutError";
  }
}
const DEFAULT_TIMEOUT_MS = 25_000;
export async function sendClassifierMessage(
  cfg: ClassifierProviderConfig,
  req: ClassifierMessageRequest,
): Promise<ClassifierMessageResponse> {
  const url = joinUrl(cfg.baseUrl, "/v1/messages");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": cfg.apiKey,
    "anthropic-version": cfg.anthropicVersion ?? "2023-06-01",
    ...(cfg.extraHeaders ?? {}),
  };
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    temperature: req.temperature ?? 0,
  };
  if (req.tools && req.tools.length > 0) body.tools = req.tools;
  if (req.stopSequences && req.stopSequences.length > 0) {
    body.stop_sequences = req.stopSequences;
  }
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const composite = combineSignals(controller.signal, req.signal);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: composite.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text();
        if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
          continue;
        }
        throw new ClassifierHttpError(res.status, text);
      }
      const json = (await res.json()) as Record<string, unknown>;
      return parseClassifierResponse(json);
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof ClassifierHttpError) throw error;
      if (composite.signal.aborted && req.signal?.aborted) {
        throw new Error("classifier request aborted");
      }
      if (controller.signal.aborted) {
        throw new ClassifierTimeoutError(timeoutMs);
      }
      lastError = error;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
        continue;
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("classifier failed after retries");
}
function parseClassifierResponse(
  json: Record<string, unknown>,
): ClassifierMessageResponse {
  const id = typeof json.id === "string" ? json.id : "";
  const stopReason = typeof json.stop_reason === "string" ? json.stop_reason : null;
  const content = Array.isArray(json.content) ? json.content : [];
  let text = "";
  let toolInput: unknown = undefined;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      text += b.text;
    } else if (b.type === "tool_use" && b.name === "classify_result") {
      toolInput = b.input;
    }
  }
  const usageRaw = (json.usage as Record<string, unknown> | undefined) ?? {};
  const usage = {
    inputTokens: numberOr0(usageRaw.input_tokens),
    outputTokens: numberOr0(usageRaw.output_tokens),
    cacheReadInputTokens: numberOr0(usageRaw.cache_read_input_tokens),
    cacheCreationInputTokens: numberOr0(usageRaw.cache_creation_input_tokens),
  };
  return { id, stopReason, text, toolInput, usage };
}
function numberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, "") + suffix;
}
function combineSignals(
  a: AbortSignal,
  b: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  if (!b) return { signal: a, cleanup: () => {} };
  const ctrl = new AbortController();
  const onA = () => ctrl.abort(a.reason);
  const onB = () => ctrl.abort(b.reason);
  if (a.aborted) ctrl.abort(a.reason);
  if (b.aborted) ctrl.abort(b.reason);
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return {
    signal: ctrl.signal,
    cleanup: () => {
      a.removeEventListener("abort", onA);
      b.removeEventListener("abort", onB);
    },
  };
}
