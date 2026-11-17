# N.E.K.O. 社区游戏授权接入

工坊地址为 `https://workshop.nekofans.games`，部署于项目方的香港主机。社区侧负责验证已有登录身份并签发一次性游戏票据，工坊核验公钥后建立独立的发布会话和游戏席位。

## 社区服务端

提供 `POST /api/game-seats/authorize?state=…&operation=…&target=…`。复用现有社区的 Bearer 登录校验，传入可信用户的 UUID 与显示名。

模块可挂载在现有 Node HTTP 或 Express 服务。社区实际后端框架及路由源码尚未提供，以下为挂载示例。

```js
import { readFileSync } from 'node:fs';
import { createGameAuthorizationHandler } from './community/http-authorization.mjs';

const handleGameAuthorization = createGameAuthorizationHandler({
  issuer: 'https://community.project-neko.cn',
  gameOrigin: 'https://workshop.nekofans.games',
  privateKey: readFileSync(process.env.NEKO_GAME_SIGNING_PRIVATE_KEY),
  async authenticate(request) {
    const user = await verifyExistingCommunityBearer(request.headers.authorization);
    return user && { id: user.id, name: user.display_name || user.username };
  },
});

app.post('/api/game-seats/authorize', handleGameAuthorization);
```

`verifyExistingCommunityBearer` 由维护者替换为已有认证逻辑。用户 ID 与 `/api/users/me` 的 `user.id` 一致。身份由认证结果取得，接口只接受 `state`、`operation`、`target` 三个查询参数。

支持 `publish/workshop`、`create/<24 位作品 ID>` 和 `join/<12 位房间 ID>`。成功响应为 `200 {"location":"https://workshop.nekofans.games/…#communitySeat=…"}`。未登录返回 401，非法参数返回 400，跨源调用返回 403。

## 密钥与工坊配置

在社区自己的受控环境中生成 Ed25519 密钥，私钥交由社区的凭证管理保存。导出的 SPKI PEM 公钥交给工坊管理员即可完成配置。

```sh
openssl genpkey -algorithm ED25519 -out community-game-private.pem
openssl pkey -in community-game-private.pem -pubout -out community-game-public.pem
```

工坊管理员将公钥安装到 `/etc/nekofans-community-ed25519.pem`，确认服务用户 `nekofans-games` 可读，再给 `/etc/nekofans-games.env` 添加以下配置。

```dotenv
NEKO_WORKSHOP_PRODUCTION=1
NEKO_GAME_COMMUNITY_ORIGIN=https://community.project-neko.cn
NEKO_GAME_COMMUNITY_PUBLIC_KEY=/etc/nekofans-community-ed25519.pem
```

现有 `HOST=127.0.0.1`、`PORT=3088`、`PUBLIC_ORIGIN=https://workshop.nekofans.games` 和 `DATA_DIR=/var/lib/nekofans-games` 配置已在香港主机建立。工坊经 Caddy 反向代理提供 HTTPS，原棋局继续使用独立服务。

## 社区前端

在 `/game-seats/authorize` 页面挂载 `seat-authorization.mjs` 的 `authorizeGameSeat`，复用已有 OAuth 登录存储。返回 `sign-in-required` 时进入社区现有登录流程，登录后回到原页面继续，完整保留本次授权的三个查询参数。票据有效期为 45 秒，以工坊浏览器中的一次性 Cookie 验证请求归属。

## 联调验收

1. 匿名调用签发接口得到 401，伪造用户 ID 无法取得票据。跨源请求和重复参数被拒绝。
2. 已登录账号从工坊发起发布授权，只收到属于该请求的有效票据。过期、重复及错误域名的票据都无法兑换会话。
3. 账号 A 发布创造台游戏和联机 HTML，在“我的作品”找到作品并开房。账号 B 在“我的作品”只看到自己的作品。
4. A 在聊天室分享邀请，B 在 Nekofans 直接打开并入座。两端完整完局，再用同一账号重进验证原席位和结果。
5. `/api/config` 显示 `communitySeats: true`、`publishEnabled: true`、`adminPublish: false` 和 `demo: false`。

本机已通过模拟社区身份的签发、兑换、两端完局和服务重启恢复。香港主机已完成工坊安装和 HTTPS 公网健康检查。真实社区签发尚待本接口部署，真实 DeepSeek 和两台设备的端到端验收随签发上线继续进行。
