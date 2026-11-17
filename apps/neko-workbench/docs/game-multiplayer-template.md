如果我已提供一个单机游戏，请保留原有单人玩法，并新增双人联机模式。先确认合作、轮流还是竞速，再明确哪些状态需要共享。以下是 Nekofans 独立游戏工坊的联机约定。

请为 Nekofans 创造一个可通过聊天室链接邀请朋友玩的双人 HTML 小游戏。

输出一个完整的单文件 HTML（CSS 与 JavaScript 全部内联），游戏内容由我接下来描述。不要输出单机假联机或两个玩家共用一个本地键盘的版本。两人将使用各自的电脑或手机打开同一个房间链接。

宿主已自动注入 window.NekofansGame，无须引入 SDK 文件、搭建服务器或直接使用 fetch/WebSocket。不要使用外部 CDN、外部图片、iframe、模块脚本或本地文件。可以使用 Canvas、CSS、SVG 和内嵌 data 图片。界面适配电脑和手机。

接入方式：
const room = NekofansGame.connect({
  initialState: { /* 纯 JSON 的初始游戏状态 */ },
  reducer(state, action, ctx) {
    // 同步、纯函数。ctx.player 是发出本次操作的玩家编号 0 或 1。
    // 验证操作是否符合游戏规则；无效操作返回原 state。
    // 返回新的纯 JSON 状态。禁止 Date.now、Math.random、DOM、副作用和异步。
    // 需要随机时，利用 ctx.seed 与 ctx.seq 以确定算法推导，保证两端一致。
    return state;
  },
  onChange(state, ctx) {
    // 每次双方状态/连接更新时，重新渲染。
    // ctx.player: 本人编号；ctx.players: [{name}, {name}]。
    // ctx.ready: 是否有两位玩家且本人连接正常。
    // ctx.isMyTurn: 本人是否可以操作；ctx.turn 当前回合；ctx.version 操作序号。
    // ctx.mode 为 turns 或 shared；ctx.online 是双方在线布尔数组。
    // 根据这些字段显示等待对手/你的回合/对手回合，并禁用不能执行的操作。
  },
  onError(message) { /* 显示简短错误 */ }
});

玩家实际操作时调用 room.submit({type:'...', ...纯 JSON 数据})。此时只提交意图，不要直接修改本地共享状态。服务器会排序并推送给两端，reducer 从相同历史计算状态。单次操作最多 4096 字节，每局最多 2000 次；适合棋类、回合制、合作解谜和共同创作，当前不适合每秒几十次同步的射击/动作游戏。

发布选择 turns 时，每次操作默认结束回合，两人交替。若同一回合需要分步骤，可 room.submit(action, {endTurn:false})，最后一步使用默认行为。shared 模式双方均可操作。

重要：服务端负责席位、回合、序号与操作同步；游戏规则由这个 HTML 的 reducer 实现。结束、胜负、重开提案等都要写入共享状态，通过操作同步。游戏结束后禁止普通落子。重开需要双方同意。页面刷新增量历史会重新计算，不能依赖 localStorage 作为共享状态。

页面里只展示游戏，不要重复实现房间邀请、昵称输入或连接凭证 UI，宿主会处理。先说明你建议选择 turns 还是 shared，再输出完整 HTML。

我的游戏想法：
（在这里填写玩法）
