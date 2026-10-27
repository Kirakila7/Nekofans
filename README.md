# 大肥鱼桌宠 · v1 开发版

接续 `大肥鱼桌宠_项目框架_v1_20261026.zip`，主角色通过独立聊天 API 交流。
当前实现独立人设、逐条聊天记录、待确认/已确认记忆、带来源的会话摘要、浅蓝单行输入、回复气泡和 Windows 开发启动入口。
已接入按需启动的内置 DSH 工作台和读取其真实目录的子代理桌宠；增加本机独立便携构建，完整真实任务与安装升级仍待验收。

免安装版本的使用、数据位置与构建说明见 [docs/PORTABLE.md](docs/PORTABLE.md)。程序和运行资源一起移动，用户数据保留在当前 Windows 用户目录。

仓库另外提供 [N.E.K.O. 精简版工作台](docs/NEKO_LITE.md)：`apps/neko-workbench/` 保留 macOS 开发项目的桌宠、N.E.K.O. 界面和真实 DSH 子代理入口，通过 `npm run start:neko` 启动。它与默认 Windows 应用使用独立的数据、工作区和 DSH profile，可并行开发。两个入口的功能与验证范围分别记录；v3 工作台共居合同及双记忆参考框架位于 `apps/neko-workbench/framework/`。当前任务与文件所有权见 [项目分工](docs/PROJECT_WORK_SPLIT.md)。

[N.E.K.O. 原生语音接入分工](docs/NEKO_NATIVE_VOICE_PLAN.md)列出已有 ASR/TTS 原生 worker、待接的聊天/记忆与桌面链路，以及并行任务和验收标准；当前分享的是接入方案，语音功能尚待实施与联调。

## 运行

源码开发要求 Windows、Node.js 24 或更新版本。仓库包含实际使用的动画和署名，Electron 固定为 44.7.0，并提交 npm 依赖锁。DSH 程序、配套运行资源及用户数据不随仓库上传。

```powershell
cd '<本地源码目录>'
npm ci
npm run setup:electron
npm start
```

点击桌宠打开单行输入，Enter 发送，Esc 收起。右键可打开内置 DSH、子代理显示数量、全局设置、API 设置、角色设定、记忆管理、完整回复和退出。
全局设置可以将桌宠移回可见区域；拖拽按屏幕工作区限制位置，显示器移除后自动适配，小工作区会等比缩小完整界面。
API 设置支持 OpenAI 兼容和 Anthropic 协议；填写地址、模型与密钥后保存。不会预置账号或自动发送测试请求。
普通远程地址要求 HTTPS，本机测试接口允许 HTTP。API 地址填写基础路径，例如 OpenAI 兼容接口的 `https://example.com/v1`。

`setup:electron` 从 Electron 官方渠道下载对应平台的二进制文件；开发启动优先使用本项目 `node_modules/electron/dist/electron.exe` 和 `assets/`。原开发沙箱只作 Electron 缺失时的兼容路径。也可用 `NEKO_FISH_ELECTRON` 和 `NEKO_FISH_ASSETS_DIR` 覆盖路径。素材许可与署名见 [assets/ATTRIBUTION.md](assets/ATTRIBUTION.md)，保留原来的非商业使用约束。

私有协作者也可从 [Releases](https://github.com/CN-Zephyr/bigfish-pet/releases) 下载不含 DSH 的 Windows 便携包，解压后直接运行，无需安装 Node 或 Electron。该包可独立使用动画、聊天和记忆；DSH 菜单在未补齐运行资源时不可用。

程序使用 `%APPDATA%/neko-fish` 私有用户数据目录，不复制其他角色的记忆。聊天 API 密钥由 Windows DPAPI 加密保存，设置页仅显示是否已保存，不回显密钥。
聊天及记忆存于本地 SQLite，人设及非秘密设置存于 JSON。退出菜单或启动终端 Ctrl+C 可停止；本机静态服务使用随机空闲端口，随程序退出关闭。

## 记忆范围

- 用户陈述中的部分姓名、偏好或“记住”指令会生成候选；这是保守的关键词提取，可能遗漏。
- 候选必须由用户在记忆面板确认，才会作为已确认记忆写入下一轮系统上下文。
- 可以编辑、删除记忆。删除记忆保留原始聊天，因此近期原话仍可能出现在聊天上下文中。
- 召回按关键词相关性及长度预算筛选，不能等同于 N.E.K.O. 的语义记忆、反思或人格系统。
- 长会话超出近期上下文的旧消息会生成本地原话摘录，按用户/角色区分，保存来源消息 ID 与生成时间。每段最多 8 条消息，首次积压每轮最多整理 256 条，不额外请求模型 API。
- 摘要与已确认事实分开保存、显示和注入；它可能省略细节或包含过时信息，不会自动升级成确认记忆。按相关性与含元数据的 4000 字符预算召回，优先参考近期原话与已确认修正。
- 记忆面板可以查看摘要来源、删除摘要。来源预览每条最多 4000 字符，原始聊天保持完整；删除后，已处理的旧段不会在重启或下一轮重新生成。
- 不启动 N.E.K.O. 或语音服务；DSH 仅在打开工作台时启动。

## DSH 工作入口

右键主角色选择「打开内置 DSH」，在工作台中发起任务、处理提问/授权及查看成果。主角色输入仍只用于陪伴聊天。
关闭工作台窗口不会停止 Host 或正在进行的任务，右键可再次打开；退出整个桌宠时关闭 Host。
DSH 的 profile、会话及账号状态位于用户目录下的 `dsh/`，默认工作区位于 `workspaces/`，不借用现有 DSH 登录态。
首次使用仍需在 DSH 自身界面完成其引导与账号配置；聊天 API 的设置不会自动用作 DSH 凭据。

子代理来自 DSH 目录，订阅只读工作区与会话投影事件，并每 2 秒补偿读取运行状态，默认显示最多 5 个；常驻先占名额，再按目录顺序显示。
点击可继续支持续聊的子代理会话，右键可常驻、修改本地昵称、恢复 DSH 名称或请求停止。
一次性或其他不可续聊的子代理保持只读，请回工作台操作。昵称与显示设置写入 `dsh-pets.json`，不修改 DSH 名称。
根会话遵循 DSH 工作区注册表顺序，每个父会话内遵循子代理目录顺序。工作台浏览器本地的扁平排列尚未同步；审批和提问继续由工作台处理，当前只读订阅不接管交互权限。
事件流断线后重新获取只读连接并同步最新状态；完整交互事件与真实模型任务仍待验收。

开发环境复用 F01 的预备 DSH 构建，可用 `NEKO_FISH_DSH_RUNTIME` 指定含 `node_modules/@deepseek-ai/dsh-desktop-host` 的目录，
用 `NEKO_FISH_DSH_PRIMARY_RUNTIME` 指定配套运行资源目录。便携构建使用已验证的完整 Python/Node 资源与 Office 技能，详见 [docs/DSH_RUNTIME.md](docs/DSH_RUNTIME.md)；并未验收所有 Office、视频或真实模型任务。

## 验证

```powershell
npm test
npm run check:distribution
```

`npm run test:desktop` 运行真实 Electron 烟测，会短暂打开测试窗口。它使用系统临时目录、本机模拟 API 与虚构密钥，结束后删除测试用户数据、关闭进程和监听端口；截图及结果写到工作区 `../_sandbox/v1/evidence/`。
其中 DSH 工作台使用真实 Host；子代理窗口的任务状态使用明确的本地 RPC 夹具，不冒充真实模型任务。
`npm run test:dsh` 单独检查真实 DSH Host 的启动、默认工作区隔离、会话及投影接口、重启恢复与退出，不登录或调用模型。

默认只运行当前 v1 的本地检查：聊天协议、持久化、记忆完整链、桌宠控制器/IPC、桌面设置与运行生命周期，以及可复用模块的离线回归。
旧 `tests/memory/`、`tests/integration/`、语音 sidecar/live 检查仍保留为历史实现，不包含在 v1 默认测试中，也不作为当前版本通过的证据。
测试使用临时数据和回环模拟接口；不证明某个真实 API 供应商已经联调成功。

分发预检只检查源码和本地运行资源，不启动服务；当前存在缺项，返回非零退出码符合预期。具体缺项见 [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)。

进度与已知缺口见 [docs/STATUS.md](docs/STATUS.md)。源码仓库与本机便携成品分别维护，上传源码不等于公开发布程序。
