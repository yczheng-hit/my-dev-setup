# pi-subagents-herdr-labels

保留 Herdr Agents 行首的 agent 编号及状态颜色，不让 `pi-subagents` 的 `⏳ 1 subagent (reviewer)` 覆盖编号。任务详情仍在现有 Pi subagent HUD；Herdr 的 `summary` / `title-suffix` 元数据也保留。

## 工作方式

这是自有适配器，**不复制、不修改 npm 包，不修改 Herdr**。

```json
[
  { "source": "npm:pi-subagents", "extensions": [] },
  "/absolute/path/to/packages/pi-subagents-herdr-labels"
]
```

Pi 继续安装/更新 npm 包并加载其 skills / prompts；原扩展入口由适配器调用一次。适配器只给上游工厂提供私有的 `exec` 包装：当且仅当它调用 Herdr `pane report-metadata --source pi-subagents:herdr` 时，删去 `--state-label` 参数对，并附上 `--clear-state-labels`，清理该 source 遗留的旧标签。其他扩展的 Pi API 不变。

- 编号仍由 `local.pane-id` 所有；`3 approval` / `3 plan ready` 仍由 `user:pi-blocked-reason` 所有。
- 上游的摘要、标题后缀、TTL、序列号、原生 Pi source guard、busy 事件、恢复活动任务、刷新和完成/退出清理均保留。
- 不新增定时刷新，不竞争标签，不强制改变父 agent 的 working/idle 状态。
- 支持 macOS/Linux、`HERDR_BIN`，从个人 agent `npm` 安装目录解析入口；不从任意 cwd 的 `.pi/npm` 自动加载代码，以免绕过项目 trust gate。未安装会明确报错，不悄悄丢失 subagent 功能。此适配器用于个人包清单，不处理项目级 npm 覆盖。

## 验证与启用

已验证上游 **pi-subagents 0.78.0**、**Pi 1.4.0**、**Herdr 0.9.1**。上游未来若改了 metadata source / CLI 形状，需要更新适配器；`bridge.test.mjs` 使用实际安装的上游桥检测这一契约。

```sh
npm test --prefix packages/pi-subagents-herdr-labels
PI_HOST_DIR=/path/to/pi-coding-agent node packages/pi-subagents-herdr-labels/test/load.mjs
```

隔离 Herdr 实测覆盖：启动、两个任务重叠、刷新、单个/全部完成、活动任务恢复、dispose、带编号审批标签。必须加载 Herdr 原生 `herdr-agent-state.ts` 并断言 pane 的 session source 是 `herdr:pi`，否则 source guard 会让测试假通过。

更改 settings 后，在没有活动子任务时 `/reload`，或重启 Pi；不要在任务运行中重载。若 npm 上游已升级而当前 Pi 仍缓存旧版本，应重启，遵循上游自身的版本检查。

回滚：将这两项配置恢复成单个 `"npm:pi-subagents"`，在空闲时重启 Pi。无需改 Herdr 配置。
