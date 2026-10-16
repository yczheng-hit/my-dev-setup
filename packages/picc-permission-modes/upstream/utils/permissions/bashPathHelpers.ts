import { homedir } from "os";
import { dirname, isAbsolute, resolve } from "path";
import { statSync } from "fs";
import { expandTilde } from "./pathValidation.ts";
import type { PermissionResult } from "../../../types.ts";
const MAX_DIRS_TO_LIST = 5;
export function formatDirectoryList(directories: string[]): string {
  const dirCount = directories.length;
  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map((dir) => `'${dir}'`).join(", ");
  }
  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map((dir) => `'${dir}'`)
    .join(", ");
  return `${firstDirs}, and ${dirCount - MAX_DIRS_TO_LIST} more`;
}
export function containsPathTraversal(path: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path);
}
export function getDirectoryForPath(
  path: string,
  cwd: string = process.cwd(),
): string {
  let absolutePath = expandTilde(path);
  if (!isAbsolute(absolutePath)) {
    absolutePath = resolve(cwd, absolutePath);
  }
  if (absolutePath.startsWith("\\\\") || absolutePath.startsWith("//")) {
    return dirname(absolutePath);
  }
  try {
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      return absolutePath;
    }
  } catch {
  }
  return dirname(absolutePath);
}
const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:\/?$/;
const WINDOWS_DRIVE_CHILD_REGEX = /^[A-Za-z]:\/[^/]+$/;
export function isDangerousRemovalPath(resolvedPath: string): boolean {
  const forwardSlashed = resolvedPath.replace(/[\\/]+/g, "/");
  if (forwardSlashed === "*" || forwardSlashed.endsWith("/*")) {
    return true;
  }
  const normalizedPath =
    forwardSlashed === "/" ? forwardSlashed : forwardSlashed.replace(/\/$/, "");
  if (normalizedPath === "/") {
    return true;
  }
  if (WINDOWS_DRIVE_ROOT_REGEX.test(normalizedPath)) {
    return true;
  }
  const normalizedHome = homedir().replace(/[\\/]+/g, "/");
  if (normalizedPath === normalizedHome) {
    return true;
  }
  const parentDir = dirname(normalizedPath);
  if (parentDir === "/") {
    return true;
  }
  if (WINDOWS_DRIVE_CHILD_REGEX.test(normalizedPath)) {
    return true;
  }
  return false;
}
export function checkDangerousRemovalPaths(
  command: "rm" | "rmdir",
  args: string[],
  cwd: string,
  extractPaths: (args: string[]) => string[],
): PermissionResult {
  const paths = extractPaths(args);
  for (const p of paths) {
    const cleanPath = expandTilde(p.replace(/^['"]|['"]$/g, ""));
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath);
    if (isDangerousRemovalPath(absolutePath)) {
      return {
        behavior: "ask",
        message: `Dangerous ${command} operation detected: '${absolutePath}'\n\nThis command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
        decisionReason: {
          type: "other",
          reason: `Dangerous ${command} operation on critical path: ${absolutePath}`,
        },
        suggestions: [],
      };
    }
  }
  return {
    behavior: "passthrough",
    message: `No dangerous removals detected for ${command} command`,
  };
}
