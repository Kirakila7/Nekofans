# Nekofans 双人隐藏规则棋局 · 本地服务协议（v0.1）

本原型是**本地单机服务 + 三个浏览器席位**：白方、黑方、女神各打开一个页面。
服务端是唯一权威：棋盘状态、合法走子、规则状态、猜测与裁决都由服务端持有；
每个席位只拿到**自己权限范围内**的状态投影。

> 安全边界：服务只监听 `127.0.0.1`，不提供公网入口，不连接外部服务，不执行任何
> 用户提交的代码。女神只能通过下列**结构化操作**修改房间状态，服务端逐项校验。

## 1. 房间与席位

创建房间后得到三条带私密令牌的链接：

| 链接 | 角色 | 能看到 |
| --- | --- | --- |
| `/room/<id>?token=<白方令牌>` | 白方玩家 | 公共棋盘、自己的规则原文、自己的猜测、公开公告 |
| `/room/<id>?token=<黑方令牌>` | 黑方玩家 | 同上（黑方视角） |
| `/room/<id>?token=<女神令牌>` | 女神 | 双方规则原文、全部猜测、事件日志、所有受控操作 |

- 棋盘与公开画面**只显示“白方/黑方”**，不显示任何角色姓名。
- 对手的规则文本、备注、猜测文本**永远不会**出现在玩家状态里；只有“是否已提交/是否已生效”这类状态位。
- 规则揭晓（`revealedAt`）是显式动作：女神揭晓，或“猜中规则”判定成功时自动揭晓双方规则；揭晓后双方都能看到规则原文。
- 令牌通过 URL 查询参数传递，进入页面后前端会把它存到该标签页的 `sessionStorage` 并从地址栏移除，避免录屏露出。

## 2. 状态投影（`GET /api/rooms/:id/state`，SSE 同结构）

```jsonc
{
  "roomId": "r-1a2b3c4d",
  "version": 12,
  "role": "player",              // "player" | "goddess"
  "seat": "white",               // "white" | "black" | null
  "phase": "lobby",              // "lobby" | "playing" | "paused" | "finished"
  "createdAt": 0,
  "updatedAt": 0,
  "game": {
    "fen": "rnbqkbnr/... w KQkq - 0 1",
    "turn": "w",
    "ply": 4,
    "inCheck": false,
    "checkmate": false,
    "stalemate": false,
    "draw": false,
    "legalMoves": [{ "from": "e2", "to": "e4", "promotion": null }],
    "lastMove": null,            // moveWire
    "pendingMove": null,         // 等待女神核准的走子（见下）
    "moves": [],                 // 已生效的公开走子（moveWire[]）
    "result": null,              // { winner, reason, note, at } | null
    "reviewMode": true,
    "guessLimit": 3
  },
  "players": {
    "white": {
      "connected": true,
      "rule": { "submitted": true, "status": "submitted" },  // 无文本
      "guess": { "used": 0, "pending": false }
    },
    "black": { }
  },
  "me": {                        // role=player 时存在，否则 null
    "seat": "white",
    "color": "w",
    "rule": {
      "status": "empty|submitted|active|returned", "revealed": false,
      "text": null,              // 仅自己的规则原文
      "note": null,              // 女神“退回修改”的说明（仅自己可见）
      "updatedAt": null
    },
    "guesses": [                 // 仅自己的猜测
      { "id": "g1", "text": "...", "status": "pending|correct|wrong|void", "note": null, "at": 0 }
    ],
    "attemptsUsed": 0,
    "attemptsLeft": 3,           // null 表示不限次数（guessLimit=0）
    "canMove": false,
    "canGuess": true,
    "canSubmitRule": false,
    "canCancelPending": false,
    "lastRejection": null        // { label, reason, at } 最近一次被驳回的走子
  },
  "goddess": null,               // role=goddess 时见下
  "announcements": [ { "id": "a1", "text": "...", "at": 0 } ],
  "revealed": {                  // 已揭晓的规则；未揭晓为 null
    "white": { "text": "...", "revealedAt": 0 },
    "black": null
  }
}
```

### 女神专属投影（`goddess` 字段）

```jsonc
{
  "rules": {
    "white": { "text": "…", "status": "active", "note": null, "updatedAt": 0, "revealedAt": null },
    "black": { }
  },
  "guesses": [ { "id": "g1", "seat": "black", "text": "…", "status": "pending", "note": null, "at": 0 } ],
  "settings": { "reviewMode": true, "guessLimit": 3 },
  "events": [ { "id": 1, "seq": 1, "type": "move_played", "at": 0, "text": "白方走子：e2→e4" } ],
  "links": { "white": "http://127.0.0.1:8787/room/r-…?token=…", "black": "…", "goddess": "…" }
}
```

### `moveWire`

```jsonc
{
  "id": "m3",
  "ply": 3,
  "color": "w",                 // 'w' | 'b'
  "seat": "white",
  "from": "g1", "to": "f3",
  "promotion": null,
  "piece": "N",                 // 'P','N','B','R','Q','K'（大写表示白）
  "captured": null,             // 被吃棋子字母，如 "p"
  "flags": { "castle": null, "enPassant": false, "doublePush": false },
  "label": "Ng1–f3",            // 服务端生成的展示文本
  "by": "player",               // "player" | "goddess"
  "at": 0
}
```

`pendingMove` 额外带 `seat`、`color`、`label`，其余字段同 `moveWire`（`by` 仍为 `"player"`，用 `game.pendingMove.id` 做裁决）。

## 3. HTTP API

约定：

- 所有接口返回 JSON；成功为 `{ "ok": true, "state": <调用者视角状态> }`（创建房间接口除外）。
- 失败为 `{ "ok": false, "error": "中文说明", "code": "machine_code" }`，HTTP 4xx/5xx。
- 写接口都需要 `?token=<令牌>`；令牌角色决定权限，越权返回 `403 forbidden`。
- 请求体 JSON ≤ 64KB（超限返回 `413` JSON）；文本字段会去除不可见控制字符（保留换行）并限制长度。
- 女神的结构化操作只能通过固定接口名 + 固定字段执行，服务端做权限/阶段/轮次/合法性校验；**没有任何执行任意代码、读写文件或访问网络的入口**。

### 3.1 房间

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/rooms` | 创建房间。body `{ "guessLimit": 3, "reviewMode": true, "scenario": "story-v1"? }`（均可选；`scenario` 为剧情场景）。返回 `{ ok, roomId, links:{white,black,goddess} }` |
| `GET` | `/api/rooms/:id/state` | 取当前席位状态投影 |
| `GET` | `/api/rooms/:id/stream` | SSE：`event: state`，每次变更推送调用者视角完整状态；15 秒心跳 |
| `GET` | `/api/rooms/:id/export` | 仅女神：导出房间全量 JSON（含规则、猜测、事件、走子记录） |
| `GET` | `/api/health` | `{ ok: true }` |

### 3.2 玩家操作（需白方或黑方令牌，且只能操作自己的席位）

| 方法 | 路径 | body | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/rooms/:id/special` | `{ "type":"p|n|b|r|q", "from":"a1", "to":"b3", "promotion"? }` | 使用公开行动，替代本回合普通走子；服务端校验类型、几何/路径、吃子、王安全、升变与终局。 |
| `POST` | `/api/rooms/:id/extra` | `{ "target":"e1", "name":"…" }` | 拥有私密行动的席位使用；端点/标签/确认文案由该席位状态 `me.story.privateAction` 下发。**不替代普通走子**，成功/失败都不改变轮次；每回合一次。返回 `{ ok, result:"success"|"failed", state }`。 |
| `GET` | `/api/rooms/:id/teammate/view` | — | 仅 A 方令牌：返回大肥鱼的脱敏视图（本方规则、公共棋盘/共享池/脱敏事件、合法普通走子、共享池动作、自己的猜测）；不含 B 规则、真名、B 猜测、女神字段。 |
| `POST` | `/api/rooms/:id/teammate/guess` | `{ "text":"…" }` | 仅 A 方令牌：以 A 席位提交对 B 规则的猜测（同 `/guess` 次数限制）。 |
| `POST` | `/api/rooms/:id/teammate/decide` | `{}` | 仅 A 方令牌：触发受控适配器；服务端生成白名单 context，模型只能从合法动作/猜测中选择；返回后服务端二次校验版本/轮次/动作/次数再应用。失败、超时、中断不自动走子。 |



| 方法 | 路径 | body | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/rooms/:id/rule` | `{ "text": "…" }` | 提交自己的隐藏规则（仅 `lobby` 阶段，状态 `empty`/`returned` 可提交；1–400 字） |
| `POST` | `/api/rooms/:id/move` | `{ "from": "e2", "to": "e4", "promotion": null }` | 请求走子。`reviewMode=true` 时进入女神待裁决；否则立即生效。非法/越序/非己方回合/有待裁决走子时拒绝 |
| `POST` | `/api/rooms/:id/move/cancel` | `{}` | 撤回自己尚未裁决的走子 |
| `POST` | `/api/rooms/:id/guess` | `{ "text": "…" }` | 提交对对手隐藏规则的猜测（1–300 字；每次提交消耗一次机会；有未裁决猜测时拒绝） |

### 3.3 女神受控操作（需女神令牌）

| 方法 | 路径 | body | 说明 |
| --- | --- | --- | --- |
| `POST` | `/api/rooms/:id/goddess/rule` | `{ "seat":"white|black", "action":"approve|return|edit|reveal", "text"?:"…", "note"?:"…" }` | `approve`：规则生效（仅 lobby）；`return`：退回该方修改并附说明；`edit`：修正文字（仅 lobby，状态不能是 empty）；`reveal`：揭晓该方规则 |
| `POST` | `/api/rooms/:id/goddess/start` | `{}` | 双方规则均为 `active` 后开始对局（lobby→playing） |
| `POST` | `/api/rooms/:id/goddess/review` | `{ "moveId":"m3", "decision":"approve|reject", "note"?:"…" }` | 核准/驳回待裁决走子；驳回须给玩家可见说明 |
| `POST` | `/api/rooms/:id/goddess/force-move` | `{ "from":"e7", "to":"e5", "promotion":null, "note"?:"…" }` | 女神代走一步（必须是当前合法走法；不能有待裁决走子） |
| `POST` | `/api/rooms/:id/goddess/edit-board` | 见下 | 受控棋盘修改：移除/放置棋子、设置行棋方 |
| `POST` | `/api/rooms/:id/goddess/undo` | `{}` | 撤销上一步已生效走子/棋盘修改（不能撤销猜中判定；揭晓后不可撤销自动终局） |
| `POST` | `/api/rooms/:id/goddess/pause` | `{ "paused": true }` | 暂停/继续（有未裁决走子时不能暂停） |
| `POST` | `/api/rooms/:id/goddess/end` | `{ "winner":"white|black|draw", "reason":"resign|goddess|agreement|abort", "note"?:"…" }` | 结束对局 |
| `POST` | `/api/rooms/:id/goddess/judge-guess` | `{ "guessId":"g1", "correct":true, "note"?:"…" }` | 裁定猜测；`correct=true` 时猜测方获胜、对局结束并自动揭晓双方规则 |
| `POST` | `/api/rooms/:id/goddess/settings` | `{ "reviewMode": true, "guessLimit": 3 }` | 修改逐手审核开关 / 猜测次数上限（0=不限） |
| `POST` | `/api/rooms/:id/goddess/announce` | `{ "text":"…" }` | 发一条双方可见的公开公告（≤300 字；女神自行负责不泄露规则） |
| `POST` | `/api/rooms/:id/goddess/reset` | `{}` | 重开一局：回到 lobby、清空规则/猜测/走子/公告，保留令牌与设置 |
| `POST` | `/api/rooms/:id/goddess/private-field` | `{ "square":"b1", "name":"…", "alias"?:"…" }` | 女神配置私密名称（跟随棋子身份）；仅女神可见，玩家投影绝不包含 |

#### `edit-board` 操作（结构化、可校验）

```jsonc
{ "op": "remove",  "square": "e5", "note": "抹除 e5 上的黑兵" }
{ "op": "place",   "square": "e5", "type": "p|n|b|r|q|k", "color": "w|b", "note": "…" }
{ "op": "setTurn", "turn": "w|b", "note": "…" }
```

服务端校验：阶段为 playing/paused、无待裁决走子、目标格状态正确、双方王各恰好一枚、
兵不能放在第 1/8 横线、易位权与王/车实际位置一致、行棋方以外的一方不能处于被将军状态；
每次修改写入事件日志与快照（可撤销）。

## 4. 阶段与判定

- `lobby`：双方提交规则 → 女神逐个 `approve` → `start`。
- `playing`：走子（可逐手审核）、猜测、女神操作。
- `paused`：暂停，玩家不能走子/猜测；女神仍可结束/揭晓/重开。
- `finished`：终局冻结；`result` 给出胜方与原因。
- 走子后由服务端引擎自动判定将死/逼和/子力不足/三次重复/五十回合等，并结束对局（不自动揭晓规则）。
- 猜中规则：猜测方获胜，对局结束，自动揭晓双方规则。
- 错误猜测：消耗一次机会，无其他惩罚（`guessLimit` 默认 3，可配置；0 为不限）。机会耗尽后不能再猜，仍可靠棋局取胜。
- 被驳回的走子不计入走子记录，只在该玩家视角的 `me.lastRejection` 中显示。

## 5. 隐私红线（服务端实现，测试覆盖）

1. 玩家状态 JSON（含 SSE 每条消息）不得出现对手规则原文、备注、猜测原文；也不得出现女神专属字段。
2. 只有 `revealed[side]` 非空时，双方才获得该方规则原文。
3. 女神令牌才能读 `goddess.rules`、全部猜测、事件日志与导出接口。
4. 女神链接只出现在创建房间响应和女神视角；不写入玩家页面。
5. 前端不把令牌写进 `localStorage`（仅本标签页 `sessionStorage`），并尽量从地址栏移除。


## 6. 剧情模式 `story-v1`（P1/P2/P3 已实现；P4 受控决策接口见第 8 节）

创建房间时 body 增加 `"scenario":"story-v1"`。该模式在标准国际象棋之上增加：

- A（白）「开源」：退场棋子（被吃/被抹除）的**原始普通走法**进入双方共享池（去重集合：`p/n/b/r/q`，王不入池）。
  轮到自己时可以用一枚己方棋子使用池中的一种走法，**代替**本回合普通走子；服务端完整校验几何、路径、吃子、
  王安全、升变与将死/逼和（若标准将死但存在合法共享走法，不终局）。
- B（黑）「抹除笔记」：自己回合可以尝试一次真名抹除，`target` 为对方棋子所在格、`name` 为输入的名字。
  **不替代本回合普通走子**；成功/失败都不切换轮次。正确真名 → 目标退场（其原始走法入池）；错误名字 → 无棋盘变化。
  每回合只能尝试一次。目标为对方王且真名正确时，默认 B 立即获胜（`result.reason="erase-king"`）。
- 真名由女神配置并跟随棋子（移动/吃子/易位/升变/撤销/改盘后仍绑定同一棋子身份）；默认场景白王真名
  `梁文峰`、公开误称 `梁武帝`，所以输入“梁武帝”会失败。真名只出现在女神投影与女神导出中。
- 猜中对方规则仍然直接判胜并揭晓双方规则（与基础模式一致）。

### 6.1 状态投影增补

```jsonc
// game.story（公共；无真名）
{
  "enabled": true,
  "special": [ { "type": "n", "label": "马", "glyph": "♞" } ],
  "events": [ { "seq": 1, "kind": "board-change", "change": "piece-removed", "square": "b1" } ],
  "lastAction": { }
}

// me.story（本席私有；无私密行动的席位不含 privateAction）
{
  "abilityLabel": "本席服务端下发",
  "abilityHelp": "本席服务端下发",
  "canSpecial": true,
  "specialActions": [ { "type":"n", "label":"…", "from":"a1", "to":"b3", "capture":false, "promotion":null } ],
  "privateAction": { "endpoint":"/extra", "label":"本席下发", "canUse":true, "used":false, "attempts":[] }
}
// 注意：无私密行动的席位（A）不返回 privateAction；A 的投影不包含 B 的任何字段/文案。

// me.teammate（仅 story 玩家投影；A 为受控适配器状态，B 为对方由人操作）
{
  "available": false,
  "configured": false,
  "mode": "unavailable",        // unavailable | synthetic | http
  "purpose": "game-player",
  "label": "未接入真实模型",     // B: "对方由人操作"
  "calls": 0,
  "maxCalls": 20,
  "maxConcurrent": 1,
  "note": "预留适配器：当前没有模型调用；可由人工以 A 席位代填或提交猜测。"
}

// goddess.adapter（仅女神；默认未接入，独立 purpose，不复用 A 会话）
{
  "available": false,
  "purpose": "game-goddess",
  "mode": "unavailable",
  "label": "女神决策适配器未接入"
}

// goddess.story（仅女神）
{
  "abilities": { "white":"open-source", "black":"erase-note" },
  "poolTypes": ["p","n","b","r","q"],
  "abilityText": { "white": { "label": "本席下发", "help": "…" }, "black": { "label": "本席下发", "help": "…" } },
  "special": ["n"],
  "kingErasureWins": true,
  "names": [ { "pieceId":"w-k-e1", "square":"e1", "color":"w", "type":"k", "originalType":"k", "trueName":"梁文峰", "alias":"梁武帝" } ],
  "attempts": [ { "id":"e1", "seat":"black", "targetSquare":"e1", "name":"梁武帝", "success":false } ],
  "events": [ ], "lastAction": { }, "eraseUsedAtPly": 1
}
```

### 6.2 隐私红线（剧情模式增补）

1. 玩家/A 队友投影、SSE、公开事件不得出现**真名**（`trueName`）、`alias`、女神 `story.names` 或 B 的抹除 `name`。
2. 公开 `story.events` 只允许棋盘变化字段：`kind:"board-change"`, `change:"piece-removed"`, `square`；**不包含** `erase-attempt` / `pool-use` / `seat` / `patternType` / 原因或能力名。
3. 公开棋谱的公开行动只显示 `kind:"special"` 与中性 `label:"特殊走法 …"`；不公开内部池字段或行动类型键。
4. 抹王终局对玩家/A 队友返回 `result.reason:"special"`、`note:null`；女神视图保留 `erase-king` 与实际备注。
5. 私密行动详情只在 `me.story.privateAction`（拥有该行动的席位）与女神审计中出现；A 与公共视图不得包含，A 的投影连 `privateAction` 键都不返回。
6. 女神令牌才能读取/配置真名、导出全量记录；`config/story-scenario.json` 不作为静态资源提供。
7. A 的共享走法使用、B 的抹除结果只通过公开棋盘变化/中性棋谱体现；B 的规则原文与真名仍不可见。

### 6.3 默认与可调整项

- 抹除是**额外行动**，不替代普通走子；失败/成功都不切换轮次。
- 共享走法**替代**普通走子；池条目不消耗；双方共用。
- 池收入退场棋子的 `originalType`（升变后的棋子仍按原始类型入池）。
- 兵共享走法按单步前进/斜吃（不含起始双步/吃过路兵）；任何兵到达底线必须升变。
- 国王真名被抹除默认判抹除方胜；可在 `config/story-scenario.json` 的 `kingErasureWins` 改为 `false`。
- 真名匹配为 NFC + 去首尾空白后的精确比较（“梁文峰” != “梁武帝”）。
- P3 已接入浏览器 UI（玩家/女神故事面板与共享走法选点）；API 仍可直接调用。

## 7. 剧情模式测试

```bash
npm test                                     # 86 项（含 P1/P2/P3/P4）
node --test tests/story-rules.test.js        # P1 规则内核（9 项）
node --test tests/story-api.test.js          # P2 API / 私密隔离（15 项）
node --test tests/teammate-adapter.test.js   # P4 适配器（6 项）
node --test tests/teammate-api.test.js       # P4 受控决策（8 项）
node --test tests/story-ui-dom.test.js       # P3 玩家 DOM 模板隐私（1 项）
```

## 8. P4 受控模型决策接口

`POST /api/rooms/:id/teammate/decide`（仅 A 令牌，body `{}`）触发受控适配器。固定协议、白名单 context、decision schema、超时/并发/调用上限和工作台改动清单见
[docs/工作台模型桥接入.md](工作台模型桥接入.md)。

- 默认 `unavailable`；合成适配器明确显示“合成适配器 · 未接真实模型”；HTTP 适配器只允许 loopback，且未验证账号时不发请求。
- 模型输出只能是 `{kind:"move"|"special",actionId}` 或 `{kind:"guess",text}`；服务端重新校验版本/轮次/合法列表/猜测次数后才应用。
- 失败/超时/中断不自动走子、不自动重试；调用次数、并发、超时由服务端限制。
- 女神用途 `game-goddess` 是独立适配器，绝不复用 A 的 `game-player` 会话。
