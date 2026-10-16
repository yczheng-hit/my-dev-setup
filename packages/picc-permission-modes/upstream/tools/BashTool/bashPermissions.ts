import { tryParseShellCommand } from "../../utils/bash/shellQuote.ts";
const SAFE_ENV_VARS = new Set<string>([
  "GOEXPERIMENT",
  "GOOS",
  "GOARCH",
  "CGO_ENABLED",
  "GO111MODULE",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "NODE_ENV",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
  "PYTEST_DEBUG",
  "ANTHROPIC_API_KEY",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TZ",
  "DATE",
  "DEBUG",
  "VERBOSE",
  "NO_COLOR",
  "FORCE_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "TERM",
  "PAGER",
  "DISPLAY",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "RUN_ID",
  "USER",
  "HOME",
  "SHELL",
  "EDITOR",
  "VISUAL",
  "NO_PROXY",
  "NO_UPDATE_NOTIFIER",
  "DISABLE_OPCACHE",
  "DISABLE_TELEMETRY",
  "BUN_DISABLE_INSTALL",
]);
const ANT_ONLY_SAFE_ENV_VARS = new Set<string>([
  "KUBECONFIG",
  "DOCKER_HOST",
  "AWS_PROFILE",
  "CLOUDSDK_CORE_PROJECT",
  "CLUSTER",
  "COO_CLUSTER",
  "COO_CLUSTER_NAME",
  "COO_NAMESPACE",
  "COO_LAUNCH_YAML_DRY_RUN",
  "SKIP_NODE_VERSION_CHECK",
  "EXPECTTEST_ACCEPT",
  "CI",
  "GIT_LFS_SKIP_SMUDGE",
  "CUDA_VISIBLE_DEVICES",
  "JAX_PLATFORMS",
  "COLUMNS",
  "TMUX",
]);
function stripCommentLines(command: string): string {
  const lines = command.split("\n");
  const nonCommentLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
  if (nonCommentLines.length === 0) {
    return command;
  }
  return nonCommentLines.join("\n");
}
export function stripSafeWrappers(command: string): string {
  const SAFE_WRAPPER_PATTERNS = [
    /<see upstream>/,
  ] as const;
  const REAL_SAFE_WRAPPER_PATTERNS: readonly RegExp[] = [
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ];
  void SAFE_WRAPPER_PATTERNS;
  const ENV_VAR_PATTERN =
    /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/;
  let stripped = command;
  let previousStripped = "";
  while (stripped !== previousStripped) {
    previousStripped = stripped;
    stripped = stripCommentLines(stripped);
    const envVarMatch = stripped.match(ENV_VAR_PATTERN);
    if (envVarMatch) {
      const varName = envVarMatch[1]!;
      const isAntOnlySafe =
        process.env.USER_TYPE === "ant" &&
        ANT_ONLY_SAFE_ENV_VARS.has(varName);
      if (SAFE_ENV_VARS.has(varName) || isAntOnlySafe) {
        stripped = stripped.replace(ENV_VAR_PATTERN, "");
      }
    }
  }
  previousStripped = "";
  while (stripped !== previousStripped) {
    previousStripped = stripped;
    stripped = stripCommentLines(stripped);
    for (const pattern of REAL_SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(pattern, "");
    }
  }
  return stripped.trim();
}
export function isNormalizedCdCommand(command: string): boolean {
  const stripped = stripSafeWrappers(command);
  const parsed = tryParseShellCommand(stripped);
  if (parsed.success && parsed.tokens.length > 0) {
    const cmd = parsed.tokens[0];
    return cmd === "cd" || cmd === "pushd" || cmd === "popd";
  }
  return /^(?:cd|pushd|popd)(?:\s|$)/.test(stripped);
}
import { splitCommand_DEPRECATED } from "../../utils/bash/commands.ts";
export function commandHasAnyCd(command: string): boolean {
  return splitCommand_DEPRECATED(command).some((subcmd) =>
    isNormalizedCdCommand(subcmd.trim()),
  );
}
export function isNormalizedGitCommand(command: string): boolean {
  if (command.startsWith("git ") || command === "git") {
    return true;
  }
  const stripped = stripSafeWrappers(command);
  const parsed = tryParseShellCommand(stripped);
  if (parsed.success && parsed.tokens.length > 0) {
    if (parsed.tokens[0] === "git") {
      return true;
    }
    if (parsed.tokens[0] === "xargs" && parsed.tokens.includes("git")) {
      return true;
    }
    return false;
  }
  return /^git(?:\s|$)/.test(stripped);
}
