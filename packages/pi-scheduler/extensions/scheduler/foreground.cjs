"use strict";
// Foreground arbitration has no timers or Pi side effects; recheck immediately before dispatch.
function createForegroundGate({ now = Date.now, quietMs = 400 } = {}) {
  let paused = false, prompts = 0, lastActivity = -Infinity;
  return {
    touch() { lastActivity = now(); },
    prompt(active) { prompts = Math.max(0, prompts + (active ? 1 : -1)); lastActivity = now(); },
    pause(value) { paused = value; lastActivity = now(); },
    reset() { prompts = 0; lastActivity = -Infinity; },
    reason(ctx) {
      if (paused) return '已暂停';
      try {
        if (prompts) return '等待确认/编辑结束';
        if (!ctx.isIdle()) return '等待前台回合结束';
        if (ctx.hasPendingMessages?.()) return '等待人类排队消息';
        if (ctx.hasUI) {
          // A UI host without draft visibility cannot safely infer that the user is idle.
          if (!ctx.ui?.getEditorText) return '无法读取草稿状态';
          if (ctx.ui.getEditorText().length) return '等待提交或清空草稿';
          if (now() - lastActivity < quietMs) return '等待输入稳定';
        }
        return undefined;
      } catch { return '会话不可用'; }
    },
  };
}
module.exports = { createForegroundGate };
