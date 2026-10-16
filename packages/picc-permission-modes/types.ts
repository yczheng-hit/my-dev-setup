export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "auto";
export type InternalPermissionMode = PermissionMode;
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "auto",
] as const;
export const INTERNAL_PERMISSION_MODES = PERMISSION_MODES;
export type PermissionBehavior = "allow" | "deny" | "ask";
export type PermissionRuleSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "flagSettings"
  | "policySettings"
  | "cliArg"
  | "command"
  | "session";
export const ALL_PERMISSION_RULE_SOURCES: PermissionRuleSource[] = [
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
  "cliArg",
  "command",
  "session",
];
export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}
export interface AllowedPrompt {
  tool: "Bash";
  prompt: string;
}
export interface PermissionRule {
  source: PermissionRuleSource;
  ruleBehavior: PermissionBehavior;
  ruleValue: PermissionRuleValue;
}
export type ToolPermissionRulesBySource = Partial<
  Record<PermissionRuleSource, string[]>
>;
export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";
export type PermissionUpdate =
  | {
      type: "addRules";
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: "replaceRules";
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: "removeRules";
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: "setMode";
      destination: PermissionUpdateDestination;
      mode: PermissionMode;
    }
  | {
      type: "addDirectories";
      destination: PermissionUpdateDestination;
      directories: string[];
    }
  | {
      type: "removeDirectories";
      destination: PermissionUpdateDestination;
      directories: string[];
    };
export interface AdditionalWorkingDirectory {
  path: string;
  source: "userSettings" | "projectSettings" | "localSettings" | "flagSettings" | "policySettings" | "cliArg" | "command" | "session";
}
export interface ToolPermissionContext {
  readonly mode: PermissionMode;
  readonly additionalWorkingDirectories: ReadonlyMap<
    string,
    AdditionalWorkingDirectory
  >;
  readonly alwaysAllowRules: ToolPermissionRulesBySource;
  readonly alwaysDenyRules: ToolPermissionRulesBySource;
  readonly alwaysAskRules: ToolPermissionRulesBySource;
  readonly isBypassPermissionsModeAvailable: boolean;
  readonly strippedDangerousRules?: ToolPermissionRulesBySource;
  readonly shouldAvoidPermissionPrompts?: boolean;
  readonly prePlanMode?: PermissionMode;
  readonly shouldStripDangerousRules?: boolean;
}
export type PermissionDecisionReason =
  | { type: "rule"; rule: { toolName: string; ruleContent?: string; source: PermissionRuleSource; ruleBehavior: PermissionBehavior } }
  | { type: "mode"; mode: PermissionMode }
  | { type: "subcommandResults"; reasons: Map<string, PermissionResult> }
  | { type: "permissionPromptTool"; permissionPromptToolName: string; toolResult: unknown }
  | { type: "hook"; hookName: string; reason?: string }
  | { type: "asyncAgent"; reason: string }
  | { type: "safetyCheck"; reason: string; classifierApprovable: boolean }
  | { type: "workingDir"; reason: string }
  | { type: "other"; reason: string };
export interface PermissionAllowDecision {
  behavior: "allow";
  updatedInput?: unknown;
  userModified?: boolean;
  decisionReason?: PermissionDecisionReason;
  toolUseID?: string;
}
export interface PermissionAskDecision {
  behavior: "ask";
  message: string;
  updatedInput?: unknown;
  decisionReason?: PermissionDecisionReason;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  isBashSecurityCheckForMisparsing?: boolean;
}
export interface PermissionDenyDecision {
  behavior: "deny";
  message: string;
  decisionReason: PermissionDecisionReason;
  toolUseID?: string;
}
export type PermissionDecision =
  | PermissionAllowDecision
  | PermissionAskDecision
  | PermissionDenyDecision;
export type PermissionResult =
  | PermissionDecision
  | {
      behavior: "passthrough";
      message: string;
      decisionReason?: PermissionDecisionReason;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
    };
export interface ModesPersistedEntry {
  mode: PermissionMode;
  additionalWorkingDirectories: Array<[string, AdditionalWorkingDirectory]>;
  alwaysAllowRules: ToolPermissionRulesBySource;
  alwaysDenyRules: ToolPermissionRulesBySource;
  alwaysAskRules: ToolPermissionRulesBySource;
  isBypassPermissionsModeAvailable: boolean;
  prePlanMode?: PermissionMode;
  shouldAvoidPermissionPrompts?: boolean;
  needsPlanModeExitAttachment?: boolean;
  planModeAttachmentCount?: number;
  planSlug?: string;
}
export type ModeColorKey =
  | "text"
  | "muted"
  | "accent"
  | "warning"
  | "error"
  | "success"
  | "dim";
export interface ModeMeta {
  title: string;
  shortTitle: string;
  symbol: string;
  color: ModeColorKey;
  hexColor?: string;
}
export const MODE_META: Record<PermissionMode, ModeMeta> = {
  default: { title: "Default", shortTitle: "Default", symbol: "", color: "muted" },
  acceptEdits: {
    title: "Accept edits",
    shortTitle: "Accept",
    symbol: "⏵⏵",
    color: "success",
  },
  plan: {
    title: "Plan Mode",
    shortTitle: "Plan",
    symbol: "⏸",
    color: "accent",
  },
  bypassPermissions: {
    title: "Bypass Permissions",
    shortTitle: "Bypass",
    symbol: "⏵⏵",
    color: "error",
  },
  auto: {
    title: "Auto mode",
    shortTitle: "Auto",
    symbol: "⏵⏵",
    color: "warning",
    hexColor: "#ffc107",
  },
};
export const PAUSE_ICON = "\u23f8";
export const PLAY_ICON = "\u25b6";
