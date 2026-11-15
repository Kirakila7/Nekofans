export type Entry = {
  id: string; kind: 'game' | 'rule'; title: string; summary: string; body: string;
  category: string; tags: string[]; stage: 'concept' | 'prototype' | 'playable';
  creator: string; createdAt: number; url?: string | null; curated?: boolean; isOwner?: boolean;
};
export const categories = ['棋盘智斗', '文字博弈', '派对推理', '其他玩法'];
export const curated: Entry[] = [
  {
    id: 'first-open-and-erase', kind: 'game', title: '开源与抹除',
    summary: '被吃掉的棋子，留下可以共享的走法。看不见的名字，决定下一次抹除。',
    body: '首位创作者 A.kira的智斗游戏原型。\n\n双方先进入同一场游戏，按共同约定提交各自的隐藏规则。创造台负责游戏的生成、修改与分享；女神接收双方秘密规则并中立主持；大肥鱼是本方的决策队友。\n\n「开源」让被移除棋子的普通走法进入共享池，双方都可以借用；规则编译器已实装开源走法借用引擎，棋子离场后双方均可在对局中借用其走法。「抹除」则围绕棋子的真实名字展开，真名猜测交互机制建设中。棋盘不公开棋子的名字，玩家要通过行动、试探与推理寻找对方能力的边界。具体使用次数、冲突处理及胜利条件，以本局双方约定为准。\n\n当前展示包含角色概念图、已有界面实录及规则编译内核。',
    category: '棋盘智斗', tags: ['隐藏规则', 'AI 队友', '双人'], stage: 'prototype',
    creator: 'A.kira', createdAt: 1794153600000, curated: true,
  },
  {
    id: 'rule-open-source', kind: 'rule', title: '开源',
    summary: '离场的棋子，把普通走法留给所有人。一次牺牲，也可能改写双方的选择。',
    body: '已接入对局引擎：被吃掉或离场的棋子，其普通走法进入共享池，任意己方棋子均可借用此走法行动（如兵借用退场马的日字跳跃、借用车象的直线斜线穿透）。\n\n规则编译器已全面实装 shared-piece-pool 走法借用生成与防被将合法性校验。',
    category: '棋盘智斗', tags: ['共享能力', '牺牲', '走法'], stage: 'playable',
    creator: 'A.kira', createdAt: 1794153500000, curated: true,
  },
  {
    id: 'rule-erase', kind: 'rule', title: '抹除',
    summary: '知道真实名字，才有资格让棋子离场。公开一个化名，也能成为一次试探。',
    body: '规则创意：只有知道目标棋子的真实名字，才能尝试抹除它；叫错名字，能力不生效。\n\n（真名猜测与交互协议建设中，对局编译器当前返回 unsupported 提示玩家换用开源等已支持规则）',
    category: '棋盘智斗', tags: ['名字', '信息博弈', '试探'], stage: 'concept',
    creator: 'A.kira', createdAt: 1794153400000, curated: true,
  },
];
