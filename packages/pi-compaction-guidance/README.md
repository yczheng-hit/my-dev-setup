# 压缩指导

普通物理模型压缩时复用 Pi 的 `compact()`，只追加简短的信息取舍规则：保护仍有效的用户目标和约束，合并重复自动检查，保留实质变化、证据和未解决问题。手动附加要求与上次摘要一并保留。

- 保留 Pi 原生摘要格式、近期保留切点、split-turn 和文件追踪，不改原始消息或压缩阈值。
- 使用当前注册的 provider 流和认证，沿用有效 retry、transport、thinking budget 与超时设置；取消或不完整摘要不写入，失败不额外退回另一份文字摘要。
- 普通摘要扩展只处理手动／阈值／溢出压缩，不拦截 `/tree`；虚拟模型仍由宿主路由和压缩，暂不追加指导，避免绕过 direct 路由。
- `openai-codex` 始终跳过：由 Codex compat 在原生压缩请求中追加同一规则，保留不透明 checkpoint 和约 64K 近期 user 消息的既有策略。
- 规则唯一来源：`../pi-openai-codex-compat/extensions/compaction-guidance.ts`。本包与仓库 Codex compat 一起使用，后者的 runtime patch 仍可独立重建。

规则只影响压缩请求，不逐轮注入系统提示，也不限制定时唤醒次数。模型摘要仍可能遗漏，不能还原此前已丢失的信息；测试证明请求和会话契约，不证明真实模型一定遵守。

离线回归：`PI_HOST_DIR=/path/to/pi-coding-agent node --test scripts/test/compaction-guidance.test.mjs`。
