# 左上角头像独立按钮修复

该修复解决真实 DSH `sidebar.brand.mark` 位于“新建会话”原生 button 内的问题。原头像组件再渲染 button 会产生嵌套交互控件，屏幕阅读和自动化工具可能只能看到外层新建会话。

## 合入范围

- 用 `sidebar-avatar-accessibility-patch.js` 的完整 `SidebarMark` 替换白标 factory 中同名函数。
- 将同名 `.css` 片段加入白标 CSS。
- 使用白标已有 ReactDOM、hooks、store、Panel、PickerTile；无需新包、新后端权限或会话接口。

始终保留一个相同尺寸的 span 锚点。首次只渲染被动图，避免任何一次提交生成嵌套按钮。检测到原生父 button 时，组件把**自己的触发按钮和原选择面板** portal 到 body 下的自有 host，并按 span 的实际 rect 覆盖头像位置。头像从 DOM 与可访问性树上成为独立按钮；原父按钮、名称、事件和功能不改，也不调用其 click。

当普通预览没有外层 button 时，保持原独立头像交互；缺少 portal 支持或未知结构时只显示被动图，不拦原按钮。自有点击、pointer 和按键阻止 React portal 沿逻辑树继续冒泡，选择器的五个内置图、自定义图、上传、提示和持久化 store 都保持原调用。

定位跟随 scroll、resize、ResizeObserver 与祖先 class/style/hidden 变化；卸载移除 host、所有监听和 observers。面板仍使用原 Popover API 与原焦点返回路径，并依据移动后的锚点更新位置。

## 离线验证

```text
node --check embedded-dsh/sidebar-avatar-accessibility-patch.js
node embedded-dsh/check-sidebar-avatar-accessibility.cjs
```

fixture 验证：外层 button 中不含头像 button；头像实际在独立 portal；点击及键盘不会进入原生新建会话；五图与自定义图、上传保留；滚动定位、卸载、普通预览和失败回退均通过。该 fixture 不创建真实会话、不操作原生应用。

## 主控实机验收

1. 可访问性树单独出现“头像：…，点击更换”按钮。
2. 只点该独立按钮，出现选择头像面板；不点原新建会话。
3. 选另一内置头像，头像与工作台背景同步变化，当前 sessionId 与历史保持。
4. 上传图片/取消、Esc 关闭及焦点返回沿用已有流程。
5. 收起/展开侧栏和窗口缩放后头像位置正确；卸载无残留 host。

以上是待进行的真实窗口检查，不能用离线 fixture 代替。
