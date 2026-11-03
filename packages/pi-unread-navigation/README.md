# pi-unread-navigation

Local, fullscreen-only final-answer navigation for Pi 1.4. Included in this repo's desired `pi/settings.json`; **editing that file does not enable it in an already-running Pi**.

## Interaction

- The native **Jump to latest** shortcut (default Ctrl+End) and bottom mouse indicator first show the **earliest unread final answer's text start**, not its thinking or tool logs.
- Repeat the jump while that answer is still unread to explicitly acknowledge all pending answers and go to the real bottom. Normal manual scrolling away resets this repeat intent.
- New completions never force-scroll a reader viewing history. A compact widget shows the pending count; `/unread` explains status.
- Programmatic `scrollToBottom()`, streaming follow mode, editor, footer and other widgets keep their native behavior.

A marker is created only for new successful, text-bearing, tool-free assistant messages after `agent_settled`, tied to the native session entry ID. Aborted, length-limited, failed, thinking-only, tool, summary and restored-history messages are not final-answer markers. Branch navigation, session replacement and reload reset markers; they are ephemeral UI state, not transcript edits.

## “Read” is an approximation, not comprehension

A final answer is acknowledged after **every text row** has been stably visible for at least 600 ms, or after the explicit repeat jump. Merely rendering an answer offscreen, passing its beginning transiently, or following its tail does not acknowledge its unseen prefix. Multiple text blocks are tracked separately. Visible overlays, nested UI prompts and reported terminal focus-out suspend reading credit. Terminals without focus reports cannot provide focus guarantees.

Resize/reflow and thinking/tool expansion use the current native layout and Container render-cache dimensions to recompute text offsets; no durable absolute row numbers. Width/height changes reset affected reading coverage conservatively. At most 100 answer anchors are retained; excess markers remain counted until explicit acknowledgement instead of silently disappearing.

## Compatibility / rollback

Pi exposes no public final-message scroll-anchor API. This package therefore has a narrow **instance-only compatibility adapter**, guarded against unsupported fullscreen renderer shapes. It resolves Pi's forwarding TUI reference, wraps only human input dispatch plus render observation, and restores its own methods/timer on disposal. It never changes a host file or global prototype. A later third-party wrapper is preserved and this package's captured wrapper becomes inert after disposal.

Regular terminal scrollback, RPC, JSON and print modes retain native navigation; no fake scrollback control. Unsupported layouts warn once and retain the native bottom action. When updating Pi, rerun these tests before activation. Remove the package from desired settings and reload at a user-chosen idle point to roll back; active session changes require separate approval.

## Validation

```sh
PI_HOST_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
  node --test packages/pi-unread-navigation/test/*.test.mjs
```

Tests use real Pi 1.4 fullscreen renderer, AssistantMessageComponent, chat viewport, forwarding proxy, native key/mouse handlers and layout/render caches with synthetic messages and an inert terminal. No model, network, actual user session, active host modification or terminal restart.

Negative control (expected failure: native bottom skips the answer beginning):

```sh
PI_HOST_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
  UNREAD_NATIVE_CONTROL=1 node --test packages/pi-unread-navigation/test/navigation.test.mjs
```
