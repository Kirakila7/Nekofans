# Nekofans

**AI、朋友与工作台。**\
大肥鱼（AI）和人携手建立家园的地方。

Nekofans 是一个将桌面 AI 陪伴、多 Agent 工作流与 N.E.K.O. 社区放在一起的工作台。当前源码基于本地 **0.28.39 / build 75**，包含 PR #55 的渠道记忆与可选主动搭话，以及安装位置选择页修订。

这是独立社区项目，与 DeepSeek、Project N.E.K.O. 及角色所对应的模型厂商不存在官方隶属或背书关系。第三方组件和角色素材保留各自的许可与署名。

## 可以做什么

- **日常版与办公版**：在陪伴、社区与 DSH 工作界面之间切换。
- **大肥鱼陪伴**：独立聊天、人设与记忆；桌面角色和子 Agent 展示。
- **创造台**：可拖动、边缘吸附的输入浮窗，选择模型、推理等级、工作区和项目；展开查看会话内容并处理真实 DSH 选项。
- **社区与聊天室**：N.E.K.O. 账号入口、公共聊天室、主 Agent 私聊和参与设置。
- **我的小窝**：海面上的木地板，逐步共建自己的家。
- **B 站浮窗**：毛玻璃外壳、清晰网页内容，可拖动和展开。
- **渠道经历**：已接受的 B 站结构化记录和 QQ 文本可以进入私有记忆；桌面主动搭话默认关闭，需要自行启用。

以上描述源码已有实现；不同平台、供应商和真实账号流程的验证范围见 [集成状态](docs/workbench/INTEGRATION_STATUS.md)。本地夹具测试不代表真实 OAuth、供应商或渠道消息已完成联调。

## 从源码运行

需要 Node.js 24 或更新版本、Electron 及 DeepSeek Harness（DSH）运行资源。完整记忆运行环境还需要 Python 3.11，依赖由 `services/neko-memory/uv.lock` 锁定。源码仓库不含 DSH 安装文件、Electron 二进制、模型权重或用户账号。

```powershell
git clone https://github.com/Kirakila7/Nekofans.git
cd Nekofans
npm ci
npm run setup:electron
```

Windows 下按本机实际位置配置运行资源；下面的路径需要自行替换：

```powershell
$env:NEKO_WORKBENCH_ELECTRON = 'C:\runtime\electron\electron.exe'
$env:NEKO_WORKBENCH_DSH_CLI = 'C:\runtime\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$env:NEKO_WORKBENCH_DSH_MODULES = 'C:\runtime\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai'
npm run start:neko -- --check
npm run start:neko
```

启动器会明确检查资源是否存在，不会使用源码仓库中的占位目录冒充 DSH。更多环境变量和启动说明见 [工作台开发说明](docs/NEKO_LITE.md)；记忆环境准备使用 `npm run setup:neko-memory`。账号由用户在应用中自行登录，仓库不预置令牌或 API 密钥。

## Windows 安装版与构建

安装器先显示安装位置选择页，可输入路径或点击“浏览”。默认 `%LOCALAPPDATA%\Programs\NEKOfuns`；安装结束可勾选运行，也可通过桌面和开始菜单快捷方式打开。

项目对外名称已统一为 **Nekofans**。为兼容旧安装与存档，源码目录 `apps/neko-workbench`、内部 `NEKOfuns.exe` / `NEKOfuns.local.json`、安装身份和原有数据路径仍予保留。改名不迁移或清空已有账号、工作区与项目。

Windows 构建使用 `scripts/build-neko-daily.mjs`，完整输入、官方 NSIS 校验、安装流程及隔离验收见 [Windows 安装版构建](docs/workbench/WINDOWS_INSTALLER.md)。构建需要自行准备并核验 Electron、Node、记忆环境及 DSH 运行资源；克隆源码并不等于获得完整安装包。历史验证见 [集成状态](docs/workbench/INTEGRATION_STATUS.md)。

## 开发与测试

```powershell
npm run check:neko
npm run test:neko
```

部分 DOM 测试需要可用的 jsdom，真实 Electron 和安装器验收需要平台运行环境并显式启用。测试使用临时资料和合成服务，不自动登录真实账号或发送付费模型请求。提交前阅读 [贡献说明](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。

当前聚合检查仍有旧角色列表和聊天隔离夹具的已有失败；本次核心 255 项回归通过。具体结果、基础版本复现和未验收范围见 [源码公开状态](docs/workbench/OPEN_SOURCE_STATUS.md)，请勿将本版本视为全部检查通过的稳定发布。

## 许可证与素材

本项目拥有授权权利的代码和修改采用 [Apache-2.0](LICENSE)。第三方代码不因根许可证而重新授权，角色动画和美术也不自动获得商业使用许可。大肥鱼素材包含非商业、署名和相同方式共享等条件；其他 AI 娘素材亦有各自许可。

请阅读 [NOTICE](NOTICE)、[第三方组件与素材](THIRD_PARTY_NOTICES.md) 和 [素材署名](assets/ATTRIBUTION.md)。完整项目不能笼统理解为“所有素材均可商用”。

## 反馈与安全

欢迎到 [Discussions 讨论区](https://github.com/Kirakila7/Nekofans/discussions)交流想法、分享体验；功能问题和复现报告可提交 [Issue](https://github.com/Kirakila7/Nekofans/issues)。提交截图和日志前先移除账号、二维码、授权链接、密钥与聊天隐私。安全问题见 [SECURITY.md](SECURITY.md)，请勿在公开 Issue 中张贴秘密。
