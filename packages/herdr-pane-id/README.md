# herdr-pane-id

herdr 插件 `local.pane-id`：给 herdr 侧栏提供两个自定义 token。

| token | 含义 | 显示位置（`herdr/config.toml`） |
| --- | --- | --- |
| `$pane_id` | pane ID，如 `w1:p3` | Agents 第二行：`pi · w1:p3` |
| `$ws_num` | 工作区序号 1、2、3…，与 `prefix+shift+N` 一致 | Agents 第一行和 Spaces：`1 · tools` |

- 何时更新：herdr 启动、新建 pane、pane 跨工作区移动、检测到 agent、新建/关闭/拖动工作区。每次全量扫描，已正确的跳过；序号随工作区顺序变化。
- 手动刷新：`herdr plugin action invoke local.pane-id.sync`。
- 只写显示用的 metadata（source `local.pane-id`），不影响 agent 状态，也不发任何按键。
- `./setup.sh` 自动 `herdr plugin link` 本目录；查看日志：`herdr plugin log list --plugin local.pane-id`。
