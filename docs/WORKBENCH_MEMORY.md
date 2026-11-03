# DSH 工作台 N.E.K.O. 原生记忆

实现日期：2026-10-28。运行入口为 `apps/neko-workbench/`，角色固定为 `personaId=bigfish`。这份说明记录当前实现；`framework/` 内 v2/v3 原始合同与参考测试继续保留，不以旧文档的“尚未接入”作为当前完成状态。

## 使用

2026-11-04 星图源码更新：记忆窗口默认只显示可旋转、缩放的星点和连线。事件文字不会在初始页面或悬停时显示；点击或用键盘激活星点后，侧栏才创建该条内容、来源和状态。关闭侧栏会移除文字。来源关系可继续点击跳转，原始消息按需读取；模型设置收在齿轮内，现有修订绑定、确认、更正、冲突合并和显式恢复保留。

星图通过主聊天窗口已有的受信 IPC 读取私有 `/workbench-memory/graph`，白名单投影原生事实（含事实归档）、当前反思文件与人格文件。来源边来自持久化投递映射、`source_fact_ids`、人格 `source_id` / `merged_from_ids` / `merged_source_ids`、反思 `absorbed_into` 和更正来源；不按文字相似度猜测关系。淡金色中心辐线仅表示属于同一主角色，中心不计入记忆数量。无法解析的来源保留原 ID，不补造节点；分片反思/人格归档不是本接口的完整覆盖范围。

读取星图不会启动原生进程，也不会调用提取、修复或模型。进程离线或快照不可用时，只显示真实同步日志中可用的记录并标明范围。快照使用原生创建/事件时间，不把读取时间冒充事件时间；不导出向量、密钥、内部配置或其他角色的数据。删除屏障与失效修订过滤同样作用于图节点和依赖反思，未确认的原生事实不因展示而自动确认。

本次为独立源码改动与隔离测试，未替换用户日常安装版、未改写真实记忆。验证状态见 `docs/workbench/INTEGRATION_STATUS.md`。

主角色右键 → **养鱼 → N.E.K.O. 记忆 → 记忆与模型设置…**。工作台选项中的“聊天记忆”也打开同一个面板。

主角色统一使用原生 N.E.K.O. 记忆。启动和保存聊天 API 后自动连接，默认复用聊天 API 整理记忆，也可配置独立模型。没有日记/进阶模式切换，也没有日记召回回退。原始聊天仍由 ConversationStore 保存；DSH 工作会话独立。

开发环境首次准备记忆组件：

```powershell
npm run setup:neko-memory
```

组件用独立的 `services/neko-memory/pyproject.toml`、`uv.lock` 和 `.venv`。启动始终通过 `uv run`；开发时可用 `NEKO_WORKBENCH_MEMORY_PYTHON` 显式选择已有 Python 环境，产品代码没有归档目录或本机源码的硬编码路径。

在面板展开“N.E.K.O. 记忆组件与整理模型”，选择复用聊天 API，或单独配置 OpenAI 兼容 / Anthropic 整理模型，再点击“保存并连接记忆组件”。无需额外启用或切换模式；模型配置就绪后自动使用。整理模型可能产生费用，主聊天和记忆整理可分别配置。新密钥由现有 Electron safeStorage 加密保存，只向原生子进程的 stdin 临时传递，不写 argv、环境变量、模型配置文件或日志。

升级时把旧 hub 事件和尚未进入 hub 的 diary.sqlite 事件，按原 ID、来源、修订和删除记录迁入原生投递队列。旧 hub 快照保存在 preNativeOnlyHub 元数据中，原 diary.sqlite 与 Markdown 文件不改动；旧恢复点元数据保留。现有冲突保留各版，面板支持显式合并，修改命令绑定修订 ID。

删除保留 tombstone。原文、旧备份或重复同步不会自动恢复；单条恢复必须明确操作。恢复不降低私人范围。

## 复用与新增边界

- 原 `openMainChat`、Chat API 双协议、PersonaStore、ConversationStore 继续复用。工作台关闭本地规则候选提取与 extractive-v1 摘要生成；事实提取、整理、反思和召回统一交给原生记忆引擎。旧候选和带来源摘要仅作迁移输入和历史查看，不并行参与聊天召回。
- `framework/reference/memory-hub.mjs` 原样复用为到原生引擎的持久投递日志，只注册 neko 一个 provider。SQLite 仅保存来源事件、待投递回执与管理修订，不实现另一套记忆算法。
- 记忆引擎直接运行仓库已有的 N.E.K.O. pinned snapshot（`config/upstream-lock.json` 的 `b4821ec…`）：FactStore、时间索引、混合召回、反思和画像维护均由原生实现负责，没有重写这些算法。
- 进程所有权、隔离 profile、实例检查和 stdin EOF 退出沿用归档 `f750605` 原生接入的做法，按本设计拆成独立记忆进程。旧 main+memory 完整聊天入口与当前可选本机 N.E.K.O. 聊天连接保留各自边界；记忆引擎不会替主聊天生成第二次回复。
- 新增 `workbench_gateway.py` 只负责旧引擎缺少的复制协议、确认来源、幂等效果键、修订和删除屏障。旧普通 `/cache` 没有可靠普通轮次幂等语义，因此不拿它冒充复制接口，也不通过直接写 `facts.json` 更新原生索引。

该兼容网关绑定当前 pinned 版本的原生内部持久化 API；更换上游版本时必须重新运行组件验证。

## 数据链路与范围

主聊天直接调用 N.E.K.O. 混合召回，再结合固定人设和预算内近期对话交给原 ChatProvider。完成的聊天回合在 ConversationStore 只提交一次，随后异步发送给原生引擎提取和持久化。记忆暂不可用时聊天继续，原始记录与待处理事件保留并重试，不切回本地或日记召回。

原双模式的日记适配器不再装配到生产聊天。旧版已接入的日记事件会迁入原生侧，原始日记文件保留；不继续扫描工作区或全局 DSH 日记。

原生提取事实作为候选回传；反思作为推断。上下文明确区分 `candidate`、`inferred`、`user-confirmed`，候选事实不会被标成“用户确认过的记忆”。原生 ID 与来源关系保留，重试继续使用原事件 ID。

原生记忆自动处理完成的回合，定时重试未完成的投递。网络失败保留事件和待处理队列。分批发送与原生效果键支持丢响应重试，事实已持久化而回执未保存的中断可以恢复。

私人内容只进入本角色私有存储和本地记忆面板，不写公开日记或通知正文。合并与恢复不会降低私人范围。账号、Cookie、API 密钥、DSH 权限、其他角色和内部系统提示词不作为记忆事件同步。

DSH 工作会话、子代理任务及“任务备注”保持独立。生活代理的原始日记仍由生活代理管理，不再作为并行记忆后端。

## 运行数据与生命周期

相对工作台数据目录：

```text
main-chat/
  conversations.sqlite             原始聊天
  memories.sqlite                  原有记忆与带来源摘要
  memory-model.json                非秘密的记忆模型选择
  secrets/memory-api-key.encrypted 独立整理模型密钥（可选）
  memory/
    hub.sqlite                     来源事件、投递回执与升级前快照
    diary.sqlite                   旧版侧表（仅升级读取，保留原文件）
    native/
      replication.sqlite           原生网关事件与投递日志
      N.E.K.O/                     原生事实、反思、画像与索引
```

原生进程仅监听 `127.0.0.1` 动态端口。每次启动生成新 token 与实例 ID；HTTP 只开放受鉴权的 `/workbench-memory/*`，拒绝浏览器 Origin 和原生其他路由。READY 必须发生在真实原生运行态初始化之后。退出通过 stdin EOF 请求关闭，超时仅回收本应用创建的进程树；不会停止外部 N.E.K.O. 服务。

正式组件没有测试桩或 free-model 回退，关闭原生诊断内容日志、云存档和外部记忆同步。向量资源是否可用仍由原引擎管理，缺失时保留原生 BM25 回退，不将离线关键词测试称为向量质量验收。

## 验证

```powershell
npm test
npm run check:neko

# 真实本机记忆引擎，模型接口使用回环合成响应
$env:NEKO_MEMORY_COMPONENT_TEST='1'
node --experimental-strip-types --test tests/neko-workbench/neko-memory-component.test.mjs tests/neko-workbench/memory-workbench-component.test.cjs

# 原生写入与同步日志之间的中断恢复
cd services/neko-memory
uv run --frozen --no-sync python -B -m unittest test_workbench_gateway
```

`memory-replication.test.mjs` 覆盖默认单原生 provider、十次重放、离线不回退、旧 hub 与未投递日记侧表迁移、原文件保护、并发修订、删除恢复和丢响应重试。组件检查运行真实 pinned 引擎与 SQLite，模型响应明确为合成 fixture，未使用真实用户资料或模型账号。

`memory-ui.test.cjs` 在显式设置 `NEKO_WORKBENCH_ELECTRON` 时运行真实 Chromium，检查单原生界面、离线提示、内容安全、草稿保留、修订绑定及独立模型设置。默认离线套件跳过需要原生组件、Electron 或其他外部环境的检查。

当前为源码接入与本机开发环境验证。真实供应商账号、向量模型检索质量、完整 DSH 窗口联合操作、macOS、干净机器安装/升级和签名发行仍需各自验收；没有替换正在运行的用户程序或修改真实用户记忆。
