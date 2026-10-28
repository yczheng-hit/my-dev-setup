# pi-openai-codex-compat 本地补丁

基础版本：npm `pi-openai-codex-compat@0.0.29`。运行代码补丁：`../../patches/pi-openai-codex-compat/0.0.29-local.patch`。

## 为什么要装

pi 自带的 `openai-codex` 适配和官方 Codex CLI 在请求形状上差很多。这个包把 GPT 路径补到接近官方：

- `apply_patch` 自由格式工具替换 `edit` / `write`；`exec_command` / `write_stdin` 替换 `bash`。
- Responses Lite 信封（`reasoning.context=all_turns`、`parallel_tool_calls=false`、`x-openai-internal-codex-responses-lite` 头），默认关，由 `pi/openai-codex-compat.json` 打开。
- `end_turn=false` 时自动续跑；远程 compaction；`fastMode`（`service_tier=priority`）。

只作用于 `openai-codex` provider，Claude 路径不受影响。不能和 `pi-openai-codex-conversion` 4.0.4 同时装。

## 改动

### Lite + 自由格式 `apply_patch` 的 schema 校验失败

`responses-tool-schema.ts`：Responses Lite 把直接声明的 function / custom 工具归入 `functions` namespace，但 namespace 的 `tools.items` 只接受 function 定义。`apply_patch` 是 custom（自由格式）工具，进入 namespace 后整个请求被校验拒绝，表现为 Lite 打开后第一轮就失败或 `end_turn=false` 续跑断掉。

补丁让 `tools.items` 接受 function 或 custom：

```ts
items: { anyOf: [RESPONSES_FUNCTION_TOOL_DEFINITION_SCHEMA, RESPONSES_CUSTOM_TOOL_DEFINITION_SCHEMA] }
```

其余文件和 npm 包一致。

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

## 和其他插件的关系

- `@nijaru/pi-fast-mode` 在本包接管 `openai-codex` 流之后不生效（实测 `service_tier` 为空，不论加载顺序），已从 `pi/settings.json` 移除，改用本包的 `fastMode`。
- `pi-hashline-edit-pro` 的 `read` 输出带行锚点，只配合它自己的 `edit`；Codex 模型改用 `apply_patch`，所以 `pi/pi-hashline-edit-pro.json` 的 `disableOnModels` 对 `openai-codex/*` 关闭它。
- `picc-permission-modes` 已补丁：`apply_patch` / `exec_command` 走和 `edit` / `write` / `bash` 同一道权限闸（见它的 LOCAL-PATCH.md）。
