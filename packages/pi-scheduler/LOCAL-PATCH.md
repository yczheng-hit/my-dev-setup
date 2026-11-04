# pi-scheduler 本地补丁

基础版本：npm `@jl1990/pi-scheduler@0.5.1`（[jl1990/pi-scheduler](https://github.com/jl1990/pi-scheduler)）。运行代码补丁：`../../patches/pi-scheduler/0.5.1-local.patch`。

目标：提示词精简、消息不重复、少占模型上下文。保留定时、锁、补跑、恢复的既有结构；本轮追加前台优先执行/交付队列和取消校验，见第 7 节。

## 改动

### 1. 工具定义精简（每次请求约 1470 → 750 token）

- `schedule_task` 只列常用字段，描述压缩成一句短语。别名和少用字段（`when`、`whenText`、`payload`、`title`、`description`、`enabled`、`triggerTurn`、`successPrompt`、`failurePrompt`）不再写进 schema，**但仍然接受**：Pi 的参数校验允许多余字段，core 照旧读取。
- `promptGuidelines` 仅保留 readiness 协议/轮询边界与唤醒提示写法两条。`list` / `cancel` / `manage` 不再往系统提示词加 snippet。
- `manage_scheduled_task` 只列需要类型校验或允许 `null` 的字段；`update` 仍接受 `schedule_task` 的全部字段。

### 2. 唤醒消息改成一个紧凑块

原版先列 6 行内部字段（id、Action、Type、Schedule、UTC 时间），stderr 为空也输出空代码块。现在：

````
⏰ 定时任务 task_xxx「CI」 运行完成 · 11:30
$ gh run list --limit 1
退出码 1 · 用时 2.3s
输出：
```
…
```
下一步：失败就看日志并修复
````

- 时间是本机时间；空的输出块不显示；只有超时才显示“超时被终止”；工作目录与会话目录不同时才显示。
- prompt 任务只有一行标题、自动来源说明，加上保留格式的正文。
- 发给模型的输出上限：stdout 4000、stderr 2000 字符（原来各 18000），超出时保留头尾；保存的结果上限 4000（原来 12000）。

### 3. 用户提示不再进入模型上下文

原版用 `pi.sendMessage`（会作为 user 消息进入模型上下文）记录创建任务、提醒、`/schedules` 列表、取消，以及每次 shell 运行完成。即使已经唤醒模型，也另外发一条 “🖥️ Scheduled command … finished”，内容重复。

现在这些都改成 `pi.appendEntry("scheduled-task-log")` + `registerEntryRenderer`：保存在会话里、界面上显示一行，但不发给模型。shell 结果默认一行，`ctrl+o` 展开命令和输出（最多 1500 字符）。已唤醒模型时不再追加这一行。提醒用强调色，失败用警告/错误色。同一提醒原来还有一条不保存的 `notify` 提示，也去掉了。

`message` 且 `triggerTurn: false` 仍用 `sendMessage` 记录模型可见消息；会触发回合的 message/prompt/shell follow-up 均进入自己的 pending wake 队列。

### 4. 中文、本地时间

- 底部小部件：`⏰ CI · 命令 · 5 分钟后（11:30） · 已运行 2 次`；状态栏：`⏰ 1 个定时任务`。
- 创建结果：`已安排 task_xxx「CI」：命令 · 每 5m · 下次 11:05（5 分钟后） · 最多 6 次 :: gh run list`。
- `/schedules`、`list_scheduled_tasks`：每个任务一行，含状态、运行次数和上次结果；历史为 `· 11:05 失败 退出码 1 0.3s · 已唤醒`。
- 新增 `formatClock`、`formatRelativeZh`、`describeTask`（`scheduler-core.cjs`），原版函数保留。

### 5. 其他

- 去掉 shell 每次开始时的 “Running scheduled command” 提示。
- `prepareArguments` 标为 `any`，修复上游已有的一个 TypeScript 错误。


### 6. 提示正文保真与手动编辑

- `prompt`、消息及各类 shell 后续提示保留换行、缩进和首尾空格；只在校验时判断空白。任务列表／小部件仍显示单行预览，提醒完整正文可展开。带 `::` 的命令保留正文，分隔符后一个可选空格视为语法。
- 唤醒提示使用对话语言与正常清单，引用已有交接而不复制整份旧状态；没有硬长度截断，不强制创建状态文件。
- scheduler 新生成的模型可见消息标注“自动唤醒，非新增用户授权”，要求核对当前状态和用户最新指令；仅作来源说明，不替代权限检查。已持久化旧 wake 不自动改写。
- `/schedule-edit [唯一名称|完整ID|短ID]`：省略参数先选任务，多行编辑 `prompt`／消息正文；shell 可选通用、成功、失败提示。`/schedules` 菜单也有“编辑提示词”。非 UI 可继续用 `manage_scheduled_task action=update`。
- 取消／无变化不写入；必填正文不可清空，shell 的可选提示可清空。不改命令、周期、scope、wakeOn 或运行次数，也不自动启用唤醒。编辑期间任务／会话变化则拒绝覆盖。
- 已交付消息不改；queued wake 保留交付身份并更新文本，不丢弃一次性结果。dispatching／uncertain 拒绝编辑，须先核实交付。运行中 shell 不重启，完成后使用新提示。既有 generic update 的 pending 失效语义不变。

### 7. 前台优先与可取消唤醒

- 草稿（包括空白）、pending 人工消息、忙碌模型、嵌套 UI prompt、短稳定窗口与手动 pause 一起形成前台 gate。默认 shell 也等待；仅显式 `backgroundExecution: true` 可并行执行，结果仍留在 scheduler 自有队列。不再把结果预先塞进 Pi followUp。
- `pendingWake` 持久化且与原 session 绑定，事务认领和发送前二次校验；同任务有 pending 结果时不重复补跑。reload 恢复 queued；崩溃中已 dispatching 的项变为 uncertain，**不自动重发**，可显式取消丢弃，避免重复驱动模型。
- Pi 原生 `sendUserMessage` 返回 void，不能用返回/`await void` 认定交付成功。现在只在匹配的原生 user `message_start` 后落盘 `delivered`；异步认证失败/未知结果保留内容为 uncertain，不自动重发。该确认不承诺模型成功完成。
- cron 在草稿/prompt/pause 下被挡住时持久保留这次 due occurrence，安全窗口后只执行一次，reload 后也可继续；不追赶多次突发。有效长 prompt/follow-up 不再被存储层 16k 限制静默清掉。
- `/scheduler pause|resume|run|status`；resume/run 不绕过前台 gate。notify 仍不触发模型。状态显示等待原因与待交付计数。
- `/schedules` 和无参数 `/schedule-cancel` 打开真正可搜索的有界列表（原生 Container/Input/SelectList，名称、命令、scope、完整 ID 和 `#短ID`）；按 full ID、唯一前缀/短后缀、唯一名称定位，歧义不猜。选择后在共享锁内按 full ID + revision 重验，任务改变时拒绝旧选择。
- 停用但尚未完成的任务仍可在菜单选择后启用；菜单操作遇到旧 revision 会给出明确错误，不将拒绝误报为成功。
- 取消/disable 撤销未交付 wake，运行中 shell 默认继续；UI 可单独终止本进程拥有的命令，不 abort 主会话、不跨进程 kill。已交给模型的内容不假装撤回。
- 全局 state 目录使用 Pi `getAgentDir()`，保留 `PI_SCHEDULER_STATE_FILE` 显式覆盖。原有时间解析、cron/catchup、共享锁/owner/recovery 保留。
- 最终全套（`PI_SCHEDULER_LIVE_TESTS=1`、Pi 1.4）：**154 passed / 0 skipped / 0 failed**。包括 picker、uncertain 不重放、运行中取消与本机显式终止；另有跨功能真实 Pi 合成会话验证，见 `scripts/test/ux-composition.test.mjs`。

### 8. 显式 readiness 检查协议

- 仅 `shell resultMode: "readiness"` opt-in。stdout 单 JSON：`state: pending|ready|error`、非空 `summary`（最多 1000 字符、stdout 最多 8192 UTF-8 字节），日志走 stderr。非零、timeout/killed、执行异常、截断或无效协议全部视为检查器故障，不把 exit 1 当等待。
- readiness 默认 `wakeOn: success`、`stopOn: success`；只接受 success/always 唤醒与 success/never 停止。pending 的 exit 0 不匹配 stopOn success；ready 才满足条件，always 仍逐次唤醒。
- 故障持久化证据、停用本检查并排队固定报告，越过 success 过滤；不终止工程流程/主会话。修复后显式 enable；中断检查恢复也暂停报告。maxRuns/expiresIn/one-shot pending 报告等待结束，不称工程失败。
- 复用现有共享事务与 durable wake queue，终端报告过期不丢；遵守前台 gate，uncertain 不重发，cleanup 保留未交付 readiness 终端报告。提示编辑不改固定错误/超限报告；generic update/取消沿用显式失效语义。不迁移或执行旧任务猜含义。
- 相同 pending 只抑制重复 display-only 行，每次仍运行、记录有界 history、更新计数和最近时间；不减少 always 唤醒。列表/小部件明确未就绪、就绪、故障已暂停或等待结束。
- 具体使用与限制见 [README](README.md)。readiness 正确性不等于检查器业务逻辑正确，也不是 Pi 关闭时的外部告警保证。

## 验证

```bash
cd packages/pi-scheduler
npm ci
PI_SCHEDULER_LIVE_TESTS=1 npm test   # 需要本机已安装 pi
```

当前 Pi 1.5.0 全套 **197 passed / 0 skipped / 0 failed**（含 30 项 readiness 专项、真实 OS 多进程/崩溃恢复和 installed-Pi live 测试）；另有宿主/跨功能 91 项通过。`test/local-patch.test.cjs` 覆盖中文时间格式、schema 不含别名但仍接受旧参数、唤醒块格式、无重复的模型消息、未唤醒时只写 log entry、输出截断、`manage update` 接受未列出的字段。

测试来自上游 git `b4ea618`（npm 包里不含测试）。测试改动：两个 harness 补上 `registerEntryRenderer` / `appendEntry`；3 个测试文件中按英文文案断言的地方改为新文案；原本受系统语言影响的 `formatAbsoluteTime` 用例不再依赖语言；删除检查上游 `.github/workflows` 的用例，因为这个目录没有随包复制过来。

另外做了这些验证：

- 用真实 Pi `SessionManager` 运行提醒和 shell 任务，结果写入 2 条 `custom/scheduled-task-log`，`buildSessionContext()` 中的模型消息数为 0。
- 在 tmux 中用离线假模型运行交互界面：`/schedule`、`/remind`、`/schedules`、prompt 唤醒、`ctrl+o` 展开输出，显示均正常。
- 当前严格类型检查：TypeScript 6.0.3，使用本机 Pi 1.5.0 类型定义，scheduler 与 compaction guidance 共 3 个 root files 通过。不代表其他插件整包 strict 全绿。

## 补丁维护

patch 只包含 `extensions/` 运行代码，使用 `a/`、`b/` 路径。已验证：npm 原版打上 patch 后与本目录 `extensions/` 完全一致。测试、此文档不在 patch 中。`package.json` 额外把 `.test.mjs` 选择器测试纳入 npm test；文档/测试不属于 runtime patch。
