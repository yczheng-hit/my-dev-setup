# pi-hud-footer 本地补丁

基础版本：npm `pi-hud-footer@0.8.0`。运行代码补丁：`../../patches/pi-hud-footer/0.8.0-local.patch`。

## 改动

- 去掉经典 HUD 两行和工具行左侧的一个空格缩进。
- 经典 HUD 第一行、边框 HUD 上边框显示当前会话名称，标签跟随 HUD 语言（`session:` / `会话:`）。未命名时省略。
- `/rename 新名称` 直接改名；`/rename` 打开输入框，当前名称作为占位提示。取消或空输入不清除名称，相同名称不重复追加记录。非交互模式不带参数时提示用法。
- 使用 `pi.setSessionName` / `pi.getSessionName` 原生 API，不另建命名数据库；Pi 自带 `/name`、其他扩展改名，以及恢复历史会话都使用同一名称。
- 原生 `session_info_changed` 事件请求重绘 HUD；显示按需读取当前名称，不缓存上个会话的名称。
- `display.all.sessionName` 默认显示，也支持 `display.classic` / `display.border` 覆盖。名称在 HUD 中最多显示 32 个终端列，完整名称保持不变；最终渲染仍受窗口宽度约束。

Pi 会延迟写入还没有用户消息的会话。只在这种会话里改名时，名称只在本次运行中显示；首次发送消息后，Pi 会把名称和会话内容一起保存。插件沿用这一原生行为，不强制创建空会话文件。

## 验证

```bash
# 指向本机安装的 Pi 包根目录，避免把机器专用路径写进测试。
PI_HOST_DIR=/path/to/node_modules/@earendil-works/pi-coding-agent \
  node --test packages/pi-hud-footer/test/session-name.test.mjs
```

14 项测试通过：命名规范化、中文标签、Unicode 长名称、两种 HUD 渲染、输入框取消/空输入、重复改名、无 UI 模式、显示开关、窄窗口，以及真实 `SessionManager` 落盘和恢复。测试使用 Pi 的 jiti 加载扩展、真实 TUI editor 和真实 SessionManager；不调用网络模型。

另外已在隔离临时 HOME 的真实 Pi 1.2.0 中通过 tmux 实测：`/rename 名称`、无参数输入框、边框 HUD、原生 `/name` 即时刷新，以及使用本地假 provider 产生响应后重启同一会话仍显示名称。类型检查通过（TypeScript 5.9.3，对接本机 Pi 1.2.0 的类型）。

## 补丁维护

补丁只包含 `extensions/` 运行代码，使用 `a/`、`b/` 路径，包含新增 `session-name.ts`。额外测试、此文档、README / 配置文档和示例不在 patch 中。

生成方法见仓库根 README。验证时重新解包 npm 原版，执行 `patch -p1`，再对其 `extensions/` 和本地目录做 `diff -r`，应无差异。

本机加载的是仓库目录，无需重新安装；运行中的 Pi 执行 `/reload` 生效。
