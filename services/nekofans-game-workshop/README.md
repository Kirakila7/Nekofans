# Nekofans 游戏工坊 · 0.1.0

核心流程：**创造台制作游戏或上传已有联机 HTML → 发布作品 → 建立房间 → 分享到聊天室 → 两人加入同一局。**

这是一套独立游戏服务，不依赖国际象棋。支持「轮流操作」和「共同操作」两种模式；示例分别为井字棋和共同点灯。作品发布后内容固定，再次修改生成新链接，已经进行的房间继续使用原版本。

## 已实现与接入边界

- 单文件 HTML 发布接口、网页上传入口、命令行发布工具、作品链接和双人房间链接。
- 访客昵称、两个独立席位、满员拒绝、服务端排序与轮次检查、重复操作去重、WebSocket 同步、断线恢复和磁盘保存。
- SDK 自动注入游戏沙箱；两端按相同操作历史计算游戏状态。网页脚本不能读取宿主发布凭证、房间凭证或直接发起网络请求。
- 生成提示词可直接交给 DeepSeek；输出必须调用 `NekofansGame.connect`。普通单机 HTML 不会自动变成联机游戏。
- 创造台游戏由服务端校验操作、判定胜负并恢复结局。上传的联机 HTML 由游戏自身的 reducer 处理玩法，服务端同步排序和轮次。
- 在独立工坊发布后，可以把**房间邀请链接**发到聊天室。工坊支持访客房间和 N.E.K.O. 账号房间。社区账号房间需要社区侧的游戏授权路由。

## 本地运行

在 `services/nekofans-game-workshop` 下操作。需要 Node.js 22 或更新版。安装依赖 `npm ci`，运行 `npm test`。

运行 `npm run preview` 后打开 `http://localhost:3098`。在普通窗口连接玩家一，在无痕窗口连接玩家二。由玩家一选《蘑菇岛》建房，再把邀请链接交给玩家二。这个入口使用模拟账号和独立的临时存档。

PowerShell：

```powershell
$env:PUBLISH_KEY='自行设置的测试发布凭证'
$env:ENABLE_DEMO='1'
npm start
```

打开 `http://127.0.0.1:3088`，选择「体验双人示例」。第二位玩家使用另一个浏览器配置或另一台设备打开房间邀请；同一浏览器配置会自动恢复原有席位。

在本机进行两个独立会话测试时，可分别使用 `127.0.0.1:3088` 和 `localhost:3088`。这只是在同一台机器上隔离两个浏览器身份，不代表完成两台真实设备或公网测试。

## DeepSeek 如何生成和发布

复制网页「给 DeepSeek 的提示词」，或使用 `public/generation-guide.md`。在提示词最后补充想要的游戏。保存生成结果为 HTML，再上传，填写游戏名称、模式和服主发布凭证。

创造台/DSH 也可以调用命令行工具。凭证通过环境变量提供，不能写入生成的 HTML：

```powershell
$env:NEKOFANS_PUBLISH_KEY='服主发布凭证'
node scripts/publish-game.mjs --server https://games.example.com --file ./my-game.html --title 我的游戏 --mode shared
```

输出作品链接。打开后创建房间，再复制房间邀请发到聊天室。作品链接用于开新局，房间链接用于进入已经创建的同一局。

工坊的「项目」页列出已发布的游戏。「房间」页可以粘贴同一工坊的邀请链接或输入房间号。建房后，房主可以更换项目，房间链接保持有效。两名玩家都在线时，房主点「开始游戏」，双方进入当前项目。

制作模板要求游戏为 Agent 提供 `observe` 和 `legalActions`，供宿主从玩家当前席位读取状态和可选动作。《蘑菇岛》已接入。工坊 SDK 在收到 `agent-view` 后返回 `agent-result`。宿主用该次读取的请求 ID 作为 `viewId`，连同状态版本与 `choiceId` 发出 `agent-action`。`submitted` 表示 SDK 已把操作送到玩家的提交路径，最终结果以服务器广播为准。

本地 DeepSeek 联机测试的房间底栏支持「大肥鱼接手」和「接回操作」。试玩版使用模拟选择器，DSH 试验入口使用本方独立 DSH 档案的 DeepSeek 账号选择动作。只发送当前可见的状态和合法动作编号及标签。普通工坊需要配置账号入座与 `chooseAgentAction` 才会显示接手按钮。Windows 客户端的主 Agent 接手仍需接入。

本机试玩的「队友设置」可以分别选择队友角色和模型。开启支持 Agent 的项目后，试玩会通过本机 Ollama 的 `/api/tags` 检测已下载的模型。安装新模型后点「刷新模型」。选择只用于自己的席位。

也可以指定试玩的默认 Ollama 模型。先启动 Ollama，运行 `ollama list` 查看已安装模型。在工坊目录打开 PowerShell，替换下面的模型名：

```powershell
$env:NEKO_GAME_OLLAMA_MODEL = '已安装的模型名:标签'
npm run preview
```

打开 `http://localhost:3108`，用两个浏览器窗口连接两位模拟玩家，开局后点「大肥鱼接手」。试玩进程向本机 `127.0.0.1:11434/api/chat` 发送当前席位可见状态和合法动作，验证模型选出的编号后提交。游戏项目、房间和席位协议照常使用。公网工坊若要调用各玩家电脑上的 Ollama，需要由 Nekofans 桌面客户端连接本机模型并把选中的动作发回房间。

## N.E.K.O. 社区账号入座

工坊启用社区授权后，作品页会显示「用 N.E.K.O. 账号建房」。已登录社区的好友打开房间链接即可入座。游戏服务器把席位与社区用户的稳定 ID 关联。同一个账号可以用另一台设备打开同一房间链接，恢复原席位和进度。

社区维护者的 HTTP 适配模块、前端路由和公钥交换步骤见 [授权接入说明](community/INTEGRATION.md)。

1. 在社区前端挂载 `/game-seats/authorize`。使用 `community/seat-authorization.mjs` 和社区已有的 OAuth 登录状态。将现有 access token 通过同源请求发给 `/api/game-seats/authorize`。如果会话过期，调用社区现有的登录流程，登录后回到同一个授权页面继续。
2. 在社区后端挂载 `POST /api/game-seats/authorize`。用现有社区认证中间件验证请求，再调用 `server/community-seats.mjs` 的 `createCommunitySeatAuthorizer`。`authenticate` 返回可信的 `{id, name}`，其中 `id` 与 `/api/users/me` 返回的 `user.id` 一致。将返回的 `status` 和 `{location}` 写回，响应头设为 `Cache-Control: no-store`。签名私钥放在社区服务端，`gameOrigin` 固定为工坊的 HTTPS 域名。
3. 在工坊服务配置 `PUBLIC_ORIGIN`、`NEKO_GAME_COMMUNITY_ORIGIN` 和 `NEKO_GAME_COMMUNITY_PUBLIC_KEY`。最后一个值是签名公钥 PEM 文件的路径。重启工坊后 `/api/config` 的 `communitySeats` 应为 `true`。

游戏票据有效期为 45 秒，只能用于发起请求的浏览器和指定作品或房间。公开房间链接只包含房间号。社区 OAuth 凭证只在社区域名内使用，游戏页面接收的房间状态只包含玩家显示名和对局数据。

## Ubuntu 24.04 部署

香港现有主机使用 Caddy，新工坊使用独立的 `nekofans-games.service` 和本地 3088 端口。已有 Caddy 的主机可参照 `deploy/Caddyfile` 添加独立站点，先验证配置再 reload。下面的安装脚本适用于使用 Nginx 的独立主机。

### 社区账号正式入口

1. 将工坊域名解析到主机。使用现有证书管理流程签发证书，或在 DNS 管理可用时使用 Certbot 的 DNS 验证。安装脚本读取 `/etc/letsencrypt/live/<工坊域名>/` 的 `fullchain.pem` 和 `privkey.pem`。保留既有棋局域名和站点配置。
2. 社区服务接好以上授权路由后，把 Ed25519 **公钥**放到工坊主机，并确保 `nekofans-games` 服务用户可读。社区私钥只留在社区服务。
3. 在主机建立权限为 `600` 的 `/etc/nekofans-games.env`，将目录及域名替换为实际配置：

```dotenv
NEKO_WORKSHOP_PRODUCTION=1
HOST=127.0.0.1
PORT=3088
DATA_DIR=/var/lib/nekofans-games
PUBLIC_ORIGIN=https://workshop.nekofans.games
NEKO_GAME_COMMUNITY_ORIGIN=https://community.project-neko.cn
NEKO_GAME_COMMUNITY_PUBLIC_KEY=/etc/nekofans-community-ed25519.pem
```

4. 在解包后的工坊源码目录运行 `sudo bash deploy/install.sh workshop.nekofans.games --production`，域名与 `PUBLIC_ORIGIN` 一致。新安装采用 HTTPS 和 HTTP 跳转。若已有同名站点，依据 `deploy/nginx-production.conf` 核对 HTTPS 和应用代理配置，尤其确保代理覆盖 `X-Nekofans-Client-IP`，避免把所有访客算成同一个限流地址。正式模式要求关闭演示与服主发布凭证。
5. 从外网核对 `/healthz`，并检查 `/api/config` 返回 `communitySeats: true`、`publishEnabled: true`、`adminPublish: false` 和 `demo: false`。用两个真实账号通过桌面端完成创造、上传、分享、加入、完局与重连。配置检查只验证工坊本身，社区签发通过实际的登录授权确认。

### 独立演示入口

把本项目上传到服务器的独立目录，在该目录执行：

```bash
sudo bash deploy/install.sh 你的公网IP或域名
```

脚本下载并校验官方 Node.js 24.13.1，安装 Nginx，创建专用系统用户、systemd 服务。源码在 `/opt/nekofans-games`，存档在 `/var/lib/nekofans-games`，配置在 `/etc/nekofans-games.env`。升级源码时保留配置和存档。云防火墙放行 80/443，应用的 3088 仅监听本机。

使用域名时，先将其解析到服务器。安装 HTTPS 证书：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d games.example.com
```

把 `/etc/nekofans-games.env` 的 `PUBLIC_ORIGIN` 更新为 `https://games.example.com`，再 `sudo systemctl restart nekofans-games`。先用 IP 做连通测试，公开使用以 HTTPS 域名作为入口。

查看状态：`systemctl status nekofans-games`。查看错误：`journalctl -u nekofans-games -n 50 --no-pager`。备份 `/var/lib/nekofans-games` 与 `/etc/nekofans-games.env`；凭证不随公开源码分发。

## 给下一位开发者

HTTP：`POST /api/games`（Bearer 发布凭证）发布作品；`POST /api/rooms`（gameId/name）建房；`POST /api/rooms/:id/join` 加入。建房/加入返回私有席位 token，公开邀请只含 room ID。WebSocket `/api/rooms/:id/socket` 第一帧验证 token，此后发送 `action`，服务端广播按版本排序的历史。游戏 SDK 契约和限制见生成提示词。

本版单机、小规模内测，最多 300 个作品、1000 个房间，每局 2000 次操作，房间重启恢复保留 7 天；HTML 不超过 512 KB，单次操作不超过 4096 字节。适合回合制和低频合作交互，不适合高频实时动作游戏。需要 npm 包、多文件资产或更大游戏时，下一阶段增加受控构建与资源托管。

独立工坊的服务入口为 `server/index.mjs`。工作台已有的游戏服务见 [nekofans-game-hub](../nekofans-game-hub/README.md)。
