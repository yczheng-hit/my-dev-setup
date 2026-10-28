# herdr-pane-id

herdr 插件 `local.pane-id`：整理 herdr 侧栏的 Agents 行，并补上 pane ID。Spaces 保持 herdr 原样。

```
1 · tools · pi-config      ← 编号代替状态圆点，随状态变色；后面是工作区 · tab
  pi · w1:p3               ← agent · pane ID
```

| 显示 | 来源 | 配置（`herdr/config.toml`） |
| --- | --- | --- |
| Agents 第一行的编号 `1` | 每个 agent pane 的 state label（各状态都设为编号），由 `state_text` 显示 | `{ token = "state_text", bold = true }` |
| 等待确认时 `1 approval` / `1 plan ready`（红） | pi 写的 blocked state label（`herdr-ui-prompt-blocked.ts`） | 同上 |
| Agents 第二行 `pi · w1:p3` | pane token `$pane_id` | `{ token = "$pane_id", dim = true }` |

- 编号按 `herdr agent list` 顺序（侧栏从上到下），与 `focus_agent`（`prefix+N`）一致。
- 编号颜色就是状态色：空闲绿、工作橙、等待红、完成蓝（`[theme.custom]` 把 tokyo-night 的 yellow/teal 改成橙/蓝，和绿色拉开）。工作区名和 tab 名保持 herdr 原来的颜色。
- 编号后的 ` · ` 和第二行的缩进是 herdr 写死的，不能配置。
- 何时更新：herdr 启动；pane 新建、关闭、退出、移动；检测到 agent 或 agent 退出；tab 关闭、移动；工作区新建、关闭、拖动。每次全量扫描，已正确的跳过。
- 手动刷新：`herdr plugin action invoke local.pane-id.sync`。
- 只写显示用的 metadata（source `local.pane-id`），不影响 agent 状态，也不发按键。
- `./setup.sh` 自动 `herdr plugin link` 本目录；日志：`herdr plugin log list --plugin local.pane-id`。
