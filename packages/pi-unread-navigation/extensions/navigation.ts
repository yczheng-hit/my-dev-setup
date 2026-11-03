import { createHash } from 'node:crypto';

// Deliberately narrow, version-guarded adapter for Pi 1.4's fullscreen renderer.
// No prototype/host patch. Unknown layouts retain the native bottom action.
type AnyObject = Record<string | symbol, any>;
type Span = { start: number; height: number; width: number; visibleStart: number; visibleEnd: number };
type Reply = { id: string; key: string; spans: Span[]; seen: Map<number, { shape: string; ranges: [number, number][] }> };
type Options = { dwellMs?: number; limit?: number; onChange?: (count: number) => void; onUnsupported?: (reason: string) => void };

export function finalReplyKey(message: any): string | undefined {
  if (message?.role !== 'assistant' || message.stopReason !== 'stop' || !Array.isArray(message.content) ||
      message.content.some((part: any) => part.type === 'toolCall')) return;
  const texts = message.content.filter((part: any) => part.type === 'text' && part.text?.trim()).map((part: any) => part.text);
  if (!texts.length) return;
  return createHash('sha256').update(JSON.stringify([message.timestamp, message.provider, message.model, texts])).digest('hex');
}

// InteractiveMode passes a stable forwarding Proxy, not the renderer itself.
// A temporary instance-only method obtains its receiver, including after a mode switch.
export function resolveRenderer(reference: AnyObject): AnyObject {
  const probe = Symbol('pi-unread-receiver');
  reference[probe] = function (this: AnyObject) { return this; };
  let target: AnyObject | undefined;
  try { target = reference[probe](); return target!; }
  finally { if (target) delete target[probe]; else reference[probe] = undefined; }
}

function merge(ranges: [number, number][], start: number, end: number): [number, number][] {
  const sorted = [...ranges, [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else result.push([...range]);
  }
  return result;
}

export function installNavigation(reference: AnyObject, options: Options = {}) {
  const replies = new Map<string, Reply>();
  const limit = Math.max(1, options.limit ?? 100);
  const dwellMs = Math.max(0, options.dwellMs ?? 600);
  let overflow = 0;
  let target: AnyObject | undefined;
  let restore: (() => void) | undefined;
  let disposed = false;
  let focused = true;
  let blocked = false;
  let jumped: string | undefined;
  let humanDepth = 0;
  let bottomUsed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sampleKey: string | undefined;
  let warned = false;
  let components = new WeakMap<object, { message: any; key: string | undefined }>();
  const count = () => replies.size + overflow;
  const changed = () => options.onChange?.(count());
  const cancelSample = () => { if (timer) clearTimeout(timer); timer = undefined; sampleKey = undefined; };
  const warn = (reason: string) => { if (!warned) { warned = true; options.onUnsupported?.(reason); } };
  const unobscured = () => !!target && !target.stopped && target.altScreenActive && focused && !blocked && !target.hasOverlay();

  function geometry() {
    const frame = target?.currentLayout;
    const sv = target?.getPrimaryScrollView();
    if (!frame?.root || !sv || !Number.isFinite(sv.scrollTop)) return;
    let scrollBox: AnyObject | undefined;
    const find = (box: AnyObject) => {
      if (box.scrollView === sv) scrollBox = box;
      else for (const child of box.children ?? []) find(child);
    };
    find(frame.root);
    if (!scrollBox) return;
    for (const reply of replies.values()) reply.spans = [];
    const byKey = new Map([...replies.values()].map((reply) => [reply.key, reply]));
    const top = Math.max(0, scrollBox.rect.y, scrollBox.clip.y);
    let end = Math.min(frame.height, scrollBox.rect.y + scrollBox.rect.height, scrollBox.clip.y + scrollBox.clip.height);
    // The native jump indicator can cover the last transcript row.
    const indicator = target?.scrollToEndIndicatorRect;
    if (indicator && indicator.row >= top && indicator.row < end) end = indicator.row;
    const contentRow = (screenRow: number) => screenRow - scrollBox!.rect.y + sv.scrollTop;

    const visitComponent = (component: AnyObject, screenRow: number, width: number) => {
      if (component.lastMessage && component.contentContainer && !component.isStreaming) {
        let cached = components.get(component);
        if (!cached || cached.message !== component.lastMessage) {
          cached = { message: component.lastMessage, key: finalReplyKey(component.lastMessage) };
          components.set(component, cached);
        }
        const reply = cached.key ? byKey.get(cached.key) : undefined;
        if (reply) {
          // Direct Markdown children are answer text; thinking is in MouseRegion.
          const textChildren = new Set(component.contentContainer.children?.filter((child: AnyObject) => child.constructor?.name === 'Markdown'));
          const locate = (node: AnyObject, row: number, nodeWidth: number) => {
            if (textChildren.has(node)) {
              const height = node.cachedLines?.length;
              if (Number.isFinite(height) && height > 0) reply.spans.push({
                start: contentRow(row), height, width: nodeWidth,
                visibleStart: Math.max(0, top - row), visibleEnd: Math.min(height, end - row),
              });
              return;
            }
            if (node.mouseLayout?.width !== nodeWidth) return;
            for (const child of node.mouseLayout.children) {
              locate(child.component, row, nodeWidth);
              row += child.height;
            }
          };
          locate(component, screenRow, width);
        }
        return;
      }
      if (component.mouseLayout?.width !== width) return;
      for (const child of component.mouseLayout.children) {
        visitComponent(child.component, screenRow, width);
        screenRow += child.height;
      }
    };
    const visitBox = (box: AnyObject) => {
      if (box.lines) visitComponent(box.component, box.rect.y - (box.lineOffset ?? 0), box.rect.width);
      else for (const child of box.children ?? []) visitBox(child);
    };
    for (const child of scrollBox.children ?? []) visitBox(child);
    return { sv, frame, scrollBox };
  }

  function sample() {
    if (!count() || !unobscured()) { cancelSample(); return; }
    const view = geometry();
    if (!view) { cancelSample(); return; }
    const snapshot = [...replies.values()].map((reply) => [reply.id, reply.spans.map((span) =>
      [span.start, span.height, span.width, span.visibleStart, span.visibleEnd])]);
    const key = JSON.stringify([view.frame.width, view.frame.height, view.sv.scrollTop, snapshot]);
    if (sampleKey === key) return;
    cancelSample();
    if (![...replies.values()].some((reply) => reply.spans.some((span) => span.visibleEnd > span.visibleStart))) return;
    sampleKey = key;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !unobscured()) { cancelSample(); return; }
      // Re-render/layout changes replace this sample; do not credit transient frames.
      const current = geometry();
      if (!current || JSON.stringify([current.frame.width, current.frame.height, current.sv.scrollTop,
        [...replies.values()].map((reply) => [reply.id, reply.spans.map((span) =>
          [span.start, span.height, span.width, span.visibleStart, span.visibleEnd])])]) !== key) { cancelSample(); return; }
      let removed = false;
      for (const reply of replies.values()) {
        reply.spans.forEach((span, i) => {
          const shape = `${span.width}:${span.height}`;
          let seen = reply.seen.get(i);
          if (!seen || seen.shape !== shape) { seen = { shape, ranges: [] }; reply.seen.set(i, seen); }
          if (span.visibleEnd > span.visibleStart) seen.ranges = merge(seen.ranges, span.visibleStart, span.visibleEnd);
        });
        if (reply.spans.length && reply.spans.every((span, i) => {
          const ranges = reply.seen.get(i)?.ranges;
          return ranges?.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= span.height;
        })) { replies.delete(reply.id); removed = true; }
      }
      sampleKey = undefined;
      if (removed) changed();
    }, dwellMs);
    timer.unref?.();
  }

  function humanBottom(original: (...args: any[]) => any, receiver: AnyObject, args: any[]) {
    bottomUsed = true;
    if (!humanDepth) { jumped = undefined; return original.apply(receiver, args); }
    if (!count() || !unobscured()) return original.apply(receiver, args);
    if (!replies.size && overflow) {
      overflow = 0; cancelSample(); changed();
      return original.apply(receiver, args);
    }
    if (jumped && replies.has(jumped)) {
      replies.clear(); overflow = 0; jumped = undefined; cancelSample(); changed();
      return original.apply(receiver, args);
    }
    const view = geometry();
    const reply = [...replies.values()].find((candidate) => candidate.spans.length);
    if (!view || !reply) {
      warn('Final reply layout unavailable; native jump-to-bottom retained.');
      return original.apply(receiver, args);
    }
    jumped = reply.id;
    cancelSample();
    view.sv.scrollTo(reply.spans[0].start, { disableFollow: true });
    target!.requestRender();
  }

  function refreshAttachment() {
    if (disposed) return;
    const next = resolveRenderer(reference);
    if (next === target) return;
    restore?.(); restore = undefined; cancelSample(); target = next;
    components = new WeakMap();
    for (const reply of replies.values()) { reply.spans = []; reply.seen.clear(); }
    if (next.mode !== 'fullscreen') return;
    const names = ['handleViewportInput', 'handleScrollToEndIndicatorMouseEvent', 'scrollToBottom', 'doRender', 'getPrimaryScrollView', 'hasOverlay'];
    if (!names.every((name) => typeof next[name] === 'function') || !('currentLayout' in next)) {
      warn('Unsupported Pi fullscreen renderer; native navigation retained.'); return;
    }
    const undo: (() => void)[] = [];
    let active = true;
    const wrap = (name: string, handler: (original: (...args: any[]) => any, receiver: AnyObject, args: any[]) => any) => {
      const original = next[name];
      const hadOwn = Object.hasOwn(next, name);
      const wrapped = function (this: AnyObject, ...args: any[]) {
        return active ? handler(original, this, args) : original.apply(this, args);
      };
      next[name] = wrapped;
      undo.push(() => { if (next[name] === wrapped) { if (hadOwn) next[name] = original; else delete next[name]; } });
    };
    const dispatch = (original: (...args: any[]) => any, receiver: AnyObject, args: any[]) => {
      const top = next.viewportTop;
      const outer = humanDepth === 0;
      if (outer) bottomUsed = false;
      humanDepth++;
      try { return original.apply(receiver, args); }
      finally {
        humanDepth--;
        if (outer && !bottomUsed && top !== next.viewportTop) jumped = undefined;
      }
    };
    wrap('handleViewportInput', (original, receiver, args) => {
      if (args[0] === '\x1b[O') { focused = false; cancelSample(); }
      if (args[0] === '\x1b[I') { focused = true; next.requestRender(); }
      return dispatch(original, receiver, args);
    });
    wrap('handleScrollToEndIndicatorMouseEvent', dispatch);
    wrap('scrollToBottom', humanBottom);
    wrap('doRender', (original, receiver, args) => {
      const result = original.apply(receiver, args);
      try { sample(); } catch { cancelSample(); warn('Unsupported final reply layout; native navigation retained.'); }
      return result;
    });
    restore = () => { active = false; for (const fn of undo.reverse()) fn(); };
  }
  refreshAttachment();
  return {
    get count() { return count(); },
    add(id: string, message: any) {
      if (disposed || replies.has(id)) return;
      const key = finalReplyKey(message);
      if (!key) return;
      if (replies.size < limit) replies.set(id, { id, key, spans: [], seen: new Map() });
      else overflow++;
      changed(); target?.requestRender();
    },
    setBlocked(value: boolean) { blocked = value; if (value) cancelSample(); else target?.requestRender(); },
    reset() { replies.clear(); overflow = 0; jumped = undefined; cancelSample(); components = new WeakMap(); changed(); },
    refreshAttachment,
    dispose() { if (disposed) return; disposed = true; cancelSample(); restore?.(); replies.clear(); overflow = 0; target = undefined; },
  };
}
