# 当前项目分工

更新：2026-10-26。参考 `NEKO桌宠_项目框架_v3_工作台共居整合_20261026.zip`。

目标是把精简版 N.E.K.O. 工作台接入 `CN-Zephyr/bigfish-pet`，与现有 Windows 桌宠及原本机项目并行开发。使用审查分支，不在本轮改动远端主分支。

## 本轮责任与文件所有权

| 工作线 | 负责人/执行方 | 拥有的目录或文件 | 本轮交付 |
| --- | --- | --- | --- |
| 现有 Windows 桌宠 | 仓库原开发线 | `apps/desktop/`、`apps/pet-overlay/`、既有 `packages/` 和 `services/` | 继续独立聊天 API、轻量记忆和 Windows 便携版；本轮接入不覆盖这些实现 |
| 原本机 N.E.K.O. 项目 | 原聊天“精简猫娘计划以适配 dsh-pet (2)” | 原项目工作目录 | 继续工作台界面、角色和共居区迭代；新仓库副本使用固定快照，后续通过审查同步 |
| 工作台接入 | 子 agent `neko_lite_source` | `apps/neko-workbench/`、`tests/neko-workbench/`；框架参考由协调方最后整合 | 固定 v0.13.0 快照、保留桌宠与 DSH 子 agent、配置运行时、隔离数据/会话/工作区、处理 DSH 启停；并行增加“新会话”下方的现有 N.E.K.O. 社区入口与离线回归 |
| 整合与 GitHub 交付 | 主协调 agent | 根启动/测试脚本、根 `package.json`、`.gitignore`、`tests/neko-launcher/`、`docs/`、工作台 `framework/` 的 v3 更新 | 统一 `start:neko`、对齐 v3 合同与配置、合并子分支、全量验证、推送审查分支与 PR |
| 独立代码审查 | 子 agent `review_neko_integration` | 只读，无生产文件所有权 | 检查入口合同、运行数据隔离、DSH 启动失败/重连/退出和原入口保留；修复由接入 agent 完成，协调方验收 |

这里的分工记录本轮真实执行范围，不表示已向其他人或其他聊天发送任务，也不替仓库维护者分派后续工作。

## 分支与协作方式

- 集成分支：`codex/neko-lite-parallel-integration`，用于最终代码审查。
- 接入子分支：`codex/neko-lite-workbench`，从本轮读取的 `origin/main` 建立独立 worktree，只提交接入 agent 拥有的文件。
- 审查 agent 只读；主协调 agent 负责将已验证的子分支合入集成分支。
- 每个 agent 只改自己的文件；共享类型、根脚本和文档由协调方收口。遵守 [COLLAB.md](COLLAB.md)。
- 本轮不自动合并远端 `main`，不改仓库可见性，不上传账号、凭据、私人记忆、会话、工作产出或本机余额截图。

## v3 功能归属与后续阶段

| 模块 | 当前所在工作线 | 当前状态 / 下一步 |
| --- | --- | --- |
| 独立聊天 API、SQLite 聊天/轻量记忆 | 既有 Windows 应用 | 已有实现；真实供应商验证与发行验收沿用原工作线记录 |
| N.E.K.O. 工作台、三角色位、头像主题、共居区与真实 DSH 子 agent | 新 `apps/neko-workbench/` | 从 v0.13.0 固定迁入并适配并行运行；本轮以离线代码与协议验证为主 |
| N.E.K.O. 现有社区 | 新工作台侧栏 → 官方喵宇宙社区 | 本轮接入口并复用现有网站；社区单点登录、通知/卡牌同步另设原生适配任务，与聊天/记忆/UI 开发并行 |
| 角色 / 皮肤 / 账号 / DSH 会话 / 记忆身份隔离 | v3 合同与两个应用边界 | `personaId=bigfish` 稳定；改名换头像不新建人格或记忆空间；Yui/Claude 角色位不冒充已接入后端 |
| 日记 ↔ N.E.K.O. 双记忆 | 工作台 `framework/` | 合同、参考内核与模拟测试；可靠持久化、真实适配器、召回路由尚待专门开发 |
| “养鱼”菜单、首启向导 | v3 配置与产品合同 | 标为 planned/disabled；后续须接真实服务，不仅切换 UI 选中态 |
| N.E.K.O. 原生语音与语音记忆 | ASR / TTS / 聊天记忆 / 桌面 UI / 验收分工 | 已核对原生 worker、sidecar 和旧适配代码，发布接入任务与所有权；待认领和实现，未启用麦克风或完成语音联调 |
| B站生活、PNGTuber | 后续适配工作 | 本轮未分派实现；不自动启动、登录、调用模型或对外发送 |
| 安装器、签名、升级与干净机器验收 | 后续发布工作 | 源码接入与发行版分别验收；原 Windows 本机便携版不替代新工作台验收 |

后续任务应先指定文件所有权和可观察的验收结果，再并行实施。不要让多个 agent 同时改工作台主进程或把未接通的适配器记作完成。

## 运行与验证入口

```sh
npm start                       # 原 Windows 桌宠
npm run start:neko -- --check    # 新工作台只读路径预检
npm run start:neko               # 显式启动新工作台
npm test                        # 原 v1 + 新增离线回归
npm run test:neko               # 仅新工作台和框架回归
npm run check:neko              # 语法与主题检查
```

新工作台的数据、Electron profile、DSH_HOME、工作区均独立。测试或语法通过不代表已登录真实账号、完成模型联调、双记忆互通或桌面视觉验收。完整接入说明见 [NEKO_LITE.md](NEKO_LITE.md)。

本轮实际检查记录见 [NEKO_INTEGRATION_CHECKS.md](NEKO_INTEGRATION_CHECKS.md)。

社区目标、接入范围和后续分工见 [COMMUNITY_INTEGRATION.md](COMMUNITY_INTEGRATION.md)。

N.E.K.O. 原生语音的现有模块、ASR/TTS 并行接入、聊天/记忆统一写入和实机验收分工见 [NEKO_NATIVE_VOICE_PLAN.md](NEKO_NATIVE_VOICE_PLAN.md)。其中语音 agent 是待认领职责，不能与上方已完成工作台接入的实际子 agent 混称。
