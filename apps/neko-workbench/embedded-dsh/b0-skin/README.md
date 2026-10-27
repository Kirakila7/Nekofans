# N.E.K.O. 工作台 · DSH Web 运行时外观包

两个 DSH 客户端插件，只用公开 slots 与 theme tokens，不接管根节点、不停用功能插件。

| 包 | 加载行 id | 职责 |
|---|---|---|
| `@bigfish/dsh-client-ui-white-label` | `neko-brand` | 产品身份 `PRODUCT_BRAND`：猫头标识、名称、首页标识、`document.title`、favicon、底部条 |
| `@bigfish/dsh-client-ui-skin` | `neko-skin` | 皮肤：`neko-mist`（默认）/ `bigfish`，仅含配色 tokens 与可选皮肤标签 |

`@bigfish` 只是 npm scope，沿用任务约定；产品身份不随它变化。

检查：

```sh
node packages/dsh-client-ui-white-label/scripts/smoke.mjs
node packages/dsh-client-ui-skin/scripts/smoke.mjs
```

接入方式见上级 `INTEGRATION.md`。`tools/patch-branding.mjs` 是原套件的构建期工具，会改安装包，本项目不使用。
