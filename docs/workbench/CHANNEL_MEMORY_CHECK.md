# B 站 / QQBot → 主角色记忆检查（接入前基线，2026-11-03）



检查对象是 `codex/nekofuns-0.28.37-creation-installer-20261103` 的 0.28.37 源码及本地修复。以下结论区分代码路径和离线模拟验证；没有登录真实 B 站 / QQ、发送消息或发起付费模型请求。

| 检查项 | 当前结论 | 依据 |
| --- | --- | --- |
| B 站养鱼启动、暂停、取消与账号门控 | 本地模拟覆盖通过 | `fish-care.test.cjs`、`fish-qq-coordinator.test.cjs` |
| B 站经历保存 | 调度器指导生活会话写独立日记，未验证真实写入 | `vendor/dsh-bili-whale/lib/scheduler.js` 使用 `whale-diary.md` / `whale-diary-private.md` |
| B 站经历进入主角色 N.E.K.O. 记忆 | 未接通 | 主入口接收 `fish-care-state` 后仅更新状态；当前记忆控制器没有扫描这两本日记的入口 |
| QQBot 生命周期、暂停围栏、聊天策略 | 本地模拟覆盖通过 | `qqbot-lifecycle.test.cjs`、`qqbot-chat-policy.test.cjs` |
| QQ 内容进入主角色记忆 | 未接通 | QQ 使用独立会话；`chat-policy.cjs` 明确不声称同步桌宠/B站/其他会话记忆；主入口只接收 QQ 状态投影 |
| 主角色记忆写入与召回的基础通道 | 大厅经历的模拟写入、去重、重启与召回覆盖通过 | `memory-shared-experience.test.mjs`；`recordSharedExperience()` 只接受 `lobby-msg:` 来源，不接受 B站/QQ 来源 |
| 根据 B站/QQ 经历主动向主人搭话 | 未接通 | 渠道经历没有进入主角色记忆，也没有渠道经历触发主角色发言的调度器；记忆召回本身不会主动发送消息 |

测试命令：

```text
node --test tests/neko-workbench/fish-care.test.cjs tests/neko-workbench/fish-qq-coordinator.test.cjs tests/neko-workbench/fish-qq-main.test.cjs tests/neko-workbench/qqbot-lifecycle.test.cjs tests/neko-workbench/qqbot-chat-policy.test.cjs tests/neko-workbench/memory-shared-experience.test.mjs
```

结果：62 项中 60 项通过、2 项失败。两项失败来自 `fish-qq-main.test.cjs` 的完整主入口夹具，在临时目录清理时报 `EPERM`；放宽执行沙箱后重试仍有相同错误，因此不能将完整主入口集成检查报告为通过。渠道模拟通过也不能等同于真实账号收发或端到端记忆验收。

若后续接通，需要为真实渠道经历增加带来源 ID、时间、角色和私密范围的独立写入入口及去重/删除规则，再为桌面搭话增加可关闭的触发、忙碌检查与频率限制。不能把 QQ 群友的发言自动当作主人偏好，也不能把私聊内容扩散到 B 站或群聊。本次只测试并记录断点，未自动开启此类同步或主动发送行为。
