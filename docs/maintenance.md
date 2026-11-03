# AI 自动更新与本机配置

把仓库链接交给 AI，并要求“按照仓库说明配置/更新本机”。AI 读取根目录 `AGENTS.md`，执行统一入口；仅浏览链接或未加载仓库指令不会自动运行任何东西。

```sh
git clone https://github.com/yczheng-hit/my-dev-setup.git ~/tools/my-dev-setup
cd ~/tools/my-dev-setup
./bootstrap.sh                 # 外部终端：检查最新 → 验证 → 更新原渠道 Pi/远程插件 → setup
./bootstrap.sh --prepare       # Pi 会话内：准备/验证；不改活动安装和配置
./bootstrap.sh --check         # 只读：查看最新版、安装方式和类型
node scripts/maintain.mjs status
```

需要 git、Node >=22.19/npm；部署还需已有的 Herdr，monitor 需 Python >=3.11。Node/Herdr/系统包不在自动升级范围。Pi 不存在时使用当前 Node 对应 npm 安装；需要写全局目录而无权限时停止，绝不自动 sudo 或换到另一套安装。Windows 原生环境暂不支持本仓库 Bash 部署，使用受支持的 macOS/Linux 环境。

## 更新类型：本地 hack 以仓库为准

唯一插件清单仍是 `pi/settings.json`，保留加载顺序、对象过滤（例如 subagents 的 `extensions: []`）。`maintenance.json` 记录本地类型，不复制一份远程包列表。

| 类型 | 更新行为 |
| --- | --- |
| `remote-npm` / `remote-git` | 每次查询 latest stable / 配置 ref 的 commit，隔离安装精确候选，验证后部署精确版本 |
| `patched` | `packages/picc-permission-modes`、Codex compat、HUD footer、scheduler：只用仓库源码；不查询、merge、rebase 或套用新版第三方上游 |
| `owned` / `adapter` | 本仓库维护；与新版远程依赖一起加载验证，不能把适配器误当上游源码 fork |
| `owned-checkout` | BTW、monitor 从 `tools.tsv` 的自有仓库取得 `maintenance.json` 固定 commit；已有不同版本/本地改动不覆盖、不自动合并 |

要更新带 hack 的代码，显式更新本仓库即可；自动维护不会主动追第三方上游。`patches/` 保留记录既有基线的职责。

## Pi 安装来源

先识别实际 `pi` 的链接/目标和 package owner：

- npm：使用原 prefix 下的 npm/Node，保留 fnm/nvm 环境，不用 PATH 中另一套 npm 全局安装。
- pnpm / Bun：验证全局目录归属后使用同一管理器。
- 官方 managed installer：验证 `managed-install.json`、release 布局和 current-version，沿其 `pi update --self`；不降为全局 npm 安装。
- Homebrew：使用原 brew 和 formula；若其版本不是 npm latest 或缺 SDK，明确阻塞本仓库宿主补丁部署。
- Nix、自定义二进制、无法证明归属：报告原渠道需要处理；不会另装 npm Pi 冒充更新成功。

升级后再次检查安装来源、实际路径、package version 和 `pi --version`。Pi 宿主 AGENTS-only 补丁先在候选 SDK 与 bundled CLI 上验证，不支持的新布局停止。只检查通过不代表宿主已启用补丁；真正部署后必须重启。

## 验证与状态

`--dry-run` 是 `--check` 的别名；`check` 只查询，不安装、不写 lock。`update` / `--prepare` 可以补齐 repo-owned checkout 和缺失的本地 runtime dependencies，npm 安装禁用 lifecycle scripts；仅对已声明且可修复的原生 addon 定点源码重编译，不对所有依赖运行脚本；补齐依赖，不改本地源码、不应用活动配置。候选 Pi/远程包及 npm cache 位于私有临时目录，结束清理。

验证目前包括：精确 npm 包版本/integrity、Git commit、原生依赖可加载、候选宿主补丁及语法、真实 Pi 完整 factory/shutdown 组合（含保留的 custom 扩展），以及候选宿主上的 scheduler 异步交付、跨功能合成会话、AGENTS 与 unread TUI 回归。`maintenance.lock.json` 仅在成功后记录直接依赖精确版本、完整性及验证环境；它**不是完整 transitive lock，也不是 live provider/UI 端到端通过证明**。本地源码/运行环境变化后必须重验。

`bootstrap --apply` 在写入前拒绝运行中的 Pi 进程，不 kill、不 restart、不 reload。AI 若本身运行于 Pi，只能准备，并报告外部终端 `./bootstrap.sh`。这样不会在会话中混用新旧宿主、hashline 锚点和撤销存储。

部署仅处理清单内远程包，不运行宽泛 `pi update --extensions`，不 reset/clean Git checkout。本地配置通过现有 `managed-deploy.mjs` 合并/备份，包清单转成验证过的精确来源；`setup.sh` 接收内部 `MY_DEV_SETUP_SETTINGS`，不回写模板中的机器路径。

## 备份与失败

本机 `<agent-dir>/state/my-dev-setup/backup-*/` 为私有目录：保存原 npm 安装、升级前 Pi package、hashline 数据目录及收据，宿主 patch 的逐文件备份由 setup 配置事务保存。备份只留本机，不提交仓库。Hashline 6→7 会更换锚点、升级数据库版本并清旧 snapshot/undo，必须先退出全部 Pi、备份后切换，重开会话后重新读取文件；web-access 新版 provider 参数为逗号分隔字符串。

这是多阶段安装，不承诺全机器 crash-atomic 或跨包管理器自动回滚。中途失败会返回非零及 backup 路径，可能已有部分安装变化；配置事务有独立恢复收据（见 `deployment-safety.md`）。按原管理器恢复 Pi，按备份恢复 npm/hashline；Git 自定义改动始终保留，恢复前检查冲突，不强盖。

AI 必须分别报告“发现最新”“候选验证通过”“本机安装完成”“待重启/阻塞”。网络失败不假报已是最新。不会自动 commit/push、读写凭据或迁移真实 session。
