# N.E.K.O. 现有社区接入

工作台“新会话”下方增加“社区”入口，位于三个角色位上方，打开现有的 [喵宇宙社区动态页](https://community.project-neko.cn/feed)。目标来自 N.E.K.O. 官方生产配置和当前客户端入口，不新建另一套社区或迁移现有动态。

## 本轮入口

- 侧栏点击通过受限主进程动作 `open-community` 打开独立的有边框社区窗口，使用社区网站自己的页面与登录流程。
- 渲染器只能请求这个动作，不能指定待打开的地址；没有可用原生桥时入口禁用。
- 目标默认 `https://community.project-neko.cn/feed`。开发者可用 `NEKO_WORKBENCH_COMMUNITY_URL` 显式覆盖为无凭据的 HTTPS 地址。
- 社区窗口不带桌宠或 DSH preload，关闭 Node、启用沙盒与 context isolation，使用独立社区会话分区。社区与官方认证源内的导航保留在社区窗口；其他正常网页链接通过系统浏览器打开，非网页协议拒绝。
- 点击入口不切换角色或 DSH 会话，不创建任务，不发送模型请求，也不将 DSH 登录态、密钥或角色记忆传给社区。
- 首页、发现、卡牌、个人页、积分与兑换等功能继续由现有社区提供；登录、发帖、互动或兑换由用户在社区内操作。

本轮完成的是工作台入口与原网站的连接。桌面社区单点登录、本地通知/卡牌同步和角色内容发布尚未作为本应用的原生模块接通。

## 与其他功能并行的分工

| 工作线 | 负责范围 | 验收 |
| --- | --- | --- |
| 工作台/侧栏接入 agent | 社区入口、位置、折叠态、键盘操作、受限 IPC、独立窗口与失败反馈 | 不影响新会话、角色位与原生工具；点击只打开已验证目标，社区窗口不暴露 DSH 原生桥 |
| 主协调 agent | 官方地址核对、v3 合同、分工与验收说明、代码合并和 GitHub PR | 目标有原始源码依据，现有功能/后续原生适配分别标明 |
| 现有 Windows 聊天/记忆线 | 保持原 `apps/desktop` 和本地记忆链路 | 社区入口不改变账号、人设或存储 |
| 原本机 UI 开发线 | 继续工作台与共居区外观迭代 | 后续更新经审查同步至本仓库快照 |
| 后续原生社区适配 | 独立处理社区 OAuth、通知/卡牌及同步 | 先指定文件所有权、目标官方版本和测试账号；不能复用 DSH 凭据或把网页入口当作单点登录完成 |

总体分工见 [PROJECT_WORK_SPLIT.md](PROJECT_WORK_SPLIT.md)。

## 官方依据与后续边界

核对日期：2026-10-26。官方 `main` 提交 `3f12697fb722d61e37bb9e4c0ead33205b2d5651` 中，社区默认源为 `community.project-neko.cn`，认证源为 `auth.project-neko.cn`，分别支持 `NEKO_SOCIAL_BASE_URL`、`NEKO_AUTH_URL` 配置：[social_base.py](https://github.com/Project-N-E-K-O/N.E.K.O/blob/3f12697fb722d61e37bb9e4c0ead33205b2d5651/utils/social_base.py)。本轮也只读打开官网核对到实际社区页面。

当前官方客户端入口由 [surface-floating-controls.js](https://github.com/Project-N-E-K-O/N.E.K.O/blob/3f12697fb722d61e37bb9e4c0ead33205b2d5651/static/app/app-ui/surface-floating-controls.js) 读取 `/api/system/social/config` 并打开 `/feed`，Electron 使用独立有边框子窗口。本次沿用这个页面和窗口方向。旧 [social-embed.js](https://github.com/Project-N-E-K-O/N.E.K.O/blob/3f12697fb722d61e37bb9e4c0ead33205b2d5651/static/social-embed.js) 保留 iframe 组件，但不把它当作当前主要入口。

OAuth、同步票据和社区 API 的原生适配属于后续工作；网页入口没有实现这些协议，也不自动登录或调用发布接口。社区账号与 DSH 账号、工作台角色位及 `personaId=bigfish` 分别管理。

## 后续原生功能的任务边界

以下接口已按上述官方版本核对，作为后续拆任务的接点；这些任务尚未分派执行，也没有在本轮调用。

| 后续任务 | 原有接口/模块 | 前置与验收 |
| --- | --- | --- |
| 社区账号网关 | `/api/card-drop/oauth/start`、`oauth/status`、`oauth/logout`、`oauth/completion`；`/oauth/callback` | 沿用 PKCE 和已注册客户端/回调；凭据留在原生存储，换账号关闭旧会话，不复制其他应用的会话文件 |
| 本体绑定/会话交接 | `/api/card-drop/auth-status`、`sync-ticket`、`social-session-init`、`sync-session`、`sync-session/status`、`bind-client/approve` | 显式绑定轻量版本体；一次性票据不写日志/源码，网页浏览成功不等于本体已连接 |
| 同角色记忆只读桥 | `/api/card-drop/native-delegate`、`capabilities`、`facts`、`facts/query`；`/api/card-drop/active-character` | 明确 `bigfish` 与原生角色映射及 `facts:read` 权限；原事实接口依赖 ConfigManager，不能直接等同 SQLite 轻量记忆或暴露整个目录 |
| 未读/通知与卡牌券 | 官方宿主 `nekoSocial` 桥；固定 `/api/notifications/stream`、`/api/forge/credits` 及其明确的 grant/claim/ack 动作 | 需实例授权及社区会话；账号切换关闭旧流，写操作分别由用户操作触发；不复用已退役的本地券账本 |

这些线可以按独立适配器并行开发，合同与角色映射由协调方统一收口。现有 Python 路由依赖原本体的角色配置与实例授权，当前入口不复制整套服务。社区网站能独立浏览和登录；需要本地角色记忆的铸造等功能仍要求后续本体连接。
