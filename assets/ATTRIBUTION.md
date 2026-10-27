# 视频素材署名

## assets/webm/dsh-pet/（真实素材，默认使用）

- 来源仓库：https://github.com/PC2005-cloud/dsh-pet
- 固定 commit：`dfc03961bdb4d26898838cb72c9c2ac09699b1e2`（2026-10-25，PC2005-cloud）
- 仓库内路径：`dsh-pet/assets/webm/`
- 下载方式：`tools/fetch-dsh-pet-webm.sh`，从 `https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/<commit>/dsh-pet/assets/webm/<名称>.webm` 获取，并按该 commit 树里的 git blob SHA-1 校验
- 文件未做任何修改（未转码、未裁剪）

| 文件 | blob SHA-1 | 最后修改的 commit |
|---|---|---|
| 待机呼吸休闲.webm | fd64a428a2be1d3b4ff6cd7f9867dfe978ba0bbb | 9097f8cc（sunkeycn，2026-08-25） |
| 被鼠标拖拽悬空反馈.webm | 728f04b2997aa9ec4bdb87d1b9b14d7910bc7fd6 | 9097f8cc（sunkeycn，2026-08-25） |
| 工作状态-思考冒泡.webm | 51bc3bb2fb894e6f1499974d62a3d93592f91859 | 903dfde2（PC2005-cloud，2026-09-05） |
| 工作状态-忙碌点按.webm | 32bc6dbf65a7f1afa403520c3dd37980ca353e5f | 903dfde2（PC2005-cloud，2026-09-05） |
| 工作状态-原地踱步张望.webm | 7b9459a1efdf4155f5ddd3beb07936fcc5c8a7ed | 903dfde2（PC2005-cloud，2026-09-05） |
| 工作状态-雀跃庆祝.webm | edd6645a8ee9b222c720fb20cfff3b715e92db9b | 903dfde2（PC2005-cloud，2026-09-05） |
| 工作状态-垂头叹气冒汗.webm | 653ef82b71d52faa1d26a014afb7764f778926f7 | 903dfde2（PC2005-cloud，2026-09-05） |
| 碎碎念-对屏碎碎念.webm | 8b7b357f01a9e5cf733dce28f32e8f94be4a030d | 7a557cd9（PC2005-cloud，2026-08-30） |
| 碎碎念-发呆碎碎念.webm | 4afcaf7459e3b27b30252648b388e9cd3296807f | 7a557cd9（PC2005-cloud，2026-08-30） |
| 碎碎念-擦桌碎碎念.webm | 343513cf0d5583b5f476080d5082f3f5e01588b8 | 7a557cd9（PC2005-cloud，2026-08-30） |

### 作者与许可（摘自 dsh-pet README「许可」一节）

- 项目与动画素材：dsh-pet，作者 PC2005-cloud（https://github.com/PC2005-cloud/dsh-pet）。代码为 MIT；素材（动画、提示词、源视频）允许开源使用，禁止商用。衍生作品须在公开渠道附上原作者 GitHub 地址。
- 角色形象：社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），不是 DeepSeek 官方形象。原型「溟月」出自 B 站 @上善无形（https://space.bilibili.com/4456176），DeepSeek 版（女仆鲸鱼娘）设计出自 B 站 @ZipZipPipe（https://space.bilibili.com/4168597）。
- 形象授权：CC BY-NC-SA 4.0（署名、非商业、相同方式共享），https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans ，声明原文：https://www.bilibili.com/opus/1247156596114456581
- 本沙箱仅用于开源非商用的验证。若对这些片段做修改后再分发，修改版须同样以 CC BY-NC-SA 4.0 发布。

## assets/webm/*.webm（占位素材）

`idle`、`speaking`、`thinking`、`working`、`success`、`dragging` 由 `tools/gen-placeholder-webm.sh` 用 ffmpeg 生成，不含第三方内容。通过 `index.html?clips=placeholder` 或 `F04_CLIPS=placeholder npm run e2e` 使用。
