# 第三方代码与角色素材

根目录 Apache-2.0 许可证仅适用于本项目拥有授权权利的代码和修改。以下组件、素材及其衍生内容继续遵循原许可证；请同时保留对应目录内的完整声明。

| 范围 | 上游项目或素材来源 | 许可或说明 | 仓库内原始声明 |
| --- | --- | --- | --- |
| 大肥鱼动画与角色 | [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)、[素材所用提交](https://github.com/PC2005-cloud/dsh-pet/commit/dfc03961bdb4d26898838cb72c9c2ac09699b1e2)、[角色原授权声明](https://www.bilibili.com/opus/1247156596114456581) | 原作者允许开源非商用；角色形象为 CC BY-NC-SA 4.0，详情以原声明为准 | [素材署名](assets/ATTRIBUTION.md)、[dsh-pet 许可](apps/neko-workbench/assets/LICENSE.dsh-pet) |
| AI 娘美术 | [chatgpt-chibi-pets](https://github.com/fywdy/chatgpt-chibi-pets) | CC BY-NC 4.0；非官方同人，商标权不随美术许可转让 | [许可](apps/neko-workbench/assets/ai-girls/LICENSE)、[同人声明](apps/neko-workbench/assets/ai-girls/NOTICE.md) |
| 像素 AI 娘 | [DSH-Pixel-Toons](https://github.com/Hjh-12138/DSH-Pixel-Toons) | 按素材目录许可与署名使用 | [许可](apps/neko-workbench/assets/pixel-ai-girls/LICENSE)、[声明](apps/neko-workbench/assets/pixel-ai-girls/THIRD_PARTY_NOTICES.md) |
| Project N.E.K.O. 角色与记忆、语音代码 | [Project N.E.K.O.](https://github.com/Project-N-E-K-O/N.E.K.O) | Apache-2.0；保留原作者、NOTICE 与子组件声明 | [角色许可](apps/neko-workbench/assets/neko-cat/LICENSE.N.E.K.O)、[记忆组件 NOTICE](services/neko-memory/vendor/NOTICE)、[ASR NOTICE](services/neko-asr/vendor/NOTICE)、[TTS NOTICE](services/neko-tts/vendor/NOTICE) |
| B 站渠道适配 | [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) | MIT；额外依赖保留原许可 | [许可](apps/neko-workbench/vendor/dsh-bili-whale/LICENSE)、[声明](apps/neko-workbench/vendor/dsh-bili-whale/NOTICE.md)、[依赖声明](apps/neko-workbench/vendor/dsh-bili-whale/deps/NOTICE.txt) |
| QQBot 上游组件 | [Tencent Connect dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) | MIT，Tencent Connect | [上游许可](apps/neko-workbench/vendor/dsh-qqbot-workbench/upstream/LICENSE)、[测试夹具许可](tests/neko-workbench/fixtures/qqbot-sdk-access-policy.LICENSE) |
| LiveKit、TRTC 等实时通信组件 | [LiveKit JS SDK](https://github.com/livekit/client-sdk-js)、[TRTC Web SDK](https://github.com/Tencent-RTC/TRTC_Web) | 各自目录内的原许可证 | [通信组件声明](apps/neko-workbench/visits/vendor/THIRD_PARTY_NOTICES.md) |

Electron、Node.js、[DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)、Python 与其它构建运行资源按各自发行包的许可分发。源码仓库不包含这些完整二进制运行环境；制作安装包时仍须核对实际打包清单并保留它们的许可证。对某个供应商提供调用接口，不等于获得该供应商商标、角色或服务的授权。

历史代码与素材贡献保留在 Git 提交记录及其原有声明中。若发现遗漏，请在不上传秘密资料的前提下提交 Issue，以补充或更正署名。
