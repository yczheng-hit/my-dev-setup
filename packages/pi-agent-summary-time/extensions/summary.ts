export interface AgentSummaryData {
  commands: number;
  reads: number;
  edits: number;
  writes: number;
  others: number;
  failed: number;
  durationMs: number;
}

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Use the persisted entry timestamp, never the time at which an old entry is re-rendered. */
export function formatChinaTime(timestamp: string | undefined): string {
  if (typeof timestamp !== "string") return "";
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return "";
  return `${clock.format(instant)} (UTC+8)`;
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "";
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const plural = (n: number) => (n === 1 ? "" : "s");

/** Same summary categories/layout as pi-cc-extensions 1.0.7, plus completion time. */
export function formatAgentSummary(
  data: AgentSummaryData,
  timestamp: string | undefined,
  colors: { success: string; failed: string } = { success: "", failed: "" },
): string {
  const parts: string[] = [];
  if (data?.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
  if (data?.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
  if (data?.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
  if (data?.writes) parts.push(`wrote ${data.writes} file${plural(data.writes)}`);
  if (data?.others) parts.push(`${data.others} other tool${plural(data.others)}`);
  if (data?.failed) parts.push(`${data.failed} failed`);
  if (!parts.length) return "";
  const text = parts
    .map((part, index) => index === 0 ? part[0]!.toUpperCase() + part.slice(1) : part)
    .map((part) => {
      const code = part.endsWith("failed") ? colors.failed : colors.success;
      return code ? part.replace(/(\d+)/, `${code}$1\x1b[0m`) : part;
    })
    .join(", ");
  return `> *${[text, duration(data.durationMs), formatChinaTime(timestamp)].filter(Boolean).join(" · ")}*`;
}
