import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { finalReplyKey, installNavigation } from './navigation';

const KEY = 'unread-final-replies';

export default function unreadNavigation(pi: ExtensionAPI) {
  let navigation: ReturnType<typeof installNavigation> | undefined;
  let latestKey: string | undefined;
  let prompts = 0;
  let rendererReference: Parameters<typeof installNavigation>[0] | undefined;
  const reset = () => { latestKey = undefined; prompts = 0; navigation?.setBlocked(false); navigation?.reset(); };

  pi.on('session_start', (_event, ctx) => {
    reset();
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget(KEY, (tui, theme) => {
      let unread = 0;
      let disabled = false;
      try {
        navigation = installNavigation(tui, {
          onChange: (count) => { unread = count; tui.requestRender(); },
          onUnsupported: (reason) => { disabled = true; ctx.ui.notify(`Unread navigation: ${reason}`, 'warning'); },
        });
        rendererReference = tui;
      } catch {
        ctx.ui.notify('Unread navigation unavailable on this Pi renderer; native navigation retained.', 'warning');
      }
      return {
        render(width) {
          try { navigation?.refreshAttachment(); } catch { /* mode-switch race: leave native navigation intact */ }
          if (tui.mode !== 'fullscreen' || disabled || !unread) return [];
          return [truncateToWidth(theme.fg('accent', `${unread} unread final ${unread === 1 ? 'reply' : 'replies'} · Jump to latest: answer start, again: bottom`), width)];
        },
        invalidate() {},
        dispose() { navigation?.dispose(); navigation = undefined; rendererReference = undefined; },
      };
    });
  });
  pi.on('message_end', (event) => {
    if (event.message.role === 'assistant') latestKey = finalReplyKey(event.message);
    else if (event.message.role === 'user') latestKey = undefined;
  });
  pi.on('agent_settled', (event, ctx) => {
    const key = latestKey;
    latestKey = undefined;
    if (!navigation || event.aborted || !key) return;
    // Resolve the native entry ID once at settlement, never on a rendering tick.
    // Do not manufacture unread markers for restored history, summaries, or commentary.
    const entry = ctx.sessionManager.getBranch().findLast((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    if (entry?.type === 'message' && finalReplyKey(entry.message) === key) navigation.add(entry.id, entry.message);
  });
  pi.on('ui_prompt_start', () => { prompts++; navigation?.setBlocked(true); });
  pi.on('ui_prompt_end', () => { prompts = Math.max(0, prompts - 1); navigation?.setBlocked(prompts > 0); });
  pi.on('session_tree', reset);
  pi.on('session_shutdown', (_event, ctx) => {
    navigation?.dispose(); navigation = undefined; reset(); rendererReference = undefined;
    if (ctx.mode === 'tui') ctx.ui.setWidget(KEY, undefined);
  });
  pi.registerCommand('unread', {
    description: 'Show unread-final-reply navigation status (fullscreen only)',
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${navigation?.count ?? 0} unread final replies. ${rendererReference?.mode === 'fullscreen' ? 'Jump to latest shows the earliest unread answer; repeat to acknowledge all and go to bottom.' : 'Fullscreen Pi 1.4 renderer required; regular terminal scrollback keeps native navigation.'}`, 'info');
    },
  });
}
