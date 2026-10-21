# pi-fork-save

只保存分叉，不切换当前会话，不启动后台 agent。

## 使用

运行 `/reload` 后：

```text
/fork-save
/fork-save 分析方案B
```

有多轮对话时弹出分叉位置菜单，默认第一项 **当前位置（完整复制当前分支）**，直接回车即可。也可以选择某个较早回合：副本包含该用户消息及其后续回答、工具结果，直到下一条用户消息之前。菜单只列当前分支，不列废弃分支。

不指定名称时，自动命名为 `原会话名称 · fork 月-日 时:分`；原会话未命名则使用工作目录名。名称保存在 Pi 原生会话元数据中。

成功后显示新会话 ID，并**仅把 ID** 复制到剪贴板；屏幕同时显示简短的恢复命令：

```sh
pi --session 新会话ID
```

在当前工作目录的默认会话目录下，直接运行该命令即可；Pi 也会跨项目查找 ID。或者从 `/resume` 按名称打开。使用自定义 `--session-dir` 时，在恢复命令中同样传入该目录。

- 当前会话不切换；不改变编辑器内容、名称或历史。
- 不启动新 Pi 进程、模型请求、后台任务或终端面板。
- 副本是创建时的快照，两边后续对话各自保存，不同步。
- 只隔离会话历史，**工作目录和磁盘文件仍共享**。
- 保留所选路径上的对话、工具结果、压缩摘要、模型/思考级别、扩展状态和标签，记录 `parentSession` 指向源文件。
- 原生 `/fork`、`/clone` 的行为不变。
- 当前回复进行中时拒绝保存，以免复制不完整的工具调用。
- `--no-session` 或尚未写入文件的空会话不能保存。
- 从 `/resume` 打开副本时，Pi 仍会正常切换会话；本插件只保证**创建**副本时不切换。

## 实现

`ctx.sessionManager` 是只读接口，因此打开一个独立的 `SessionManager`，调用 Pi 导出的 `createBranchedSession(leafId)` 提取所选路径，再给副本保存名称。它不调用运行中会话的 `ctx.fork` / `ctx.switchSession`，也不手写 JSONL 格式。

注册在仓库 `pi/settings.json` 的 `repo:packages/pi-fork-save`；部署脚本会解析成本地路径。

## 验证

测试需要指向 Pi 安装目录，不写入用户会话或剪贴板：

```sh
export PI_HOST_DIR="$(npm root -g)/@earendil-works/pi-coding-agent"
npm test --prefix packages/pi-fork-save
```

真实 TUI 集成测试需安装 `tmux`。它启动独立的临时 tmux server 和两个 Pi TUI，使用仓库已有的本地假模型，不产生付费请求；结束后清理临时文件和自己的 server：

```sh
PI_FORK_SAVE_LIVE_TEST=1 node packages/pi-fork-save/test/live-fork-save.mjs
```

验证：创建副本不改写源文件；原窗口继续写入源会话；之后 `--session ID` 恢复完整副本上下文；副本与原会话能分别继续。
