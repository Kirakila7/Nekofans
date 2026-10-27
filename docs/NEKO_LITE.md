# N.E.K.O. 精简版并行接入

本次以用户提供的 `NEKO桌宠_项目框架_v3_工作台共居整合_20261026.zip` 为参考，将本机 N.E.K.O. 桌宠工作台 v0.13.0 的源码快照接入同一仓库。原项目继续在原目录开发，这份快照在独立分支维护；后续界面更新需通过代码审查同步。当前执行分工见 [PROJECT_WORK_SPLIT.md](PROJECT_WORK_SPLIT.md)。

## 两个运行入口

| 入口 | 作用 | 现有实现 |
| --- | --- | --- |
| `npm start` → `apps/desktop/` | Windows 大肥鱼桌宠 | 独立聊天 API、人设、SQLite 聊天/轻量记忆、按需 DSH Host、子代理桌宠；详情见原 README |
| `npm run start:neko` → `apps/neko-workbench/` | N.E.K.O. 工作台开发入口 | macOS 原型的透明桌宠、视频动作、雾蓝/大肥鱼界面、头像/角色位、真实 DSH 目录和子代理续聊 |

两个入口保持独立。Windows 应用不会因增加工作台而替换聊天或记忆实现；工作台也不会读取 Windows 的数据库、DPAPI 密钥或正在开发的原项目存档。子代理状态来自各自 DSH 目录，主角色不随子任务进入工作状态。

工作台默认不启用本地 N.E.K.O. 聊天适配器。通用聊天 API 仅在原 Windows 入口中已有实现；本次没有把它移植到工作台。角色头像位和皮肤选择不会自动创建已连接的聊天模型。

## 开发启动

要求 Node.js 24+、本机 Electron 和匹配的 DeepSeek Harness 运行时。工作台按 macOS 开发项目接入；其他平台的这个新入口尚未完成本机验收。原 Windows 入口及便携构建方式不变。

```sh
# 仅检查启动文件路径；不启动服务，也不创建存档
npm run start:neko -- --check

# 启动独立工作台副本
npm run start:neko
```

macOS 默认使用已安装 DeepSeek Harness 的 CLI/模块和 `~/.dsh/electron/` 中的 Electron，也可通过以下变量指定开发依赖。源码没有捆绑运行时，不会下载软件或借用其他项目的账号。

| 环境变量 | 作用 |
| --- | --- |
| `NEKO_WORKBENCH_ELECTRON` | Electron 可执行文件；显式设置失效时直接报错 |
| `NEKO_WORKBENCH_DSH_CLI` | 匹配的 `dsh` CLI 可执行文件 |
| `NEKO_WORKBENCH_DSH_MODULES` | 同版本的 `@deepseek-ai` 模块目录，支持安装包内的 ASAR 路径 |
| `NEKO_WORKBENCH_DATA_DIR` | 工作台独立数据目录，默认 `apps/neko-workbench/data/` |
| `NEKO_WORKBENCH_WORKSPACE` | 独立任务产出目录，默认 `apps/neko-workbench/workspaces/` |
| `NEKO_WORKBENCH_ELECTRON_USER_DATA` | 独立 Electron profile，默认数据目录下的 `electron/` |
| `NEKO_WORKBENCH_COMMUNITY_URL` | “新会话”下方社区入口的 HTTPS 地址，默认官方喵宇宙社区 |

DSH_HOME 始终使用所选数据目录下的 `dsh/`。首次启动需要在内置 DSH 完成自己的账号配置；默认不导入全局 DSH 凭据。不要把上面的数据目录指向正在运行的原项目。如果要同时启动多个工作台副本，分别设置数据、工作区与 Electron profile。

启动路径预检对 ASAR 只检查归档文件存在，无法在普通 Node 中确认归档内每个模块。它不代表 Electron 窗口、DSH 协议或真实模型请求已验证。Ctrl+C 或终止启动终端会请求关闭当前副本。

社区入口连接已有 [喵宇宙社区动态页](https://community.project-neko.cn/feed)，在独立沙盒窗口中使用网站自己的账号与功能。社区与 DSH 的会话分区各自独立；桌面单点登录、通知/卡牌和本地记忆的桥接分别推进。详见 [COMMUNITY_INTEGRATION.md](COMMUNITY_INTEGRATION.md)。

## v3 工作台共居合同与双记忆框架

`apps/neko-workbench/framework/` 纳入 v3 工作台/共居区合同、配置和测试，同时保留 v2 双记忆内核与原合同：

- 日记与 N.E.K.O. 两种记忆接口，按稳定角色 ID 隔离。
- 原事件 ID、父事件、来源与确认状态；增量游标、重试与去重。
- 冲突保留两版、显式删除/恢复、私人记忆能力检查。
- 主角色右键“养鱼”功能集合与首次配置/发布验收规格。
- 全局头像、三个显示角色位、账号与 DSH 会话身份分别管理；仅大肥鱼角色位启用现有 DSH 入口。
- 共居区只按真实登录状态显示人物；官方余额保留 CNY/USD 原币种，未知值不显示为零，不跨币种求和。

这些是参考实现和模拟适配器测试。真实日记/N.E.K.O. 网关、原生“养鱼”菜单、聊天上下文接线和下载安装向导尚未接通。现有 Windows 轻量记忆继续使用原实现；本次不会自动同步任何角色记忆，也不会启动 B站自主生活或公开发布行为。

## 检查

```sh
npm test                 # 原 v1 离线套件 + 新工作台离线回归
npm run test:neko        # 仅新增启动、隔离、工作台纯模块及双记忆参考测试
npm run check:neko       # 工作台源码与主题静态检查
```

离线套件中的回环模拟 API 需要系统允许监听 127.0.0.1。它们不连接真实模型供应商。Windows DPAPI 专属检查在 macOS 跳过，真实 Windows Electron/便携包验收不能由本机结果替代。

本次没有重新验证历史截图中的余额、账号、窗口或旧真实任务；新工作台未进行真实账号登录和模型调用。安装包、签名、原生双记忆互通、跨平台运行验收分别推进，不把源码接入视为发布完成。

## 来源与协作

工作台来源见 `apps/neko-workbench/SOURCE.json`。保留 dsh-pet 的 MIT 许可、素材来源和用户提供的 B0 界面套件来源。源码迁入排除运行时、账号、会话、记忆、产出、余额截图及本机验证证据；原素材的公开再分发条件仍需沿用仓库现有的分发验收。

遵守 [COLLAB.md](COLLAB.md)：每个子 agent 使用独立 worktree 和明确文件所有权。本轮工作台迁入由子 agent 负责；根启动器、根测试入口、文档与最终合并由协调 agent 负责。远端提交保持在 `codex/neko-lite-parallel-integration` 审查分支，主分支继续现有项目开发。
