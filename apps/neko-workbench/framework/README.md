# N.E.K.O. 桌宠框架 v3 · 仓库接入参考

本目录来自用户提供的 `NEKO桌宠_项目框架_v3_工作台共居整合_20261026.zip`，保留 v3 工作台/共居区合同、配置与离线测试，以及原 v2 双记忆合同和同步参考内核。来源与归档 SHA-256 见 `REFERENCE_SOURCE.json`。

桌面源码已映射到本目录的父级 `apps/neko-workbench/`，无需再复制一份 `desktop/`。v3 文档中的 `desktop/` 均指父级工作台；`config/*.json` 的 `desktopSource` 已调整为相对配置目录的 `../../`。其余 v2 身份、记忆合同、参考内核和原测试保持原字节。

- [项目框架](docs/项目框架.md)：身份、角色、账号、任务与记忆的边界。
- [工作台与共居区整合](docs/工作台与共居区整合.md)：当前 UI 实现与后续记忆桥接位置。
- `src/workbench-contracts.ts`、`config/workbench.example.json`：三角色位、头像主题、原币种余额与共居区合同。
- `src/memory-contracts.ts`、`reference/memory-hub.mjs`：双记忆协议与同步参考内核。
- `config/main-agent-menu.json`：“养鱼”集合仍标为 planned / disabled。

工作台的真实运行配置由父级 `runtime-config.cjs` 管理；本目录配置是设计合同，不会自动启动服务、登录、充值或改变模型。通用聊天 API 已在仓库原 Windows 入口实现，但尚未移植到这个工作台。双记忆、B站向导、语音、PNGTuber 和下载即用安装器仍待接入。

在本目录运行 `npm test` 执行框架离线检查；从仓库根目录运行 `npm run test:neko` 或 `npm test` 也包含这些测试。`npm run check:desktop` 转到父级的语法/主题检查，`npm start` 则显式启动独立工作台。

本次没有复制附件中的重复桌面代码或 `design/account-ui-preview/` 示例预览；示例账号、额度和第三方参考动画不进入真实运行应用。旧验证报告不作为本轮通过证据。仓库入口、隔离与当前项目分工见根目录 `docs/NEKO_LITE.md` 和 `docs/PROJECT_WORK_SPLIT.md`。
