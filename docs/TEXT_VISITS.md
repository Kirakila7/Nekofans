# 好友双猫纯文本串门

当前版本兼容现有 N.E.K.O. 串门接口：两台青春版在客户端关闭音视频，仅使用 RTC 数据通道交换文字。无需部署新增 `mode:text`、`/end` 接口或数据库迁移。兼容的是服务端接口；与完整版客户端的旧聊天协议互通尚未实现和验收。

工作台菜单及主角色菜单的“猫娘串门…”打开独立本地面板。先配置聊天 API，再登录社区、填写公开人设、邀请互关在线好友；对方接受后，两端各自调用自己的模型，默认交替发送六条文本。双方都可结束，关闭面板也停止当前串门。

本功能集成在工作台主进程；使用 `npm run start:neko` 启动。不会部署或更改串门服务端。普通启动尚未自动提供 OAuth 注册配置，需按下列说明配置；旧版 portable 安装包不会自动更新。

## 配置与启动

使用现有工作台的 Electron / DSH / 数据目录配置（见 `NEKO_LITE.md`）。额外提供下列环境变量，全部值均为公开地址或注册客户端标识，不应填写 client secret：

| 变量 | 内容 |
| --- | --- |
| `NEKO_VISIT_COMMUNITY_URL` | Verse 根地址；默认 `https://community.project-neko.cn` |
| `NEKO_VISIT_AUTHORIZATION_URL` | Auth 公共授权端点的完整 HTTPS URL |
| `NEKO_VISIT_TOKEN_URL` | 同源 token 端点的完整 HTTPS URL |
| `NEKO_VISIT_OAUTH_CLIENT_ID` | 已注册且允许 PKCE 的 public client ID |
| `NEKO_VISIT_REDIRECT_URI` | 注册的精确回调，如 `http://127.0.0.1:<端口>/oauth/callback` |

应用不会猜测可用 OAuth 注册。登录通过系统浏览器，token 仅由主进程使用并通过系统 safeStorage 加密保存。退出登录清除本机凭据，不等于撤销远端授权。每台设备必须有自己的数据目录；不假定现有服务器会额外强制同账号单设备。

首次打开串门面板时，后端会尝试恢复已加密保存的登录凭据，并重新核验服务器账号、好友及通知。没有凭据时保持未登录；凭据失效时提示重新登录，不自动打开浏览器。恢复成功只加载当前账号的历史，不重新入房、不自动发邀请或调用模型。退出登录会阻止尚未完成的恢复请求重新激活账号。

本次已用现有官方桌面注册 `neko-servers-desktop-prod` 完成真实账号登录及好友列表读取。联调回调使用 `http://127.0.0.1:48913/oauth/callback`；原 `48911` 被已有服务占用，未停止该服务。该配置由隔离测试启动器提供，不表示普通启动已经自动配置 OAuth。回调端口不可用、浏览器打开失败和登录超时均有明确提示。

## 与现有服务的契约

1. `POST /api/visit/credentials` 保持原字段，不发送 `mode`；仍使用定向邀请，房主指定好友，客方兑换该房间。
2. 旧回包缺少顶层 `visit_id`、`role` 时，从可信本地请求补齐；显式冲突则拒绝。旧身份票没有 `mode` 也可验签，保留房间、角色、参与者、transport、期限和公钥撤销校验。
3. 归一化的 `mode:'text'`、`mediaPolicy:'client-only'` 仅是本地策略。供应商凭据可能仍有媒体权限；客户端不采集、不发布、不自动订阅媒体，独立 sandbox 窗口拒绝权限请求。
4. 正常结束发送 leave、排空 ACK 后退出 RTC，不调用新增 `/end`。主家未接通的邀请失败仍使用原 `/cancel`。云端清理由现有供应商在场观察及房间生命周期处理，不将本地“已结束”作为云端终止确认。

此前的 Verse/Connect 强制文本模式服务端草稿保留在各自隔离工作树，当前客户端不依赖它们，也未部署它们。

现有分钟配额计费保持不变：创建时主家预占 50，客家入房后主家扣 50、客家扣 40；不是新增免费文本套餐或 token 计费。首轮上线前需明确采用该规则还是另做产品计费调整。

LiveKit 已用现有带媒体权限的凭据完成本机真实数据通道验证；TRTC 有旧版凭据及适配器测试，但尚未拿腾讯云凭据实测。Connect 仍按既有区域策略选供应商，不能凭 LiveKit 本机通过宣称 CN/TRTC 已验收。青春版双方协议为 `neko-visit-text-v1`。

## 数据与停止行为

- 只分享用户编辑的公开名字、公开介绍及本次文本；不读取主人私聊、主人记忆、人设文件或工作代理工具。独立 Chat API provider 不提供工具调用。
- 历史位于工作台数据目录 `visits/accounts/<社区用户 ID>/visits.sqlite`，与 `main-chat` 数据库分开。退出/切换账号清空面板历史缓存；重启仅查看历史，不自动继续发言。
- 邀请最长等待十分钟；激活后无有效文本进度两分钟结束，整场最多十分钟。结束后保留 6.5 秒末条 ACK 重传窗口，再关闭本地传输。
- 远端离房、本地断线、停止、退出登录会中止生成；晚到回复不得出站。首次数据通道尚未就绪的丢帧由 hello/ACK 重试处理。

## 验证范围

专项测试由默认测试发现器自动收录：

```powershell
$tests = (Get-ChildItem tests/neko-workbench/visit-*.test.cjs).FullName
node --test $tests
npm run check:neko
```

真实 RTC 重现说明在 `apps/neko-workbench/visits/RTC_SMOKE.md`。本机回环服务测试在受限沙箱中可能无法连通，应在可信本机环境验证；不能把该网络隔离当作登录失效。

两台物理设备的最终验收需要现有串门服务、已注册 OAuth、两个互关测试账号及两端已配置模型：邀请→接受→两边各三次独立模型生成→文本一致→双方退出 RTC；再验证拒绝、掉线、停止、云端观察结果和重新登录历史隔离。未完成这些步骤前，不宣称真实账号或双机生产可用。

### 本次本地验收记录（2026-10-28）

用户最终选择本地测试；没有部署远端或创建生产账号。

| 验证 | 结果与边界 |
| --- | --- |
| 兼容版串门专项 | 83 项通过，包含旧回包、无 mode 签名票、媒体禁用、账号隔离、OAuth、回调端口冲突、登录恢复/退出竞态、损坏凭据重新登录、服务端撤销凭据、邀请/停止竞态、重传和超时 |
| 官方接口参数 | 真实客户端生成参数、剥离全部身份凭据后请求现网，返回 401；不再发送 mode，未登录、未建房、未发邀请 |
| 官方登录后的接口 | 用户在官方 Auth 完成登录；实际面板显示已登录并加载真实好友列表，控制器状态 signedIn=true、busy=false、error=null。尚未取得真实 RTC 房间凭据或完成好友双端对聊 |
| 工作台入口 | 真实 `main.cjs` → 原生菜单 → sandbox 面板 → preload/主进程 IPC 通过；独立临时 profile，未登录 |
| 兼容版双实例整链路 | 两个独立 Electron 44.7.0 进程、LiveKit 1.13.11、真实 HTTP 客户端/验签/provider/SQLite；旧服务格式下 1 次邀请、1 次接受、6 次模型请求、两端六条一致文本、退出后历史重开通过；新增结束接口调用为 0 |
| 替身边界 | 上述整链路的 OAuth 账号会话、Verse/Connect HTTP 服务及模型回复使用本机测试替身；不是生产账号/模型调用 |
| 媒体与掉线 | 真实 LiveKit 管理 API 确认凭据允许媒体发布/订阅，但实际媒体轨道为 0；对端进程终止后约 22.5 秒收到离房事件，另有 120 秒应用等待期限兜底 |
| PR 前全量回归 | 558 项：538 通过、14 失败、6 跳过；14 个失败均在未修改的 aeb6bc5 基线导出中逐项复现，涉及 Windows 路径、Codex 测试替身、QQ 权限/路径及任务桥接。串门专项 83 项通过 |
| PR 审查修复 | 修复恢复登录时退出误删凭据、取消后残留部分账号状态、损坏/撤销凭据无法重新授权；SDK 增加 Git -text 属性并实测 core.autocrlf=true 检出过滤后的哈希仍匹配 |

兼容版整链路证据位于 `apps/neko-workbench/visits/_smoke/controller-d8e74bea-41ea-4c91-ad52-a5f0c898a5c8/`；官方参数探测为 `_smoke/official-compatibility-20261028.json`。早期服务端草稿的 PostgreSQL 测试受本机 Docker 故障阻塞，当前兼容版无需该迁移；本地替身验证仍不代替真实账号/模型验收。

可重现命令：

```powershell
# 不需要后端：实际工作台菜单与桥接入口
node tests/neko-workbench/visits-entry-smoke.cjs

# 先按 RTC_SMOKE.md 启动仅回环监听的本地 LiveKit，再运行整链路
node tests/neko-workbench/visits-smoke.cjs (Get-Location).Path (Join-Path (Get-Location) 'node_modules/electron/dist/electron.exe')
```

测试进程、LiveKit 和回环 HTTP 服务均已关闭。成功的截图、`result.json` 与测试 SQLite 保留在被 Git 忽略的 `apps/neko-workbench/visits/_smoke/` 下；可追踪的复现脚本保留在源码中。
