// Offline fixture: a real Pi model turn calls the real ExitPlanMode tool.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { makeExitPlanModeTool } from "../../exitPlanModeTool.ts";
export default function (pi: any) {
  const tool = makeExitPlanModeTool({ planText: async () => "# Offline plan\n", applyExit: async () => {} });
  pi.registerTool({ ...tool, execute: (id: any, params: any, signal: any, update: any, ctx: any) => tool.execute(id, params, signal, update, {
    ...ctx, hasUI: true, mode: "tui",
    // UI is stubbed only here; native focus and terminal handoff have a separate live test.
    ui: { ...ctx.ui, custom: async () => ({ action: process.env.REVIEW_ACTION ?? "no" }), editor: async () => undefined },
  }) });
  pi.registerProvider("review-fixture", {
    baseUrl: "http://127.0.0.1:9", apiKey: "offline", api: "review-fixture-api",
    models: [{ id: "fixture", name: "Review fixture", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 }],
    streamSimple(model: any, context: any) {
      appendFileSync(process.env.REVIEW_LOG!, "model-call\n");
      const stream = createAssistantMessageEventStream();
      const fresh = context.messages.at(-1)?.role === "user";
      const toolCall = { type: "toolCall", id: "review-call", name: "ExitPlanMode", arguments: {} };
      const output: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: fresh ? [toolCall] : [{ type: "text", text: "UNEXPECTED_AUTOMATIC_CONTINUATION" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: fresh ? "toolUse" : "stop", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: output });
        if (fresh) {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        }
        stream.push({ type: "done", reason: fresh ? "toolUse" : "stop", message: output });
        stream.end();
      });
      return stream;
    },
  });
}
