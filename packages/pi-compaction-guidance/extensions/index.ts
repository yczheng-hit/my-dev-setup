import { compact, SettingsManager, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { withCompactionGuidance } from "../guidance.ts";

/** Keep Pi's preparation, summary format, iterative merge, split-turn handling and file tracking. */
export default function compactionGuidance(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    // Codex owns opaque checkpoints, including provider-internal percentage compaction.
    // Virtual routing is also host-owned: the public registry has no direct-route API.
    if (!ctx.model || ctx.model.provider === "openai-codex" || ctx.model.api === "pi-virtual") return;
    if (event.signal.aborted) return { cancel: true };
    const model = ctx.model;
    const settings = SettingsManager.inMemory(pi.getSettings());
    const providerRetry = settings.getProviderRetrySettings();
    const timeout = providerRetry.timeoutMs ?? settings.getHttpIdleTimeoutMs();
    const telemetry = process.env.PI_TELEMETRY;
    const attributed = telemetry === undefined ? settings.getEnableInstallTelemetry() : /^(1|true|yes)$/i.test(telemetry);
    const stream: StreamFn = (target, context, options) => ctx.modelRegistry.streamSimple(target, context, {
      ...options,
      identity: { userAgent: "detailed", version: VERSION, attribution: attributed ? PI_ATTRIBUTION : null },
      transport: settings.getTransport(),
      thinkingBudgets: settings.getThinkingBudgets(),
      timeoutMs: timeout === 0 ? 2_147_483_647 : timeout,
      websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(),
      maxRetries: providerRetry.maxRetries,
      maxRetryDelayMs: providerRetry.maxRetryDelayMs,
    });
    try {
      const result = await compact(event.preparation, model, undefined, undefined,
        withCompactionGuidance(event.customInstructions), event.signal, ctx.thinkingLevel,
        stream, undefined, settings.getRetrySettings());
      return { compaction: result };
    } catch (error) {
      if (!event.signal.aborted && ctx.hasUI) ctx.ui.notify(`Compaction guidance failed; history preserved: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { cancel: true };
    }
  });
}
