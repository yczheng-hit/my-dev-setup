# AI 自动更新与本机配置

把仓库链接交给 Pi agent，要求“按照仓库说明配置/更新本机”。agent 读取根目录 `AGENTS.md` 并执行入口。**用户不需要另开终端、手动执行维护脚本，或为了更新退出当前 Pi。**

## 当前进程不中断

agent 在自己的 shell 工具中运行 `./bootstrap.sh`：

1. 查询最新 stable、识别原安装渠道，隔离安装并验证候选。
2. **有 Pi 进程运行**：候选保存到本机私有目录，标记 `queued`；当前宿主、插件目录、配置与 hashline 数据继续使用原版。安装一个带 ownership/hash 校验的启动钩子，只影响未来启动。
3. **下次自然启动 Pi**：钩子先检查其他 Pi 进程；全部旧进程已经自然结束时，按已验证的精确版本自动安装、部署并启动新版。仍有其他 Pi 时，本次继续启动旧版，候选保持排队。无需用户运行另一条维护命令。
4. **无运行中 Pi 的首次 setup**：直接沿原渠道安装并配置。

Pi 核心不能通过 `/reload` 替换，不能把“已下载”报告为“当前进程已升级”。本流程选择**整套组合延迟激活**，包括扩展：避免原生 ESM 缓存、适配器与 hashline 数据迁移混用新旧代码。已有普通源码修改仍可按 Pi 原生规则 reload，但维护不会对任意第三方包承诺安全热更新，也不会自动中断当前会话、kill、restart 或 reload。

启动钩子保留原 executable/link、管理器与 Node prefix。未来启动经同 PID `execve` 交接，没有常驻 supervisor。`pi --version`、help、package/auth 等非会话命令不触发激活。外部包管理器可能替换钩子；下一次由 agent 更新时会重新检查，不抢回未知启动器。

启动前再次校验候选内容、仓库来源指纹、安装 owner/version，并重跑 loader。源码/候选已变、另一个 Pi 正在运行等安装前条件不满足时，保留排队并继续旧版；**安装开始后失败**则保留收据并停止这次新启动，避免启动混合版本。现有 Pi 不受影响。让 agent 检查 `status` 即可，不自动强行重试或覆盖本地改动。

## agent 使用的入口

```sh
./bootstrap.sh                 # 默认：有 Pi 则持久排队，无 Pi 则安装配置
./bootstrap.sh --prepare       # 只在临时目录准备验证，不安装启动钩子/不排队
./bootstrap.sh --check         # 只读查询最新版、渠道和类型
node scripts/maintain.mjs status
```

`--dry-run` 是 `--check` 的别名。`check` 不安装、不写 lock。`--prepare` 和默认更新可以补齐 repo-owned checkout、缺失 runtime dependencies；npm 禁用 lifecycle scripts，只对已声明可修复的原生 addon 定点编译。源码不变；活动目录的依赖修复仍应由 agent 明确报告。

需要 git、Node >=22.19/npm；部署还需已有的 Herdr，monitor 需 Python >=3.11。Node/Herdr/系统软件不在自动升级范围。macOS/Linux Bash 与 Node execve 受支持；Windows 原生环境不支持此启动钩子。路径无写权限时停止，不自动 sudo 或另装 Pi。

## 更新类型：本地 hack 以仓库为准

唯一插件清单是 `pi/settings.json`，保留顺序、对象过滤（例如 subagents 的 `extensions: []`）。`maintenance.json` 补充本地分类和自有 checkout pins。

| 类型 | 更新行为 |
| --- | --- |
| `remote-npm` / `remote-git` | 查询 latest stable / 配置 ref 的 commit，验证精确候选，按精确版本部署 |
| `patched` | permission、Codex compat、HUD footer、scheduler 只使用本仓库源码，不查询或合并第三方上游 |
| `owned` / `adapter` | 使用本仓库代码，与新版远程依赖一起验证 |
| `owned-checkout` | BTW、monitor 使用自有仓库固定 commit；已有不同 HEAD 或工作区修改保留，不自动 merge/reset |

需要更新本地 hack 时显式更新本仓库；`patches/` 记录既有基线，不是自动追上游入口。

## Pi 安装来源

- npm：使用原 prefix 的 npm/Node，保留 fnm/nvm，不另装第二份。
- pnpm / Bun：验证全局归属后沿同一管理器。
- 官方 managed installer：验证 marker/release/launcher，使用其 `pi update --self`。
- Homebrew：原 brew/formula；缺 SDK 或没有候选目标版本时阻塞。
- Nix、自定义二进制、无法证明归属：交回原渠道，不使用 npm fallback。
- 尚未安装 Pi：使用当前 Node 对应 npm。

自动激活后再次核对安装 owner、实际版本、`pi --version`。AGENTS-only patch 同时验证 SDK 与 bundled CLI，不支持新布局时停止。

## 验证与状态

候选验证包括直接 npm version/integrity、Git SHA、原生依赖可加载、宿主 patch/语法、真实完整 factory/shutdown（含保留 custom 扩展）、候选宿主上的 scheduler/AGENTS/unread/跨功能合成回归。`maintenance.lock.json` 是直接版本与验证环境记录，**不是完整 transitive lock，也不是 live provider/OAuth/UI 验收**。启动激活会重新安装精确直接依赖，间接依赖可能重新解析。

分别报告：`latest discovered`、`candidate validated`、`queued / next-safe-start`、`installed`、`current runtime`。`status: queued` 不等于安装完成；核心新版仅新进程生效。已有完整匹配的安装不重复排队。

## 备份与失败

`<agent-dir>/state/my-dev-setup/`：
- `candidates/<uuid>/`（0700）保存持久候选；不含凭据、真实会话或日志。被替代候选保留，不盲删正在使用的目录。
- `pending.json` 保存待激活指针与校验；仓库源码、候选内容变化须重新准备。
- `backup-*/` 保存升级前 Pi、npm、hashline 数据及安装收据；配置事务另存 `~/.my-dev-setup-backups/`。

Hashline 跨代可更换锚点并迁移 undo/snapshot 存储，所以整套激活只在所有旧 Pi 自然结束后进行。激活后重新读取文件取得新锚点。

部署只处理清单内远程包，不调用宽泛 `pi update --extensions` 或 reset/clean Git。未跟踪 npm lock 等本地文件先报告，由 agent 获授权后备份移出，不能静默删除。配置沿用 `managed-deploy.mjs` ownership/hash 事务。

多阶段安装不承诺全机器 crash-atomic 或跨包管理器自动回滚。失败报告备份路径与部分变更；恢复前检查冲突，不强盖。凭据、真实 session 不读写；下载依赖、启动器备份和机器路径留本机，不提交。commit/push 仅按用户要求。
