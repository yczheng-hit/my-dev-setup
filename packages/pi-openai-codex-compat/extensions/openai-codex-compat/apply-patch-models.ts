import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isObject } from "./codex-protocol.ts";

export const DEFAULT_APPLY_PATCH_MODELS = "openai-codex/*";

export interface ModelIdentifierLike {
  provider?: string;
  id?: string;
  api?: string;
}

export function splitApplyPatchModels(
  value: string | readonly string[] | undefined = DEFAULT_APPLY_PATCH_MODELS,
): string[] {
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value)
        ? value
        : [DEFAULT_APPLY_PATCH_MODELS];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(trimmed);
  }
  return result;
}

export function formatApplyPatchModels(patterns: readonly string[]): string {
  return splitApplyPatchModels(patterns).join(", ");
}

export function parseApplyPatchModels(value: unknown): string | undefined {
  if (typeof value === "string") {
    return formatApplyPatchModels(value.split(","));
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return formatApplyPatchModels(value);
  }
  return undefined;
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (const char of glob) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`, "i");
}

export function modelCandidateLabels(model: ModelIdentifierLike): string[] {
  const labels: string[] = [];
  if (typeof model.id === "string" && model.id.length > 0) {
    labels.push(model.id);
    if (typeof model.provider === "string" && model.provider.length > 0) {
      labels.push(`${model.provider}/${model.id}`);
    }
  }
  if (typeof model.api === "string" && model.api.length > 0) {
    labels.push(model.api);
  }
  return labels;
}

function matchesGlob(model: ModelIdentifierLike, glob: string): boolean {
  const regex = globToRegExp(glob);
  return modelCandidateLabels(model).some((label) => regex.test(label));
}

export function isApplyPatchModel(
  model: ModelIdentifierLike | undefined,
  patternsInput: string | readonly string[] | undefined = DEFAULT_APPLY_PATCH_MODELS,
): boolean {
  if (!model) return false;
  const patterns = splitApplyPatchModels(patternsInput);
  if (patterns.length === 0) return false;

  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      const negative = pattern.slice(1).trim();
      if (negative && matchesGlob(model, negative)) {
        matched = false;
      }
    } else if (matchesGlob(model, pattern)) {
      matched = true;
    }
  }
  return matched;
}

function parseModelKey(modelKey: string): ModelIdentifierLike {
  const slash = modelKey.indexOf("/");
  if (slash <= 0) return { id: modelKey };
  return {
    provider: modelKey.slice(0, slash),
    id: modelKey.slice(slash + 1),
  };
}

export function toggleModelInApplyPatchModels(
  currentValue: string | readonly string[] | undefined,
  targetKey: string,
  knownModelKeys: readonly string[] = [],
): string {
  const trimmedTarget = targetKey.trim();
  if (!trimmedTarget) return formatApplyPatchModels(splitApplyPatchModels(currentValue));

  const patterns = splitApplyPatchModels(currentValue);

  if (trimmedTarget.includes("*")) {
    const regex = globToRegExp(trimmedTarget);
    const hasWildcard = patterns.some((p) => p.toLowerCase() === trimmedTarget.toLowerCase());
    if (hasWildcard) {
      return formatApplyPatchModels(
        patterns.filter(
          (p) => p.toLowerCase() !== trimmedTarget.toLowerCase() && !regex.test(p),
        ),
      );
    }
    const filtered = patterns.filter((p) => !regex.test(p));
    return formatApplyPatchModels([...filtered, trimmedTarget]);
  }

  const targetModel = parseModelKey(trimmedTarget);
  const currentlyEnabled = isApplyPatchModel(targetModel, patterns);

  if (!currentlyEnabled) {
    const withoutNegative = patterns.filter(
      (p) => p.toLowerCase() !== `!${trimmedTarget}`.toLowerCase(),
    );
    return formatApplyPatchModels([...withoutNegative, trimmedTarget]);
  }

  const next: string[] = [];
  for (const pattern of patterns) {
    if (pattern.toLowerCase() === trimmedTarget.toLowerCase()) {
      continue;
    }
    if (!pattern.startsWith("!") && matchesGlob(targetModel, pattern)) {
      const expanded = knownModelKeys.filter(
        (candidate) =>
          !candidate.includes("*") &&
          candidate.toLowerCase() !== trimmedTarget.toLowerCase() &&
          matchesGlob(parseModelKey(candidate), pattern),
      );
      if (expanded.length > 0) {
        next.push(...expanded);
      } else {
        next.push(pattern, `!${trimmedTarget}`);
      }
      continue;
    }
    next.push(pattern);
  }
  return formatApplyPatchModels(next);
}

export function collectSelectableModelKeys(options: {
  currentModel?: ModelIdentifierLike | undefined;
  availableModels?: readonly ModelIdentifierLike[] | undefined;
  agentDir?: string | undefined;
  patterns?: string | readonly string[] | undefined;
}): { key: string; isCurrent: boolean; isWildcard: boolean }[] {
  const seen = new Set<string>();
  const items: { key: string; isCurrent: boolean; isWildcard: boolean }[] = [];

  const currentKey =
    options.currentModel?.provider && options.currentModel?.id
      ? `${options.currentModel.provider}/${options.currentModel.id}`
      : undefined;

  const add = (key: string, isWildcard = key.includes("*")) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    items.push({
      key: trimmed,
      isCurrent: currentKey !== undefined && lower === currentKey.toLowerCase(),
      isWildcard,
    });
  };

  if (currentKey) add(currentKey, false);

  const dir = options.agentDir ?? getAgentDir();
  const settingsPath = join(dir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (isObject(parsed) && Array.isArray(parsed["enabledModels"])) {
        for (const entry of parsed["enabledModels"]) {
          if (typeof entry === "string") add(entry);
        }
      }
    } catch {
      // Ignore invalid settings.json while collecting model choices.
    }
  }

  for (const model of options.availableModels ?? []) {
    if (model.provider && model.id) {
      add(`${model.provider}/${model.id}`, false);
    }
  }

  add("openai-codex/*", true);

  for (const pattern of splitApplyPatchModels(options.patterns)) {
    if (!pattern.startsWith("!")) add(pattern, pattern.includes("*"));
  }

  return items;
}

export function buildApplyPatchModelSelectItems(options: {
  currentModel?: ModelIdentifierLike | undefined;
  availableModels?: readonly ModelIdentifierLike[] | undefined;
  agentDir?: string | undefined;
  patterns?: string | readonly string[] | undefined;
}): { value: string; label: string }[] {
  const entries = collectSelectableModelKeys(options);
  const patterns = splitApplyPatchModels(options.patterns);

  return entries.map((entry) => {
    const enabled = entry.isWildcard
      ? patterns.some((p) => p.toLowerCase() === entry.key.toLowerCase())
      : isApplyPatchModel(parseModelKey(entry.key), patterns);
    const badge = enabled ? "[apply_patch]    " : "[edit (hashline)]";
    const suffix = entry.isCurrent
      ? " (current)"
      : entry.key === "openai-codex/*"
        ? " (all Codex models)"
        : "";
    return {
      value: entry.key,
      label: `${badge}  ${entry.key}${suffix}`,
    };
  });
}

export function formatApplyPatchModelsSummary(
  patternsInput: string | readonly string[] | undefined,
  currentModel?: ModelIdentifierLike | undefined,
): string {
  const patterns = splitApplyPatchModels(patternsInput);
  const currentStatus = currentModel
    ? isApplyPatchModel(currentModel, patterns)
      ? "current: apply_patch"
      : "current: edit"
    : undefined;
  const countLabel = `${patterns.length} rule${patterns.length === 1 ? "" : "s"}`;
  return currentStatus ? `${currentStatus} (${countLabel})` : countLabel;
}

export function hashlineConfigPath(overrideDir?: string): string {
  if (overrideDir) return join(overrideDir, "config.json");
  const envDir = process.env["PI_HASHLINE_DIR"];
  if (envDir && envDir.length > 0) return join(envDir, "config.json");
  const home =
    process.env["HOME"] && process.env["HOME"].length > 0 ? process.env["HOME"] : homedir();
  const base =
    process.platform !== "win32" &&
    process.env["XDG_CONFIG_HOME"] &&
    process.env["XDG_CONFIG_HOME"].length > 0
      ? process.env["XDG_CONFIG_HOME"]
      : join(home, ".config");
  return join(base, "pi-hashline-edit-pro", "config.json");
}

export function syncHashlineDisableOnModels(
  patternsInput: string | readonly string[] | undefined,
  applyPatchEnabled: boolean,
  overrideDir?: string,
): void {
  const filePath = hashlineConfigPath(overrideDir);
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      if (isObject(parsed)) existing = { ...parsed };
    } catch {
      existing = {};
    }
  }
  existing["disableOnModels"] = applyPatchEnabled ? splitApplyPatchModels(patternsInput) : [];
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export const NON_CODEX_APPLY_PATCH_INSTRUCTIONS = `## apply_patch Format
When calling \`apply_patch\`, pass a patch string in the \`patch\` parameter with this structure:
*** Begin Patch
*** Update File: path/to/file.ext
@@ optional context header
 unchanged context line
-removed line
+added line
*** Add File: path/to/new_file.ext
+new file line
*** Delete File: path/to/old_file.ext
*** End Patch`;
