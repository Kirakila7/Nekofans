# N.E.K.O. 原生语音接入与项目分工

更新：2026-10-26。用于 `CN-Zephyr/bigfish-pet` 的并行开发与认领，衔接 [总体分工](PROJECT_WORK_SPLIT.md) 和 v3 工作台框架。

本轮交付是代码核对后的接入方案与任务分工，没有新增语音实现、启用麦克风、启动语音服务或调用模型。下表负责人是建议的职责角色，语音任务均待认领，未向其他聊天或维护者派发。

核对基线为当前集成分支 `c1f9e87`，并确认最新 `main@813e702` 的便携构建/素材更新未改动下列 ASR/TTS 模块或主聊天语音接线状态。分工不回退该主分支的已有更新。

## 接入目标

复用 N.E.K.O. 原生 ASR/TTS worker，通过独立的本机语音服务接到主角色：按住说话 → 最终转写 → 现有聊天服务 → 回复 → 原生 TTS → 实际播放 → 桌宠说话状态。主角色聊天继续独立于 DSH，子 agent 不接收这条语音输入，也不因主角色说话改变任务状态。

先打通按住说话和回复播音，再单独评估实时全双工。上游 Core/omni 实时会话包含完整对话语义，不能当作可直接替换的免费 ASR。系统朗读、浏览器合成、测试音也不能标成 N.E.K.O. 原生角色语音。

现有 Windows 入口已有独立 Chat API 和轻量记忆，可作为首个接线目标。新 `apps/neko-workbench` 的通用主聊天尚待接入，须先完成真实 ChatService 连接，才能宣称该入口支持完整语音聊天；可并行开发语音模块和 UI。

语音服务按需使用自身 Python、模型与 provider 配置，不要求先打开 DSH。当前可不携带 DSH 的便携构建也应保留可选语音资源方案，不能把完整 DSH 运行时重新变成语音的强制前置。

## 已有代码与缺口

| 部分 | 仓库内依据 | 当前边界 |
| --- | --- | --- |
| 原生 ASR worker 与协议 | [ASR 来源](../services/neko-asr/VENDOR.md)、[server.py](../services/neko-asr/server.py) | 有 `faster_whisper`、`dummy`、`scripted` 适配；云端 ASR 当前被拒绝为未验证，不代表所有上游 provider 已可用 |
| 原生 TTS worker 与协议 | [TTS 来源](../services/neko-tts/VENDOR.md)、[server.py](../services/neko-tts/server.py)、[providers.py](../services/neko-tts/providers.py) | 有 `tone/dummy/free/step` 路由；默认 `tone` 为测试音。源码中的 verified 标记及历史说明不代替本次真实人声验收 |
| ASR 客户端 | [asr.ts](../packages/voice-adapter/src/asr.ts)、[asr-sidecar.ts](../packages/voice-adapter/src/asr-sidecar.ts) | 有按住说话、partial/final/empty/error；sidecar 模块混有 Node 子进程和 Buffer，不能直接导入关闭 Node 的沙盒渲染器 |
| 播音与打断 | [tts.ts](../packages/voice-adapter/src/tts.ts)、[tts-sidecar.ts](../packages/voice-adapter/src/tts-sidecar.ts)、[tts-webaudio.ts](../packages/voice-adapter/src/tts-webaudio.ts) | 有合成、实际播放、抢占和迟到帧处理；仍需主聊天回复接线、真实输出设备及退出清理验收 |
| 语音回合与动作 | [voice-turn.ts](../packages/app-coordinator/src/voice-turn.ts)、[speech-sync.ts](../packages/app-coordinator/src/speech-sync.ts) | 旧回合接 `MemoryClient.commitTurn`，当前 v1 则由 ChatService 管理聊天/轻量记忆；两条存储链不能直接同时挂载，否则可能重复回复或双写 |
| 服务启动 | [ASR 启动代码](../packages/voice-adapter/src/asr-sidecar.ts)、[TTS 启动代码](../packages/voice-adapter/src/tts-sidecar-process.ts) | 默认 Python 指向 `.venv/Scripts/python.exe`，是开发路径；须适配 Windows/macOS 的实际运行资源，不能写死开发者路径 |
| 当前桌面入口 | [Windows 入口](../apps/desktop/main.cjs)、[工作台入口](../apps/neko-workbench/main.cjs) | 本次核对未发现原生语音链路已接到这两个产品入口；有旧模块不等于已安装可用 |
| 默认测试 | [test-v1.mjs](../scripts/test-v1.mjs) | 现有默认套件不包含 `tests/voice-adapter`、语音记忆服务集成和 live 语音测试；此前 331 项通过记录不能作为语音验收 |

仓库 ASR/TTS 来源记录固定在 N.E.K.O. `b4821ecb003dd913a4f592b2296616cd8ea7e870`，属于既有源码快照，不是当前上游版本或发行兼容性的保证。保留 Apache 2.0 LICENSE/NOTICE；不要直接修改 `vendor/`，确需升级时另行重取快照并核对差异。

## 并行任务与文件所有权

| 任务 | 建议负责人 | 独占范围 | 交付与验收 |
| --- | --- | --- | --- |
| V0 协议与整合 | 主协调者 | `packages/app-contracts/`、各包 `src/index.ts`、共享运行资源解析、根测试/打包入口 | 先定义角色、语音回合、取消、播放状态及存储去重合同；统一可注入 Python/端口配置，收口共享导出 |
| V1 原生 ASR | ASR 接入 agent | `services/neko-asr/` 非 vendor 文件、`packages/voice-adapter/src/asr*.ts`、`tests/voice-adapter/asr*.test.ts` | 分离浏览器传输与 Node 进程管理；16kHz 单声道 PCM16、partial 只展示、final/empty/error 有界结束；拒绝麦克风和断线后仍可文字聊天 |
| V2 原生 TTS | TTS 接入 agent | `services/neko-tts/` 非 vendor 文件、`packages/voice-adapter/src/tts*.ts`、`tests/voice-adapter/tts*.test.ts` | 复用指定原生 worker/voice_id；实际音频开始才进入 speaking；停止、抢占、错误和无音频正确结束，旧 PCM/结束事件不串到新回复 |
| V3 聊天与语音记忆 | 回合/记忆 agent | 新的 `packages/app-coordinator/src/voice-chat.ts` 及专属回归；旧 `voice-turn.ts` 的必要适配 | final 进入既有主聊天路径，只产生一次回复与一套主存储写入；稳定 utterance/turn ID、重放去重、来源映射、取消不写入未完成内容 |
| V4 桌面录音与播放 UI | 桌面语音 agent | 新的工作台 voice UI/设置辅助模块及专属 UI 测试 | 按住说话、设备/声线设置、停止播音、可见收音状态；隐藏输入、拒绝权限、拔掉设备及断线后均可恢复 |
| V5 独立审查与实机验收 | 审查/验收角色 | 只读审查；专属验收记录 | 核对真实 provider、角色隔离、退出无残留、麦克风/扬声器和打断；Windows/macOS 分别记录，听感由用户确认 |

共享入口 `apps/desktop/main.cjs`、`apps/desktop/preload.cjs`、`apps/neko-workbench/main.cjs`、`preload.cjs`、`renderer.js` 及设置总入口由协调者统一修改。V4 提供独立模块和所需挂接清单，不与原 UI 工作线同时编辑主文件。现有聊天、记忆数据库 schema 的变更也由协调者收口，V3 先提交迁移需求与测试。

V1 负责抽出 ASR 进程模块时，仍拥有原 `asr-sidecar.ts`；V2 不修改它。公共 Python/资源路径解析由 V0 提供，双方只消费接口。遵守 [COLLAB.md](COLLAB.md)：各任务独立分支/worktree、不同时改共享文件、不直接改 pinned vendor。

## 批次与依赖

1. **先完成 V0 合同。** 明确当前应用使用哪一个聊天/记忆主链路、provider/voice_id 配置归属、取消语义和持久去重位置。
2. **V1、V2、V3 并行。** 先用内存 fixture 或本机模拟接口对接合同；原项目、社区入口及 DSH 功能继续独立开发。桌面模块 V4 可先做 UI，主入口挂接等接口稳定后由协调者执行。
3. **协调者接线 V4。** 先在 Windows 独立 ChatService 上验证，再接到已完成主聊天适配的 N.E.K.O. 工作台。不要把主角色语音转发到 DSH 根会话或子 agent。
4. **V5 分级验收。** 先离线协议，再本机真实语音，再桌面操作与用户试听，最后发行资源/安装升级。阶段结果分别记录。

实时全双工、自动端点/VAD、唤醒词和回声消除另开任务；不把按住说话版本宣称为全双工已经完成。

## 接线合同

```text
麦克风（用户主动启用）
  → 采样/16kHz PCM16 → AsrInput / 原生 ASR sidecar
  → partial：临时字幕；final：按 utterance_id 去重
  → 本角色既有 ChatService：人设 + 已确认记忆 + 近期聊天
  → 一次回复和一次原始聊天存档
  → 原生 TTS engine → TtsPlayer → 实际音频输出
  → speaking / ended / interrupted → 主角色动作

最终转写与回复 → 既有记忆规则 → 候选/确认/来源记录
DSH 任务、社区页面及其他角色 → 各自保持原有链路
```

- `personaId=bigfish` 保持稳定；原生协议需要 `character_id` 时使用显式绑定，不能从昵称、头像或 DSH session 推导。声线配置单独保存，不改人设和记忆空间。
- 新语音控制器以 utterance ID 对应一次主聊天请求；当前 ChatService 已写入原始消息和候选记忆，不能再无条件调用旧 `respond + commitVoice` 产生第二份回复/存档。新增持久回执由 V0/V3 统一设计。
- 既有 ASR sidecar 使用 `start/audio/stop` 和 `partial/final/empty/error`；既有 TTS 使用 `speak/flush/interrupt` 和 `audio_chunk`/PCM/结束事件。它们是本仓库适配协议，不宣称是所有上游版本通用的 HTTP/WS API。
- `speech_id`、`playback_id` 与当前回复明确关联；合成开始不等于用户已听到。新回复或打断必须同时停止合成与实际播放，并丢弃已取消回合的迟到数据。
- 原始音频默认不保留；语音记忆先保存最终转写和来源 ID。若后续增加音频引用，需有用户可见的保存/删除设置，不能把音频默认为用户已确认事实。
- 麦克风权限由用户主动启用；默认不后台常开。社区窗口不获得语音 IPC 或本地语音服务能力。秘密配置留主进程/受保护存储，渲染器只获得有限的语音控制方法。
- sidecar 按需启动、固定回环监听；两个应用各自拥有进程、数据、配置与端口，不能停止另一项目服务。当前示例端口 ASR `59067`、TTS `59077` 可配置，正式接入需处理占用和来源/会话校验。

## 验收清单

| 层级 | 必须观察的结果 |
| --- | --- |
| 离线协议 | partial 不入库；重复 final 不重复回复/写入；空音频、超时、断线、取消与重启后重放有明确结果 |
| 播放与状态 | queued 保持未说话；首个实际可听样本触发 speaking；停止即静音；旧音频/旧 ended 不影响新回合；无音频和错误能退出状态 |
| 聊天/记忆 | 文字与语音使用同一主存储，保留来源；其他角色不可串用；模型提议仍需确认；DSH 子任务状态不改变主角色 |
| 本机原生 worker | 使用明确的 provider、模型版本、voice_id 和本机资源；证明真实转写或真实人声，测试音与模拟输出单列 |
| 桌面实机 | 用户说话 → 正确转写 → 一次回复 → 实际听到角色声音；麦克风拒绝/设备切换/隐藏窗口/打断/退出重启均可恢复 |
| 发布 | 干净 Windows/macOS 机器的 Python/依赖/模型资源、许可证、签名、首次设置与升级保留数据；源码存在不等于安装包可用 |

已有离线参考包括 `asr-fake.test.ts`、`voice-turn.test.ts`、`tts-player.test.ts` 和 `speech-sync.test.ts`；涉及 sidecar 的测试还依赖 Python 与本机服务环境。`asr-whisper-live.test.ts`、`tts-free-live.test.ts` 是显式 live 测试，不包含在当前默认套件中，也没有在本次分享任务中运行。后续验证命令由任务实现者按实际依赖列出，不把旧检查记录当成本轮通过。

## 完成状态

本次完成：核对既有源码、标出接线缺口、制定并行任务/所有权/依赖和验收标准，并上传仓库。

待实施：语音任务认领、共享合同落地、两种桌面入口挂接、真实 provider 和设备验证、用户试听及安装包验收。本文不表示已启动这些开发任务或完成原生语音联调。
