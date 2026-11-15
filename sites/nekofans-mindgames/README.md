# Nekofans.Game

玩家原创的智斗游戏与规则交流站。首位创作者 A.kira 的《开源与抹除》和两条原创规则作为首发内容。

## 功能

- 游戏与规则浏览、分类、搜索、详情及规则复制。
- 本机收藏，保存于当前浏览器。
- ChatGPT 登录后投稿游戏、原型、玩法概念及规则；D1 保存投稿，作者可删除自己的投稿。
- 署名保护：A.kira 为首发展示专属署名；普通投稿由创作者如实填写自身署名。
- 三段实机录屏演示素材与原创角色概念图。当前展示玩法概念与界面实录，尚未提供公开可玩的完整对局链接。

## 开发与测试

- Node 22.13+
- 本地开发：`npm run dev`
- 单元测试：`npm test`（运行 `node --test test/*.test.mjs`）
- 生产构建：`npm run build`
- 数据库迁移：`npm run db:generate`，使用 `db/schema.ts` 与 `drizzle/` 迁移文件。

站点名称不表示已经持有 nekofans.game 域名。当前 Sites 地址由 `.openai/hosting.json` 的项目绑定。
