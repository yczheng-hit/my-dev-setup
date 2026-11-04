# pi-openai-codex-compat 本地补丁

基础版本：npm `pi-openai-codex-compat@0.0.29`。运行代码补丁：`../../patches/pi-openai-codex-compat/0.0.29-local.patch`。

## 为什么要装

pi 自带的 `openai-codex` 适配和官方 Codex CLI 在请求形状上差很多。这个包把 GPT 路径补到接近官方：

- `apply_patch` 自由格式工具替换 `edit` / `write`；`exec_command` / `write_stdin` 替换 `bash`。
- Responses Lite 信封（`reasoning.context=all_turns`、`parallel_tool_calls=false`、`x-openai-internal-codex-responses-lite` 头），默认关，由 `pi/openai-codex-compat.json` 打开。
- `end_turn=false` 时自动续跑；远程 compaction；`fastMode`（`service_tier=priority`）。

工具替换和请求适配只作用于 `openai-codex` provider；失活工具恢复仅在历史中出现过本扩展工具时补充指引，不改变其他模型的执行工具。不能和 `pi-openai-codex-conversion` 4.0.4 同时装。

## 改动

### Lite + 自由格式 `apply_patch` 的 schema 校验失败

`responses-tool-schema.ts`：Responses Lite 把直接声明的 function / custom 工具归入 `functions` namespace，但 namespace 的 `tools.items` 只接受 function 定义。`apply_patch` 是 custom（自由格式）工具，进入 namespace 后整个请求被校验拒绝，表现为 Lite 打开后第一轮就失败或 `end_turn=false` 续跑断掉。

补丁让 `tools.items` 接受 function 或 custom：

```ts
items: { anyOf: [RESPONSES_FUNCTION_TOOL_DEFINITION_SCHEMA, RESPONSES_CUSTOM_TOOL_DEFINITION_SCHEMA] }
```

### 同会话切换模型后的失活工具恢复

`tool-recovery.ts` 在 `before_agent_start` 根据当前分支的真实历史调用和当前工具集合，增加一段结构化工具接口提示；新会话没有旧调用时不添加，切回相应工具或换分支时重新计算、清除过期提示。只推荐当前已声明的编辑/命令工具，不启用额外工具，也不把旧命令 session ID 交给其他工具续跑。

Pi 对未知工具不会触发 `tool_call` / `tool_result`，因此通过 `context_with_system` 读取请求中的工具声明（排除本回合隐藏项），在消息副本中增强准确匹配的 `Tool <name> not found`：必须是本扩展的失活工具、匹配前面的调用 ID/name 且 `isError: true`。明确未执行、不要重复，并指向当前工具。成功结果、其他错误、其他插件工具不改；不自动翻译执行，不改原始 session 或历史工具调用，不新增 Pi 核心补丁。

离线回归使用真实 Pi Session/ExtensionRunner/调度器和合成模型：先成功 `apply_patch`，切到普通 Completions 后故意误用一次，再用当前工具成功并切回 Codex；验证请求序列化含纠正说明、旧调用不执行、原始历史仍保留原错误。提示只能改善恢复，不保证任意实际 endpoint/model 都不再误用。

### 压缩时保护用户要求

`extensions/compaction-guidance.ts` 保存唯一一份短规则；在 `CodexProviderRuntime.performCompaction()` 构造原生请求时幂等追加。手动／Pi 阈值／溢出／provider 百分比各入口共用，普通回合不追加；手动 customInstructions 保留。规则不要求 Markdown、不改 checkpoint、retained-context 或失败即取消策略。普通模型由 `pi-compaction-guidance` 复用 Pi 摘要函数处理；它跳过 Codex，避免双重压缩。

离线请求与真实 SDK 合成会话回归：`scripts/test/compaction-guidance.test.mjs`；证明指导确实发送、checkpoint 原样保留，不代表实际后端摘要质量验收。

## 验证

不连真实模型，用本地 mock 的 Codex Responses 端点跑真实 pi CLI（Lite 开 / 关各一次）：

```bash
cd packages/pi-gpt-codex
PI_GPT_CODEX_LIVE_TEST=1 LIVE_LITE=1 \
  PI_HOST_DIR="$(npm root -g)/@earendil-works/pi-coding-agent" \
  PI_COMPAT_DIR="$PWD/../pi-openai-codex-compat" \
  node test/live-codex.mjs
```

断言：`end_turn=false` 触发后续请求、`apply_patch` 真的改了文件、请求里是 Codex 工具集（没有 `edit` / `write` / `bash`）、Lite 头和 `reasoning.context` 正确、系统提示词是 Codex 风格。

新增工具切换与边界回归（临时 HOME、合成凭据/会话、无真实 provider 请求）：

```sh
PI_HOST_DIR=/path/to/pi-coding-agent \
  node --test scripts/test/codex-tool-switch.test.mjs scripts/test/codex-tool-recovery.test.mjs
```

本机配置引用仓库路径时，下次正常启动会加载这些源码；本轮实现和测试不自动 reload/restart 当前会话。真实 endpoint 的模型恢复行为仍需在目标机器验证。

## 和其他插件的关系

- `@nijaru/pi-fast-mode` 在本包接管 `openai-codex` 流之后不生效（实测 `service_tier` 为空，不论加载顺序），已从 `pi/settings.json` 移除，改用本包的 `fastMode`。
- `pi-hashline-edit-pro` 的 `read` 输出带行锚点，只配合它自己的 `edit`；Codex 模型改用 `apply_patch`，所以 `pi/pi-hashline-edit-pro.json` 的 `disableOnModels` 对 `openai-codex/*` 关闭它。
- `picc-permission-modes` 已补丁：`apply_patch` / `exec_command` 走和 `edit` / `write` / `bash` 同一道权限闸（见它的 LOCAL-PATCH.md）。
