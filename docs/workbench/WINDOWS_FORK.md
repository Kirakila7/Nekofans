# Windows 工作台分叉

本分叉从上游 `ec32201615c51b0b6814328d54ebeb8a71576245`（0.28.18，build 54）开始，独立维护 Windows 适配。版本信息在 `config/windows-release.json`；macOS 日包配置仍保留在 `config/daily-release.json`。

- 开发分支：`codex/windows-0.28.18`。
- 已确认效果的固定基线：`windows-0.28.18-baseline-20261030`。后续视频窗口层级和尺寸修复使用单独提交。
- 这是使用现有 Electron、DSH、Node 和 Python 的本地源码启动版本，尚不是新的 Windows 安装包。当前机器通过仓库外已有的 `启动最新版工作台测试.cmd` 启动，沿用既有配置和工作目录。
- Git 仅保存源码、测试和配置格式。账号、密钥、聊天记录、项目记忆、QA 配置、运行时和本地部署记录不加入仓库。

## 基线行为

社区和视频模式隐藏底部聊天区，同一个肥鱼移到竖栏并支持点击聊天；返回聊天室恢复原位与草稿。账号入口适配当前 DSH 的语义属性。页面铺满侧栏，Windows 原生页面为悬浮输入、恢复按钮和分隔条让位；输入框保留原 React 节点，通过手动 popover 避免收起工作区后的裁切。Windows 记忆组件可使用既有便携 Python，保存过的模型设置优先。

## 修改与同步

在此分支修改源码。编辑 `embedded-dsh` 的界面源文件后运行相应的 `sync-workspace-shell.cjs`、`sync-side-rail.cjs`、`sync-unified-layout.cjs` 和 `sync-account-habitat.cjs`，同时提交生成的客户端。更新上游前保留此基线，并检查所有 Windows 适配；历史输出目录仅作参考。

基线的本地检查涵盖账号代理、页面切换、草稿保留、原生窗口几何和输入框命中。实际供应商回复、登录授权和视频播放不包含在这些检查中。
