import { MODE_META, type PermissionMode } from "./types.ts";
export function modeMetaTitle(mode: PermissionMode): string {
  return MODE_META[mode].title;
}
export function modeMetaShortTitle(mode: PermissionMode): string {
  return MODE_META[mode].shortTitle;
}
export function modeMetaSymbol(mode: PermissionMode): string {
  return MODE_META[mode].symbol;
}
export function modeMetaColor(
  mode: PermissionMode,
): "text" | "muted" | "accent" | "warning" | "error" | "success" | "dim" {
  return MODE_META[mode].color;
}
export { MODE_META, type PermissionMode } from "./types.ts";
