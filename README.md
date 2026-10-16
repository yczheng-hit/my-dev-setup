# my-dev-setup

个人 herdr + pi 开发环境配置。普通 Git 仓库 + Bash 脚本，不需要 chezmoi、Stow 等配置管理工具。

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
- 不读写 `auth.json`、`models.json`、`models-store.json`、session、日志、缓存。

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
│   └── config.toml                         # Ctrl+Q prefix、blocked reason sidebar
├── pi/
│   ├── settings.json                       # 插件清单、cc-dark 主题、UI、模型偏好
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

两个 patch 都已验证：npm 原版打上 patch 后与 `packages/` 里的运行代码一致（picc 比较时忽略原版的 CRLF 换行）。patch 只覆盖运行代码；picc 目录里额外的测试和 `LOCAL-PATCH.md` 是本地补充。

**picc-permission-modes**：基于 [Ladbaby/picc-permission-modes](https://github.com/Ladbaby/picc-permission-modes) 的 npm `@ladbabynpm/picc-permission-modes@0.1.3`，详细记录在它的 `LOCAL-PATCH.md`：

1. **计划文件修复**：`EnterPlanMode` 立即返回当前 session 的确切计划路径；`ExitPlanMode` 在计划缺失、为空或不可读时留在 plan mode，要求先写计划，不弹批准窗口。
2. **计划批准弹窗**：选项顺序改为 **1. bypass permissions（Enter 默认）**、2. accept edits（Shift+Tab）、3. 留在 plan mode；全屏模式下鼠标滚轮只滚动计划内容。
3. **底栏交给 pi-hud-footer**：不再自己 `setFooter`，改为发布 `permission-mode` 状态；颜色可在 `modeColors` 配置。
4. **（2026-10-15 新增）shell 解析错误不再打到屏幕上**：带 JS 模板字符串的 heredoc 会让 shell-quote 报 `Bad substitution`，原来被 `console.error` 直接画在编辑器和 HUD 上。现在默认静默；需要诊断时设置 `PICC_DEBUG=/绝对路径` 写入文件。权限判断不变。

**pi-hud-footer**：npm `pi-hud-footer@0.8.0`（[liao666brant/pi-hud-footer](https://github.com/liao666brant/pi-hud-footer)）+ 1 处本地改动：去掉 HUD 两行和工具行左侧的一个空格缩进。改动见 `patches/pi-hud-footer/0.8.0-local.patch`；已验证“npm 原版 + 这个 patch”与 `packages/pi-hud-footer` 完全一致。

**pi-subagent-hud 0.1.2**：在本仓库维护的小插件。在 HUD 状态行末尾显示正在运行的 pi-subagents 子 agent（模型、任务、耗时、token）。依赖 `pi/extensions/subagent/config.json` 里的 `inlineToolDisplay: "summary"`、`asyncWidget: false`、`fleetView: false`。说明见它的 README。live 测试通过 `PI_HOST_DIR` 指定 Pi 安装目录，不再依赖某台机器的绝对路径。

### npm 插件

没有本地改动的插件仍用 npm 名称，版本未锁定。括号里是 2026-10-16 的参考版本：

```text
pi-cc-extensions (1.0.4)      pi-subagents (0.78.0)         @mrclrchtr/supi-review (8.0.1)
pi-omp-advisor (0.7.2)        pi-hashline-edit-pro (6.4.6)  pi-repl-py (0.9.0)
pi-context (2.3.0)            pi-web-access (0.40.0)        pi-sticky-last-prompt (0.1.2)
```

pi-subagents 已与 npm 0.78.0 原版逐文件哈希比对（1331 个文件），没有本地改动。

`cc-dark` 主题由 `pi-cc-extensions` 提供。

## 兼容性

参考环境：herdr **0.9.3**、pi **1.2.0**、Node.js **24.x**。

herdr 配置使用 `default_shell = "/bin/zsh"`。目标机器没有这个路径时，编辑 `herdr/config.toml` 改成可用 shell；不要盲目部署。

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
tmp=$(mktemp -d) && (cd "$tmp" && npm pack pi-hud-footer@0.8.0 --silent && tar xzf *.tgz)
diff -ru --strip-trailing-cr "$tmp/package" packages/pi-hud-footer \
  | grep -v '^Only in' > patches/pi-hud-footer/0.8.0-local.patch
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

2026-10-16 同步后，在 Mac 临时 HOME 中完整运行两次：

- 从 GitHub clone 了 pi-btw-split（`845ef90`）和 herdr-monitor（`38b164a`）；herdr-monitor 用 Python 3.12 装进 venv。第二次运行没有任何文件变化。
- `settings.json` 合并后保留 `deviceId`；`pi list` 能解析 4 个本地包：picc-permission-modes、pi-btw-split、pi-hud-footer、pi-subagent-hud。
- picc 全套测试：530 通过、4 失败、6 跳过。失败的 4 个与 `LOCAL-PATCH.md` 记录的既有失败完全相同（默认配置目录、bypass 下 deny 规则、`~` 计划路径、Windows 路径），不是这次改动引入的；新增的 parse-noise 测试通过。
- pi-subagent-hud 单元测试 15/15 通过。
- herdr 的 plugin/server 命令连到本机正在运行的 herdr，已有 `local.pi-btw-light` 注册指向 `~/tools/pi-btw-split`，所以只警告、没有替换。

尚未在真实 HOME 应用，也未在 Linux 新机器端到端验证。
