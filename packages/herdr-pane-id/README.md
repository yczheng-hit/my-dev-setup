# herdr-pane-id

herdr 插件 `local.pane-id`：整理 herdr 侧栏的 Agents 行，并补上 pane ID 和工作区序号。

```
1 tools · pi-config        ← 编号 + 工作区 · tab，整段随状态变色
  pi · w1:p3               ← agent · pane ID
```

| 显示 | 来源 | 配置（`herdr/config.toml`） |
| --- | --- | --- |
| Agents 第一行 `1 tools · pi-config` | 每个 agent pane 的 state label（idle/working/done/unknown 都设为同一段文字），由 `state_text` 显示 | `[{ token = "state_text", bold = true }, "machine"]` |
| 等待确认时整行变成 `1 approval`（红） | blocked 的 state label；pi 会改成具体原因，如 `1 plan ready` | 同上 |
| Agents 第二行 `pi · w1:p3` | pane token `$pane_id` | `{ token = "$pane_id", dim = true }` |
| Spaces 的 `● 1 · tools` | 工作区 token `$ws_num` | `[ui.sidebar.spaces]` |

- 编号按 `herdr agent list` 顺序（侧栏从上到下），与 `focus_agent`（`prefix+N`）一致。
- 编号、工作区名、tab 名是同一个 token，所以编号后面没有 ` · `，颜色就是状态色：空闲绿、工作橙、等待红、完成蓝（`[theme.custom]` 把 tokyo-night 的 yellow/teal 改成橙/蓝，和绿色拉开）。
- 何时更新：herdr 启动；pane 新建、关闭、退出、移动；检测到 agent 或 agent 退出；tab 改名、关闭、移动；工作区新建、改名、关闭、拖动。每次全量扫描，已正确的跳过。
- 手动刷新：`herdr plugin action invoke local.pane-id.sync`。
- 只写显示用的 metadata（source `local.pane-id`），不影响 agent 状态，也不发按键。
- `./setup.sh` 自动 `herdr plugin link` 本目录；日志：`herdr plugin log list --plugin local.pane-id`。
