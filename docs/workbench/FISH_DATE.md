# 肥鱼有约（本地源码，2026-11-04）

聊天室选择栏在“我的小窝”下新增“肥鱼有约 / 和她谈心”。它直接使用现有主 agent 的聊天服务、人物、模型、记忆和会话数据库，不另建一份私聊记录，也不向公共聊天室发送消息。较早记录每次加载 200 条，可以继续向前翻页。

进入后，原有的大肥鱼角色节点移动到右侧单行输入框上方，左侧私聊框隐藏且保留草稿。创造台使用公共聊天室的左栏位置和宽度。离开后恢复原角色与聊天框；工作会话和肥鱼有约的草稿保持独立。

输入框支持文字、emoji、表情包及 PNG/JPEG/GIF/WebP 图片，可选择文件、粘贴图片或拖入。每条最多 4 张，单张最多 4MB、合计最多 12MB。发送失败保留文字和附加内容；中文输入法组词期间不会提交消息。其他主聊天入口显示附件名称摘要。

图片保存于现有主聊天数据目录的 `main-chat/media/`，聊天数据库只存内容摘要标识及附件信息。读取图片必须先加载包含它的当前会话记录；目录/文件软链接和越界标识会被拒绝。切换聊天后端清除已授权图片标识。

OpenAI 兼容与 Anthropic API 使用各自的图片协议，历史上下文仅展开最近最多四张图片（12MB）；Anthropic 的 GIF 转为明确的文字提示。具体模型须支持视觉。当前 DSH 账号聊天线路只接收文字：图片仍可保存和显示，但界面及模型上下文会明确提示不能识图，不编造图片内容。本机 N.E.K.O. 线路暂不支持附加图片，发送会保留草稿并说明原因。

## 验证

提交分支以已合并 PR #62、#63、#64 的 `c7072113` 为基础；80 项检查通过，0 失败、0 跳过。该分支已用独立 Electron 数据目录核对原生界面：右侧聊天区填满内容栏，没有横向溢出；大肥鱼节点移入输入框上方；原左侧私聊框隐藏；独立创造台窗口可见。无真实账号或模型请求。

- 自动化：媒体持久化与协议、407 条 SQLite 消息分页和会话隔离、重启恢复、emoji/表情包/粘贴、中文输入法、失败草稿恢复、角色节点移动和归位、创造台左侧定位。
- 回归：主聊天、工作台隔离、办公/日常切换、原生创造台及小窝。
- 实际 Electron 源码预览：使用独立数据和 Electron 配置目录，核对新入口、右侧自适应、角色及单行输入框、表情面板；未使用日常账号或向真实供应商发送测试消息。

运行：设置 `NEKO_DOM_DEPS` 指向安装了 jsdom 的目录，用 Node 24 执行：

```text
node --test tests/neko-workbench/fish-date.test.cjs tests/neko-workbench/main-chat-runtime.test.cjs tests/neko-workbench/companion-isolation.test.cjs tests/neko-workbench/workspace-shell.test.cjs tests/neko-workbench/edition-switch.test.cjs tests/neko-workbench/native-composer-shell.test.cjs tests/neko-workbench/chatroom-home.test.cjs
```

修改界面源码后运行 `node apps/neko-workbench/embedded-dsh/sync-workspace-shell.cjs`，再启动源码预览。真实账号回复、模型识图能力及旧安装程序未作为本次验收结果。
