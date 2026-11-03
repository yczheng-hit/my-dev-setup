# my-dev-setup

个人 **Herdr + Pi** 开发环境：配置、主题、本地扩展与自动维护入口。使用普通 Git 仓库和 Bash/Node 脚本，不依赖额外的 dotfiles 管理器。

## 配置与更新

把本仓库链接交给 Pi agent，告诉它：

> 按仓库说明配置或更新我的 Pi 环境，保留当前会话。

agent 按 [AGENTS.md](AGENTS.md) 执行检查、下载和验证，**不需要你另开终端、手动运行脚本或为了更新退出 Pi**。

- **Pi 正在运行**：新版组合保存为持久候选，当前会话继续使用现有版本；下次正常启动、且没有其他旧 Pi 进程时自动激活。
- **Pi 未运行**：直接安装并配置。
- **已经是目标版本与配置**：验证后保持不变，不重复排队。

核心与第三方插件整套切换，不把 `/reload` 当成 Pi 核心热升级；不自动 kill、重启或 reload 当前会话。安装沿用原包管理器及 Node prefix，不另装第二份 Pi。

需要 **macOS/Linux、git、Node >=22.19/npm、Herdr**；monitor 另需 Python >=3.11。Node、Herdr 和系统软件不自动升级。完整流程、安装渠道和异常处理见 [自动维护](docs/maintenance.md)。

### 部署前注意

这是个人配置，不是通用安全默认：

- 权限默认为 **`bypassPermissions`**，计划批准默认选项也是 bypass。需要更保守的模式时，先修改 [权限配置](pi/extensions/picc-permission-modes/config.json)。
- 配置包含默认模型、模型白名单及 SSH/SCP allowlist，部署到其他机器前应检查；**不包含账号或 API key**。
- 不读写凭据、真实 session 或聊天日志，不清全局缓存；包安装及 hashline 数据备份只保存在本机。

## 主要功能

| 功能 | 实现与说明 |
| --- | --- |
| AGENTS-only 上下文 | [pi-agents-context](packages/pi-agents-context/README.md)：AGENTS 与受信任 `.agents/rules`，不自动导入 Claude 文件 |
| 权限与独立审核模型 | [picc-permission-modes](packages/picc-permission-modes/LOCAL-PATCH.md)：手动 plan、审批反馈、独立 auto reviewer；审核角色不改变主模型 |
| GPT/Codex 适配 | [Codex compat](packages/pi-openai-codex-compat/LOCAL-PATCH.md)＋`pi-gpt-codex`：工具、提示词与 Responses 路由适配 |
| 前台优先调度 | [pi-scheduler](packages/pi-scheduler/LOCAL-PATCH.md)：草稿/弹窗/模型回合期间延迟唤醒，可暂停、取消，交付不明时不自动重发 |
| 未读回复导航 | [pi-unread-navigation](packages/pi-unread-navigation/README.md)：fullscreen 中优先定位最早未读最终回复 |
| 会话与子任务 HUD | [HUD footer](packages/pi-hud-footer/LOCAL-PATCH.md)、[subagent HUD](packages/pi-subagent-hud/README.md)、UTC+8 回合摘要 |
| Herdr 编号与状态 | [pane-id](packages/herdr-pane-id/README.md)＋[subagents 标签适配器](packages/pi-subagents-herdr-labels/README.md)：保留编号、状态颜色和审批提示 |
| 分叉快照 | [pi-fork-save](packages/pi-fork-save/README.md)：保存副本而不切换前台会话 |
| 侧边对话与监控 | [pi-btw-split](https://github.com/yczheng-hit/pi-btw-split)、[herdr-monitor](https://github.com/yczheng-hit/herdr-monitor)；`./monitor.sh` 启动监控 |

monitor 默认只观察。显式开启自动确认后是界面识别，**不是命令安全审查**，详见它自己的说明。

## 插件来源与维护策略

[pi/settings.json](pi/settings.json) 是唯一加载清单，保留顺序和资源过滤；[maintenance.json](maintenance.json) 记录分类与自有工具 commit。

| 来源 | 更新方式 |
| --- | --- |
| 普通远程 npm/git 包 | 查询最新稳定版/配置 ref，隔离验证后固定到精确版本/commit |
| 本地补丁包 | permission、Codex compat、HUD footer、scheduler 以本仓库源码为准，**不查询、merge 或替换第三方上游** |
| 自有扩展与适配器 | 使用 `packages/` 中的代码，与新版远程依赖一起验证 |
| 自有独立工具 | BTW、monitor 按仓库固定 commit 初始化；已有不同版本或本地修改保留，不自动 reset/merge |

[maintenance.lock.json](maintenance.lock.json) 记录成功验证的直接依赖版本和完整性，**不是完整间接依赖锁，也不是本机已安装状态**。本机状态看维护收据；不要用宽泛的 `pi update --extensions` 替代分类型维护。

本地补丁记录在 [patches/](patches/)，修改补丁包时同步运行代码、测试和对应 patch。历史变更看 Git，不在 README 维护另一份版本流水。

## 仓库布局

```text
AGENTS.md                 # agent 维护约定
bootstrap.sh              # agent 调用的统一更新入口
maintenance*.json         # 来源策略与已验证候选记录
pi/                       # Pi 配置模板、主题、独立扩展
herdr/                    # Herdr 配置模板
packages/                 # 仓库维护的扩展、适配器与补丁包
patches/                  # 相对已记录第三方基线的运行代码 patch
tools/                    # 自有独立 checkout；monitor 为 submodule
scripts/                  # 候选验证、启动钩子、部署事务与测试
monitor.sh                # 在已有 Herdr pane 中启动 monitor
```

`repo:` 是部署占位符，会展开为 checkout 路径；不要把源 `pi/settings.json` 直接复制到本机，也不要把含机器路径的本机 settings 整份拷回仓库。

## 状态、验证与恢复

以下是 agent 使用的诊断入口，也可手动运行：

```sh
node scripts/maintain.mjs status   # 本机 applied / queued / failed 收据
./bootstrap.sh --check            # 只读查询最新版本、安装渠道和来源分类
./bootstrap.sh --prepare          # 临时验证，不排队、不安装启动钩子
node scripts/check-pi-extensions.mjs .  # 已安装组合的隔离加载检查
```

候选排队不等于当前会话已升级；`pi --version` 表示磁盘安装版本，不证明已有进程已切换。验证覆盖宿主补丁、完整扩展 factory/shutdown 和合成 SDK/UI 回归，**不替代真实 provider、OAuth 或完整 UI 验收**。

配置使用 ownership 清单和 SHA-256 事务：保留自定义/修改过的代码，只清理哈希未变的旧受管资源。包安装与配置分别备份，不承诺整台机器的原子回滚。启动前发现候选过期会延期；安装中途失败会保留收据与备份，不强行启动混合版本。详见 [部署安全与恢复](docs/deployment-safety.md)。

开发回归（`PI_HOST_DIR` 指向实际 Pi package 目录）：

```sh
PI_HOST_DIR=/path/to/pi-coding-agent \
  node --test scripts/test/*.test.mjs packages/pi-agents-context/test/*.test.mjs
bash -n bootstrap.sh setup.sh
git diff --check
```

更完整的设计与验证边界见 [UX 方案](docs/pi-ux-roadmap.md)。提交前检查差异；不提交密钥、登录状态、会话、下载依赖、私有主机或机器专用路径。
