import {readFileSync} from 'node:fs';

export const privateChessBoard = readFileSync(new URL('./standard-trial/chess.html',import.meta.url),'utf8')
  .replace('本次只执行标准国际象棋规则；秘密规则与 DeepSeek 私密执行尚未开放。','双方的秘密规则在服务器上生效，棋局表现可能帮助对手推测规则。')
  .replace('nekofans-chess v0.1.0 · 标准规则 · 私密规则未接通','nekofans-chess v0.1.0 · 私密规则实验')
  .replace('本次为标准棋局，秘密规则尚未开放','秘密规则已就绪')
  .replace('等待朋友加入；秘密规则尚未开放','等待双方提交规则')
  .replace('房间尚未就绪：等待朋友加入。','对局尚未开始或已暂停，请查看房间提示。');
