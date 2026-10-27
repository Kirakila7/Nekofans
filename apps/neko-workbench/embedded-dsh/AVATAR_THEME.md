# 头像与工作台配色

该模块只改变背景与强调色，跟随**左上角全局头像**。它不调用头像保存方法，不选择角色，不修改会话、模型、账号、记忆、动作或系统外观偏好。

## 合入

把 `avatar-theme-source.js` 全部内联到白标 `lib/client.js` 的 factory 内、`apply()` 前；保留 `@neko-avatar-theme:start/end` 标记。然后加一项 effect：

```js
ctx.effect(() => installAvatarTheme(), 'neko-brand: avatar theme')
```

不需要增加 `exports.inject`。只读使用已经存在的 `window.nekoWorkbench.getState()` 与 `subscribe()`，从 `state.avatar` 取 `builtinId`、`customDataUrl`。该源码也可单独放入预览页；调用 `installAvatarTheme()` 时需已有 body。

原白标检查里将每处 `bigfish` 都视为不合法品牌字符串的断言，应排除这个有明确标记的调色板块；`PRODUCT_BRAND` 与 favicon 仍独立检查，不能因此放开产品品牌约束。

## 五套主题

| 头像 | 浅色主背景 | 浅色侧栏 | 浅色生活区 | 深色主背景 |
| --- | --- | --- | --- | --- |
| YUi | `#EEF2FB` | `#E5EAF7` | `#DCE4F4` | `#171D2C` |
| 开发喵 | `#FAF4EA` | `#F2E7D6` | `#EBDDC8` | `#241E18` |
| 大肥鱼 | `#EAF4F8` | `#DDEDF4` | `#D0E5EF` | `#12232D` |
| Claude娘 | `#FFF1EA` | `#F8E2D5` | `#F0D5C4` | `#2A1D18` |
| Gemini小猫 | `#F5EFFB` | `#EBE1F5` | `#E1D3EF` | `#211A2D` |

完整数据在 `NekoAvatarTheme.PALETTES`。样式层设置已核实的 DSH 颜色别名，并提供：

- `body[data-neko-avatar-theme="yui|devcat|bigfish|claude|gemini|custom"]`
- `--neko-account-habitat-bg`：供共居小角色的独立生活区使用。
- `--neko-avatar-accent`、`--neko-avatar-focus`：强调色与可见焦点色。

原 DSH 主题 owner 在实际深色（含跟随系统的深色）时给 body 加 `data-ds-dark-theme`。模块据此切换两套 token；不直接按操作系统媒体查询强行覆盖手动浅色。切换深浅色仍用原设置，模块不写该属性。

## 自定义头像

自定义图片仅接受限制大小的 PNG/JPEG/WebP base64 data URL。它在本机 48×48 Canvas 中抽取有效彩色像素的代表色相，再生成柔和浅/深主题；不会请求 HTTP/file 图片，不写图片、颜色或账户信息到日志或持久存储。无彩色像素、无 Canvas、图片损坏和解码失败统一使用柔和中性配色。人物和文字不会染色。

初次 `getState()` 的迟到结果不能覆盖之后收到的订阅；反复的同头像推送不重复解码；切换头像会使旧解码结果失效。卸载时退订桥、解除图片回调、移除独立 style，并仅恢复自己仍拥有的 body 属性。

## 验证

```text
node --check embedded-dsh/avatar-theme-source.js
node embedded-dsh/check-avatar-theme.cjs
```

离线检查覆盖 5 套内置配色和 72 种自定义色相、浅深模式共 3696 个文字/底色组合，全部达到 4.5:1；按钮文字也达到 4.5:1。另检查代表色抽取、只读桥推送、迟到初始读取、未知/外链头像回退、重复卸载和其他 owner 属性保护。

这些是离线检查；实际 Electron 主题切换、popover 继承、真实上传图片和原生深浅色尚须主控运行验收。
