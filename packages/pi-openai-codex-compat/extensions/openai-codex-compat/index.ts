import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { requirePiRuntime } from "./pi-runtime.ts";
import { DEFAULT_CONFIG, loadConfig, type CodexCompatConfig } from "./config.ts";
import type { ConfigContext } from "./config-context.ts";
import { registerCodexProvider } from "./codex-provider.ts";
import { installCodexFooter } from "./footer.ts";
import registerCodexModelPolicy, { codexModelPolicyApi } from "./model-policy.ts";
import registerOutputLimitContinuation, {
  outputLimitContinuationApi,
} from "./output-limit-continuation.ts";
import registerRemoteCompaction, { remoteCompactionApi } from "./remote-compaction.ts";
import {
  hashlineConfigPath,
  NON_CODEX_APPLY_PATCH_INSTRUCTIONS,
  syncHashlineDisableOnModels,
} from "./apply-patch-models.ts";
import registerCodexRequestOptions, { isCodexModel } from "./request-options.ts";
import registerCodexSettings, { loadSessionConfig } from "./settings-pane.ts";
import registerCodexThreadLineage, { codexThreadLineageApi } from "./codex-thread-lineage.ts";
import registerCodexTools, { syncCodexTools, CODEX_TOOL_NAMES } from "./tools.ts";
import registerToolRecovery from "./tool-recovery.ts";
export {
  closeOpenAICodexWebSocketSessions,
  getOpenAICodexWebSocketDebugStats,
  resetOpenAICodexWebSocketDebugStats,
  type OpenAICodexWebSocketDebugStats,
} from "./codex-transport.ts";

const HASHLINE_EDIT_TOOL_NAMES = [
  "replace",
  "replace_match",
  "insert",
  "copy",
  "move",
  "undo_last_change",
] as const;

/**
 * Whether pi-hashline-edit-pro is installed. Its anchored tools conflict with `apply_patch`, so its
 * `disableOnModels` must follow the patch gate on those machines only.
 */
function hashlineInstalled(pi: Pick<ExtensionAPI, "getActiveTools">): boolean {
  if (existsSync(hashlineConfigPath())) return true;
  const active = new Set(pi.getActiveTools());
  return HASHLINE_EDIT_TOOL_NAMES.some((name) => active.has(name));
}

export default function registerOpenAICodexCompat(pi: ExtensionAPI): void {
  requirePiRuntime(piAi, piCodingAgent, pi);
  let activeConfig: CodexCompatConfig | undefined;
  let sessionContext: Parameters<typeof loadSessionConfig>[0] | undefined;
  const resolveConfig = (ctx: ConfigContext): CodexCompatConfig => {
    activeConfig ??= sessionContext
      ? loadSessionConfig(sessionContext)
      : loadConfig(ctx.cwd, ctx.isProjectTrusted());
    return activeConfig;
  };
  const resolveToolBackground = () => activeConfig?.toolBackground ?? DEFAULT_CONFIG.toolBackground;
  const resolveApplyPatchDebug = () =>
    activeConfig?.applyPatchDebug ?? DEFAULT_CONFIG.applyPatchDebug;
  const resolveApplyPatchDiagnostics = () =>
    activeConfig?.applyPatchDiagnostics ?? DEFAULT_CONFIG.applyPatchDiagnostics;

  // Set when the pane changed the patch gate after Pi had already declared this session's tools.
  let patchGateChanged = false;

  pi.on("session_start", (event, ctx) => {
    sessionContext = ctx;
    activeConfig = undefined;
    activeConfig = resolveConfig(ctx);
    patchGateChanged = false;
    // The settings pane stores the same patterns here; refresh them after an out-of-band edit.
    if (hashlineInstalled(pi)) {
      syncHashlineDisableOnModels(activeConfig.applyPatchModels, activeConfig.applyPatch);
    }
    installCodexFooter(ctx, resolveConfig);
    if (event.reason !== "reload" && ctx.mode === "tui") {
      ctx.ui.notify("pi-openai-codex-compat loaded · /codex-settings", "info");
    }
  });

  const commandTools = registerCodexTools(
    pi,
    resolveConfig,
    resolveToolBackground,
    resolveApplyPatchDebug,
    resolveApplyPatchDiagnostics,
  );
  registerCodexThreadLineage(codexThreadLineageApi(pi));
  const codexProvider = registerCodexProvider(pi, resolveConfig);
  const modelPolicy = codexModelPolicyApi(pi);
  registerCodexRequestOptions(pi, resolveConfig);
  registerOutputLimitContinuation(outputLimitContinuationApi(pi));
  registerRemoteCompaction(remoteCompactionApi(pi), codexProvider, resolveConfig);
  registerCodexModelPolicy(modelPolicy, resolveConfig, commandTools);
  registerToolRecovery(pi, [
    ...CODEX_TOOL_NAMES,
    "bash",
    "edit",
    "write",
    "replace",
    "replace_match",
    "insert",
    "copy",
    "move",
    "undo_last_change",
  ]);
  // Non-Codex models were not trained on the Codex tool description, so apply_patch contributes a
  // short format section. A pane change reapplies the gate before the next turn when the host
  // could not reload the session.
  pi.on("before_agent_start", (event, ctx) => {
    if (patchGateChanged) {
      patchGateChanged = false;
      syncCodexTools(modelPolicy, ctx.model, resolveConfig(ctx), commandTools);
    }
    if (pi.getActiveTools().includes("apply_patch") && !isCodexModel(ctx.model)) {
      event.systemPromptOptions.sections.apply_patch_format = NON_CODEX_APPLY_PATCH_INSTRUCTIONS;
    } else {
      delete event.systemPromptOptions.sections.apply_patch_format;
    }
  });

  registerCodexSettings(pi, {
    getConfig: resolveConfig,
    hasPersistentSessions: commandTools.hasPersistentSessions,
    onChange(config, ctx) {
      activeConfig = config;
      patchGateChanged = true;
      codexProvider.updateSessionConfig(ctx.sessionId, config);
      if (hashlineInstalled(pi)) {
        syncHashlineDisableOnModels(config.applyPatchModels, config.applyPatch);
      }
      syncCodexTools(modelPolicy, ctx.model, config, commandTools);
    },
  });
}
