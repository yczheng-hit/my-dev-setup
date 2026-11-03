import { Container, Input, SelectList, Text, getKeybindings } from '@earendil-works/pi-tui';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';

export type PickerItem = { value: string; label: string; description?: string };
/** Native TUI components, bounded viewport and incremental substring search (including CJK). */
export function createTaskPicker(items: PickerItem[], theme: { fg(color: 'accent' | 'dim', text: string): string },
  done: (value: string | undefined) => void, requestRender: () => void) {
  const root = new Container();
  const input = new Input();
  const makeList = (choices: PickerItem[]) => {
    const next = new SelectList(choices, 10, getSelectListTheme());
    next.onSelect = (item) => done(item.value); next.onCancel = () => done(undefined);
    return next;
  };
  let list = makeList(items);
  root.addChild(new Text(theme.fg('accent', '选择任务 · 输入名称 / 命令 / ID 搜索'), 0, 0));
  root.addChild(input); root.addChild(list);
  root.addChild(new Text(theme.fg('dim', '↑↓ 选择 · Enter 确认 · Esc 取消'), 0, 0));
  return {
    render: (width: number) => root.render(width),
    invalidate: () => root.invalidate(),
    handleInput(data: string) {
      const kb = getKeybindings();
      if ((['tui.select.up', 'tui.select.down', 'tui.select.confirm', 'tui.select.cancel'] as const).some((key) => kb.matches(data, key))) list.handleInput(data);
      else {
        input.handleInput(data);
        const query = input.getValue().toLowerCase();
        // Native SelectList.setFilter only matches value prefixes, not names/descriptions.
        list = makeList(items.filter((item) => `${item.label} ${item.description ?? ''} ${item.value}`.toLowerCase().includes(query)));
        root.children[2] = list;
      }
      requestRender();
    },
  };
}
