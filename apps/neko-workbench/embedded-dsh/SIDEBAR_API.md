# DSH 0.2.1-rc.3 侧栏 API 调查

调查时间：2026-10-26。仅静态只读检查已安装的真实应用源码；未执行 UI 操作，未修改应用安装包或客户端实现。本文用于 Claude 的角色侧栏设计与接线。

## 结论

- **没有“新会话按钮下方的任意内容”公开插槽，也没有装饰原侧栏的 wrapper/next API。** 不应把角色伪装成 `sidebar.panellist` 全局面板注册项。
- 真实面板入口可公开导航：`ctx.layout.selectPanel('plugins')`、`ctx.layout.selectPanel('schedules')`；`ctx.layout.selectPanel(null)` 回到现有会话，保留当前 Session。
- 指定真实会话可用 `ctx.uiWorkspace.openSession(sessionId)`。它会自行回到 Conversation，无需再调用 `selectPanel(null)`。
- **推荐角色列表使用可卸载 portal adapter，只新建自己的 sibling 容器；原生全局工具 nav 保持 React 原位，由 CSS 折叠/展示在当前角色选项下面。** 这样保留所有已注册面板、图标、原生事件、More 扩展与点击统计，无需重建未知插件的行为。
- 角色位是前台入口。当前只启用大肥鱼，指向真实 `state.dshRoot.sessionId`；Yui、Claude小姐显示未启用。把全局工具放进角色菜单不会创建独立的每角色插件运行时。

## 可核查来源

源码统一根目录：

`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`

相关包均为 `0.2.1-rc.3`：

| 包 | 相关文件与位置 |
| --- | --- |
| `@deepseek-ai/dsh-client-ui-sidebar` | `README.md`；`lib/client.js` 第 17 行 pin 状态、第 206 行 PanelRow、第 238 行 More、第 448–519 行布局、第 560–655 行注册 |
| `@deepseek-ai/dsh-client-ui-layout` | `README.md`；`lib/client.js` 第 468 行 `selectPanel`、第 623 行 root 槽声明 |
| `@deepseek-ai/dsh-client-ui-workspace` | `README.md`；`lib/client.js` 第 1471 行 `openSession`、第 1500 行 `startSession`、第 1645 行 `clearMain`、第 1652 行 `replaceMain`、第 5221 行 browser 注册 |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | `lib/client.js` 第 4355 行 `PANEL_ID`、第 4465 行 `pluginNavigation`、第 4484 行侧栏注册 |
| `@deepseek-ai/dsh-client-ui-schedule` | `lib/client.js` 第 7363 行 `PANEL_ID`、第 7473 行 main 注册、第 7484 行侧栏注册 |
| `@deepseek-ai/dsh-client-ui-entry-customization` | `lib/client.js` 第 32 行 `EntryMenuContent`、第 102 行 `apply`、第 129 行 More 内容注册 |
| `@deepseek-ai/dsh-client-ui-renderer` | `lib/client.js` 第 342 行 slot ownership、第 1117 行 DOM 锚点、第 1368 行 `slots.inject`、第 1544–1555 行枚举、第 1813 行 `register` |
| `@deepseek-ai/dsh-web-frontend` | `dist/assets/index-BXV-oxvX.js` 内嵌 `@deepseek-ai/dsh-client-ui-slots` 的 SlotCore；原生包根目录没有单独安装 ui-slots，该模块由 Web frontend 共享表提供 |

Electron 自带 fs 可读 ASAR；普通 macOS 路径工具不能把 ASAR 当目录：

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' /private/tmp/your-reader.cjs
```

已提取的只读调查副本位于 `/private/tmp/dsh-sidebar-api/`。下列行号以提取副本与安装包 `lib/client.js` 相同的行序为准。

## 已公开的槽位

SidebarRoot 的 `children` 声明如下；全部 `scope: 'root'`：

| 槽 | kind | 实际用途 |
| --- | --- | --- |
| `sidebar.brand.mark` | single | 顶部/收起态标志 |
| `sidebar.brand.name` | single | 顶部品牌名称 |
| `sidebar.toggle.badge` | single | 收起按钮非交互徽标 |
| `sidebar.panellist` | list | 全局面板**图标**，由 shell 包装为原生导航按钮 |
| `sidebar.panellist.actions` | list | 原生 More 的菜单内容 |
| `sidebar.workspaces` | single | 完整工作区/会话 browser |
| `sidebar.settings` | single | 底部设置 |
| `sidebar.footer.action` | list | 底部附加操作 |

可用于 adapter 控制器的布局槽：`shell.overlay` 为 root list，可注册非视觉控制组件；`shell.bottom` 为 root single，现有产品条已经使用它。

标准声明感知注册形状：

```js
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay',
  id: 'neko.character-sidebar-adapter',
  inject: () => ({
    openPanel: id => ctx.layout.selectPanel(id),
    openSession: id => ctx.uiWorkspace.openSession(id),
  }),
  }, CharacterSidebarAdapter)));
// 对应插件 exports.inject 至少包含 ['slots', 'layout', 'uiWorkspace']。
```

`slots.inject`/`slots.register` 均由调用者 fiber 管理，插件卸载会清理；自建 DOM、observer、全局监听还须由组件 effect 或 `ctx.effect` 返回清理函数。

外层 `slots.inject('sidebar.panellist', ...)` 是这里推荐的**原侧栏卸载监听**：该声明属于 SidebarRoot，声明 collapse 会 dispose 内层控制器注册及其 effect，恢复声明后会重新安装。无需猜测或订阅不存在的 `sidebar/unload` 事件。`ctx.slots.subscribe('sidebar', callback)` 可额外观测 occupant 变化；实际 DOM 挂载比注册晚，首次定位仍交给受限 MutationObserver / 下一帧。

### 为什么不能只注册一个角色 panellist

原生 `PanelRow` 的行为固定为：

```js
button.onClick = () => selectPanel(id);
// 图标放在 aria-hidden span 中
renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id });
```

因此该槽只适合注册实际 `main` 面板。角色切换按钮放进图标组件，会产生嵌套交互及父按钮选择错误；没有同名 main 时还会抛错。

### priority 不是 wrapper 或 hide API

SlotCore 支持 `priority`，同一 single / keyed key / list id 中数值较小者生效；相同 priority 重复注册抛错。它**没有** `next`、`wrap`、`decorate`、`hidden` 选项。

把 `plugins` 的图标 shadow 成 `null` 只会隐藏图标；shell 仍会按注册元数据生成按钮。注册新的 sidebar/workspaces single 会替换整块 UI，原组件没有 `/client` 导出；复制原 children 声明还会触发 `slot is already declared`。不推荐借此包装原生 shell/browser。

原生 pin 状态也不满足需求：`setPinned` 只通过 More 内容的 `onPinnedChange` 回调下传，非公开服务；`plugins` 被显式禁止 unpin；pin 状态仅本次插件生命周期内共享，reload 重置。

## 面板、标题、图标与 More 的精确来源

原生侧栏的列表来源就是：

```js
const { resolveSlotLabel } = require('@deepseek-ai/dsh-client-ui-slots');
const rows = ctx.slots.entriesOfSlot('sidebar.panellist')
  .map(({ options }) => ({
    id: options.id,
    order: options.order ?? 0,
    label: resolveSlotLabel(options.label) ?? options.id,
  }))
  .sort((a, b) => a.order - b.order);
// resolveSlotLabel(label) === typeof label === 'function' ? label() : label
```

更新订阅必须同时覆盖 `ctx.slots.subscribe('sidebar.panellist', refresh)` 与 `ctx.locale.subscribe(refresh)`。`entriesOfSlot()` 每次产生新数组，不要直接当 `useSyncExternalStore` 的稳定 snapshot；使用自己的缓存 source。没有 `ctx.layout.panels` 或 `ctx.slots.useItems`。

真实已装入口：

| id | order | 中文标题 | 图标组件 |
| --- | --- | --- | --- |
| `plugins` | 0 | 插件 | 包内 `PluginsPanelIcon` → `IconPluginPinwheelOutlineRegular` |
| `schedules` | 10 | 自动化任务 | 包内 `TaskManagerIcon` |

entry 本身有 `.component`、`.inject`、`.store`、`.locale` 等；直接 `h(entry.component, {size, active})` 会绕过注册 inject/hooks/locale 绑定，**不适合通用第三方图标或操作复用**。

图标的标准渲染是 SidebarRoot 自己的 `props.renderSlot(...)`；renderSlot 只能渲染该 registration 的 children，其他组件直接调用 `renderSlot('sidebar.panellist', ...)` 会抛 `SlotOwnershipError`。`ctx.slots.renderSlot` 只允许 `'root'`，不是任意槽渲染器。

More 不在 panellist 的注册元数据里。它由 SidebarRoot 在有 `sidebar.panellist.actions` 注册时额外渲染，图标 `IconAppsAddOutlineRegular`，标题 `panels.more`，本地 `useState(false)` 控制开关，**无公共 openMore 命令/服务**。

`sidebar.panellist.actions` 内每项获得：

```js
{ entries, onOpen, onPinnedChange, onDismiss }
// entries: [{ id, label, pinned, active }]
// plugins 永远不包含在 entries 中
```

当前原装 `entry-customization` 注册的 More 内容只有：

1. **浏览更多插件**：`ctx.pluginNavigation.openList()`；该服务选择 `plugins`，切到 `installed` tab 并回 list。
2. **创建你的插件**：`ctx.uiWorkspace.startSession(undefined, { agentPreset: 'cordis', prompt: '创建一个带左侧栏入口的 DSH 插件。', whenDraftExists: 'append' })`。

原装 More 对 sidebar 会忽略传来的 `entries`，不会自行显示自动化任务或 pin 控件。其他插件仍可向 actions list 添加内容；只重做两个已知按钮会丢失未来贡献。

## 导航与大肥鱼真实 Session

```js
ctx.layout.selectPanel('plugins');   // 真插件页
ctx.layout.selectPanel('schedules'); // 真自动化任务页
ctx.layout.selectPanel(null);        // 返回已有 Conversation，不改 Session
ctx.uiWorkspace.openSession(workspaceSessionId); // 打开已有大肥鱼 DSH root
```

`selectPanel(nonNullId)` 在 `main` 没有对应 key 时抛错并保留原选择；`null` 是明确返回 API。不要把 `'conversation'` 当关闭参数；它是 main 中保留的 Conversation key，但官方服务用 `null` 表达回对话。

`openSession(target)` 为同步导航请求，调用 `replaceMain(target, lifetime.signal, 'reveal')`：retain Session（source `mainView`）、更新 session selection/subagent address、释放旧主引用、`selectPanel(null)`。它打开已有 Session，**不创建、发送 prompt 或启动任务**。异常应在角色点击入口显示真实错误，不改成假成功。

接线约定：新 `window.nekoRoles.getState()` 应提供 `workspaceSessionId = state.dshRoot.sessionId`。现有 `window.nekoWorkbench.getState()` 只含 avatar/neko/workbench，不含这个 id。不要将 N.E.K.O. `actors[id=main]` 的空 sessionId、头像 id、角色名或最新 DOM 会话标题当成 DSH root。不要固化 evidence 文件中的历史 UUID。

## 推荐的最小 DOM / portal adapter

以下是源码推导的真实 DOM 轮廓，不是本次 live DOM 测试结果：

```text
[data-slot="sidebar"]                 // renderer 稳定锚点，display:contents
└─ div.kB3qhq_root                      // 原生 SidebarRoot
   ├─ div.kB3qhq_topStrip               // darwin 拖动/收起控件
   ├─ div.kB3qhq_logoRow                // brand.mark / brand.name
   ├─ button.kB3qhq_newSession          // aria-label 由 locale 生成
   ├─ div[data-neko-role-host]          // adapter 唯一新建 sibling，portal 内容
   ├─ nav.kB3qhq_panelList              // 原插件/自动化/More，保留原父节点
   │  ├─ button.kB3qhq_panelRow         // 插件
   │  ├─ button.kB3qhq_panelRow         // 自动化任务
   │  └─ More anchor → button[aria-haspopup="menu"]
   ├─ div.kB3qhq_regionArea
   │  └─ [data-slot="sidebar.workspaces"]
   └─ div.kB3qhq_footArea               // footer.action + settings
```

公开 `[data-slot]` 锚点由 renderer 第 1117 行直接产生。`kB3qhq_*` 是**这个 build 的实际 CSS module 名**，不保证跨版本稳定；可结合 sidebar root 下的 direct-child nav、其 panel 按钮及前面的 newSession 控件验证结构。Tooltip 组件最终 DOM 是否多包一层应由主任务的实际 UI 验证，插入点优先选择已确认的原生 nav 前面，不猜按钮的 parent。

建议流程：

1. 在受管理的控制器组件 effect 中找 `[data-slot="sidebar"]` 内的原生 panelList；验证其属于同一 SidebarRoot，且其前方为 New Session 区域。
2. 只创建 `div[data-neko-role-host]` 并 `nativeNav.before(host)`；用 `require('react-dom').createPortal(<RoleSeats/>, host)` 渲染自己的 Yui / 大肥鱼 / Claude小姐列表与角色配置。
3. 仅给命中的原生 nav 写一个 adapter 自有 attribute/id，以及自有 CSS variables。默认折叠该 nav。点击当前角色选项时，**原 nav 仍在原 DOM 父节点中**，只通过 CSS `position:fixed` 显示在角色工具触发器下面；其原 button、图标、原生 More 均完整呈现。More 的自身 portal 会从实际按钮矩形正确定位。
4. 避免把原 nav 当 `appendChild`/`replaceWith`/`createPortal` 的内容；不要 clone 原按钮，不读 `__reactFiber`，不重写原生 event handler。
5. 角色工具 trigger 用 `aria-expanded` / `aria-controls` 对应 native nav；打开后可 focus 原 nav 的首个按钮，Escape 关闭并回焦点。外部点击判断须包含 native nav 与原生 More 的 portal（其 `[data-slot="sidebar.panellist.actions"]`），否则会在 pointerdown 阶段过早隐藏按钮。
6. 监听 role trigger 的 resize、窗口 resize；仅在组件挂载/原 shell 重建时用受限 MutationObserver 重新定位自有 host。应按 `requestAnimationFrame` 合并，防止自建 DOM 引起 observer 循环。
7. 原 More 若仍 `aria-expanded=true`，关闭角色工具时要通过原 More 按钮的正常点击关闭其本地菜单，或等待其自身关闭；仅隐藏 nav 会留下原生 portal。保留原 More 的事件与统计行为。
8. 卸载时 unmount/移除自己的 portal host、disconnect observer、移除全部自有 attribute/id/style；恢复记录的原属性值。未知版本/结构不符时 fail open：保留原 nav 可见，不破坏原工具入口。

这条路径不需要枚举后重建原生工具，也不会因 locale、更换图标、追加 panel/More 注册而漏功能。工具仍是当前 DSH profile 的共享工具，只是入口收进当前角色的选项。

## 主任务最小验证

- 新会话下恰有三个可自定义角色位；仅大肥鱼是可用入口。
- 大肥鱼点击实际选中桥给出的 workspaceSessionId；已有历史与子代理仍可见，未发新 prompt。
- 当前角色工具中的插件、自动化任务、More 均触发真实原生功能；More 的浏览、创建与未来 action 注册不丢失。
- 插件/自动化页回对话、大肥鱼重复点击、切换 main 面板后角色选项、收起/展开侧栏、窗口 resize、light/dark、reload/unload 后原工具入口均可用。
- 检查未修改全局 app.asar、未移动 native React 节点、未出现嵌套 button 或重复自有 host。
