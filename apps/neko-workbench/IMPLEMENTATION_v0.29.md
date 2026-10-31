# v0.29 · 公共频道（大厅）文本聊天

日期：2026-10-30（Asia/Shanghai）。范围：可选 N.E.K.O. 工作台的「频道」面板，对接新建的 N.E.K.O.Chat 服务。协议以 N.E.K.O.Chat 仓库的 `docs/protocol.md` 为准。本轮不做熟人房、视频分享和社区动态。

侧栏「社区」后面新增「频道」按钮。所有登录的人在同一个频道里文字聊天，每个人可以带上自己的猫娘。和她的私聊（主角色陪伴聊天）不依赖频道：没配置频道服务、频道断线、被禁言或频道模块初始化失败时，私聊照常可用。

## 模块

| 文件 | 内容 |
| --- | --- |
| `lobby-config.cjs` | 解析 `NEKO_WORKBENCH_CHAT_URL`、`_CLIENT_ID`、`_AUTH_URL`、`_OAUTH_PORTS`，派生 `wss:`/`ws:` 地址。未设置地址时使用内置生产地址 `https://chat.nekotech.ai/`；显式设为空字符串时面板显示「频道服务未配置」。 |
| `lobby-auth.cjs` | 社区账号 OAuth：PKCE（S256）+ state，`127.0.0.1` 一次性回调服务器（5 分钟内只接受一次 `GET /oauth/callback`），scope `openid offline profile`。刷新单飞，先保存轮换后的 refresh token 再使用新 access token；`invalid_grant` 清空回到未登录；登出尽力调用 revoke。access token 只在内存。 |
| `lobby-client.cjs` | REST（Bearer，401 刷新后重试一次，历史 512KB 上限，错误码映射成固定中文）和 WebSocket（首帧 `auth`、心跳、全抖动退避重连、`last_event_seq` 补齐、按 `event_seq` 去重、`resync.required` 重载、按 `client_message_id` 重发 outbox、过期前 `auth.refresh`）。内存只保留最近 500 条消息，不落盘。 |
| `lobby-frames.cjs` | 入站帧逐类型 schema 校验，未知类型和超过 64KB 的帧丢弃。 |
| `lobby-sanitize.cjs` | 移植自 N.E.K.O. 串门的清洗函数：去控制字符、nonce 信封与伪造标签中和、去 Markdown 图片/链接、去情绪标签、去猫娘提及、截断。 |
| `lobby-avatars.cjs` | 主进程下载头像：只接受白名单 https 主机，`redirect:'error'`、5 秒超时、256KB 上限、按魔数确认格式后转 `data:` URL；失败回退到按 ID 计算的色相。快照里没有外部 URL。 |
| `lobby-cat.cjs` | 她在频道里的生成：一起回复的 `suggest()`，以及独立发言应答器（触发、调度、提示词、出站清洗）。 |
| `lobby-experience.cjs` | 收集共同经历片段、生成摘要并写回记忆。 |
| `lobby-controller.cjs` | 组合以上模块；白名单校验渲染进程请求；发布投影后的快照（连接状态、参与状态、我、频道、最近 200 条消息、成员、猫娘设置、建议卡片、当日用量、错误文本）。快照里没有 token、原始服务端响应或召回的私人记忆。 |
| `lobby-composer.js` | 渲染进程的草稿逻辑（纯函数）：采用建议、替换/接在后面、撤销、来源标记。 |

接线：`main.cjs` 在社区账号之后构造 controller。模块缺失或构造抛错时换成不做事的 `lobbyOffline`。`ipcMain.handle('workbench:lobby')` 先调用 `assertWorkbenchCaller`；`before-quit` 调用 `dispose()`。`workbench-preload.cjs` 只增加 `lobby` 和 `subscribeLobby`。界面在 `embedded-dsh/workspace-shell-source.js`/`.css` 的 `createLobbyView`，改完用 `sync-workspace-shell.cjs` 同步进 B0 皮肤的 `client.js`。所有消息文本用 `textContent` 渲染。

## 两种参与方式

同一时间只开一种，默认「一起回复」。也可以选「她不参与」。

1. **一起回复（assist）**：她不直接在频道里说话。点消息上的「请她帮我回」或在输入框上方的私下协商框里说要求，她生成一张建议卡片（采用 / 重新生成 / 放弃）。这条路径没有任何发送调用，最后由用户按发送。输入框非空时采用会让用户选「替换」或「接在后面」，替换可撤销。被 @ 时协商框里只出现一句提示，不自动生成。生成可读取召回的共同记忆（≤1200 字，标为仅供参考），`maxOutputTokens` 300，超时 30 秒，截到 2000 字。
2. **她自己说话（independent）**：她以「主人昵称的猫娘名」身份发 `cat.message.send`。触发方式：只在被 @ 时（`mention`）、主人说话或被 @ 时（`owner_or_mention`）、自由发言（`free`，概率 0.15、本地冷却 60 秒、每日上限默认 200）。只响应 60 秒内的实时 `message.new`，延迟 0.5–1.5 秒，每只猫一次只生成一条。提示词只含角色人设、固定频道说明、可选的频道补充说明和最近 20 条频道消息（nonce 信封包裹），`memories: []`，没有工具。输出清洗后截到 500 字 / 12 行，空或 `[PASS]` 不发。服务端的冷却和上限拒绝静默丢弃，状态显示「猫猫在休息」。

切换方式、离开频道或换了目标消息时，未采用的建议和进行中的生成都作废（`modeEpoch` 比对后丢弃，`AbortController` 中止）。已采用进输入框的文字算用户草稿，保留原来的标记。草稿只在渲染进程内存里。

两种方式都要求聊天 API 后端（`backend==='chat-api'` 且已保存密钥）。`neko` 后端或没配置 API 时只能选「她不参与」，并显示「需要聊天 API」。此外，猫娘未保存、频道关闭猫娘、管理员停用、被禁言、被封禁和频道未连接都会让参与不可用，并显示对应原因。

## 来源标记

| 发送方式 | `origin` | 别人看到 | 自己看到 |
| --- | --- | --- | --- |
| 用户自己写 | `human` | `张三` | `我` |
| 采用过她的建议后用户发送 | `human_ai` | `人＋AI 共同回复 · 张三与大肥鱼` | `人＋AI 共同回复 · 我与大肥鱼` |
| 她独立发言 | 猫娘消息 | `AI 独立发言 · 张三的大肥鱼` | `AI 独立发言 · 我的大肥鱼` |

采用建议后输入框左侧出现「人＋AI」标记，清空草稿才会去掉，发送时带 `origin:'human_ai'` 和 `assistCatId`。标记在发送时由服务端保存，之后切换方式不改历史；回复引用使用同样的标记。猫娘徽标由服务端按消息类型决定，人类把昵称改成「张三的大肥鱼」不会带上徽标。来源标记是诚实客户端的声明，服务端无法证明文本是否来自模型。

## 共同经历写回记忆

用户在频道里发过言，且当时参与方式是 assist 或 independent，这一段在 10 分钟静默、离开频道或切换方式后结束。`lobby-experience.cjs` 只取这段里和用户相关的消息（最多 30 条、6000 字），用用户自己的聊天 API 生成一两句摘要（≤200 字，要求把别人的话写成「某某说……」），再调用 `memorySystem.recordSharedExperience`。记忆条目 `itemId` 以 `lobby:` 开头，`evidenceRefs` 是 `lobby-msg:<id>`，`certainty` 为 `inferred`，同一段重复提交得到相同 `eventId`。记忆窗口显示来源「大厅共同经历」，可以确认、修改或删除。

- `off` 模式、用户没发言的段落不写。摘要连续失败两次就放弃，不写原文。
- 退出时打开或正在处理的片段存到 `data/lobby/pending-experience.json`；临时写入失败的片段也保留待重试，成功或明确放弃摘要后删除；超过 7 天的片段丢弃。POSIX 使用 0600；Windows 继承数据目录 ACL，尚未验证为仅所有者可读。
- 只有一起回复会读召回的记忆，而且只允许所有来源引用均为大厅消息的记录；无来源或混合来源不返回。独立发言不读记忆。记忆写入只发生在 `lobby-experience.cjs`。
- hub 的 `origin` 校验没有改，条目来源靠 `lobby:` 前缀和 `lobby-msg:` 引用区分。

## 本地数据与隐私

- `data/lobby/secrets/refresh-token.encrypted`：`WorkbenchSecretStore` 加密保存，拒绝 `basic_text` 后端。
- `data/lobby/cat.json`（0600，`atomicBytes` 写入）：`personaId`、`serverCatId`、`mode`、`independentTrigger`、频道补充说明（≤500 字）、每日上限。
- `data/lobby/pending-experience.json`：未写回的共同经历片段，写入成功后删除；Windows 文件权限继承数据目录 ACL。
- 不写入 `data/main-chat/` 的会话库。记忆只通过 `recordSharedExperience` 写进 hub。
- 频道生成都不经过 `MainChatService` 和私聊会话库。独立发言不读记忆；一起回复只读召回结果、不写；记忆写入只发生在 `lobby-experience.cjs`。
- 消息文本不写日志；除 `pending-experience.json` 外不落盘（客户端内存只保留最近 500 条）。

## 测试（`tests/neko-workbench/*.test.cjs`，`npm run test:neko`）

- `lobby-config.test.cjs`：强制 https、loopback http 允许、拒绝凭据和疑似 secret 的 query、auth http 只能配 loopback chat URL、client_id 正则。
- `lobby-auth.test.cjs`：授权 URL 形状（S256、43 字符 challenge、精确 redirect、scope）；错 state / 第二次回调 / 错路径 / 超时都被拒；token 响应校验；轮换的 refresh token 先持久化再使用；`invalid_grant` 清空存储；不回退明文；token、code、verifier 不出现在快照或错误里。
- `lobby-client-rest.test.cjs` / `lobby-client-ws.test.cjs`（假 `fetch`、假 `WebSocket`）：REST 401 刷新后重试一次、历史大小上限；token 只在第一帧、不在 URL；重连带 `last_event_seq`、抖动退避；按 `event_seq` 去重、跳号触发重连补齐、补到的 `message.deleted` 会把旧消息标成已删除、`resync.required` 重载；outbox 用同一 `client_message_id` 重发；畸形/超大帧丢弃；服务端错误文本映射、不回显；过期前发 `auth.refresh`。
- `lobby-frames.test.cjs` / `lobby-sanitize.test.cjs`：入站帧 schema 与大小上限；信封转义（含全角 `＜`/`‹`）、Markdown 媒体去除、提及移除和截断。
- `lobby-cat.test.cjs`：独立模式 3 种触发矩阵；忽略自己、过旧、补发的消息；延迟在 0.5–1.5s；新轮次取消并改目标、删除时中止；伪造的 `</lobby_data nonce=…>` 关不掉信封；`[PASS]` 和空输出不发送；猫娘提及被移除；独立发言 provider 调用带 `memories: []`；从不调用 `MainChatService` 或 `startApiPrompt`；每日上限生效；`mode!=='independent'` 时收到 @ 也不调用 `cat.message.send`。
- `lobby-assist.test.cjs`：`suggest` 完成后 client 的 `send` 和 `catSend` 调用次数都是 0；切模式、换目标、离开频道后，旧生成完成时被丢弃、不出现在快照；新请求中止旧请求；召回的记忆不出现在快照里；`neko` 后端时 `suggest` 被拒。
- `lobby-composer.test.cjs`：空输入框采用直接填入；非空时替换/追加可选，替换可撤销；采用后发送带 `origin:'human_ai'`；没采用时是 `human`；清空草稿去掉标记；切模式不清空已采用的草稿。
- `lobby-experience.test.cjs`：用户发过言且她在参与时，10 分钟静默、离开或切模式后写回一条；`off` 模式不写；用户没发言的段落不写；段落只含用户相关消息，其他频道消息不进入摘要提示词；`itemId` 带 `lobby:` 前缀、`evidenceRefs` 是 `lobby-msg:`；同一段重复提交 `eventId` 相同；退出时写 `pending-experience.json`，重启后处理并删除；摘要失败两次不写原文。
- `memory-shared-experience.test.mjs`：用临时目录和假 worker 构造 `WorkbenchMemory`，`recordSharedExperience` 后 `records()` 里有这条、记忆窗口可改可删；重建 controller（模拟重启）后 `recall` 仍返回它；没有改 hub 的 `origin` 校验。
- `companion-isolation.test.cjs`：lobby controller 未配置、断线、初始化抛错、被禁言、正在生成建议时，`workbench:companion` 的 `send` 都照常工作；频道生成进行中私聊 `send` 不返回 `busy`；`workspace-shell` 切换频道/社区/工作区时 dock 节点不被移除或设为 `inert`。
- `lobby-avatars.test.cjs`：只下载白名单 https 主机；重定向、超时、超大、魔数不对都回退色相；并发同 URL 只下载一次；快照里没有外部 URL。
- `lobby-controller.test.cjs`：请求校验拒绝未知键和动作；快照不含 secret；`neko` 后端时不能启用猫娘。
- `lobby-ui.test.cjs`：三种 `origin` 的 label、徽标和样式；回复引用 label 与原消息一致；自己的显示 `我` / `我与大肥鱼` / `我的大肥鱼`；模式条和三种状态点；`participation.available=false` 时只能选「她不参与」；昵称写成 `张三的大肥鱼` 的人类没有猫娘徽标；`<img onerror>` 文本按文本渲染；非管理员看不到管理控件；打开面板会调 `hideSocial`。
- `lobby-main-entry.test.cjs`：`workbench:lobby` handler 调 `assertWorkbenchCaller`；preload 只暴露 `lobby` 和 `subscribeLobby`；`before-quit` 销毁 controller。

测试用 mkdtemp 目录和端口 0。

## 验证

- 所有自动化测试通过（模拟登录、模拟服务端、假 provider、假时钟）。
- 和她私聊在频道断线、未配置、被禁言时照常可用。
- 一起回复时，建议不自动发送；切模式后旧建议不按新方式发出。
- 她自己说话时，按选定触发方式和频道防刷屏规则发言。
- 三种来源标记在消息行、回复引用和历史里显示一致。
- 用聊天 API 的用户能用频道里的猫娘功能；用本地 N.E.K.O. 的用户频道真人聊天正常，私聊也正常。

本轮只用模拟服务验证，真实 OAuth 完整流程、client_id 注册、生产服务器和真实模型行为需要单独测试、单独报告。
