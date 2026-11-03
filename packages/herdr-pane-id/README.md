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
- `pi-subagents` 的异步详情不占用编号：`packages/pi-subagents-herdr-labels` 只过滤上游桥的 state-label 写入，保留摘要/标题和清理；这里不增加周期刷新来竞争 metadata。
- `./setup.sh` 自动 `herdr plugin link` 本目录；日志：`herdr plugin log list --plugin local.pane-id`。

## 本地性能与生命周期修复（0.7.0，尚未部署）

- 先测量：10 个合成并发生命周期事件，旧代码运行 10 次全量扫描 / 30 个 CLI 子进程。新增按 `HERDR_SOCKET_PATH` + binary 隔离的短时 writer lease，100ms 合并窗口；同一 fixture 变为 1 次扫描 / 3 个子进程。没有 socket 身份时不合并，避免串会话。
- 扫描过程中到来的事件记录 demand，writer 结束前/释放锁后再检查；失败释放锁，失去 lease 不标记完成。使用精确依赖 `proper-lockfile@4.1.2`，异步 CLI 保持 heartbeat 可运行，不新增常驻 daemon/周期刷新或全局清缓存。
- `HERDR_PANE_SYNC_DIR` 可覆盖临时协调目录；默认每用户私有 tmp 目录，按 socket hash 分区。残留已完成状态不会抑制后来的新事件；拒绝 root/分区 symlink、非本用户或可被组/其他用户写入的目录，token 用独占临时文件 + rename 更新。该检查不是对恶意同 UID 进程的安全隔离。
- `node --test packages/herdr-pane-id/test/*.test.mjs` 使用 fake Herdr，不连接实际 server、不修改实际 metadata。依赖通过仓库本地 npm 安装；激活/部署另获授权。
