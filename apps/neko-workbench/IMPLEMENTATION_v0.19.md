# v0.19 · 两套像素 Q 版可选形象

日期：2026-10-27（Asia/Shanghai）。范围为可选工作台及其测试。

## 选择与保存

新增 `claude-pixel`（Claude 娘 · 像素 Q 版）和 `gemini-pixel`（Gemini 小猫 · 像素 Q 版）。主 agent、中号任务角色（用户所称 subsection）、小号 subagent 均通过各自右键 → 形象选择；主角色菜单 → 设置提供三类默认值。原有四种形象与自定义导入继续可选，旧存档无需迁移或更改现有选择。

单只覆盖、跟随默认、40%～100% 尺寸以及右上方前三字名字沿用现有逻辑。源图保持原像素比例，显示时仅隐藏所有动作共用的纯透明外边：Claude 使用 170×187 可见窗口，Gemini 使用 164×165。角色比例与落脚线在动作切换时保持一致，名字、头顶输入与回复根据各动作的实际头顶位置靠拢；拖拽、减少动态效果和静帧回退也同步更新。模型、会话、真实任务身份、记忆及三档尺寸关系不由形象选择改变。

## 素材来源与解码

来源为 [Hjh-12138/DSH-Pixel-Toons](https://github.com/Hjh-12138/DSH-Pixel-Toons)，固定提交 `973c6bdbeffd272e2bc35f7065ba2f7d42fbe7e8`。角色包分别为 `examples/character-packs/orange-flower.toons.zip` 和 `purple-star-cat.toons.zip`，本地源包 Git blob 已与该提交的 GitHub tree 核对。

按源包 manifest 中的原始矩形与时长，将九组 PNG 帧无损编码为 WebP：idle、think、search、read、type、check、success、failed、walk-left。每套九个动图，每个 256×256、8 个不同帧、125 毫秒/帧，总时长 1 秒、无限循环。解码后逐帧核对可见 RGBA 与原始 PNG 一致，没有生成、重绘或拉伸角色。每套 still.png 为 idle 第 0 帧，仅用于减少动态效果与加载失败回退。

`assets/pixel-ai-girls/SOURCE.json` 保留源包 Git blob/SHA-256、源 manifest、每个生成文件的哈希、帧数与时长；目录同时保留上游原始 LICENSE 和 THIRD_PARTY_NOTICES。角色为非官方同人形象，相关名称与第三方权利按上游声明保留。没有安装或运行上游插件及其脚本。

## 状态联动

| 当前状态 | 动作 |
| --- | --- |
| 空闲 | idle |
| thinking | think |
| working / 执行中 | type |
| result / 检查工具结果 | check |
| waiting / 停止中 | read |
| success | success |
| error | failed |
| 拖拽 | walk-left |

search 动作随原始完整动作包保留；当前六档工作状态没有独立的搜索档位。相同状态广播不会重复重置动画。主角色普通聊天也使用其实际工作状态切换媒体。

## 验证

- 形象、三档布局与真实主入口针对性测试：23 项通过。实际主入口 harness 覆盖三类角色的两套选择、三个默认值、存档保存、单只覆盖及任务身份晋升后保留形象。
- 默认完整回归：413 项，408 通过，5 项 Windows 专项跳过，0 失败。
- 54 个源文件语法检查与三个主题 smoke 通过。
- 18 个 WebP 的帧数、125 毫秒帧时长、无限循环、固定文件哈希以及来源声明均有自动检查。减少动态效果、加载失败与原有形象切回也有覆盖。
- 全部 144 帧均检查过可见边界，显示裁去的区域仅含透明像素。
- macOS 当前工作台主角色已实际切换并显示两套新动画，右上角三字标签、头顶已有回复和紧凑比例均保留；三类默认形象菜单均出现新选项。中号任务与子代理的选择、保存、继承和身份晋升由实际主入口 harness 验证；本轮没有新建付费模型任务。

上述检查不构成 Windows 桌面或新的在线模型/语音能力验收。
