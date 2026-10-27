# herdr-pane-id

herdr 插件 `local.pane-id`：把每个 pane 的 ID（如 `w1:p3`）写成 pane 自定义 token `$pane_id`，供左侧 Agents 列表显示，例如 `pi · w1:p3`。

- 何时更新：herdr 启动时、新建 pane（`pane.created`）、pane 跨工作区移动后换了 ID（`pane.moved`）、检测到 agent（`pane.agent_detected`）。每次把所有 pane 扫一遍，已经正确的跳过。
- 手动刷新：`herdr plugin action invoke local.pane-id.sync`。
- 显示位置由 `herdr/config.toml` 的 `[ui.sidebar.agents] rows` 决定：`["agent", { token = "$pane_id", dim = true }]`。
- 只写显示用的 metadata（source `local.pane-id`），不影响 agent 状态，也不发任何按键。
- `./setup.sh` 自动 `herdr plugin link` 本目录；查看日志：`herdr plugin log list --plugin local.pane-id`。
