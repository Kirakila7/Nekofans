# 工作台最左侧导航

新增 64px 窄栏，顺序如下：

- 顶部：当前角色头像，点击打开「头像与主题」，角色头像与对应配色同步切换。
- 中段：弹性留白。
- 底部从上到下：B站小电视、大肥鱼养鱼头像、账号头像。

B站按钮在工作台右侧打开官方 `https://www.bilibili.com/` 主页；再次点击也会从原有视频页面返回主页，沿用已存在的隔离浏览器会话。养鱼头像打开已有养鱼界面，不会自动开始养鱼或代替用户登录。

账号头像沿用原生账号菜单；DSH 和 Codex 的登录状态、额度、刷新、设置与隐私入口保留。可见头像按钮只触发原生菜单，原有 React 控件不移动、不克隆、不替换，原生弹窗关闭后焦点返回可见按钮。

原有会话列表、会话草稿及「＋ / 社区」区域保留；重复的 B站入口和养鱼设置按钮仅在新窄栏存在时隐藏。插件卸载会移除导航、样式和自有标记，恢复原生按钮与键盘焦点顺序。

验证命令：

```sh
NEKO_DOM_DEPS=/absolute/path/to/jsdom-deps node apps/neko-workbench/embedded-dsh/check-side-rail-dom.cjs
node --test tests/neko-workbench/community-route.test.cjs tests/neko-workbench/community-pane-ui.test.cjs
npm test
npm run check:neko
```

安装后的实际窗口和三个入口交互需另行观察；DOM 夹具不代表外部网站已加载。
