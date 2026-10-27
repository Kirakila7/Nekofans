# 本机独立便携版

本次目标是 Windows 本机免安装使用。整个程序目录携带 Electron、DSH Host、原版动画、Python/Node 运行资源与配套 Office 技能；不要只移动其中的 exe。

2026-10-26 成品在仓库上一级工作区 `dist/大肥鱼桌宠-本机便携版-20261026/`，约 2.48 GiB。已在移动目录后通过真实 exe 的 7 项启动/重启检查、复制后 DSH Host 的 10 项检查、包内运行资源检查及 88,490 个文件的 SHA-256 校验。聊天上游使用本机模拟服务，实际供应商与 DSH 账号尚未配置。

## 使用

双击目录中的 `大肥鱼桌宠.exe`。主角色右键打开「API 设置」，填写文字聊天 API 的地址、模型与密钥；这里不是 TTS 设置。保存不会自动发送测试请求，发送聊天时才请求配置的模型。

右键「打开内置 DSH」进入工作台，在工作台中配置其账号并发起任务。主角色的聊天 API 与 DSH 账号各自独立。退出使用桌宠右键「退出」，会同时停止内置 DSH Host。

可选启动参数：`--settings` 启动时打开聊天设置，`--dsh` 启动时打开工作台。普通双击无需命令行或系统 Node/Python。

## 数据和移动目录

用户数据保持在 `%APPDATA%/neko-fish`：聊天、确认记忆与摘要、人设、DPAPI 密钥、DSH profile 及工作区均不写入程序目录。移动整个程序目录会保留该 Windows 用户原有数据；同一用户运行多个程序副本仍共用单实例与数据目录。

密钥绑定当前 Windows 用户。换用户或机器后应在设置页重新填写；已损坏或无法解密的旧密钥也可以替换、清除。不要把个人 profile、DSH 登录数据或密钥打进程序包。

开发/验收可通过 `NEKO_FISH_DATA_DIR` 指定一个独立数据目录。便携程序的运行资源始终取自身 `resources/`，不受旧 `NEKO_FISH_ASSETS_DIR`、`NEKO_FISH_DSH_RUNTIME` 等开发资源环境变量影响。

## 构建与验证

私有仓库提供“不含 DSH”的协作包：包含 Electron、桌宠应用、动画和署名，排除 DSH Host、primary-runtime、office-skills 及任何用户数据。源码保留本项目的 DSH 对接实现，动画目录名 `dsh-pet` 表示素材来源，不是 DSH 程序。

克隆源码后执行 `npm ci`、`npm run setup:electron`；输出父目录需预先存在：

```powershell
npm run build:portable -- --without-dsh --output '<新的便携目录>'
npm run test:portable -- '<便携目录>' --without-dsh
```

不含 DSH 的构建无需 DSH 安装、源码或空占位目录；聊天 API、记忆和动画可以独立使用。DSH 工作台及子代理任务需另行准备运行资源。本机原来包含 DSH 的便携目录保持不变。

```powershell
# 父目录应已存在，输出目录必须是新目录；不覆盖旧产物
$env:NEKO_FISH_DSH_PRIMARY_RUNTIME = '<已有完整 primary-runtime 目录>'
npm run build:portable -- --output '<新的便携目录>' --plan
npm run build:portable -- --output '<新的便携目录>'
node scripts/build-portable.mjs --verify '<便携目录>'
npm run test:portable -- '<便携目录>'
```

构建时解析当前应用源码依赖，以及 DSH 运行清单中的生产依赖。工作区链接转换为包内普通文件，排除源码沙箱和用户数据；冲突依赖版本按 Node 解析规则放入必要的嵌套目录。生成的 `SHA256SUMS.json` 验证文件内容及额外/遗漏文件，失败构建保留 `BUILD-INCOMPLETE.txt`。

`test:portable` 直接运行成品 exe 的生产入口，以 TEMP profile 和本机模拟聊天 API 检查动画、设置、DPAPI、聊天、记忆、重启及真实 DSH 工作台。调试端口只为该测试启用，测试结束后退出程序并删除临时数据，不修改实际用户 profile。

完整 Python/Node 资源与 Office 文档读写验证见 [DSH_RUNTIME.md](DSH_RUNTIME.md)。它不等于所有 DSH 工具或真实模型任务均已验收；真实聊天供应商与 DSH 账号需要用户在本机配置。当前便携目录用于本机使用，公开分发、安装升级与签名另见 [DISTRIBUTION.md](DISTRIBUTION.md)。
