# Nekofans 自建聊天室

`ultra` 支持两套部署。普通启动走 N.E.K.O. 官方路线。要选自建路线，在启动 Nekofans 前设置 `NEKO_WORKBENCH_CHAT_DEPLOYMENT=nekofans`。自建默认连接 `https://chat.nekofans.games` 与 `https://auth.nekofans.games`，用户可从频道或账号菜单进入系统浏览器授权。切换路线后需重启应用。

| 部署 | 账号入口 | 本地频道资料 |
|---|---|---|
| 官方 | N.E.K.O. 社区一键登录 | `data/lobby/` |
| Nekofans | Nekofans 账号 | `data/lobby-deployments/` 下按聊天室地址、Auth 地址和客户端 ID 分目录 |

自建模式使用独立凭据、频道偏好及猫猫设置，也隔离官方大厅的公共经历。社区网页可以单独浏览，桌面身份转交与社区日常在官方路线使用。工作台模型账号和桌宠私聊使用各自的配置。

## 服务端并行部署

复用 N.E.K.O.Chat 后端的 FastAPI、PostgreSQL 和 Redis。使用 [并行部署覆盖文件](nekofans-games-chat.compose.yml) 与后端原来的两份 Compose 文件。独立项目名会产生新的网络、Postgres 数据卷和 Redis 数据卷，API 只监听本机 `18091`。由 HTTPS 反向代理将 `chat.nekofans.games` 转发到该端口，并启用 `/ws/` 的 WebSocket 升级。需要 Docker Compose 2.24.4 或更新版本。 [Compose 覆盖文件](https://docs.docker.com/reference/compose-file/merge/)

1. 在服务器上为新环境创建独立配置文件，例如 `/etc/nekofans-chat.env`。设置 `APP_ENV=prod`、`AUTH_ISSUER=https://auth.nekofans.games` 和 `AUTH_ALLOWED_CLIENT_IDS=neko-chat-desktop-prod`，并配置独立的 PostgreSQL、Redis、令牌缓存密钥、Auth introspection 和资料目录凭据。完整变量参考后端仓库自己的 `.env.example`。
2. 在 Auth 为 `neko-chat-desktop-prod` 注册桌面 public client，启用授权码、PKCE S256、`openid profile offline` 和 refresh grant。注册 `http://127.0.0.1:48921/oauth/callback`、`http://127.0.0.1:48922/oauth/callback`、`http://127.0.0.1:48923/oauth/callback`。桌面端使用同一授权源下的 `/oauth2/auth`、`/oauth2/token`、`/oauth2/revoke`。聊天室后端的私有 introspection 接口需返回其要求的 `active`、`client_id`、`sub`、`exp`、`token_use` 与 `scope`。
3. 配置 `VERSE_PROFILE_DIRECTORY_URL` 指向自己的资料服务。现有后端通过带服务凭据的 POST 按 Auth subject 查找昵称与头像，返回 `profiles` 和 `missing`。独立档案可将 `community_user_id` 设为 null。如启用头像，设置 `VERSE_COMMUNITY_PUBLIC_URL=https://chat.nekofans.games`，使用同源的 `/static/avatars/<uuid>.<ext>` 地址。纯文字联调可使用首字头像。
4. 在服务器的 N.E.K.O.Chat 后端目录合并检查后启动。以下路径换成服务器上的实际位置。

```sh
export NEKOFANS_CHAT_ENV_FILE=/etc/nekofans-chat.env
export NEKOFANS_CHAT_OVERLAY=/opt/Nekofans/docs/workbench/nekofans-games-chat.compose.yml
docker compose --project-name nekofans-games-chat --env-file "$NEKOFANS_CHAT_ENV_FILE" \
  -f docker-compose.yml -f docker-compose.prod.yml -f "$NEKOFANS_CHAT_OVERLAY" config --quiet
docker compose --project-name nekofans-games-chat --env-file "$NEKOFANS_CHAT_ENV_FILE" \
  -f docker-compose.yml -f docker-compose.prod.yml -f "$NEKOFANS_CHAT_OVERLAY" up -d --build
```

检查 `https://chat.nekofans.games/api/v1/health`。随后用两个新账号核对授权、进入频道、双向收发、历史、断线重连和退出。正式认证与资料目录是服务端前置条件。

## 本地联调

现有后端的开发 Compose 和测试 Auth 可用于联调。桌面启动环境示例

```powershell
$env:NEKO_WORKBENCH_CHAT_DEPLOYMENT = 'nekofans'
$env:NEKO_WORKBENCH_CHAT_URL = 'http://127.0.0.1:8091'
$env:NEKO_WORKBENCH_CHAT_AUTH_URL = 'http://127.0.0.1:8094'
$env:NEKO_WORKBENCH_CHAT_CLIENT_ID = 'neko-chat-desktop-dev'
npm run start:neko
```

本地覆盖地址必须成对使用本机地址。恢复官方路线时清除以上四个变量，再重启应用。
