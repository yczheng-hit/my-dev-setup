// local patch: sequential native review/edit UI; cancellation ends this model turn.
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AllowedPrompt, PermissionMode } from "./types.ts";
import {
  buildMarkdownTheme,
  createExitPlanModeDialogFactory,
  type ExitPlanModeDialogResult,
} from "./exitPlanModeDialog.ts";
import { getPlanFilePath } from "./utils.ts";
export interface ExitPlanModeState {
  planText: (ctx: ExtensionContext) => Promise<string>;
  applyExit: (
    ctx: ExtensionContext,
    params: { mode: PermissionMode; plan: string; allowedPrompts?: AllowedPrompt[] },
  ) => Promise<void>;
}
const OPTIONS_TUI: string[] = [
  "Yes, bypass permissions on plan exit",
  "Yes, auto-accept edits on plan exit",
  "Stay in plan mode",
  "Request changes to the plan…",
];
const OPTIONS_HEADLESS: string[] = [
  "Yes, bypass permissions on plan exit",
  "Yes, auto-accept edits on plan exit",
  "Stay in plan mode",
];
const EXIT_PLAN_MODE_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.
## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it
## When This Tool Returns
- If the user approved, the plan is echoed back. Continue implementing without asking again.
- If the user requested changes, revise the plan file and request approval again; do not implement.
- If the user cancelled or chose to stay, remain in plan mode and wait for their next instruction.
## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.
## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval
**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.
## Examples
1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.`;
const allowedPromptSchema = Type.Object({
  tool: Type.Literal("Bash"),
  prompt: Type.String({
    description:
      'Semantic description of the action, e.g. "run tests", "install dependencies"',
  }),
});
export function makeExitPlanModeTool(state: ExitPlanModeState) {
  return defineTool({
    name: "ExitPlanMode",
    label: "Exit plan mode",
    description: EXIT_PLAN_MODE_PROMPT,
    promptSnippet: "Exit plan mode after writing a plan file.",
    parameters: Type.Object({
      allowedPrompts: Type.Optional(
        Type.Array(allowedPromptSchema, {
          description:
            "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
      let planText: string;
      try {
        planText = await state.planText(ctx);
      } catch {
        return planNotReadyResult(planPath, "unreadable-plan");
      }
      if (!planText.trim()) {
        return planNotReadyResult(planPath, "missing-or-empty-plan");
      }
      let result: ExitPlanModeDialogResult;
      if (ctx.hasUI && ctx.mode !== "rpc") {
        // local patch: each approval overlay must release focus before opening an editor.
        while (true) {
          const factory = createExitPlanModeDialogFactory(
            planText,
            planPath,
            {
              title: (t) => ctx.ui.theme.fg("accent", t),
              sectionLabel: (t) => ctx.ui.theme.fg("muted", t),
              optionSelected: (t) => ctx.ui.theme.fg("accent", t),
              optionDefault: (t) => ctx.ui.theme.fg("text", t),
              optionHint: (t) => ctx.ui.theme.fg("dim", t),
              hint: (t) => ctx.ui.theme.fg("dim", t),
              hintDim: (t) => ctx.ui.theme.fg("muted", t),
              border: (t) => {
                try { return ctx.ui.theme.fg("borderAccent", t); }
                catch {
                  try { return ctx.ui.theme.fg("border", t); }
                  catch { return t; }
                }
              },
              emptyPlan: (t) => ctx.ui.theme.fg("warning", t),
            },
            buildMarkdownTheme(ctx.ui.theme),
          );
          result = await ctx.ui.custom<ExitPlanModeDialogResult>(factory, {
            overlay: true,
            overlayOptions: { anchor: "bottom-center", width: "100%" },
          });
          if (result?.action !== "edit") break;
          const edited = await ctx.ui.editor("Edit plan", planText);
          if (edited !== undefined) {
            if (!edited.trim()) {
              ctx.ui.notify("The plan cannot be empty; the saved plan was kept.", "warning");
            } else {
              try {
                writeFileSync(planPath, edited, "utf8");
                planText = edited;
              } catch {
                ctx.ui.notify("Could not save the edited plan; the previous plan was kept.", "error");
              }
            }
          }
        }
      } else {
        const choice = await ctx.ui.select("Plan ready — what next?", OPTIONS_HEADLESS);
        result = mapLegacyHeadlessChoiceToResult(choice);
      }
      if (!result || !result.action) {
        return {
          terminate: true,
          content: [{ type: "text", text: "User dismissed ExitPlanMode dialog" }],
          details: { exited: false },
        };
      }
      switch (result.action) {
        case "acceptEdits": {
          const echo = planText;
          await state.applyExit(ctx, {
            mode: "acceptEdits",
            plan: echo,
            allowedPrompts: params.allowedPrompts,
          });
          return {
            content: [
              {
                type: "text",
                text: buildPlanApprovalToolResult(echo),
              },
            ],
            details: {
              exited: true,
              mode: "acceptEdits" as PermissionMode,
            },
          };
        }
        case "bypassPermissions": {
          const echo = planText;
          await state.applyExit(ctx, {
            mode: "bypassPermissions",
            plan: echo,
            allowedPrompts: params.allowedPrompts,
          });
          return {
            content: [
              {
                type: "text",
                text: buildPlanApprovalToolResult(echo),
              },
            ],
            details: {
              exited: true,
              mode: "bypassPermissions" as PermissionMode,
            },
          };
        }
        case "no":
          return {
            terminate: true,
            content: [{ type: "text", text: "The user did not approve the plan. Stay in plan mode and wait for their next instruction." }],
            details: { exited: false, choice: "stay" },
          };
        case "refine": {
          // local patch: feedback is not a plan-file edit; Pi owns input and Ctrl+G.
          const notes = (await ctx.ui.editor("Refine plan — what should change?"))?.trim();
          if (!notes) {
            return {
              terminate: true,
              content: [{ type: "text", text: "Plan refinement cancelled. Stay in plan mode and wait for the user's next instruction." }],
              details: { exited: false, choice: "refine-cancelled" },
            };
          }
          // local patch: return feedback in this turn, never queue a second follow-up run.
          return {
            content: [{ type: "text", text: `The user requested changes to the plan:\n\n${notes}\n\nRevise the plan file, then request approval with ExitPlanMode. Do not implement before approval.` }],
            details: { exited: false, choice: "refine" },
          };
        }
        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${String((result as { action: string }).action)}` }],
            details: { exited: false },
          };
      }
    },
  });
}
function mapLegacyHeadlessChoiceToResult(
  choice: string | undefined,
): ExitPlanModeDialogResult {
  switch (choice) {
    case "Yes, auto-accept edits on plan exit":
      return { action: "acceptEdits" };
    case "Yes, bypass permissions on plan exit":
      return { action: "bypassPermissions" };
    default:
      return { action: "no" };
  }
}
function buildPlanApprovalToolResult(plan: string): string {
  if (!plan || plan.trim() === "") {
    return "User has approved exiting plan mode. You can now proceed.";
  }
  return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable.
## Approved Plan:
${plan}`;
}
function planNotReadyResult(
  planPath: string,
  reason: "unreadable-plan" | "missing-or-empty-plan",
) {
  const problem = reason === "unreadable-plan" ? "could not be read" : "is missing or empty";
  return {
    content: [{
      type: "text" as const,
      text: `Cannot request plan approval: the plan file at ${planPath} ${problem}.\nYou are still in plan mode. Write the complete implementation plan to this exact path using the Write tool, then call ExitPlanMode again. Do not start implementation before the user approves a non-empty plan.`,
    }],
    details: { exited: false, reason, planPath },
  };
}
export { OPTIONS_TUI, OPTIONS_HEADLESS };
