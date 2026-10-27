# herdr-pane-id

herdr 插件 `local.pane-id`：给 herdr 侧栏补编号和 pane ID。

| 显示 | 来源 | 配置（`herdr/config.toml`） |
| --- | --- | --- |
| Agents 行首的 agent 编号 `1` `2` `3`，颜色随状态（空闲绿 / 工作黄 / 等待红 / 完成蓝） | 每个 agent pane 的 state label 都设为编号，由 `state_text` 显示，代替状态圆圈 | Agents 第一行 `{ token = "state_text", bold = true }` |
| Agents 第二行的 pane ID：`pi · w1:p3` | pane token `$pane_id` | `{ token = "$pane_id", dim = true }` |
| Spaces 的工作区序号：`● 1 · tools` | 工作区 token `$ws_num` | `[ui.sidebar.spaces]` |

- agent 编号按 `herdr agent list` 顺序，也就是侧栏从上到下的顺序，与 `focus_agent`（`prefix+N`）一致。
- 何时更新：herdr 启动；pane 新建、关闭、退出、移动；检测到 agent 或 agent 退出；tab 关闭、移动；工作区新建、关闭、拖动。每次全量扫描，已正确的跳过。
- 手动刷新：`herdr plugin action invoke local.pane-id.sync`。
- 只写显示用的 metadata（source `local.pane-id`），不影响 agent 状态，也不发按键。
- 本插件占用 state label；pi 的等待原因只用 `$blocked_reason` token（`pi/extensions/herdr-ui-prompt-blocked.ts`）。
- `./setup.sh` 自动 `herdr plugin link` 本目录；日志：`herdr plugin log list --plugin local.pane-id`。
