# my-dev-setup

个人 herdr + pi 开发环境配置。普通 Git 仓库 + Bash 脚本，不需要 chezmoi、Stow 等配置管理工具。

## 更新日志

按日期倒序记录影响使用或部署的变更；每次改配置、插件或部署行为时同步更新。

### 2026-10-21

- 全局 `pi/AGENTS.md` 只保留一条规则：搜索优先使用 ripgrep（`grep` 工具或 bash 中的 `rg`）。
- 新增 `/fork-save`：保存当前会话的分叉副本，但前台仍停留在原会话。保存后只把新会话 ID 复制到剪贴板，副本中的历史 token 和 cost 统计从零开始。
- `/btw` 升级到 pi-btw-split `0.7.1-split.6`/`split.7`：每次提问都会重新生成一份有预算的主会话快照。快照包含主会话的运行状态、当前任务及工具调用进度（成功、报错、等待中）、之前几轮对话和已有的压缩摘要，不会额外调用模型。快照最多占 BTW 剩余窗口的 25%，且不超过 12k token，第一次提问不会触发压缩。`0.7.1-split.7` 起，可以在 `~/.pi/agent/btw.json` 写 `{"snapshot":{"share":"50%","maxTokens":"24k"}}` 调整比例和上限，下一次提问即生效。已安装的机器在 `~/tools/pi-btw-split` 执行 `git pull`，再在 Pi 里执行 `/reload`。

### 2026-10-20

- HUD 显示会话名称，并新增 `/rename`。
- Pi 回合摘要显示 UTC+8 完成时间。
- 新增 `@jl1990/pi-scheduler` 和 `@narumitw/pi-goal`。
- plan mode 改为只能由用户手动进入。
- 要求 `pi-hashline-edit-pro >= 6.5.0`，修复长会话中读取大文件时卡住的问题。
- 修复 herdr 插件通过符号链接注册时被误判为有变化的问题。

### 2026-10-16

- 初始化 herdr 和 pi 配置。
- 同步 Pi 主题和插件。
- 改用本机 Herdr 快捷键和 Tokyo Night 主题。

## 使用

机器上需要已经安装 **git、herdr、pi、Node.js / npm**；使用 herdr-monitor 还需要 **Python 3.11+**（缺少时只跳过 monitor）。工具本身的安装不在本仓库脚本中自动执行。

```bash
git clone https://github.com/yczheng-hit/my-dev-setup.git ~/tools/my-dev-setup
cd ~/tools/my-dev-setup
./setup.sh --dry-run     # 预览，不修改环境
./setup.sh               # 应用配置
```

以后更新：

```bash
cd ~/tools/my-dev-setup
git pull --ff-only
./setup.sh
```

运行中的 pi 执行 `/reload`；herdr 配置会尝试热加载，不会自动重启进程。

### 脚本行为

- 文件内容相同则跳过；改变前备份到 `~/.my-dev-setup-backups/<时间>/`。
- `pi/settings.json` 与本机现有文件合并：仓库中的同名顶层字段优先，本机独有字段（如 `deviceId`）保留。`packages` 是整份清单替换，不是追加。
- `repo:...` 是本脚本的路径占位符，部署时转成此 checkout 的绝对路径；不能把源 `settings.json` 直接复制给 pi。
- `tools.tsv` 列出的自有工具仓库会 clone 到 `tools/<name>`（已 gitignore），之后每次 `git pull --ff-only`；有本地改动或不在指定分支时只警告、不更新。
- herdr-monitor 在 `tools/herdr-monitor/.venv` 里用 Python 3.11+ 安装，commit 变化后才重装；脚本只安装，不启动它。
- 其他白名单文件直接复制，不清空整个目标目录。
- 本地插件仅安装必要的 runtime dependencies，不安装宿主 pi 的另一份副本。
- npm 插件按清单由 pi 在下一次启动时自动安装。版本未锁定，更新插件另行执行 `pi update --extensions`。
- 官方 herdr integration 用 `herdr integration install pi` 安装，不搬运生成文件。
- 同一个 herdr 插件 ID 如果已注册到另一个目录，保留原注册并警告，不偷偷替换。
- 不读写 `auth.json`、`models.json`、`models-store.json`、session、日志、缓存。**部署配置与插件不需要登录或密钥**；只有实际使用需要认证的模型、联网服务时，才另行配置对应账号/凭据。

> **配置的实际内容包含默认模型和权限规则。** 默认模型仅保存 ID，不保存 key；在没有这些模型的机器上，可以删除 `defaultProvider`、`defaultModel`、`enabledModels` 这几个字段，沿用本机选择。权限规则包含 SSH/SCP 的 allowlist，见 `pi/permissions.json` 与 `pi/extensions/picc-permission-modes/config.json`；不需要时应先删除对应项。
>
> `picc-permission-modes` 的本地补丁让计划批准菜单默认选项为 **bypass permissions**，不是更保守的 acceptEdits；详情在它的 `LOCAL-PATCH.md`。这是个人偏好，不是通用安全默认。

## 结构

```text
my-dev-setup/
├── setup.sh
├── monitor.sh                              # 启动 herdr-monitor（在 herdr pane 里运行）
├── tools.tsv                               # 自有工具仓库清单
├── tools/                                  # setup.sh clone 的仓库，不提交
│   ├── pi-btw-split/
│   └── herdr-monitor/
├── herdr/
│   └── config.toml                         # 本机 Herdr 快捷键、tokyo-night 主题、blocked reason 侧栏
├── pi/
│   ├── AGENTS.md                           # 全局指令：搜索优先 ripgrep
│   ├── settings.json                       # 插件清单、claude-dark 主题、UI、模型偏好
│   ├── themes/claude-dark.json              # 自定义主题
│   ├── keybindings.json                    # Ctrl+E / Alt+T 切换 thinking，End 到行尾
│   ├── pi-cc-extensions.json               # diff、卡片、footer 等 UI 偏好
│   ├── WATCHDOG.yml                        # pi-omp-advisor 的 main watchdog 关闭
│   ├── permissions.json
│   └── extensions/
│       ├── herdr-ui-prompt-blocked.ts       # 计划/权限弹窗 -> herdr blocked reason
│       ├── claude-rules.ts                 # 读取项目 .claude/rules
│       ├── handoff.ts                      # 上下文交接
│       ├── todo.ts
│       ├── question.ts
│       ├── questionnaire.ts
│       ├── subagent/config.json            # 含 pi-subagent-hud 需要的 fleetView 等设置
│       └── picc-permission-modes/config.json
├── packages/                               # 本地补丁版 / 本地插件（vendored）
│   ├── picc-permission-modes/
│   ├── pi-hud-footer/
│   └── pi-subagent-hud/
└── patches/                                # 第三方包相对 npm 原版的改动
    ├── picc-permission-modes/0.1.3-local.patch
    └── pi-hud-footer/0.8.0-local.patch
```

## 插件来源与版本

### 自有工具（独立 GitHub 仓库）

| 工具 | 仓库 | 用途 |
|---|---|---|
| pi-btw-split | [yczheng-hit/pi-btw-split](https://github.com/yczheng-hit/pi-btw-split) | pi `/btw` 侧边对话；同时作为 pi 包和 herdr 插件 `local.pi-btw-light` |
| herdr-monitor | [yczheng-hit/herdr-monitor](https://github.com/yczheng-hit/herdr-monitor) | 前台 herdr agent 监控 TUI，可选的受保护权限确认 |

两者都跟随 `main`。以后想固定版本，可在 `tools.tsv` 把分支改成 tag。

herdr-monitor 默认 **OFF**（只观察）。开启 ON 后会向符合条件的权限菜单发送 Enter；这是界面识别，不是命令安全审查。详见它的 README。

当前参考的 BTW 版本是 split.5（`845ef90`，Linux/macOS），部署时跟随 GitHub `main`。

### 本地补丁版 / 本地插件（packages/）

**规则：** 较大、独立开发的模块单独建仓库（目前只有 pi-btw-split、herdr-monitor，列在 `tools.tsv`）；小补丁和小插件直接放在本仓库 `packages/` 维护，不再开新仓库或 fork。

| 目录 | 类型 | 基础版本 | 相对原版的改动 |
|---|---|---|---|
| `packages/picc-permission-modes` | 第三方 + 补丁 | npm `@ladbabynpm/picc-permission-modes@0.1.3` | `patches/picc-permission-modes/0.1.3-local.patch` |
| `packages/pi-hud-footer` | 第三方 + 补丁 | npm `pi-hud-footer@0.8.0` | `patches/pi-hud-footer/0.8.0-local.patch` |
| `packages/pi-subagent-hud` | 自己的小插件 | — | — |
| `packages/pi-agent-summary-time` | 自己的小插件 | — | 覆盖回合摘要渲染，显示东八区完成时间 |
| `packages/pi-fork-save` | 自己的小插件 | — | `/fork-save` 保存分叉但不切换前台，稍后用 `pi --session` 加载 |

两个 patch 都已验证：npm 原版打上 patch 后与 `packages/` 里的运行代码一致（picc 比较时忽略原版的 CRLF 换行）。patch 只覆盖运行代码；目录里额外的测试、文档和示例是本地补充。

**picc-permission-modes**：基于 [Ladbaby/picc-permission-modes](https://github.com/Ladbaby/picc-permission-modes) 的 npm `@ladbabynpm/picc-permission-modes@0.1.3`，详细记录在它的 `LOCAL-PATCH.md`：

1. **计划文件修复**：`EnterPlanMode` 立即返回当前 session 的确切计划路径；`ExitPlanMode` 在计划缺失、为空或不可读时留在 plan mode，要求先写计划，不弹批准窗口。
2. **计划批准弹窗**：选项顺序改为 **1. bypass permissions（Enter 默认）**、2. accept edits（Shift+Tab）、3. 留在 plan mode；全屏模式下鼠标滚轮只滚动计划内容。
3. **底栏交给 pi-hud-footer**：不再自己 `setFooter`，改为发布 `permission-mode` 状态；颜色可在 `modeColors` 配置。
4. **shell 解析错误不再打到屏幕上**：带 JS 模板字符串的 heredoc 会让 shell-quote 报 `Bad substitution`，原来被 `console.error` 直接画在编辑器和 HUD 上。现在默认静默；需要诊断时设置 `PICC_DEBUG=/绝对路径` 写入文件。权限判断不变。
5. **权限模式标签不再加粗**：RGB 颜色只设置前景色，不再发送 ANSI 粗体指令，避免底栏粗体样式泄漏到后续文字。
6. **plan mode 只能手动进入**：`config.json` 设置 `"planMode": { "agentCanEnter": false }` 后，不注册模型可以调用的 `EnterPlanMode` 工具，Pi 不会主动切换到 plan mode，也不会弹窗询问。手动入口 `/plan`、`/mode plan`、`Shift+Tab` 照常可用。plan mode 里的 `ExitPlanMode` 计划批准流程不变。本仓库配置已经设为 `false`；删除该字段或改为 `true` 即恢复原版行为。修改后执行 `/reload` 生效。

**pi-hud-footer**：npm `pi-hud-footer@0.8.0`（[liao666brant/pi-hud-footer](https://github.com/liao666brant/pi-hud-footer)）+ 本地补丁：去掉 HUD 左侧缩进；两种 HUD 样式显示当前会话名称；新增 `/rename 新名称`（不带参数时弹出输入框）。名称通过 Pi 原生会话 API 保存，恢复会话后仍显示，Pi 自带 `/name` 也会同步刷新 HUD。未命名时不占位置，长名称只在 HUD 中截断；可用 `display.all.sessionName: false` 隐藏。改动见 `patches/pi-hud-footer/0.8.0-local.patch`，详细验证及测试命令见 `packages/pi-hud-footer/LOCAL-PATCH.md`。

**pi-subagent-hud 0.1.2**：在本仓库维护的小插件。在 HUD 状态行末尾显示正在运行的 pi-subagents 子 agent（模型、任务、耗时、token）。依赖 `pi/extensions/subagent/config.json` 里的 `inlineToolDisplay: "summary"`、`asyncWidget: false`、`fleetView: false`。说明见它的 README。live 测试通过 `PI_HOST_DIR` 指定 Pi 安装目录，不再依赖某台机器的绝对路径。

**pi-agent-summary-time 0.1.0**：把 `pi-cc-extensions` 回合末尾的 `Ran 3 commands · 36s` 显示为 `Ran 3 commands · 36s · 14:23:45 (UTC+8)`。时间取该摘要会话条目的保存时间，因此重新打开历史会话也不会变成当前时间；强制使用 `Asia/Shanghai`，与本机时区无关。它只覆盖 `agent-summary` 的渲染，不改变原插件统计或保存的数据。Pi 对同一类型采用第一个注册的 renderer，所以它必须排在 `npm:pi-cc-extensions` 前面；如上游改变了摘要条目格式，需要一起更新本地 formatter。`npm test --prefix packages/pi-agent-summary-time` 可运行格式测试。

**pi-fork-save 0.1.0**：`/fork-save [副本名称]` 只保存一份当前分支的快照，不切换当前会话、不启动新 Pi 或后台 agent。菜单默认「当前位置」（完整复制当前分支），也可选到某个较早回合为止；之后的内容和其他分支不会复制。不指定名称时自动生成 `原名 · fork 月-日 时:分`。保存后显示新会话 ID 和 `pi --session ID`，**只复制 ID 到剪贴板**；副本也会出现在 `/resume` 中。原生 `/fork`、`/clone` 不变。它复用 Pi 的 `SessionManager.createBranchedSession()`，保留历史、压缩摘要和标签；副本中历史 token/cost 用量从零开始（不影响原会话或实际账单）；两边后续对话不会同步，工作目录和磁盘文件仍共享。详见 `packages/pi-fork-save/README.md`。

### npm 插件

没有本地改动的插件仍用 npm 名称，版本未锁定。括号里是 2026-10-16 的参考版本：

```text
pi-cc-extensions (1.0.4)      pi-subagents (0.78.0)         @mrclrchtr/supi-review (8.0.1)
pi-omp-advisor (0.7.2)        pi-hashline-edit-pro (≥6.5.0) pi-repl-py (0.9.0)
pi-context (2.3.0)            pi-web-access (0.40.0)        pi-sticky-last-prompt (0.1.2)
@jl1990/pi-scheduler (0.5.1)    # 定时 prompt / shell 检查；Pi 运行中触发
@narumitw/pi-goal (0.54.13)     # /goal：持续工作直到 goal_complete；默认 25 轮自动回复上限
pi-cc-steer (GitHub main)     # 中途 steering；通过 Pi 的 git: 安装，不在 tools.tsv 单独 clone
```

pi-subagents 已与 npm 0.78.0 原版逐文件哈希比对（1331 个文件），没有本地改动。

**pi-hashline-edit-pro 必须 ≥ 6.5.0：** 6.4.x 在长会话把锚点池用到接近耗尽后，每分配一个新锚点都要同步探测数千次，读一个大文件会让 pi 主线程卡几分钟，而且 Esc 无法取消。上游 6.5.0 的提交 [`44e05ee`](https://github.com/YuGiMob/pi-hashline-edit-pro/commit/44e05ee) 修好了这个问题：池满后跳过注定失败的新锚点探测，回收后游标前移；同时超限文件在分配前就被拒绝。因此不另打本地补丁。2026-10-20 实测，在剩余 441 个新锚点的会话里读取：

| 读取 | 6.4.7 | 6.5.0 |
|---|---|---|
| 204,135 行 | 321.6 s | 4.8 s |
| 50,000 行 | 77.5 s | 0.9 s |

两版锚点都唯一，归属也一致；上游 6.5.0 全量测试 1917/1922 通过，失败的 5 个是 macOS `/private/var` 临时路径断言，与锚点无关。`./setup.sh` 只检查这个版本下限并给出警告，不会自动升级；需要升级时运行 `pi update --extension npm:pi-hashline-edit-pro`，再在运行中的 pi 里 `/reload`。不要用清空 `~/.config/pi-hashline-edit-pro` 或批量 kill node 进程的方式“修复”卡顿，那会丢掉锚点与撤销记录。

当前 `claude-dark` 主题由 `pi/themes/claude-dark.json` 部署，不需要借助 `pi-cc-extensions` 的 `cc-dark`。Pi 还设置 `hideThinkingBlock: true`（隐藏思考块）。

**pi-cc-steer 的行为提示：** `git:github.com/panbergco/pi-cc-steer` 从公开上游 `main` 安装；除了对话中途插入消息，它默认还会替换 Pi 的 `bash` 工具，提供后台命令和 `bg_list` / `bg_output` / `bg_stop`，超时 120 秒的命令会转后台而非直接终止，原有 shell 路径/前缀设置可能被忽略。只要 steering、不想替换 bash 时，启动 Pi 前设置 `PI_CC_STEER_BACKGROUND=0`。`/reload` 会丢掉尚未交给模型的内存消息；详见插件自己的 README。

**定时与后台唤醒：** [`@jl1990/pi-scheduler`](https://github.com/jl1990/pi-scheduler) 支持 `/schedule prompt once 10m :: 检查任务进度`、`/schedule shell once 5m :: npm test`（该命令默认只执行并记录结果，不自动唤醒；需由模型用 `schedule_task` 设置 `wakeOn`）、`/schedules` 和 `/schedule-cancel <id>`；模型也可以通过 `schedule_task` 设置 `scope: "session"`、`maxRuns` 与 shell 的 `wakeOn: "success" | "failure" | "always" | "change"`。定时 shell 由 scheduler 自己执行并按策略唤醒；立即启动的后台 `bash` 则由**已经安装**的 pi-cc-steer 在完成后自动通知、空闲时唤醒，不需要重复安装。两者都要求 Pi 运行才能按时触发。scheduler 把任务保存在本机 `~/.pi/agent/state/scheduler/tasks.json`，关闭期间不触发但重开同一会话后可能补跑逾期任务；要让任务彻底失效，请 `/schedule-cancel <id>`，不要把本机任务状态提交到仓库。`scope: "session"` 要求持久 Pi 会话，关闭后并不自动删除任务。默认一次性任务或为重复任务设置 `maxRuns`，避免无界自动调用模型。安装/升级由 Pi 按 `pi/settings.json` 的包清单在启动时完成，当前会话执行 `/reload` 后生效。

## 兼容性

参考环境：herdr **0.9.3**、pi **1.2.0**、Node.js **24.x**。

herdr 模板配置使用 `/bin/zsh`；`setup.sh` 会在它不可用时自动生成使用 `/bin/bash` 的本机配置，不修改仓库里的模板。如果两个路径都不可用，会警告并跳过 herdr 配置。

## 日常维护

直接编辑仓库里的配置再应用：

```bash
# 编辑 herdr/config.toml、pi/keybindings.json 等
./setup.sh --dry-run
./setup.sh
git add .
git commit -m "Tune UI and keybindings"
git push
```

### 修改 packages/ 里的插件

直接改 `packages/<name>/` 里的代码，用 `./setup.sh` 部署，运行中的 pi 执行 `/reload`。改的是第三方包时，顺手重新生成它的 patch，让 patch 始终反映“相对原版改了什么”：

```bash
# 以 pi-hud-footer 为例；picc 换成 @ladbabynpm/picc-permission-modes@0.1.3
tmp=$(mktemp -d)
(cd "$tmp" && npm pack pi-hud-footer@0.8.0 --silent && tar xzf *.tgz)
# 临时 Git 工作树保证新文件也进入 patch，并使用 a/、b/ 路径；只覆盖运行代码。
(cd "$tmp/package" && git init -q && git add extensions)
cp -R packages/pi-hud-footer/extensions/. "$tmp/package/extensions/"
(cd "$tmp/package" && git add -N extensions && git diff -- extensions) \
  > patches/pi-hud-footer/0.8.0-local.patch
```

### 升级第三方包

上游发布新版本后：下载新版 → 套用 `patches/` 里的 patch → 处理冲突 → 替换 `packages/<name>/` → 重新生成 patch 并改文件名里的版本号 → 跑测试后部署。

```bash
tmp=$(mktemp -d) && (cd "$tmp" && npm pack pi-hud-footer@<新版本> --silent && tar xzf *.tgz)
(cd "$tmp/package" && patch -p1 < "$OLDPWD/patches/pi-hud-footer/0.8.0-local.patch")
```

如果先在工具里调了配置，再把对应白名单文件复制回仓库。`pi/settings.json` 不要整份回拷（会带入 deviceId 和本机路径）；只把要维护的字段改回源文件。

这是个人公有仓库。不要提交 key、登录状态、聊天记录、私有主机地址或机器专用路径。

## 当前验证范围

2026-10-16 最近一次同步后，在 Mac 临时 HOME 中完整运行：

- 从 GitHub clone 了 pi-btw-split（`845ef90`）和 herdr-monitor（`38b164a`）；herdr-monitor 用 Python 3.12 装进 venv。第二次运行没有任何文件变化。
- `settings.json` 合并后保留 `deviceId`；`pi list` 无报错，能解析 4 个本地包（picc-permission-modes、pi-btw-split、pi-hud-footer、pi-subagent-hud）和 `pi-cc-steer` 的 Git 源；主题文件也部署成功。
- picc 全套测试：530 通过、4 失败、6 跳过。失败的 4 个与 `LOCAL-PATCH.md` 记录的既有失败完全相同（默认配置目录、bypass 下 deny 规则、`~` 计划路径、Windows 路径），不是这次改动引入的；新增的 parse-noise 测试通过。
- pi-subagent-hud 单元测试 15/15 通过。
- herdr 的 plugin/server 命令连到本机正在运行的 herdr，已有 `local.pi-btw-light` 注册指向 `~/tools/pi-btw-split`，所以只警告、没有替换。

尚未在真实 HOME 应用，也未在 Linux 新机器端到端验证。
