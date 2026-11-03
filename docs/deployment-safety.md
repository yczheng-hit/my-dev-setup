# 本地预检、部署清单与恢复

这些脚本已实现并在临时目录验证；本轮没有运行真实 `setup.sh`、写入活动设置、修改活动 Pi 安装或 reload 用户会话。默认权限模式仍为 `bypassPermissions`。

本机 settings 可直接引用本地仓库 package；新启动或 `/reload` 可能直接加载当前源码。没有运行 setup 只说明未同步受管配置/宿主事务，不能据此断言新版代码未启用。宿主补丁仍须重启 Pi。

新版自动更新入口见 [maintenance.md](maintenance.md)：`bootstrap.sh` 检查 Pi 安装渠道、只更新远程直用包、保留仓库 hack，并通过 `MY_DEV_SETUP_SETTINGS` 将已验证的精确来源交给部署脚本；有运行中 Pi 时由 agent 持久排队，下次安全自然启动自动激活，不要求手动退出或外部执行。现有配置 restore 不覆盖包管理器更新或 hashline 数据迁移。

## 只读扩展组合预检

```sh
PI_HOST_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
  node scripts/check-pi-extensions.mjs . --agent-dir "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
```

- 用 Pi `DefaultPackageManager.getInstalledPath` 定位现有 npm/git 包，`repo:`/本地路径转绝对路径；保留对象形式的资源过滤（特别是 `pi-subagents` 的 `extensions: []`）。不执行安装、更新或 git fetch。
- `DefaultResourceLoader` 同时加载所有包，以及按 managed deployment 的同一 ownership/prune 规则构造的 **prospective standalone tree**：保留同路径 custom/modified 和额外本机扩展，移除未修改的旧受管代码，加入仓库新代码；继承设置 merge 会保留的显式 extension 路径。自定义 agent-dir 与 setup 保持一致。检测真实工具/flag 冲突；Pi 1.4 重复命令的 `:1`、`:2` 是正常命名空间，仅提示。
- 保留扩展只复制代码和 package manifest，配置仅使用仓库版本，不复制真实扩展 JSON、凭据、session 或日志；显式路径只供只读加载。独立 cwd/HOME/agent-dir，清除凭据与 Herdr 身份变量，禁用 Jiti 磁盘缓存；不触发 session_start、模型或工具。真实 runner + 空的内存 SessionManager 负责 shutdown 清理。因此验证的是部署后代码组合，不代表真实配置/provider 可用性。
- Node 24 permission model 只允许写临时目录，禁止子进程；显式阻止常用 JS 网络入口。为检查真实 tree-sitter 等原生依赖保留 `--allow-addons`，所以**这不是运行恶意扩展的安全沙箱**；原生代码可能绕过 Node 权限。只检查你已信任的配置包。
- 返回码：`0` 完整通过；`1` 加载/清理/冲突失败；`2` 缺包或配置版本不满足，组合不完整；`3` 找不到兼容 Pi host。缺失不当作通过，且绝不静默安装。
- 这证明 factory 初始化与清理组合，不证明真实 provider、OAuth、完整交互 UI 或业务行为端到端正确。当前 Pi 1.4 本机组合：23 配置包、29 factories（含保留的本机扩展，移除受管 legacy Claude rules）、missing=0、failed=0。

## 配置事务与 ownership inventory

`setup.sh` 首先只读构建配置和 AGENTS 宿主补丁计划，**在 clone/install 或目标写入前**校验 JSON、路径、兼容性和 legacy ownership。安装本地依赖后，在写配置前执行隔离 loader；真正加载失败会停止配置部署。首次缺少 npm 包时仍可部署用于下一次 Pi 安装的清单，但会明确报告 incomplete 并以非零状态结束；安装后必须重跑预检。

显式配置部署使用 `scripts/managed-deploy.mjs`，不是逐文件无清单覆盖：

- `<agentDir>/.my-dev-setup-manifest.json` 保存仓库身份、目标路径、已部署 SHA-256 和类型，不包含会话正文或凭据。
- 只清理 inventory 中已管理、位于 extensions/themes 根下且当前哈希仍等于上次部署的旧资源。修改过或未知资源保留；官方 `herdr-agent-state.ts` 不参与 stale prune。不会清空目标目录。
- 遇到同路径的自定义扩展代码会保留并警告；已管理但被手动修改的扩展同样保留。仓库明确管理的 JSON 配置仍按原有规则更新/合并，更新前备份。未知本机顶层 JSON 键保留；packages 是整份替换，支持对象 `repo:` 和资源过滤。
- AGENTS-only 补丁同时校验 SDK 与 bundled CLI；custom legacy Claude rules 拒绝整个计划。不迁移或删除用户 `.claude` 文件。
- 单个 agent-dir 的排他锁阻止同时部署/恢复；锁只在短暂同步文件事务期间存在。崩溃留下锁时，先核对锁内 PID，确认已退出后才手动移除；不自动抢锁或 kill。
- 写入前校验全部旧哈希，逐项再验、临时文件原子 rename；普通 I/O 失败按已知哈希回滚，不覆盖并发人工修改。文件系统无法跨多个文件/目录保证 crash-atomic：断电/进程被杀仍需要检查 prepared 备份和锁，不能宣称绝对事务性。
- 拒绝目标或祖先符号链接。自定义 agent-dir 的 scheduler/HUD 使用 Pi `getAgentDir()`；setup 不偷偷把官方 Herdr integration 安装到默认目录，需独立管理该集成。
- 配置事务之外的工具 clone/npm 安装、plugin link、官方 integration、venv、Herdr reload 不在该恢复范围。此工具不是整个机器的快照。

## 安全恢复（默认仅预览）

每次有变化的配置事务创建：

```text
~/.my-dev-setup-backups/<时间>/transaction-<uuid>/
  transaction.json  # 原/部署后哈希、状态、文件类型和目标
  before-N          # 需要时保存原内容，0600；目录 0700
```

```sh
# 用 setup 输出的确切 transaction 目录；没有 --apply 不会写目标。
node scripts/managed-deploy.mjs --restore /path/to/transaction-UUID
node scripts/managed-deploy.mjs --restore /path/to/transaction-UUID --apply
```

恢复先验证**所有** blob 的 SHA-256 和目标部署后哈希，任何冲突整体拒绝；不会覆盖部署后的人工修改或不同版本 Pi。新增文件只在仍匹配部署哈希时删除，退休文件恢复原字节，manifest 同步恢复。普通恢复 I/O 失败尝试回到部署状态。备份只应用一次，状态变为 restored。prepared/failed 记录需要人工检查，不自动猜测恢复。只使用可信且未被修改的备份目录。

宿主 AGENTS patch 需要用户空闲时**重启 Pi**，仅 `/reload` 不会重新加载宿主模块。Pi 更新后必须重新验证，不能把旧 host 备份强盖到新版。

## 跨功能离线会话

`scripts/test/ux-composition.test.mjs` 使用真实 Pi SessionManager/ExtensionRunner/ModelRuntime、合成持久会话、内存 providers 与无输出的原生 fullscreen layout。验证 AGENTS/rules、独立 reviewer 认证与主模型隔离、BTW 注册、HUD/未读导航共存，以及草稿阻塞、取消 shell 待交付结果、安全窗口只唤醒一次与 shutdown 清理。没有真实凭据、用户会话或 Herdr server；不能代替真实 provider/OAuth 与部署后交互验收。

## 回归

```sh
PI_HOST_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
  node --test scripts/test/*.test.mjs packages/pi-agents-context/test/*.test.mjs
bash -n setup.sh
git diff --check
```

测试只使用 fixture config、复制的 host、合成会话和临时目标；不运行真实 setup。另见 [统一 UX 方案与证据](pi-ux-roadmap.md)。
