import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import { lstatSync, realpathSync } from "fs";
import { containsVulnerableUncPath } from "../shell/readOnlyCommandValidation.ts";
import { containsPathTraversal } from "./bashPathHelpers.ts";
import type { isPathAllowedAdaptor } from "../../../permissionContext.ts";
const GLOB_PATTERN_REGEX = /[*?[\]{}]/;
export type FileOperationType = "read" | "write" | "create";
export type PathCheckResult = {
  allowed: boolean;
  decisionReason?:
    | { type: "rule"; rule: string }
    | { type: "other"; reason: string };
};
export type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string;
};
const getPlatform = (): "macos" | "windows" | "wsl" | "linux" | "unknown" => {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return "unknown";
};
export function getGlobBaseDirectory(path: string): string {
  const globMatch = path.match(GLOB_PATTERN_REGEX);
  if (!globMatch || globMatch.index === undefined) {
    return path;
  }
  const beforeGlob = path.substring(0, globMatch.index);
  const lastSepIndex =
    getPlatform() === "windows"
      ? Math.max(beforeGlob.lastIndexOf("/"), beforeGlob.lastIndexOf("\\"))
      : beforeGlob.lastIndexOf("/");
  if (lastSepIndex === -1) return ".";
  return beforeGlob.substring(0, lastSepIndex) || "/";
}
export function expandTilde(path: string): string {
  if (
    path === "~" ||
    path.startsWith("~/") ||
    (process.platform === "win32" && path.startsWith("~\\"))
  ) {
    return homedir() + path.slice(1);
  }
  return path;
}
function safeResolvePath(filePath: string): {
  resolvedPath: string;
  isCanonical: boolean;
} {
  if (filePath.startsWith("//") || filePath.startsWith("\\\\")) {
    return { resolvedPath: filePath, isCanonical: false };
  }
  try {
    const stats = lstatSync(filePath);
    if (
      stats.isFIFO() ||
      stats.isSocket() ||
      stats.isCharacterDevice() ||
      stats.isBlockDevice()
    ) {
      return { resolvedPath: filePath, isCanonical: false };
    }
    const resolvedPath = realpathSync(filePath);
    return { resolvedPath, isCanonical: true };
  } catch {
    return { resolvedPath: filePath, isCanonical: false };
  }
}
export function validateGlobPattern(
  cleanPath: string,
  cwd: string,
  context: Parameters<typeof isPathAllowedAdaptor>[1],
  operationType: FileOperationType,
  isPathAllowed: typeof isPathAllowedAdaptor,
): ResolvedPathCheckResult {
  if (containsPathTraversal(cleanPath)) {
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath);
    const { resolvedPath, isCanonical } = safeResolvePath(absolutePath);
    const result = isPathAllowed(
      resolvedPath,
      context,
      cwd,
      operationType,
      isCanonical ? [resolvedPath] : undefined,
    );
    return {
      allowed: result.allowed,
      resolvedPath,
      decisionReason: result.decisionReason,
    };
  }
  const basePath = getGlobBaseDirectory(cleanPath);
  const absoluteBasePath = isAbsolute(basePath)
    ? basePath
    : resolve(cwd, basePath);
  const { resolvedPath, isCanonical } = safeResolvePath(absoluteBasePath);
  const result = isPathAllowed(
    resolvedPath,
    context,
    cwd,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  );
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  };
}
export function validatePath(
  path: string,
  cwd: string,
  context: Parameters<typeof isPathAllowedAdaptor>[1],
  operationType: FileOperationType,
  isPathAllowed: typeof isPathAllowedAdaptor,
): ResolvedPathCheckResult {
  const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ""));
  if (containsVulnerableUncPath(cleanPath)) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: "other",
        reason: "UNC network paths require manual approval",
      },
    };
  }
  if (cleanPath.startsWith("~")) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: "other",
        reason:
          "Tilde expansion variants (~user, ~+, ~-) in paths require manual approval",
      },
    };
  }
  if (
    cleanPath.includes("$") ||
    cleanPath.includes("%") ||
    cleanPath.startsWith("=")
  ) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: "other",
        reason: "Shell expansion syntax in paths requires manual approval",
      },
    };
  }
  if (GLOB_PATTERN_REGEX.test(cleanPath)) {
    if (operationType === "write" || operationType === "create") {
      return {
        allowed: false,
        resolvedPath: cleanPath,
        decisionReason: {
          type: "other",
          reason:
            "Glob patterns are not allowed in write operations. Please specify an exact file path.",
        },
      };
    }
    return validateGlobPattern(
      cleanPath,
      cwd,
      context,
      operationType,
      isPathAllowed,
    );
  }
  const absolutePath = isAbsolute(cleanPath)
    ? cleanPath
    : resolve(cwd, cleanPath);
  const { resolvedPath, isCanonical } = safeResolvePath(absolutePath);
  const result = isPathAllowed(
    resolvedPath,
    context,
    cwd,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  );
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  };
}
