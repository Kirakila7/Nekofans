# 工作台统一账号入口

左下角显示 DSH 和 Codex 各自的登录状态。点击后在同一菜单内分开查看 DSH 原生充值钱包余额，以及 Codex 原生接口报告的额度窗口、剩余百分比和重置时间。菜单中的原生设置、登录/退出操作属于 DSH；Codex 沿用本机登录。隐私 / 高级设置入口继续保留在原生通用设置中。

DSH 继续使用 desktop profile 的原生账号与余额服务。Codex 在主进程启动短生命周期的官方 `codex app-server` stdio 客户端，仅调用初始化、`account/read` 和 `account/rateLimits/read`，读取完即关闭。不会创建会话、执行任务、消费额度重置次数、充值、登录或退出账号。使用本机 Codex 的配置与凭据存储；工作台不复制凭据。

界面启动时读取登录状态，回到窗口及菜单展开时刷新；额度按需读取，菜单打开时定期更新，并可手动刷新。IPC 仅允许读取参数，不接受命令、路径或任意 RPC。邮箱、账号标识、凭据、原始诊断不会传给界面或保存到工作台状态。

Codex 优先展示多额度桶接口，保留服务端实际窗口长度；未提供的数据显示暂不可读取。不会假设固定的五小时 / 每周双窗口，不会把钱包金额与百分比相加。API Key 或其他认证方式没有 ChatGPT 订阅额度时会说明。额度接口失败不代表余额为零；原生包含额度受限状态单独展示，不根据重置时间推断额度已经恢复。

协议依据：[OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。本机接口类型同时通过已安装 Codex CLI 生成的 TypeScript 定义核对。

检查：

```sh
node --test tests/neko-workbench/codex-account.test.cjs
NEKO_DOM_DEPS=/absolute/path/to/jsdom-deps node apps/neko-workbench/embedded-dsh/check-unified-account-dom.cjs
npm test
npm run check:neko
```

单元 / DOM 检查使用离线夹具；真实账号状态与额度读取、安装后窗口检查另行记录。
