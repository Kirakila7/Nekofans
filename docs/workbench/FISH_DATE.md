# 肥鱼有约（本地源码，2026-11-04）

聊天室选择栏在“我的小窝”下新增“肥鱼有约 / 和她谈心”。它直接使用现有主 agent 的聊天服务、人物、模型、记忆和会话数据库，不另建一份私聊记录，也不向公共聊天室发送消息。较早记录每次加载 200 条，可以继续向前翻页。

进入后，原有的大肥鱼角色节点移动到右侧单行输入框上方，左侧私聊框隐藏且保留草稿。创造台使用公共聊天室的左栏位置和宽度。离开后恢复原角色与聊天框；工作会话和肥鱼有约的草稿保持独立。

输入框支持文字、emoji、表情包及 PNG/JPEG/GIF/WebP 图片，可选择文件、粘贴图片或拖入。每条最多 4 张，单张最多 4MB、合计最多 12MB。发送失败保留文字和附加内容；中文输入法组词期间不会提交消息。其他主聊天入口显示附件名称摘要。

图片保存于现有主聊天数据目录的 `main-chat/media/`，聊天数据库只存内容摘要标识及附件信息。读取图片必须先加载包含它的当前会话记录；目录/文件软链接和越界标识会被拒绝。切换聊天后端清除已授权图片标识。

OpenAI 兼容与 Anthropic API 使用各自的图片协议，历史上下文仅展开最近最多四张图片（12MB）；Anthropic 的 GIF 转为明确的文字提示。具体模型须支持视觉。DSH 账号聊天线路通过原生 attachments + LLM 图像块发送图片，继续使用当前 deepseek-account / deepseek-flash 账号路线与余额，不读取或切换 API Key。GIF 原图保留动画显示；模型收到最多首、中、末三张采样帧与帧号说明（最多 300 帧、解码像素上限 16,777,216）。不将采样帧说成完整视频。账号模型未开放图像能力时显示错误，不能静默丢图。格式按文件头识别，不依赖后缀或浏览器 MIME。本机 N.E.K.O. 线路暂不支持附加图片，发送会保留草稿并说明原因。

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

## 2026-11-04 单人物与账号识图修复

角色移入肥鱼有约后，封面图原本依赖的 dock [hidden] 样式不再生效，导致封面和动画叠加。新增角色自身的隐藏规则，并恢复视频裁切比例，保证一个可见人物。

组合回归 117 通过、0 失败，1 项原生依赖用例在普通 Node 中跳过；该项另用实际打包的 DSH/Sharp/消息类型运行，8 项图像专测全通过。真实三帧 GIF 的三个颜色画面经过持久附件存储后仍按顺序进入账号桥接。实际 Electron 使用合成历史核对一个人物图层和原 GIF 显示。供应商回复为替身，没有使用真实账号或额度，未声称实际模型识图质量通过。
