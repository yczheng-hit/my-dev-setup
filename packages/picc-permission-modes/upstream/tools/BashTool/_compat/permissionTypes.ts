export type Behavior = 'allow' | 'deny' | 'ask' | 'passthrough';
export interface PermissionDecisionReason {
  type: string;
  reason?: string;
  [key: string]: unknown;
}
export interface PermissionResult {
  behavior: Behavior;
  message?: string;
  decisionReason?: PermissionDecisionReason;
  isBashSecurityCheckForMisparsing?: boolean;
  suggestions?: unknown;
  blockedPath?: string;
  updatedInput?: { command?: string; [key: string]: unknown };
}
