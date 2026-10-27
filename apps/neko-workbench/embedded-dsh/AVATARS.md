# v0.11 头像素材

本版五个内置头像放在 `assets/avatars/`：`yui.webp`、`devcat.webp`、`bigfish.webp`、`claude.webp`、`gemini.webp`。它们是 256px、带透明通道的头像导出；母图为同目录 `atlas-source.png`。

大肥鱼、Gemini、Claude 使用用户本轮提供的原图作为造型和画风依据，原开发项目中的参考图未随本仓库快照导入；本目录仅保留生成的最终头像及来源记录。Gemini 是紫发异色瞳猫娘，Claude 是长橙发女仆；最早画成普通小猫和短棕发的版本已弃用，不参与界面。

首页五头像采用无框扇形布局；左上角保留可切换头像与上传入口。头像选择只影响外观，不切换真实模型、角色档案或记忆。

使用 `node b0-skin/packages/dsh-client-ui-white-label/scripts/embed-avatars.mjs assets/avatars` 重新嵌入五张头像；脚本会检查五张齐全、类型和单图大小，再执行插件 smoke。v0.10 的单头像 `neko-hero.webp` 与旧 HANDOFF 作为历史来源保留，本版不使用旧 HERO_ART。

上传的自定义头像在主进程内裁切、缩小并保存到 `data/workbench-appearance.json`；它不进入源码 ZIP。用户手动选择“连接 N.E.K.O.”之前，不会因更换头像启动聊天连接。
