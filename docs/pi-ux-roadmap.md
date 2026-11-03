# Pi 工作台体验改进：本地实现与验收记录

## 范围与状态

用户已通过“开始处理，完成这个方案”授权完整本地方案：AGENTS-only、独立 auto reviewer、BTW reload、前台优先 scheduler、易取消任务、未读最终回复导航，以及部署前检查/inventory、CJK HUD、Herdr 提示与有测量依据的性能修复。**不运行 setup、不部署配置、不修改活动 Pi 安装、不把默认 bypass 改成 auto、不改远端或 Herdr-managed integration、不伪造身份、不读取真实会话正文。**

| 工作 | 当前状态 | 下一步 |
| --- | --- | --- |
| 移除 Claude Code 自动配置耦合 | 仓库实现、临时宿主副本及完整扩展组合预检完成 | 实际宿主激活需另授权 |
| 独立 auto reviewer | 运行代码、命令、安全门、离线集成测试完成 | 实际审核 provider 可用性、UI 和部署验收 |
| BTW native 依赖 reload | 本地修复；双版本回归与真实 bundled TUI 多次改源 reload 通过 | 远端激活另获授权，身份缺失根因仍单列 |
| 返回底部优先定位未读最终回复 | 独立包本地实现；20 项真实 TUI 组件/布局回归、严格类型检查通过 | 完整加载与合成跨功能会话通过；实际目标会话启用需另授权 |
| scheduler 不打断 steer | 本地前台 gate + durable pending wake；含 live 的全套 **150/150** 通过 | 部署/目标会话启用另授权 |
| scheduler 易于辨认和取消 | 原生可搜索有界选择器、名称/完整 ID/短 ID 消歧、revision 重验、uncertain 不重放、显式本机终止 | 部署/目标会话启用另授权 |
| 部署前支持项 | 完整 loader、inventory/restore、自定义 agent-dir、嵌套提示、CJK 和测量后性能修复本地通过；真实 Pi 合成跨功能会话通过 | 实际 provider、实际 UI 和部署验收另授权 |

支持项已纳入授权范围，但不把未完成项混报为通过。性能优化先测量；任何激活、安装更新、远端操作均另获授权。

## 0. BTW 交接修复：先解决已证实的 reload 缓存

### 已证实与未知项分开

- `025190d` 仅是缺少官方身份的诊断与一次报错，不是功能恢复。远端后来被外部进程替换后官方身份元数据恢复，但用户尚未验证 `/btw` 成功，不能宣称已修。
- 本地真实 Pi 1.2.0/1.4.0 均复现：修改 `.ts` 入口与 native `.mjs` 后 reload，入口新、surface/herdr/protocol 仍旧。根因是 async native ESM 依赖图不随 Pi 的 factory cache 失效。
- 该结论不自动解释远端为什么运行旧 `.ts` 的双重通知，或官方 integration 为什么没报告 session；这些根因仍未确认。

### 统一修复选择与边界

1. 不扩大现有 AGENTS 宿主兼容补丁去修改 Pi 的通用模块加载器；避免把所有扩展缓存行为一起改变。
2. BTW 新增包内 `extensions/btw-native-backend.ts`：每个 extension factory 使用独立同步 Jiti scope，只加载 SDK-free 的 `surface -> herdr -> protocol`；显式依赖 `jiti@2.7.0`，该小模块图禁用 module/fs cache。frontend 仍用原来的 `.mjs`，不复制两套源文件，不只给最外层加 query。
3. 原 surface 正常 shutdown 后释放最后一个 IPC directory 对应的 exit listener，避免 reload 多代积累。严格父 session/terminal、子 nonce 所有权和单次错误通知保留。
4. 仅在本机授权的 `/Users/yuchzheng/tools/pi-btw-split` 改代码；不写 managed integration、不伪造父身份、不读取真实会话正文、不静默 internal fallback、不部署或清空全局缓存。

### 本地验收

- 新增真实 BTW 入口 source-edit 回归：旧代码第二代得到 `entry=2, surface=1, herdr=1, protocol=1`；修复后四层版本连续四次更新一致，IPC 目录/exit listener 回收通过。
- BTW 全套 **40/40**，Pi 1.2.0 与 1.4.0 均通过；Pi 1.2.0 严格类型检查与发布文件 dry-run 通过。
- 私有 XDG + 本地 `herdr --session pidtest`（tmux `hp`）中，真实 bundled Pi 1.4.0 TUI 连续三代改源 `/reload` 通过：官方身份不变、旧 child 关闭、新 native frontend 实际出帧。未使用真实模型/凭据或用户会话。
- 激活需要实际部署/更新声明依赖，并由用户在目标 Pi 上操作；已有陈旧 runtime 的首次激活可能需要用户空闲时重启。不能承诺反复 reload 能修官方身份。

## 1. Auto mode：完善与确认

### 已实现

- 指令采用 native AGENTS 和 `.agents/rules`；不再回退读取 CLAUDE，也不自动导入/持久化 `.claude` permissions。不迁移/删除用户的 Claude 文件；`.pi` 仍是运行配置目录；仍允许选择 Claude 模型。
- 主模型与审核模型分离：固定 `provider/model` 或显式 follow-active。通过 Pi 原生 registry dispatch，审核模型自己的 endpoint/auth/headers/OAuth 负责请求，不借用主模型凭据。不修改主模型、thinking 或工具集。
- 审核器无执行工具；严格 plain JSON `allow/deny/ask`；拒绝额外字段、XML、工具调用和不完整输出。
- 显式 deny/ask、敏感路径先于 auto 快路径；普通工作区写入和安全读取可不调用模型。问题/计划批准由人操作。
- 超时、失败熔断、一次性人工降级、无 UI 阻止、会话/重载/树/模型/模式变化取消、晚到审批失效、默认日志不记录私密正文。
- `/auto status`、`/auto model active|provider/model`、`/auto test`；交互选择仅限本次会话，持久设置在用户配置。
- 新增回归发现并修复：相对文件规则未匹配绝对工具路径；显式 shell ask 被只读快路径抢先放行；审核上下文改用真实只读 SessionProjection，并保留压缩摘要来源。

### 验证证据

- 权限全套：**581 passed / 6 skipped / 0 failed**（21 suites）。
- AGENTS/宿主副本测试：**5 passed**；覆盖 SDK 与 bundled CLI、实际补丁语法、拒读跟踪、worktree shadow、trust、Claude symlink、dry-run、backup、幂等和不支持布局拒绝。
- 真实 Pi ModelRuntime/ModelRegistry + 内存 provider：审核 key/header 隔离、无工具、主模型不变，通过。
- 真实 SessionManager 压缩投影：旧消息省略、摘要证据不冒充新用户授权，通过。
- 真实 Pi 离线计划回合：取消/停留不自动续跑，批准才续跑，通过。
- GPT 单元测试 **5 passed**；本地 mock Codex lite/full 续跑、双向模型切换和真实子 agent 适配器加载，通过。
- npm 0.1.3 + runtime patch 与本地 **36 个 runtime 文件**一致；脚本语法与 diff whitespace 检查通过。

### 不能据此宣称的内容

- 没有调用真实外部审核服务，未验证真实 OAuth refresh、账户额度、审核判断质量/误报率和端到端延迟。
- 已通过新的完整 factory 组合加载/清理：23 个配置包（包含全部已安装 npm/git 与 BTW）、28 factories，missing=0、failed=0；这仍不等于所有第三方扩展的完整交互/模型端到端验收。
- 新增包/HUD/scheduler/AGENTS 已用 TypeScript 6 对 Pi 1.4 严格检查；permission 全包仍以 581/6 skip 测试、离线 registry/model-turn 为证据，没有声称完整宿主 tsc。没有应用宿主补丁/部署设置；当前运行中的 Pi 仍保留旧发现行为。
- auto 是应用层权限闸，不是 OS sandbox；文本 hardDeny 是审核指引，不等于确定性系统拦截。

**结论：核心实现与离线安全回归通过，可以进入部署前验收；不是“线上已启用且万无一失”。默认仍为 bypassPermissions。**

## 2. Back to bottom → 先读未读最终回复

### 已确认入口

Pi TUI 的 `tui-alt-screen.js`：快捷键与点击底部 indicator 都调用 `scrollToBottom()`，内部直接 `scrollToEnd()`。这不是 `pi/keybindings.json` 换绑快捷键就能完整解决的，需要会话语义和视口状态配合。只处理人工“返回最新”意图，不改所有内部自动滚动，否则可能破坏输入框、弹窗和 streaming 跟随。

### 推荐交互

1. 有未读最终回复：第一次“返回最新”跳到 **最早一条未读最终回复的正文开头**，不跳到尾部；不把工具日志/思考区当成答案。
2. 没有未读最终回复：按原行为回到最底部。
3. 已定位到同一回复后再次触发：允许明确跳到真正底部，不让用户困在同一锚点。
4. 新输出到来但用户正在翻历史：只显示“有未读最终回复”，不抢滚动位置。
5. 按会话/分支隔离；resize、折叠工具区、CJK/emoji 换行后按消息 ID + 内容偏移重算，不保存易失效的绝对行号。

### 未读的操作定义

程序无法知道人是否真正读懂。用“最终回复尚未被查看/确认”而不是声称读心：回合真正结束后建立最终正文锚点；仅渲染过、自动滑过或点击开头不等于整条已读。依靠实际可见区域、焦点/遮挡和阅读进度，或明确的“到最新”操作更新状态。取消/报错半截输出、压缩摘要、工具结果、普通系统通知不自动算正常最终回复。

验收：生成长最终答案时用户上滚；快捷键和鼠标均回正文开头；短答案/无答案/多条未读/二次跳底/调整窗口/分支切换/流式未结束/弹窗遮挡均有真实 TUI 测试。普通终端 scrollback 无法伪装成 fullscreen 的可控视口，应明确支持范围。
本地实现：`packages/pi-unread-navigation`。仅包装当前 fullscreen renderer 实例上的人工输入路径，保留内部自动滚动。`agent_settled` 后以 native entry ID + 内容摘要定位；按可见正文范围累计 600ms 稳定观看，遮挡/焦点缺失/嵌套提示不计。最多 100 个锚点，超额仍计数；普通 scrollback 原生降级。20 项真实 renderer、AssistantMessageComponent、chat viewport 和转发代理测试通过；负对照 `146 !== 41` 证明原生 bottom 跳过正文开头。没有启动实际用户 TUI。

## 3. Scheduler 与 steer：前台优先，执行与唤醒分离

### 已确认现状

`sendAgentPrompt()` 仅看 `ctx.isIdle()`：idle 时立即 `sendUserMessage()`，否则提交 Pi followUp。`isIdle()` 只表示模型没 streaming，不表示你没在写 steer；也没有检查 `getEditorText()` 或 `hasPendingMessages()`。提交给 Pi 的 followUp 可能越过用户尚未提交的草稿。单纯把 steer 改成 followUp 不能修复这类混乱。

### 推荐状态模型

```text
scheduled → due → waiting-for-foreground → running
                                        → completed → wake-pending → delivered
任何未交付状态 → cancelled / expired / session-suppressed
```

- 定时“到点”、shell“实际执行”和“把结果交给模型”分别记录，不能把挂起误报成已交付。
- **人类前台优先**：非空草稿、排队的人类 steer/followUp、正在进行的前台回合、权限/编辑弹窗或用户手动暂停时，scheduler 不能抢会话。
- `notify` 仍可显示轻量提醒，但不切焦点、不触发模型。
- `prompt` / 会触发回合的 `message` / shell 完成后的 follow-up 先留在 scheduler 自己可取消的队列里，不提前塞进 Pi 队列。
- 默认工作区 shell 也等安全窗口再开始：测试、构建、git 等并不天然只读，不能假设它们与人工操作并发安全。任务可显式选择“允许后台执行，但结果稍后交付”。已经运行的 shell 单独显示，不因前台输入被静默杀掉。
- 安全窗口需同时满足模型 idle、无 pending 用户消息、草稿为空、无交互阻塞和短暂稳定期；发出前二次检查并做会话 generation/任务 revision 认领。不能只在 `agent_end` 瞬间发，因为该回合后面还可能有用户排队输入。
- 用户可以手动“现在处理待办”或暂停/恢复 scheduler 的模型唤醒；等待原因持续可见，例如“2 个到点任务，等你提交草稿”。不能靠无限等待而没有可见出口。
- interval/cron 错过多次不突发补跑；同任务的重复检查可以按策略合并，但保留次数和重要结果变化，不吞掉失败→恢复等事件。

验收必须同时覆盖：正在打字（未提交）、已提交 steer 正在执行、多条前台消息排队、followUp 间歇 idle、任务同时到点、reload/resume、跨进程 claim、取消 pending wake、不会重复执行/重复唤醒。

## 4. Scheduler：不记 ID 也能准确取消

### 已确认问题

- `/schedule-cancel` 无参数只显示 `Usage: /schedule-cancel <id>`。
- `/schedules` 输出有 ID，但缺少直接操作入口，需要回找和复制。
- core 的 `findTask()` 当前使用首个 prefix 匹配；统一管理入口应拒绝有歧义的前缀，不允许“碰巧取消第一个”。

### 推荐交互

- `/schedules` 打开可搜索、可操作列表；保留 `all` / `history` 文本视图，供 headless 和诊断使用。
- `/schedule-cancel` 无参数直接选任务；支持完整 ID、唯一短 ID 和名称检索。名称重复/前缀歧义时列候选，**不猜**。
- 每行展示：名称、动作/命令摘要、下一次时间、状态、scope/所属项目与会话、稳定短 ID。完成/取消后反馈同一组信息，不只回显一串 ID。
- 可选“取消最近创建的任务”，但必须回显目标；不要使用列表序号作为跨刷新稳定标识。
- 选择器持有 full ID + revision，提交时在事务内重验，防止列表刷新后取消错任务。
- 取消同时处理未开始执行和 scheduler 自有 pending wake；已经交给模型的内容不能假装撤回。正在运行的 shell 明确区分“停止后续调度”与“终止当前进程”，不通过 abort 主会话去停止无关前台工作。
- model tool 与 slash command 共用同一定位/消歧逻辑；UI 可见 scope 不能成为越权取消其他会话任务的捷径。

验收：不记 ID 可完成取消；同名/同前缀不误取消；pending wake 被撤销；运行中取消的影响准确显示；重启/跨进程后仍定位同一任务。

## 5. 部署支持项：本地实现与边界

- 完整 loader：Pi 原生资源解析 + 保留 package filters，已安装 npm/git 只读定位，standalone 一起加载。独立 HOME/cwd/agent-dir、Node 写权限限制、JS 网络/子进程阻止；真实 runner/空 SessionManager 清理，不读取真实会话。当前 23 包/28 factories 全部加载。原生 addon 仍需信任，不声称安全执行恶意代码。
- managed deployment：写入前整体验证、配置/宿主同一哈希备份、排他锁、原子 rename、普通 I/O 故障回滚；只 prune 未修改的已管理旧 extensions/themes，custom/official integration 保留。默认预览恢复，所有后态哈希和原 blob 一致才执行。断电/强杀不具备跨文件 crash-atomic 保证。
- scheduler/HUD 跟随 `getAgentDir()`；custom dir 不偷写默认官方集成。嵌套 Herdr prompt 不因内层关闭提前清空 blocked；不修改 managed integration。
- CJK/emoji：HUD 按真实终端列宽截断，包括极小预算和 lead 前缀。
- 性能：先测 50k entries × 250 frames 的分支遍历；缓存从每帧复制改为稳定 leaf/scope 下 1 次，append/切支/全 session 无 count 保守 fallback 有回归。同 socket pane-id 10 并发事件从 10 scans/30 CLI 改为 1 scan/3 CLI；async exec 保留 lock heartbeat，持锁期间新请求继续 drain；不运行常驻 daemon。
- 跨功能真实 Pi 1.4 合成会话：AGENTS 与 `.agents/rules` 进入 provider context；auto 使用独立 reviewer key/header、无 tools、不改主模型；BTW 已注册；HUD editor/footer 与未读 widget 共存，人工回最新显示答案开头；草稿期间后台 shell 结果不唤醒模型且可按名称取消；清空草稿/resume 后只唤醒一次，shutdown 清理导航实例包装与 HUD editor。仍未使用真实凭据或用户会话。
- 最终回归：scheduler **150/150**（含 live）；support/navigation/HUD/AGENTS/scripts **86/86**（含新增 pane symlink 防护与跨功能会话）；permission **581 passed / 6 skipped**；GPT 5、fork-save 10、summary-time 4、BTW 40；完整加载 23 包/28 factories；严格类型检查 16 root files；三份 runtime patch 与 npm 基线一致。
- 详细使用与恢复范围见 [deployment-safety.md](deployment-safety.md)。没有运行真实 setup、修改活动宿主或执行远端激活。

## 本地实施完成；激活另行授权

1. **P0 已完成**：BTW 已证实的 reload 缓存修复、AGENTS-only 与独立 auto reviewer；完整组合加载和隔离回归通过，默认仍是 bypass。
2. **P1 已完成**：scheduler 可取消队列、前台 gate、可搜索列表/短 ID、revision 校验及运行中取消边界。
3. **P2 已完成**：独立未读最终回复导航，真实 renderer 的鼠标/快捷键及跨功能合成会话验证。
4. 后续若明确授权激活：先确认真实 reviewer provider/认证，再预览事务、部署、用户空闲时重启并执行实际 UI 验收；远端同步/发布单独授权。配置恢复只覆盖事务清单，不覆盖工具安装/link 或远端状态。

以上为已授权的本地实现和验收标准；不代表部署或线上激活授权。
