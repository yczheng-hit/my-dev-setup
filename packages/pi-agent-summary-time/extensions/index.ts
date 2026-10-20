import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatAgentSummary, type AgentSummaryData } from "./summary.ts";

/**
 * Loaded before pi-cc-extensions in the packages list. Pi uses the first
 * renderer for a custom entry type; pi-cc-extensions still owns the single
 * agent-summary writer and the existing session data remains unchanged.
 */
export default function (pi: ExtensionAPI): void {
  pi.registerEntryRenderer<AgentSummaryData>("agent-summary", (entry, _options, theme) => {
    const line = formatAgentSummary(entry.data!, entry.timestamp, {
      success: theme.getFgAnsi("success"),
      failed: theme.getFgAnsi("error"),
    });
    return line ? new Markdown(line, 1, 0, getMarkdownTheme()) : undefined;
  });
}
