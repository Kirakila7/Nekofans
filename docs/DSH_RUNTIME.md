# DSH 独立运行资源

桌宠的 DSH Host 项目与 `primary-runtime` 是两组独立资源。Host 启动、网页打开，不代表 Python、Office 或视频工具已经可用。旧 `_sandbox/f01-dsh-desktop/primary-runtime-stub` 只适用于早期启动验证，不能用于分发。

## 本机已验收的资源

2026-10-26 在本机 DSH NEXT 安装目录的 `resources/runtime/x64/` 找到完整资源。没有读取、复制或修改账号及用户 profile。下表为执行验证后的资源统计。

| 组件 | 文件数 | 大小 |
| --- | ---: | ---: |
| primary-runtime | 6,131 | 263,993,913 bytes（约 252 MiB） |
| office-skills | 8 | 24,511 bytes |

原始 manifest 标记 `desktopVersion: 2.0.19-next`。Python 3.12.14、Node 24.21.0 以及 13 个 Python distribution 与当前 F01 源码锁一致；pnpm 11.8.0 与源码的 11.28.5 不同。保留原始 manifest、payloadDigest 和来源，不能将导入资源标成当前源码构建或改写版本以掩盖差异。

已使用当前上游 `apps/desktop/scripts/prepare-primary-runtime.ts` 的 native smoke 运行：Python/Node 版本、Python 子进程和独立 venv、完整 Python distribution 集、pip 依赖一致性、NumPy/pandas、DOCX/PPTX/XLSX 合成文档读写回读、pnpm 执行全部通过。合成文件在上游脚本创建的临时目录，测试完成后删除。

虽然顶层 Python 使用 `-I -B`，venv/ensurepip 内部子进程仍可能生成 stdlib `__pycache__`；首次检查直接执行原资源，统计有少量变化，不能把那次 smoke 称为严格只读，也没有猜测性地删除原有缓存。当前验证入口已修正：`--smoke` 先把 primary-runtime 和 office-skills 复制到 TEMP，所有程序在副本执行，成功或失败均清理副本。后续验证不会改变安装源或便携包的文件哈希。默认检查或 `--inspect` 始终只读，不运行程序。

这些检查没有验收 DSH 模型调用、账号、付费任务、Office PDF 渲染/重算引擎、视频工具或所有工具组合。`allDshToolsVerified` 始终为 false，不能由 primary-runtime 验证推导全部工具已经可用。

## 可复用验证入口

`scripts/prepare-dsh-runtime.mjs` 不自动搜索用户 profile，也不自动下载。指定可信的 DSH 源码和完整资源路径后运行：

```powershell
node scripts/prepare-dsh-runtime.mjs --source "<DSH源码目录>" --runtime "<primary-runtime目录>" --report "<现有报告目录>/dsh-runtime-check.json"
```

默认（也可显式 `--inspect`）只检查清单、入口文件、版本、资源尺寸及配套技能，返回 `nativeSmokePassed: false`。加 `--smoke` 后在 TEMP 副本执行真实 native smoke，需额外约 264 MB 临时空间；失败退出码非零，不写成功报告。成功报告包含 `verificationUsedTemporaryCopy`、`temporaryCopyRemoved`。

`office-skills` 必须与 `primary-runtime` 同级，包含 Office 总技能及 DOCX、PPTX、XLSX、导出 PDF、重算和渲染技能。Host 的 `desktop-host/src/office.ts` 从 `dirname(primaryRuntime)/office-skills` 解析，单独复制 Python 文件夹会导致资源不完整。便携构建可以直接从已经验证的安装资源复制到自己的资源目录，避免先生成第二份中间副本；不得复制安装程序的用户数据或账号目录。

## 从锁定源码重新准备

上游入口为 `scripts/primary-runtime/prepare.ts`。Node、Python 和 wheels 的 URL、版本、SHA-256 来自 `scripts/primary-runtime/lock.json`；pnpm 和 Office skills 从可信源码的已安装依赖复制。该过程要求源码已完成依赖安装和必要构建。

```powershell
# 只列出锁定下载项，不发网络请求
node scripts/prepare-dsh-runtime.mjs --source "<DSH源码目录>" --plan

# 明确执行下载/构建；output必须是不存在的新目录
node scripts/prepare-dsh-runtime.mjs --source "<DSH源码目录>" --prepare --output "<新的runtime目录>" --cache "<下载缓存目录>" --report "<现有报告目录>/dsh-runtime-build.json"
```

资源来自 nodejs.org、Astral 的 python-build-standalone GitHub release 和 files.pythonhosted.org。准备脚本使用上游校验和验证，不修改已有 payload；已有 output 会被拒绝。准备失败可能留下新 output 中的部分文件，用于排查；不应将该目录分发。成功后还会运行 native smoke，通过才写验证报告。

该入口只准备 primary-runtime 和 Office 技能；完整 Host 生产依赖闭包、独立 Office 引擎及应用包仍由各自的打包步骤负责。资源分发前还需保留原许可与 notices，并针对最终复制后的目录运行验证。
