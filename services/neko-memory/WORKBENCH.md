# 独立 N.E.K.O. 记忆服务（Windows）

此功能目前为可选项。它为主角色 Chat API 聊天检索相关记忆，并将完成的对话交给 N.E.K.O. 后台整理。DSH 与 Codex 会话不使用此记忆。独立数据保存在工作台数据目录的 `neko-memory` 下，原有 YUI 记忆不会自动导入。

在 Windows 上使用 Python 3.12（64 位）建立虚拟环境，并在仓库根目录执行：

```powershell
py -3.12 -m venv .venv-neko-memory
.\.venv-neko-memory\Scripts\python.exe -m pip install -r services\neko-memory\requirements.lock psutil==7.2.2
$env:NEKO_MEMORY_PYTHON = (Resolve-Path .\.venv-neko-memory\Scripts\python.exe).Path
$env:NEKO_WORKBENCH_MEMORY = 'neko'
```

然后从同一终端按项目现有方式启动工作台。Windows 便携发行版也可以在发行版根目录放置 `memory-runtime\python.exe` 和 `memory-python-libs`；无需设置 `NEKO_MEMORY_PYTHON`。主角色的聊天模型仍需在聊天设置中单独配置。

记忆整理使用 N.E.K.O. 官方免费模型，需要联网并会将相关对话发送到官方服务。记忆列表目前只读。写入结果不确定的对话会保存在本地待确认队列，不自动重复提交。退出工作台时后台服务会关闭。
