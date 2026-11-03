# 配置与更新

让 Pi agent 按仓库说明更新即可。agent 运行 `./bootstrap.sh`：

1. 检查原安装渠道，查询 Pi 和普通远程插件的最新稳定版。
2. 在临时目录验证宿主补丁、扩展加载和合成回归。
3. 备份后直接更新磁盘安装及配置，清理临时目录。

**不保存候选、不排队、不安装启动钩子，也不使用维护锁或仓库版本锁文件。** 每次更新重新查询版本；同一次操作使用刚验证的精确版本，实际版本写入本机 settings 和备份收据。不要同时运行多次维护。

当前 Pi 不会被 kill、重启或自动 `/reload`；新版核心在下次正常启动时使用。直接更新不是运行中进程的隔离：旧会话可能延迟加载新版插件或访问新版共享数据，尤其是 hashline 的 undo/snapshot 存储。此方案接受这些风险来保持流程简单；更新后避免 `/reload`，不承诺当前会话完全不受磁盘变更影响。

## 入口

```sh
./bootstrap.sh                         # 临时验证后直接安装、配置
./bootstrap.sh --check                 # 只读检查，不下载或修改
./bootstrap.sh --prepare               # 仅临时验证，不安装配置
node scripts/maintain.mjs status        # 最近一次本机维护收据
```

`--dry-run` 等于 `--check`。验证可初始化缺失的自有工具 checkout、安装缺失运行依赖；npm 禁 lifecycle scripts，只对声明可修复的原生 addon 定点编译。依赖修复会影响 checkout，agent 应明确报告。

需要 macOS/Linux、git、Node >=22.19/npm、Herdr；monitor 还需 Python >=3.11。沿用原 npm/fnm/nvm、pnpm、Bun、官方 installer 或 Homebrew 渠道，不自动换 Node、sudo 或另装第二份 Pi。Nix/custom/归属不明、Homebrew 缺 SDK 或目标版本时停止并报告。

## 来源策略

`pi/settings.json` 是唯一加载清单，`maintenance.json` 记录分类与自有工具 commit：

- **远程 npm/git**：查询最新稳定版／配置 ref，验证后更新；Git 有本地修改则保留并报告，不 reset/clean。
- **本地补丁、自有扩展和适配器**：使用本 checkout，不查询、merge 或替换原第三方上游。
- **BTW、monitor**：缺失时按自有仓库固定 commit 初始化；已有不同版本或本地修改时停止自动处理，保留现场。

不调用宽泛的 `pi update --extensions`，避免触及本地维护包或重置 Git 工作区。npm 自己的 `package-lock.json` 属包管理器产物，不是额外的仓库维护锁。

更新保留本机 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`、`externalEditor`；缺失时才采用仓库默认，不引入强制模型思考级别覆盖。权限配置只在缺失时初始化，已有文件保持原样；特殊规则和 schema 调整交给各机器上的 AI 按需处理，不复制进仓库。

## 验证与备份

验证覆盖 npm 版本/完整性、Git SHA、宿主 SDK/bundled patch、完整 factory/shutdown 和合成 SDK/UI 回归；不调用真实模型，不证明 provider、OAuth 或完整 UI 可用，也不承诺完整间接依赖复现。

安装前的 Pi、npm 和 hashline 备份及维护收据保存在 `<agent-dir>/state/my-dev-setup/backup-*/`；配置备份位于 `~/.my-dev-setup-backups/`。失败直接报告部分变更和备份，不自动重试或在未来启动时接续。保留自定义文件与哈希冲突检查，不承诺全机器原子回滚。恢复方法见 [部署安全](deployment-safety.md)。

从旧版延迟更新机制迁移时，更新入口会恢复原启动器，并将旧候选与旧锁标记归档；不再自动激活。
