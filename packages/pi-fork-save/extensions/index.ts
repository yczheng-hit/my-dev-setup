import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultForkName, forkPoints, normalizeName, saveFork } from "./fork-save.ts";

export default function (pi: ExtensionAPI) {
  registerForkSave(pi);
}

/** `copy` is injectable so tests do not overwrite the real clipboard. */
export function registerForkSave(pi: Pick<ExtensionAPI, "registerCommand">, copy: (text: string) => Promise<void> = copyToClipboard) {
  pi.registerCommand("fork-save", {
    description: "Save a fork of this session without switching to it: /fork-save [name]",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("请等当前回复结束后再分叉保存，避免复制不完整的工具调用", "warning");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("当前会话不保存到文件（--no-session），无法分叉保存", "error");
        return;
      }

      const points = forkPoints(ctx.sessionManager.getBranch());
      if (points.length === 0) {
        ctx.ui.notify("当前会话还没有内容，无法分叉保存", "warning");
        return;
      }

      let point = points[0]!;
      if (ctx.hasUI && points.length > 1) {
        const labels = points.map((p) => p.label);
        const choice = await ctx.ui.select("分叉保存到哪里为止？（当前会话保持在前台）", labels);
        if (choice === undefined) return;
        const selected = points[labels.indexOf(choice)];
        if (!selected) return;
        point = selected;
      }

      // A dialog can stay open while the underlying session changes.
      if (!ctx.isIdle() || ctx.sessionManager.getSessionFile() !== sessionFile) {
        ctx.ui.notify("会话状态已改变，请重新运行 /fork-save", "warning");
        return;
      }

      const name = normalizeName(args) || defaultForkName(ctx.sessionManager.getSessionName(), ctx.cwd);
      try {
        const saved = saveFork(sessionFile, ctx.sessionManager.getSessionDir(), point.leafId, name);
        const command = `pi --session ${saved.id}`;
        let copied = false;
        try {
          await copy(saved.id);
          copied = true;
        } catch {
          // The command stays visible in the notification.
        }
        ctx.ui.notify(
          `已保存分叉「${saved.name}」，当前会话未切换。\n会话 ID：${saved.id}\n${command}${copied ? "\n（仅会话 ID 已复制到剪贴板）" : ""}\n也可在 /resume 中按名称打开。`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`分叉保存失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
