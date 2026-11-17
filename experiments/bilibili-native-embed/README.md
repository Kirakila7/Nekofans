# 官方 B 站 Windows 客户端原生窗口嵌入试验

独立 Electron 宿主 + 本地编译的 C# Win32 助手。使用 `SetParent` / `WS_CHILD` 挂载官方客户端真实窗口；没有替换工作台现有的网页入口，也没有引入 npm 或预编译原生插件依赖。

## 本机运行

在此工作树根目录执行：

```powershell
# 交互试用：弹出并还原按钮解除挂载；关闭宿主会先还原并保留客户端。
& .\experiments\bilibili-native-embed\start.ps1

# 自动验证：挂载、缩放、解除/再次挂载、挂载中关闭。结束时清理本次隔离客户端。
& .\experiments\bilibili-native-embed\start.ps1 -Smoke

# Review 回归：客户端发现期间立即关闭宿主。
& .\experiments\bilibili-native-embed\start.ps1 -Smoke -CloseDuringStartup

# 无需官方客户端或可见桌面的通信/生命周期回归。
node --test experiments/bilibili-native-embed/bridge-client.test.cjs
```

可通过 `-ElectronPath '完整路径\electron.exe'` 指定 Electron。本机优先使用工作树依赖，否则使用相邻 `_archive/neko-fish` 中现成的 Electron 44.7.0。需要 Windows x64、PowerShell 7、.NET Framework C# 编译器；没有 HTTP 服务或端口。启动器同时验证签名和已验证的客户端版本 `1.19.0.5062`，新版本需要重新验证按钮区域后才能放行。

本次从 [哔哩哔哩官方下载页](https://app.bilibili.com/) 获取 Windows 安装包 1.19.0.5062，并以 7-Zip 解包其中的 `$PLUGINSDIR/app-64.7z`，未运行安装器。安装包和主程序 Authenticode 签名均验证有效，签名方为上海哔哩哔哩科技有限公司。没有重新分发这些二进制文件。

本机解包文件、编译产物、独立客户端数据、日志、截图都在 Git 忽略的 `_sandbox/bilibili-native-spike/`。换机器需要自行从官方来源获取并验证客户端，解包到该目录的 `client/`，使 `client/哔哩哔哩.exe` 存在。脚本每次启动前仍检查主程序签名。

## 已验证（2026-10-29 复核）

- Electron 44.7.0 / Windows / 144 DPI（150% 缩放）。
- 官方客户端首页真实显示在预留区域；延迟后再次检查原生父窗口句柄与 `WS_CHILD`，排除只短暂挂载。
- 宿主从 1380×900 调整到 1180×800 后，客户端物理宽高与预留区域计算结果一致。
- 两次解除/再次挂载，以及挂载中关闭宿主：共三次恢复原来的 parent、owner、style、exStyle、visible 与屏幕矩形，自动断言通过。
- 嵌入时裁掉右上角 164×64 DIP 的原生按钮区域，显示“窗口由工作台控制”；两个宿主尺寸下，三个按钮位置的 Windows 命中测试均不会把输入交给客户端。
- 实际调用原生最小化、最大化后，恢复检查能把客户端恢复到嵌入尺寸；解除挂载后仍可正常最小化。原始窗口区域也经过恢复与一致性校验。
- GPU compositing、WebGL 与 video decode 的 Electron 功能状态为 enabled；未调用禁用 GPU、禁用沙箱的开关。启用 contextIsolation、sandbox，禁用 renderer nodeIntegration。
- `smoke.jsonl` 以 `smoke-complete` 结束；`attached.png`、`resized.png`、`detached.png` 为实际屏幕截图。
- Review 后的 6 项通信/生命周期回归通过：迟到响应不串线、超时后取消队列并等待还原确认、助手崩溃、写入管道错误、启动/关闭竞争、还原失败后的受控重试。
- 完整 Windows smoke 再次通过，增加宿主最大化后解除挂载保持最大化的原生状态断言；启动中关闭的独立 smoke 也通过，没有晚到的 attach。证据分别在 `review-full-smoke.jsonl`、`review-startup-close.jsonl`。
- PR CI 仅运行通信回归、JavaScript 语法检查和 C# x64 编译；不下载官方客户端，不把 CI 成功当成 GUI 或播放验收。

这里只证明原生窗口布局和正常还原。没有验证视频实际播放/声音、账号登录、IME、播放器全屏/小窗、跨 DPI 显示器、客户端更新后的兼容性、宿主崩溃或强杀恢复；尚不能作为生产接入完成的依据。

## 实现与边界

- `start.ps1`：签名/已有实例检查，本地编译与启动；Smoke 结束仅清理本次启动时间之后、位于隔离目录的客户端进程。
- `main.cjs`：Electron 主进程负责启动、窗口区域和生命周期；preload 仅开放固定 attach/detach/capture 操作。客户端启动器可能重启自身，因此按完整可执行路径和本次启动时间发现窗口，而不是只依赖最初 PID。
- `bridge-client.cjs`：每条命令使用 requestId 对应响应；超时或管道失败使整条连接失效并关闭 stdin，等待助手明确确认还原后才允许宿主退出。整段启动/挂载/解除/关闭流程串行化，避免按钮连点或启动中关闭造成交错。启动器互斥锁和 Electron 实例锁阻止重复试验互相覆盖日志、编译或清理。
- `WindowBridge.cs`：检查窗口 PID 和 DPI awareness，保存原样式/位置，挂载、缩放和还原。不同 DPI awareness 拒绝挂载。解除后再更新尺寸会被拒绝。
- 内嵌时移除系统最小化/最大化/菜单样式，并用 `SetWindowRgn` 裁掉客户端自绘按钮区域，解除时恢复保存的窗口区域。交互模式每 250 ms 检查异常最小化/最大化/隐藏并恢复；这属于事后恢复，可能出现短暂闪动，不是拦截客户端内部 API。没有注入 DLL 或修改官方客户端资源。
- 区域尺寸适配本次官方客户端 1.19.0 的首页布局，客户端升级、播放器全屏、替代布局和跨 DPI 屏幕尚需验证；不能保证拦截键盘快捷键、系统消息或程序自身退出。
- 中文路径通过 UTF-8 标准输入输出传递。普通窗口移动由原生父子关系处理，不通过反复 SetWindowPos 跟随，避免事件反馈循环。
- 正常关闭和标准输入 EOF 会尝试还原。强杀整个进程树、目标程序挂死、句柄重建等故障恢复尚未实现；不要把原型直接接到用户已有客户端进程。
- 交互模式关闭宿主后客户端继续运行；在客户端中退出后才能再次启动试验。PID 记录在 `pids.json`；自动测试使用独立数据目录，不接管已有实例。

## 研究来源

- [sweetwisdom/electron-native-windows](https://github.com/sweetwisdom/electron-native-windows)：`SetParent`、裁剪样式和容器思路；未复制代码，也未使用其禁用 GPU/沙箱的 demo 配置或关闭时终止目标的行为。
- [HyperDesk](https://github.com/qetqet910/HyperDesk)：参考窗口生命周期思路；其当前 owned-window 方案不等同于真正的 child window。
- [Microsoft SetParent](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)：窗口样式与跨进程 DPI 限制。
- [Microsoft SetWindowRgn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowrgn) / [GetWindowRgn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrgn)：原生窗口裁剪与恢复，成功设置后区域句柄的所有权转交系统。
- [Electron getNativeWindowHandle](https://www.electronjs.org/docs/latest/api/browser-window#wingetnativewindowhandle)：Windows HWND 获取方式。

后续接入工作台时，应增加明确的本机客户端入口、客户端路径配置、DOM 区域到 DPI 坐标同步、页面切换/托盘隐藏/应用退出处理，并先完成播放与输入验收。
