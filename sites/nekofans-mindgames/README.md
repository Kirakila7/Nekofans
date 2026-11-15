# Nekofans.Game

玩家原创的智斗游戏与规则交流站。首位创作者 A.kira 的《开源与抹除》和两条原创规则作为首发内容。

## 功能

- 游戏与规则浏览、分类、搜索、详情及规则复制。
- 本机收藏，保存于当前浏览器。
- ChatGPT 登录后投稿游戏、原型、玩法概念及规则；D1 保存投稿，作者可删除自己的投稿。
- 署名由创作者填写，作品阶段与游戏链接分别呈现。
- 三段实机素材与原创角色概念图。当前没有公开可玩的完整对局链接。

## 开发

Node 22.13+。npm run dev -- --hostname 127.0.0.1 --port 5487
npm run db:generate 生成后续数据库迁移；生产发布由 Sites 工作流完成。
使用 db/schema.ts、drizzle/ 的迁移，不在请求中创建表。

站点名称不表示已经持有 nekofans.game 域名。当前 Sites 地址由 .openai/hosting.json 的项目绑定。
