# Windows 开发入口

本机免安装成品及双击启动说明见 [PORTABLE.md](../../docs/PORTABLE.md)。以下路径和环境变量用于源码开发；便携版从自身 `resources/` 读取运行资源。

在 `neko-fish` 目录运行 `npm start`（或 `node scripts/start-desktop.mjs`）。
`node scripts/start-desktop.mjs --check` 仅检查本机 Electron 和素材路径，不打开窗口。

先执行 `npm ci`、`npm run setup:electron`，默认使用本项目固定的 Electron 44.7.0 和 `assets/` 动画素材；保留原工作区 Electron 路径作为缺失时的兼容路径。
可通过 `NEKO_FISH_ELECTRON` 和 `NEKO_FISH_ASSETS_DIR` 指定本地路径。
缺少素材时使用文字占位。实际动画的出处与非商业许可见素材目录的 `ATTRIBUTION.md`；
开发入口没有把这些第三方素材重新授权，也不包含可再分发的安装包。

首次启动把 `config/personas/bigfish.json` 复制到 `%APPDATA%/neko-fish/personas/`。
之后只编辑这个用户副本。聊天、记忆、设置和 DPAPI 密钥文件均保存在 `%APPDATA%/neko-fish/`，
不会写回仓库。初始没有 API 地址、模型和密钥；保存设置不会发出网络请求。

右键桌宠可打开内置 DSH、子代理显示数量、API 设置、角色设定、记忆管理、完整回复，或退出。
记忆管理中另列未经确认的会话摘要，支持查看来源原文和删除；摘要由本地摘录生成，原始聊天保持完整。
全局设置可将桌宠移回可见区域。主角色和子代理共用多显示器工作区约束，使用主进程 DIP 游标拖拽；小工作区会等比缩小界面，显示器移除后自动收回。
设置窗口以隔离、沙箱 renderer 运行，只接受自身主框架的 IPC 请求。
密钥由主进程交给 Windows DPAPI，读取设置只返回是否已保存密钥。
保存设置会取消进行中的回复、关闭旧数据库和临时回环服务，再创建新的聊天与桌宠实例。
右键「退出」或终端 Ctrl+C 都会正常关闭回环服务；启动终端断开也会通知桌宠退出。
正常关闭超过 5 秒时，开发启动器才强制停止子进程。端口由系统动态分配，仅监听 `127.0.0.1`。

内置 DSH 在用户选择打开时启动，使用 `%APPDATA%/neko-fish/dsh` 独立 profile。
关闭工作台窗口继续保留任务；退出桌宠或启动终端断开时统一停止 Host。
真实目录驱动子代理窗口，默认上限 5，可配置常驻和本地昵称；续聊与停止使用父子会话专用接口。
工作区和会话投影通过只读事件流触发刷新，运行状态每 2 秒轮询补偿；断线重新认证并获取完整基线，退出取消订阅及重连计时器。
根会话读取工作区注册表顺序；浏览器本地扁平排列、完整交互事件和真实模型任务仍待联调，审批权保留在 DSH 工作台。
预备构建路径可用 `NEKO_FISH_DSH_RUNTIME`、`NEKO_FISH_DSH_PRIMARY_RUNTIME` 覆盖。
没有启动 N.E.K.O. 或语音服务。
