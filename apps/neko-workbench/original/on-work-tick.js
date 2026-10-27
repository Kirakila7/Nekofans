PetSprite.prototype.onWorkTick = function onWorkTick(snapshot, tick) {
  if (!this.pet.workStatusEnabled) return; // 未启用工作状态联动 -> 该宠物完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevWorkTick) return;
  this.prevWorkTick = tick;
  const state = snapshot && snapshot.state ? snapshot.state : null;
  this.workState = state; // 当前工作状态：互动/事件动画播完恢复档位循环用（与浏览器 workStatusRef 同用途）
  const stateChanged = this.prevWorkState !== state;
  this.prevWorkState = state;
  if (!state) {
    // 回空闲：把正在**循环播**的进行中档位动画改成"播完即停"（与浏览器 src/client/pet.ts 的空闲分支
    // 同一处修复）。进行中档位走 switchTo(name, false)（el.loop=true、el.onended=null），ended 永不
    // 触发；而这里不切动画（原设计"由常规动画链回待机"），链因此拿不到推进信号 —— 宠物会一直卡在
    // 那段工作动画上。只把当前段改成播完即停：它结束后走 handleEnded → resumeWorkStatusAnim() 返回
    // false → playIdle；工作期间的原生 loop 不受影响。
    if (S.poolIncludes(this.animations.events?.workStatus ?? [], this.anim)) {
      const frontEl = this.front === 0 ? this.videoA : this.videoB;
      if (frontEl) {
        frontEl.loop = false;
        frontEl.onended = () => this.handleEnded();
      }
    }
    // 空闲：收起常驻气泡
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workOn = false;
    this.workText = null;
    this.renderBubble();
    return;
  }
  const pool = this.animations.events?.workStatus;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画');
    return;
  }
  const idx = S.WORK_STATUS_INDEX[state];
  const slot = pool[idx];
  if (slot === undefined) {
    console.error('[dsh-pet] work-status 档位索引越界：state=' + state + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' workStatus pet=' +
      this.pet.id +
      ' state=' +
      state +
      ' -> [' +
      idx +
      '] ' +
      name,
  );
  this.stopMove();
  // 气泡文本：任务详情（todo/write 提供）优先，否则从条目级 workStatusTexts[档位]（数组）随机抽一句；
  // 整字段/整档缺失 = 不弹文本，只播动画（与浏览器同一语义）。
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  const configuredText =
    Array.isArray(textGroup) && textGroup.length > 0
      ? textGroup[Math.floor(Math.random() * textGroup.length)]
      : undefined;
  this.workText = (snapshot && snapshot.task) || configuredText || null;
  const terminal = state === 'success' || state === 'error';
  // 气泡点亮/收起只在状态变化时动作：同状态后续 tick（todo 文案更新、其它会话事件搅动 ts）
  // 不重新点亮**已自动收起的终态气泡**——否则"任务完成"的气泡会被后续 ts 变化反复弹回（Bug 2，
  // 与浏览器 workBubbleOn 同一语义）。
  if (stateChanged) {
    this.workOn = true;
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = terminal
      ? window.setTimeout(() => {
          this.workOn = false;
          this.renderBubble();
        }, BUBBLE_DURATION_MS)
      : null; // 非终态：常驻，不设自动收起
  }
  this.renderBubble();
  // 循环语义（与浏览器 setOnce 一致）：终态播一遍回 idle；非终态多候选档位播一遍 →
  // ended 由 sprite.handleEnded 轮换到下一候选（长时间状态不单段重复）；非终态单候选档位无限循环。
  const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
  if (terminal || rotating) this.playOnce(name);
  else this.switchTo(name, false); // 进行中循环播（单动画/单候选档位）
};
