import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutoModeClassifierConfig } from "./auto-mode-config.ts";

export function resolveClassifierModel(config: AutoModeClassifierConfig, ctx?: ExtensionContext): Model<Api> {
  if (!ctx) throw new Error("Auto reviewer unconfigured: no Pi model registry");
  const model = config.mode === "active" ? ctx.model : ctx.modelRegistry.find(config.provider!, config.model!);
  if (!model) throw new Error(`Auto reviewer not found: ${config.mode === "active" ? "active model" : `${config.provider}/${config.model}`}`);
  return model;
}

/** Pi owns endpoint selection, OAuth refresh and auth. Never borrow another provider's key. */
export async function sendClassifierMessage(
  ctx: ExtensionContext,
  model: Model<Api>,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> {
  const stream = ctx.modelRegistry.streamSimple(model, {
    systemPrompt: system,
    messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
    // No tools: reviewer output can never execute an action.
  }, { signal, reasoning: "off", maxTokens: 1024 });
  const response = await stream.result();
  if (signal.aborted) throw new Error("Auto review cancelled");
  if (response.stopReason !== "stop") throw new Error(`Auto review incomplete (${response.stopReason})`);
  if (response.content.some((block) => block.type === "toolCall")) throw new Error("Auto reviewer attempted a tool call");
  return response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
