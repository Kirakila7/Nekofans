# N.E.K.O. 免费语音（工作台实验）

在主角色「聊天 API 设置」中开启 N.E.K.O. 免费语音后，已完成的主角色回复会发送到 N.E.K.O. 的 `free` 语音服务并播放。默认关闭；设置页可停止朗读，开始下一次主角色对话也会停止当前播放。子代理和工作任务不自动朗读。本功能只涉及回复的语音合成，不包含语音输入或语音识别。

语音合成需要联网，服务可能有用量、连接频率或并发限制。开启前请注意：角色回复文本会发送至语音服务。模型聊天与语音合成分别由各自的服务处理。

## 开发运行依赖

需要 Python 3.12 及 `numpy`、`soxr`、`websockets`。例如在 Windows 源码目录建立独立虚拟环境：

```powershell
py -3.12 -m venv .venv-tts
.\.venv-tts\Scripts\python.exe -m pip install "numpy>=1.26,<3" "soxr>=0.3,<1" "websockets>=14,<16"
$env:NEKO_TTS_PYTHON = (Resolve-Path .\.venv-tts\Scripts\python.exe).Path
npm run start:neko
```

其他平台可将 `NEKO_TTS_PYTHON` 指向对应虚拟环境的 Python。未显式设置时，启动器尝试记忆服务的本地虚拟环境，再尝试 PATH 中的 `python`。该环境仍需安装上述语音依赖。缺少依赖或语音服务不可用时会提示失败，不会播放测试音代替角色声音。

运行资源和安装包尚未包含或验收独立语音 Python 环境。用户需要自行配置；不能把源码接入当作便携包开箱即用。

## 安全与生命周期

工作台通过私有进程标准输入输出连接仓库固定的 N.E.K.O. `free` worker；不开放未鉴权的本地 WebSocket。仅主角色窗口可以请求朗读当前已完成的回复。每次朗读使用独立进程；停止、下一回合和退出会结束该进程并丢弃迟到音频。文字聊天与记忆的现有写入逻辑保持不变。

## 验证边界

Node 离线测试覆盖请求来源、PCM 排队播放、停止、迟到事件、进程错误和语音开关。固定上游 worker 可用模拟 WebSocket 验证消息顺序与 PCM 输出。实际免费服务连通、听感、设备与浏览器自动播放策略、完整桌面体验和 Windows/macOS 安装升级仍需实机验收。

```powershell
node --test tests/neko-workbench/tts-guard.test.cjs tests/neko-workbench/tts-player.test.cjs tests/neko-workbench/tts-runtime.test.cjs tests/neko-workbench/tts-settings.test.cjs
.\.venv-tts\Scripts\python.exe tests/neko-workbench/tts-worker.test.py
```

界面测试需要可解析的 `jsdom`；缺少时测试会明确跳过。
