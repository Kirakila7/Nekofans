# Windows 安装版构建

Windows 默认输出由官方 NSIS 编译器生成的当前用户安装程序。安装位置固定为 `%LOCALAPPDATA%\Programs\NEKOfuns`，创建开始菜单和桌面快捷方式，并在系统“已安装的应用”中登记卸载入口。安装和卸载不需要管理员权限；升级或卸载遇到该目录中的运行进程时要求用户自行关闭，不强制结束工作任务。

账号、会话和项目仍由现有 bootstrap 管理。保留 `--profile-name NEKOfuns-PR52-Trial`，无需迁移存档。卸载只删除安装器逐项登记的程序文件，保留账号存档、项目以及安装目录内未登记的其它文件。安装程序不接管没有对应安装标记的非空目录，不沿目录联接或符号链接写入、卸载文件。

## 编译器来源

使用 [NSIS 官方 SourceForge 项目的 3.13 ZIP](https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13.zip/download)，该下载页公布的 SHA-256 为：

```text
ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8
```

编译前必须提供工具目录和 `NSIS_TOOL_RECEIPT.json`。构建器核对上述归档哈希、编译器哈希及解包工具的完整文件清单；不安装全局工具。此工作区已经验证的工具位于 `.neko-windows-build/tools/nsis-3.13`，收据位于其上一级。

## 分两步构建

先使用冻结的 source manifest、已验证的 Electron/Node/DSH 缓存和既有记忆运行环境执行正常构建命令，追加 `--stage-only`。此步只生成 `application` 与 `APPLICATION_SHA256.json`，不编译或运行安装程序。

确认本地预览和文件清单后，在相同版本配置下继续：

```powershell
node scripts/build-neko-daily.mjs `
  --output <此前的独立输出目录> `
  --resume-package `
  --package-format installer `
  --nsis-compiler <已验证工具目录>/makensis.exe `
  --nsis-receipt <工具收据路径> `
  --artifact-name NEKOfuns-<版本>-Setup.exe
```

续建会再次核对版本、完整库存及每个文件哈希。已有同名 EXE 不会被覆盖。输出包含安装 EXE、`BUILD_RECEIPT.json`、`NSIS_BUILD.log` 和使用说明。生成的 NSIS 脚本及文件清单也保留用于审查。旧自解压便携方案仅在显式传入 `--package-format portable` 时使用。

## 隔离验收

编译专用 QA 安装包时必须同时提供三项，使用独立卸载身份及快捷方式组：

```text
--installer-test-id NEKOfuns-QA-<唯一标识>
--installer-install-dir <独立绝对路径>
--installer-shortcut-group NEKOfuns-QA-<唯一标识>
```

QA 包不创建桌面快捷方式。正式包不使用这些参数。`/S` 支持静默安装，静默模式不会自动运行工作台；有运行任务时退出码为 1618。

`windows-installer.test.cjs` 检查生成、清单、隔离参数与续建；设置 `NEKO_NSIS_COMPILE_FIXTURE=1` 只额外编译一个极小合成安装包，不执行它。`windows-installer-native-qa.cjs` 则必须显式设置 `NEKO_INSTALLER_NATIVE_QA=1`：它安装独立的合成 Node 程序，检查快捷方式/卸载登记、升级、运行进程阻挡和卸载保留文件。此脚本不打开工作台或真实账号，运行后将验收收据留在独立目录中。

系统若阻止编译器或安装器执行，保留错误并报告，不修改系统策略或绕过阻止。未签名安装包仍可能出现系统发布者确认；只有真实运行验收才能确认目标机器是否允许执行。
