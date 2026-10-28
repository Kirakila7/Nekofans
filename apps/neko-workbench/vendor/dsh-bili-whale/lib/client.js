/**
 * dsh-bili-whale —— 客户端半边：DSH「设置」里的 **养鱼** section（完整版）
 *
 * 历史（2026-10-18）：
 *   v1 只放了 6 个字段（owner/persona/作息窗口）→ 主人说"和微信端讲的不一样" ✗。
 *   真因：宿主半边那份独立页面 `settings.html` 有 25 个字段，但它被 DSH 的信任栅栏挡着打不开 ✗，
 *        而 section 是我另写的精简版 ✗ → 两套界面、一个配置，看着像两个插件。
 *   v2（本文件）：把那 25 个字段**按同一份配置结构**搬进 section ✓；渲染改成**数据驱动**
 *                （FIELDS 是唯一真相；加字段只改这个数组 ✓）。
 *
 * 数据流：section ⇄ `/dsh-bili/api/*`（同源 fetch ✓）⇄ `~/.dsh/bili-whale.config.json`
 *         —— 与 bilibili-tools 的 `lib/config.mjs` 读**同一份文件** ✓，不存在"两套配置"。
 *         ⚠️ 保存时提交**整份配置**（load 回来原样改几个键）→ 未显示的字段不会被抹掉 ✓
 */
window.__ModuleLoader__.load({
  id: "dsh-bili-whale",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const {createPortal}=require("react-dom");
    const { createElement: h, useCallback, useEffect, useState, useRef } = React;

    const API = "/dsh-bili/api";
    const CSS_TAG = "dsh-bili-whale/section.css";
    const CSS = [
      ".blw{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
      ".blw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
      ".blw-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}",
      ".blw-group{margin-top:14px;font-size:13px;font-weight:600;line-height:20px}",
      ".blw-rows{display:flex;flex-direction:column}",
      ".blw-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
      ".blw-row:last-child{border-bottom:none}",
      ".blw-row>div:first-child{flex:1;min-width:190px}",
      ".blw-label{font-size:13px;line-height:19px}",
      ".blw-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}",
      ".blw-input,.blw-select{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:180px;outline:none}",
      ".blw-input:focus-visible,.blw-select:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
      ".blw-input.blw-wide{min-width:260px}",
      ".blw-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      // 2026-10-25 修：主按钮文字原来写死 #fff —— 深色主题下 brand-primary = #f9fafb（近白），
      //   于是「白底白字」，保存 / 注入人设 / 发 三个按钮只剩一块白，字看不见（对比度 1.05:1）✗
      //   与之配对的 token 是 label-primary-foreground（深色 #0f1115 / 浅色 #fff）✓
      //   兜底 #fff：老版本 DSH 的 brand-primary 是蓝色，没有这个 token 时也仍然可读。
      ".blw-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
      ".blw-btn:disabled{opacity:.5;cursor:default}",
      ".blw-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
      ".blw-out{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary);background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;max-height:240px;overflow:auto;margin-top:10px}",
      ".blw-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-line}",
      ".blw-hint.blw-pre{white-space:pre-line}",
      ".blw-badge{display:inline-block;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:rgba(127,127,127,.14);color:var(--dsw-alias-label-secondary);margin-left:6px}",
      ".blw-cookie{display:flex;flex-direction:column;gap:8px;min-width:250px}",
      ".blw-details{margin-top:14px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}",
      ".blw-details>summary{cursor:pointer;font-size:13px;line-height:24px;color:var(--dsw-alias-label-secondary)}",
    ].join("");

    // ── 唯一真相：字段清单（加字段只改这里 ✓）────────────────────────────
    //   kind: text | number | list（逗号分隔数组）| switch | select
    const FIELDS = [
      {group:"互动权限",path:["workbench","allowExternalWrites"],label:"允许 B站写操作",hint:"开启后才允许按下方设置评论、私信、收藏或发弹幕。默认只阅读、写本地日记。",kind:"switch"},
      {group:"会话成本",path:["sessionRotateDays"],label:"会话轮换天数",hint:"0 不轮换；开启后在空闲时创建新会话，保留旧会话",kind:"number"},
      {group:"会话成本",path:["personaOncePerSession"],label:"每会话减少重复人设",hint:"成功投递后减少重复内容；重启或人设变化时重新注入",kind:"switch"},
      {group:"分享前检查",path:["share","aiCommentGuard"],label:"疑似 AI 评论检查（试用）",hint:"仅主动 @ 分享；按视频缓存 6 小时，超阈值暂缓并推送",kind:"switch"},
      { group: "工具链", path: ["home"], label: "专用会话目录", hint: "已存在目录的绝对路径；留空用默认目录。重启后新建会话生效，已有会话不迁移", kind: "text", wide: true },
      { group: "日记与推送", path: ["listen", "mentionSummary"], label: "主人 @ 请求总结", hint: "默认关闭。开启后处理主人含总结/摘要/概括的新 @，通过消息推送通道发送", kind: "switch" },
      { group: "作息", path: ["night", "minGapMin"], label: "最小唤醒间隔（分钟）", hint: "默认 10；窗口放不下就少醒几次", kind: "number" },
      { group: "她是谁", path: ["persona", "name"], label: "角色名", hint: "她怎么被称呼", kind: "text" },
      { group: "她是谁", path: ["persona", "ownerTitle"], label: "她怎么称呼你", hint: "例如「主人」", kind: "text" },
      { group: "她是谁", path: ["persona", "selfClaim"], label: "她怎么自称", hint: "例如「我」/「人家」", kind: "text" },

      { group: "你（主人）", path: ["owner", "mid"], label: "主人 mid", hint: "用来认「谁回过她 / 谁点了赞」", kind: "text" },
      { group: "你（主人）", path: ["owner", "name"], label: "主人昵称", hint: "@ 分享时写进正文", kind: "text" },
      { group: "你（主人）", path: ["self", "mid"], label: "她自己 mid", hint: "只读（来自 cookie）", kind: "text", readOnly: true },
      { group: "你（主人）", path: ["self", "name"], label: "她自己昵称", hint: "只读（来自 nav）", kind: "text", readOnly: true },

      { group: "作息", path: ["night", "skipChance"], label: "今晚不看的概率", hint: "0.3 = 三成", kind: "number" },
      { group: "作息", path: ["night", "maxVideos"], label: "单次醒来观看视频数量", hint: "初筛的候选数；筛完再挑 2–3 条深读", kind: "number" },

      { group: "口味", path: ["preferences", "like"], label: "爱看", hint: "逗号分隔", kind: "list" },
      { group: "口味", path: ["preferences", "dislike"], label: "不爱看", hint: "逗号分隔", kind: "list" },

      { group: "日记与推送", path: ["diary", "push"], label: "推送日记摘要", hint: "关掉 = 她照写两本日记，但不推给你（日记本身不能关 ✓）", kind: "switch" },

      { group: "工具链", path: ["toolsPath"], label: "工具目录", hint: "留空 = 用插件自带的 tools/ 或开发目录", kind: "text", wide: true },
    ];

    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const setPath = (obj, path, value) => {
      let cur = obj;
      for (let i = 0; i < path.length - 1; i += 1) {
        const k = path[i];
        if (cur[k] == null || typeof cur[k] !== "object") cur[k] = typeof path[i + 1] === "number" ? [] : {};
        cur = cur[k];
      }
      cur[path[path.length - 1]] = value;
    };

    function useStyleOnce() {
      useEffect(() => {
        if (typeof document === "undefined") return;
        if (!document.getElementById(CSS_TAG)) {
          const el = document.createElement("style");
          el.id = CSS_TAG;
          el.textContent = CSS;
          document.head.appendChild(el);
        }
      }, []);
    }

    function Row({ f, cfg, set }) {
      const raw = getPath(cfg, f.path);
      const common = { "aria-label":f.label,className: "blw-input" + (f.wide ? " blw-wide" : "") };
      // 2026-10-18 修：list 字段以前"值 = 数组 join、改动 = split 回数组" ✗
      //   → 你一打逗号，join 立刻把它吞掉（输入框里根本打不出逗号 ✗）
      //   现在：本地文本 state 管显示 ✓ 数组只在解析时更新 ✓（逗号能打、末尾逗号也不会乱跳 ✓）
      const [listText, setListText] = useState(Array.isArray(raw) ? raw.join("，") : (raw ?? ""));
      useEffect(() => {
        setListText(Array.isArray(raw) ? raw.join("，") : (raw ?? ""));
      }, [JSON.stringify(raw ?? null)]);
      let control;
      if (f.kind === "list") {
        control = h("input", {
          ...common,
          value: listText,          // ← 显示用本地文本（逗号不会被吞 ✓）
          readOnly: !!f.readOnly,
          onChange: (e) => {
            const v = e.target.value;
            setListText(v);          // 先原样显示（中文逗号、英文逗号、末尾逗号都能打 ✓）
            // 再解析成数组写进配置（空项过滤掉，不会因为末尾逗号多出一个空串 ✓）
            set(f.path, v.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
          },
        });
      } else if (f.kind === "number") {
        control = h("input", { ...common, type: "number", step: "any", value: raw ?? "", readOnly: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value === "" ? undefined : Number(e.target.value)) });
      } else if (f.kind === "switch") {
        control = h("input", { type: "checkbox", checked: !!raw, disabled: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.checked) });
      } else if (f.kind === "select") {
        control = h("select", { className: "blw-select", value: raw ?? "", disabled: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value) },
          f.options.map((o) => h("option", { key: o, value: o }, o)));
      } else {
        control = h("input", { ...common, value: raw ?? "", readOnly: !!f.readOnly,
          onChange: (e) => set(f.path, e.target.value) });
      }
      return h("div", { className: "blw-row" },
        h("div", null,
          h("div", { className: "blw-label" }, f.label, f.readOnly ? h("span", { className: "blw-badge" }, "只读") : null),
          f.hint ? h("div", { className: "blw-hint" }, f.hint) : null),
        control);
    }

    // ── 作息窗口编辑器（2026-10-18 主人画的草图）─────────────────────────
    //   ①  07:00 – 09:00   （醒来 1 次）   [x]
    //   ②  17:00 – 18:00   （醒来 1 次）   [x]
    //   [ + 添加窗口 ]
    //   每个窗口自带"醒来几次"；保存时把总和写回 night.maxWakesPerDay（工具链读它 ✓）
    const NUMS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
    function WindowsEditor({ cfg, set }) {
      const wins = getPath(cfg, ["night", "windows"]);
      const list = Array.isArray(wins) ? wins : [];
      const upd = (i, patch) => set(["night", "windows"], list.map((w, j) => (j === i ? { ...w, ...patch } : w)));
      const del = (i) => set(["night", "windows"], list.filter((_, j) => j !== i));
      const add = () => set(["night", "windows"], [...list, { start: "20:00", end: "22:00", wakes: 1 }]);
      const timeInput = (v, onChange) =>
        h("input", { className: "blw-input", style: { width: "86px", minWidth: "86px" }, value: v ?? "", onChange: (e) => onChange(e.target.value) });
      return h("div", null,
        h("div", { className: "blw-rows" },
          list.length === 0
            ? h("div", { className: "blw-hint" }, "（没有窗口 = 永远不醒；至少加一个）")
            : list.map((w, i) =>
                h("div", { className: "blw-row", key: i },
                  h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                    h("span", { className: "blw-hint", style: { minWidth: "18px" } }, NUMS[i] ?? String(i + 1)),
                    timeInput(w.start, (v) => upd(i, { start: v })),
                    h("span", { className: "blw-hint" }, "–"),
                    timeInput(w.end, (v) => upd(i, { end: v })),
                    h("span", { className: "blw-hint" }, "醒来"),
                    h("input", { className: "blw-input", style: { width: "56px", minWidth: "56px" }, type: "number", min: 1,
                      value: w.wakes ?? 1, onChange: (e) => upd(i, { wakes: Number(e.target.value) || 1 }) }),
                    h("span", { className: "blw-hint" }, "次")),
                  h("button", { className: "blw-btn blw-btn2", disabled: list.length <= 1, onClick: () => del(i), title: "删掉这个窗口" }, "×"))),
        h("div", { style: { marginTop: "8px" } },
          h("button", { className: "blw-btn blw-btn2", onClick: add }, "+ 添加窗口"))));
    }

    // ── 开关行（复选框 + 说明）──────────────────────────────────────────
    function SwitchRow({ label, hint, value, onChange, disabled }) {
      return h("div", { className: "blw-row" },
        h("div", null,
          h("div", { className: "blw-label" }, label),
          hint ? h("div", { className: "blw-hint" }, hint) : null),
        h("input", { type: "checkbox", checked: !!value, disabled: !!disabled, onChange: (e) => onChange(e.target.checked) }));
    }

    // ── 【分享评论】（主动 @ 你）· 2026-10-18 主人给的排版 ────────────────
    function ShareEditor({ cfg, set }) {
      const s = cfg.share ?? {};
      const daily = cfg.quota?.shareDaily ?? 3;
      // 2026-10-19：分享方式二选一 —— comment=评论区公开 @ / dm=私信给你（必须带视频链接）
      const via = s.via === "dm" ? "dm" : "comment";
      const viaRadio = ([value, label, hint]) =>
        h("label", { key: value, style: { display: "flex", alignItems: "flex-start", gap: "8px", marginBottom: "10px", cursor: "pointer" } },
          h("input", { type: "radio", name: "blw-share-via", checked: via === value, style: { marginTop: "3px" }, onChange: () => set(["share", "via"], value) }),
          h("div", null,
            h("div", { className: "blw-label" }, label),
            h("div", { className: "blw-hint" }, hint)));
      return h("div", null,
        h("div", { className: "blw-group" }, "分享（主动告诉你 · 二选一）"),
        h("div", { className: "blw-rows" },
          h(SwitchRow, { label: "开启", hint: "关掉 = 她只看不说 ✓", value: s.enabled !== false, onChange: (v) => set(["share", "enabled"], v) }),
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "分享方式（二选一）"),
              h("div", { className: "blw-hint" }, "只在「有值得分享的」时才发；一条都不值得就一条都不发 ✓")),
            h("div", null,
              viaRadio(["comment", "评论区 @ 你", "在视频评论区发一条带 @ 的公开评论 ✓（原功能 · 别人也看得到）"]),
              viaRadio(["dm", "B站私信", "不发公开评论 ✗ 直接把分享内容 + 视频链接私信给你 ✓（更干净 ✓ 需要互关 ✓）"]))),
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "每天上限"),
              h("div", { className: "blw-hint" }, via === "dm"
                ? "私信：一天只锁定你一个收信人 ✓ 条数不限 ✓"
                : "同一视频 7 天内一次 · 只从「深读过的」里挑 · 调大时会弹警告")),
            h("input", { className: "blw-input", style: { width: "80px", minWidth: "80px" }, type: "number", min: 0,
              value: daily, onChange: (e) => set(["quota", "shareDaily"], Number(e.target.value)) }))));
    }

    // ── 【全天监听】（别人找她）· 2026-10-18 主人给的排版 ──────────────────
    function ListenEditor({ cfg, set }) {
      const L = cfg.listen ?? {};
      const sel = (value, options, onChange) =>
        h("select", { className: "blw-select", value, onChange: (e) => onChange(e.target.value) },
          options.map(([v, label]) => h("option", { key: v, value: v }, label)));
      const num = (value, onChange, w = "70px") =>
        h("input", { className: "blw-input", style: { width: w, minWidth: w }, type: "number", min: 0, value: value ?? "", onChange: (e) => onChange(Number(e.target.value)) });
      return h("div", null,
        h("div", { className: "blw-group" }, "全天监听（别人找她）"),
        h("div", { className: "blw-rows" },
          h(SwitchRow, { label: "评论区监听", hint: "查「回复我的 / @我的」；按配置间隔检查（默认 60 秒），仅失败时退避", value: L.comment !== false, onChange: (v) => set(["listen", "comment"], v) }),
          // 2026-10-24 主人要求去掉「查一次间隔」这个输入框：
          //   填了也不准 —— 实际节奏为配置间隔，加上失败退避和平台暂停，
          //   那个框给的是"承诺值"，跟真实行为对不上。节奏交给代码，不再暴露 ✓

          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "只回"), h("div", { className: "blw-hint" }, "哪种通知算「找她」")),
            sel(L.scope ?? "both", [["both", "直接回我的 + @我的"], ["reply", "只回直接回我的"]], (v) => set(["listen", "scope"], v))),
          h(SwitchRow, { label: "同一个人最多只回一条", hint: "30 天内只回一次同一人（默认开 ✓）", value: L.oncePerPerson !== false, onChange: (v) => set(["listen", "oncePerPerson"], v) }),
          h(SwitchRow, { label: "全天（我睡着时也回）", hint: "关掉 = 只在她醒着的窗口里回 ✓", value: !!L.allDay, onChange: (v) => set(["listen", "allDay"], v) }),

          h(SwitchRow, { label: "私信监听（只认主人）", value: !!L.dm, onChange: (v) => set(["listen", "dm"], v),
            hint: "默认每 60 秒检查，无消息不降频；仅失败时退避，平台限制期间暂停" }),
          h(SwitchRow, { label: "直播间监听", hint: "蹲直播间弹幕里有没有叫她", value: !!L.live, onChange: (v) => set(["listen", "live"], v) }),
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "直播间房间号"), h("div", { className: "blw-hint" }, "留空 = 不蹲直播")),
            h("input", { className: "blw-input", style: { width: "120px", minWidth: "120px" }, value: L.liveRoom ?? "", placeholder: "例如 12345", onChange: (e) => set(["listen", "liveRoom"], e.target.value) })),
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "直播间只回"), h("div", { className: "blw-hint" }, "只回主人 = 观众的一律不理；只回艾特她的 = 只看有没有人叫她")),
            sel(L.liveScope ?? "owner", [["owner", "只回主人"], ["mention", "只回艾特她的"]], (v) => set(["listen", "liveScope"], v)))),
        h("div", { className: "blw-out" },
          "【风控护栏 · 不可关】撞到 12015 / 12051 / 10031 → 立刻停监听 + 报你\n" +
          "评论、私信等操作还需开启「允许 B站写操作」，并保存对应互动设置。"));
    }

    // ── 【待审核】（2026-10-18 主人选 B 档：她的回复先给你看，你点「发」才发）──────
    function PendingEditor() {
      const [items, setItems] = useState([]);
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");

      const load = useCallback(async () => {
        try { const r = await fetch(`${API}/pending`, { headers: { accept: "application/json" } }); const j = await r.json(); setItems(j.items ?? []) } catch {}
      }, []);
      useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [load]);

      const act = async (id, what) => {
        setBusy(id + what); setMsg("");
        try {
          const r = await fetch(`${API}/pending/${what}`, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ id }),
          });
          const j = await r.json().catch(() => ({}));
          setMsg(j.ok
            ? (what === "approve" ? `✓ 已发出${j.rpid ? " · rpid=" + j.rpid : ""}` : "✓ 已删掉（也记了一笔「否」✓）")
            : `✗ ${j.error ?? "失败"}`);
          await load();
        } catch (e) { setMsg("✗ " + e.message) } finally { setBusy("") }
      };

      return h("div", null,
        h("div", { className: "blw-group" }, "待审核" + (items.length ? `（${items.length} 条）` : "")),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } }, "她回复别人之前，草稿先到这儿 —— 你点「发」才发 ✓（否掉也会记一笔，她会学着改 ✓）"),
        h("div", { className: "blw-rows" },
          items.length === 0
            ? h("div", { className: "blw-hint", style: { padding: "8px 0" } }, "（队列是空的 ✓）")
            : items.map((x) => h("div", { className: "blw-row", key: x.id },
              h("div", null,
                h("div", { className: "blw-label" }, `→ ${x.who || "对方"}`, h("span", { className: "blw-badge" }, String(x.at ?? "").slice(5, 16).replace("T", " "))),
                x.src ? h("div", { className: "blw-hint" }, `他说：${String(x.src).slice(0, 80)}`) : null,
                h("div", { className: "blw-hint", style: { color: "var(--dsw-alias-label-primary)", marginTop: "4px" } }, `你要回：${x.message}`)),
              h("div", { style: { display: "flex", gap: "6px" } },
                h("button", { className: "blw-btn", disabled: !!busy, onClick: () => act(x.id, "approve") }, busy === x.id + "approve" ? "发出中…" : "发"),
                h("button", { className: "blw-btn blw-btn2", disabled: !!busy, onClick: () => act(x.id, "reject") }, "删"))))),
        msg ? h("div", { className: msg.startsWith("✓") ? "blw-hint" : "blw-err" }, msg) : null);
    }

    // ── 【消息推送】（她看完一轮，把摘要送到哪）· 2026-10-18 主人给的排版 ──────
    function NotifyEditor({ cfg, set, save }) {
      const n = cfg.notify ?? {};
      // 旧配置里可能是 stdout / file → 界面上按「不推送」显示（不误导 ✓），选新方式时会被覆盖 ✓
      const type = ["none", "desktop", "dm", "webhook", "command"].includes(n.type) ? n.type : "none";
      const [testing, setTesting] = useState(false);
      const [testOut, setTestOut] = useState("");
      const setType = (v) => set(["notify", "type"], v);
      const radio = ([value, label]) =>
        h("label", { key: value, style: { display: "inline-flex", alignItems: "center", gap: "6px", marginRight: "14px", cursor: "pointer", fontSize: "13px" } },
          h("input", { type: "radio", name: "blw-notify", checked: type === value, onChange: () => setType(value) }),
          label);
      const test = async () => {
        setTesting(true); setTestOut("…正在保存设置（测试前先落盘 ✓）\n");
        try {
          // 2026-10-19：测试前**先保存** ✓
          //   以前测试读的是磁盘上的旧配置 → "点了别的单选、测试却还发到旧通道" ✗
          //   现在"你看到的就是你测的" ✓
          await save();
          const r = await fetch(`${API}/notify-test`, { method: "POST", headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          setTestOut((j.ok ? "✓ 已发送（设置已自动保存 ✓）\n" : "✗ 失败（设置已自动保存 ✓）\n") + (j.out || "") + (j.err ? "\n" + j.err : ""));
        } catch (e) { setTestOut("✗ " + e.message); } finally { setTesting(false); }
      };
      const box = { className: "blw-out", style: { marginTop: "8px" } };
      return h("div", null,
        h("div", { className: "blw-group" }, "消息推送"),
        h("div", { className: "blw-hint", style: { marginTop: "2px" } }, "她看完一轮，把摘要送到哪？"),
        h("div", { className: "blw-rows" },
          h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "方式"),
              h("div", { className: "blw-hint" }, "不推送 = 只写日记与事件流")),
            h("div", null, ["none", "desktop", "dm", "webhook", "command"].map((v, i) =>
              radio([v, ["不推送", "桌面通知", "B站私信", "Webhook", "自定义命令"][i]])))),

          type === "webhook" ? h("div", null,
            h("div", { className: "blw-row" },
              h("div", null, h("div", { className: "blw-label" }, "Webhook 地址"),
                h("div", { className: "blw-hint" }, "飞书 / 钉钉 / 企业微信 / QQ机器人 / WorkBuddy —— 把机器人给的地址贴进来就行（报文按域名自动适配 ✓）")),
              h("input", { className: "blw-input blw-wide", style: { minWidth: "300px" }, value: n.url ?? "", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/…", onChange: (e) => set(["notify", "url"], e.target.value) })),
            h("div", { className: "blw-row" },
              h("div", null, h("div", { className: "blw-label" }, "模板"),
                h("div", { className: "blw-hint" }, "纯文本最稳；飞书/钉钉选 markdown 会漂亮一些")),
              h("select", { className: "blw-select", value: n.template ?? "text", onChange: (e) => set(["notify", "template"], e.target.value) },
                h("option", { value: "text" }, "纯文本"),
                h("option", { value: "markdown" }, "markdown")))) : null,

          type === "command" ? h("div", { className: "blw-row" },
            h("div", null, h("div", { className: "blw-label" }, "自定义命令"),
              h("div", { className: "blw-hint" }, "cmd = 可执行文件（如 node.exe）；消息**自动作为最后一个参数**传进去 ✓"),
              h("div", { className: "blw-hint" }, "⚠️ 不再支持 $MSG（2026-10-18 弃用：走 shell 有命令注入风险 ✗）")),
            h("input", { className: "blw-input blw-wide", style: { minWidth: "300px" }, value: n.cmd ?? "", placeholder: 'C:\\path\\to\\node.exe', onChange: (e) => set(["notify", "cmd"], e.target.value) }),
            h("div", { className: "blw-hint", style: { marginTop: "6px" } }, "参数（JSON 数组，可留空；比如 [\"C:/path/to/cli.js\"]）"),
            h("input", {
              className: "blw-input blw-wide", style: { minWidth: "300px" },
              value: JSON.stringify(n.args ?? []),
              onChange: (e) => {
                try { const v = JSON.parse(e.target.value); set(["notify", "args"], Array.isArray(v) ? v : []) } catch {}
              },
              placeholder: '["C:/path/to/cli.js"]',
            })) : null),

        h("div", { className: "blw-actions", style: { borderTop: "none", marginTop: "8px", paddingTop: "0" } },
          h("button", { className: "blw-btn blw-btn2", onClick: test, disabled: testing }, testing ? "发送中…" : "发条测试"),
          type === "none" ? h("span", { className: "blw-hint" }, "（方式=不推送时，测试只验证命令能跑通）") : null),
        testOut ? h("div", box, testOut) : null);
    }

    function QrLogin({ disabled, onAccount, onActiveChange, autoStart }) {
      const [qr, setQr] = useState(null);
      const [error, setError] = useState("");
      const flow = useRef({ generation: 0, id: null, timer: null });
      const call = async (name, body = {}) => {
        const response = await fetch(`${API}/auth/qr/${name}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(result.error || "登录操作失败，请重试。");
        return result;
      };
      const cancel = () => {
        flow.current.generation++;
        clearTimeout(flow.current.timer);
        const id = flow.current.id;
        flow.current.id = null;
        if (id) void call("cancel", { id }).catch(() => {});
      };
      useEffect(() => () => cancel(), []);
      const start = async () => {
        cancel(); setError(""); setQr({ status: "starting" });
        const generation = flow.current.generation;
        try {
          const initial = await call("start");
          if (generation !== flow.current.generation) {
            void call("cancel", { id: initial.id }).catch(() => {}); return;
          }
          flow.current.id = initial.id;
          setQr(initial);
          const poll = async () => {
            try {
              const result = await call("poll", { id: initial.id });
              if (generation !== flow.current.generation) return;
              setQr(result);
              if (result.status === "success") {
                onAccount(result.account);
                flow.current.id = null;
              } else if (["waiting", "scanned"].includes(result.status)) {
                flow.current.timer = setTimeout(poll, 2000);
              }
            } catch (e) {
              if (generation !== flow.current.generation) return;
              cancel(); setError(e.message); setQr({ status: "error" });
            }
          };
          flow.current.timer = setTimeout(poll, 2000);
        } catch (e) {
          if (generation === flow.current.generation) { setError(e.message); setQr({ status: "error" }); }
        }
      };
      const startedAutomatically=useRef(false);
      useEffect(()=>{
        if(!autoStart&&startedAutomatically.current){
          startedAutomatically.current=false;
          if(flow.current.id||["starting","waiting","scanned"].includes(qr?.status)){
            cancel();setQr({status:"cancelled"});
          }
        }else if(autoStart&&!disabled&&!startedAutomatically.current){
          startedAutomatically.current=true;void start();
        }
      },[autoStart,disabled]);
      const active = ["starting", "waiting", "scanned"].includes(qr?.status);
      useEffect(() => {
        onActiveChange(active);
        return () => onActiveChange(false);
      }, [active, onActiveChange]);
      const status = {
        starting: "正在生成二维码…", waiting: "用哔哩哔哩 App 扫码登录。",
        scanned: "已扫码，请在手机上确认。", expired: "二维码已过期，请重新生成。",
        cancelled: "已取消，原登录态未改变。",
        success: qr?.account ? `已登录：${qr.account.name}（mid ${qr.account.mid}）` : "",
      }[qr?.status];
      return h("div", { className: "blw-cookie" },
        qr?.image ? h("img", { src: qr.image, alt: "B 站登录二维码", width: 220, height: 220 }) : null,
        status ? h("div", { className: "blw-hint", role: "status" }, status) : null,
        error || qr?.error ? h("div", { className: "blw-err", role: "alert" }, error || qr.error) : null,
        qr?.account?.warn ? h("div", { className: "blw-err" }, qr.account.warn) : null,
        h("div", { style: { display: "flex", gap: "8px" } },
          h("button", { className: "blw-btn", onClick: start, disabled: disabled || active }, qr ? "重新生成二维码" : "扫码登录"),
          active ? h("button", { className: "blw-btn blw-btn2", onClick: () => { cancel(); setQr({ status: "cancelled" }); } }, "取消登录") : null));
    }

    function BiliWhaleSection({ compact = false } = {}) {
      useStyleOnce();
      const [cfg, setCfg] = useState(null);
      const [savedJson, setSavedJson] = useState("");   // 2026-10-19：用来判断"有没有未保存的改动" ✓
      const [out, setOut] = useState("");
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState("");
      const [ck, setCk] = useState({ sessdata: "", bili_jct: "", buvid3: "" });
      const [ckMsg, setCkMsg] = useState("");
      const [qrActive, setQrActive] = useState(false);
      const [fishState,setFishState]=useState({enabled:false,phase:'paused',reason:'已暂停'});
      useEffect(()=>{let alive=true,updated=false;fetch(`${API}/control`).then(r=>r.json()).then(j=>{if(alive&&!updated&&j.state)setFishState(j.state)}).catch(()=>{});const off=window.nekoWorkbench?.subscribe?.(next=>{if(alive&&(next.fish||next.fishQq?.fish)){updated=true;setFishState(next.fish||next.fishQq.fish)}});return()=>{alive=false;off?.();};},[]);
      const control=async action=>{setErr('');try{let result;if(window.nekoWorkbench?.fish)result=await window.nekoWorkbench.fish(action);else{const response=await fetch(`${API}/control`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});const body=await response.json();if(!response.ok||!body.ok)throw Error();result=body.state;}setFishState(result);}catch{setErr('养鱼操作未能完成，请检查连接后重试。');}};

      // 2026-10-21：她专属的人设（~/.bili-ai/persona.md）—— 自由输入 + 注入 ✓
      const [personaText, setPersonaText] = useState("");
      const [personaMsg, setPersonaMsg] = useState("");
      const [personaBytes, setPersonaBytes] = useState(0);

      const load = useCallback(async () => {
        setErr("");
        try {
          const r = await fetch(`${API}/settings`, { headers: { accept: "application/json" } });
          if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 403 ? "（被信任栅栏拒绝）" : ""}`);
          const j = await r.json();
          setCfg(j.config ?? {});
          setSavedJson(JSON.stringify(j.config ?? {}));
          // 人设单独一个文件，顺手读一下 ✓
          try {
            const pr = await fetch(`${API}/persona`, { headers: { accept: "application/json" } });
            if (pr.ok) { const pj = await pr.json(); setPersonaText(pj.text ?? ""); setPersonaBytes(pj.bytes ?? 0); }
          } catch {}
        } catch (e) { setErr(`读取配置失败：${e.message}`); }
      }, []);

      useEffect(() => { load(); }, [load]);

      const set = (path, value) => setCfg((c) => {
        const next = JSON.parse(JSON.stringify(c ?? {}));
        setPath(next, path, value);
        return next;
      });

      const save = async () => {
        setBusy("save"); setErr(""); setOut("");
        try {
          const wins = cfg?.night?.windows ?? [];
          const total = Math.max(1, wins.reduce((s, w) => s + (Number(w.wakes) || 1), 0));
          const body = { ...(cfg ?? {}), night: { ...(cfg?.night ?? {}), maxWakesPerDay: total } };
          const r = await fetch(`${API}/settings`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            // 2026-10-18：宿主现在两种都收 ✓，这里显式包一层最稳（以前发裸对象 → 宿主 merge 到 {}
            body: JSON.stringify({ config: body }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setOut(`✓ 已保存到当前工作台${j.warn ? `\n${j.warn}` : ""}`);
          if (j.config) { setCfg(j.config); setSavedJson(JSON.stringify(j.config)); }
        } catch (e) { setErr(`保存失败：${e.message}`); } finally { setBusy(""); }
      };

      const injectPersona = async () => {
        setBusy("persona"); setPersonaMsg("");
        try {
          const r = await fetch(`${API}/persona`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ text: personaText }),
          });
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
          setPersonaBytes(j.bytes ?? 0);
          setPersonaMsg(j.detail ?? "✓ 已注入");
        } catch (e) { setPersonaMsg("✗ " + e.message); }
        finally { setBusy(""); }
      };

      const deps = async () => {
        setBusy("deps"); setErr(""); setOut("检查中…");
        try {
          const r = await fetch(`${API}/deps`, { headers: { accept: "application/json" } });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          const lines = (j.items ?? []).map((i) => `${i.ok ? "✓" : "✗"} ${i.name} — ${i.detail ?? ""}`);
          const schedulerOk = j.scheduler?.ok === true;
          lines.push(`${schedulerOk ? "✓" : "✗"} 生物钟 — ${j.scheduler?.reason ?? "未返回调度器状态"}`);
          if (j.error) lines.push(j.error);
          // 2026-10-19：体检后顺手重读配置 ✓ 不然「她自己 mid/昵称」那两格永远显示旧值 ✗
          if (j.self) lines.push("", `她自己：${j.self.name}（mid ${j.self.mid}）✓`);
          await load();
          setOut([...lines, "", j.ok && schedulerOk ? "全部可用 ✓" : "有项不可用 ✗"].join("\n"));
        } catch (e) { setErr(`依赖体检失败：${e.message}`); } finally { setBusy(""); }
      };

      const saveCookie = async () => {
        setBusy("cookie"); setErr(""); setCkMsg("");
        try {
          const r = await fetch(`${API}/cookie`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(ck),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setCkMsg(`✓ ${j.detail ?? "已写入"}` + (j.warn ? `\n${j.warn}` : ""));   // 永不回显 cookie ✓（warn 要说出来 ✗ 不然等于没查）
          setCk({ sessdata: "", bili_jct: "", buvid3: "" });
          if (j.self) updateAccount(j.self);
        } catch (e) { setCkMsg(`✗ ${e.message}`); } finally { setBusy(""); }
      };

      const updateAccount = ({ mid, name }) => {
        const self = { mid, name };
        setCfg((current) => ({ ...current, self }));
        setSavedJson((current) => current ? JSON.stringify({ ...JSON.parse(current), self }) : current);
      };

      if (!cfg) {
        return h("div", { className: "blw" },
          h("h3", { className: "blw-title" }, "养鱼"),
          err ? h("div", { className: "blw-err" }, err) : h("div", { className: "blw-hint" }, "读取中…"));
      }

      const groups = [];
      for (const f of FIELDS) {
        let g = groups.find((x) => x.name === f.group);
        if (!g) { g = { name: f.group, fields: [] }; groups.push(g); }
        g.fields.push(f);
      }
      // 渲染顺序（2026-10-22 主人定，见下面的 GROUP_ORDER）：
      //   她是谁 → 你（主人）→ 口味 → 作息 →【分享评论 + 全天监听】→ 日记与推送 → 消息推送 → 工具链
      // 2026-10-21：人设块 —— 挂在「她是谁」那一组下面 ✓（主人要求放这三个字段下面）
      const personaBlock = () => [
          h("div", { className: "blw-group" }, "她的人设（只属于她）"),
          h("div", { className: "blw-rows" },
            h("div", { className: "blw-row" },
              h("div", null,
                h("div", { className: "blw-label" }, "人设正文"),
                h("div", { className: "blw-hint" },
                  "单独保存在当前工作台，只用于养鱼会话。每次唤醒时读取。",
                  h("br"),
                  "建议写：身份与来历 / 说话腔调 / 在意什么、怕什么 / 明确不要的行为。上限 20000 字，注入时只取前 3000 字 ✓")),
              h("div", { className: "blw-cookie", style: { minWidth: "420px" } },
                h("textarea", {
                  className: "blw-input",
                  rows: 12,
                  placeholder: "例如：\n她的名字是…\n她说话时会…\n她在意…\n她绝对不会…",
                  value: personaText,
                  onChange: (e) => setPersonaText(e.target.value),
                  style: { resize: "vertical", fontFamily: "inherit", lineHeight: "1.6" },
                }),
                h("div", { className: "blw-hint" },
                  "当前 " + personaBytes + " 字节" + (personaText.length > 20000 ? "（超过 20000 上限 ✗）" : "")),
                h("button", { className: "blw-btn", onClick: injectPersona, disabled: !!busy || personaText.length > 20000 },
                  busy === "persona" ? "注入中…" : "注入人设"),
                personaMsg ? h("div", { className: personaMsg.startsWith("✓") ? "blw-hint" : "blw-err" }, personaMsg) : null))),
      ];

      const renderGroup = (g) => h("div", { key: g.name },
        h("div", { className: "blw-group" }, g.name),
        g.name === "作息" ? h(WindowsEditor, { cfg, set }) : null,
        h("div", { className: "blw-rows" }, g.fields.map((f) => h(Row, { key: f.path.join("."), f, cfg, set }))),
        // 2026-10-21：人设块放在这三个字段【下面】✓（主人要求）
        g.name === "她是谁" ? h("div", null, personaBlock()) : null);
      // 2026-10-22 修：分组顺序显式定死 ✗ 不再靠 FIELDS 里字段出现的先后
      //   （v0.4.2 把新字段插在 FIELDS 最前面 → 工具链跑到了第一位 ✗ 整个页面顺序乱了）
      //   主人定的顺序：她是谁 → 你 → 口味 → 作息 →【分享 / 监听】→ 日记与推送 → 消息推送 → 工具链
      const GROUP_ORDER = ["她是谁", "你（主人）", "口味", "作息"]
      const byName = (n) => groups.find((g) => g.name === n)
      const orderedTop = GROUP_ORDER.map(byName).filter(Boolean)
      // 2026-10-24 主人要求：「分享前检查」要提到「分享」前面 ✓
      const orderedPreShare = ["分享前检查"].map(byName).filter(Boolean)
      const orderedMid = ["日记与推送"].map(byName).filter(Boolean)
      const orderedTool = ["工具链"].map(byName).filter(Boolean)
      // 兜底：万一以后又加了新分组，别让它消失 ✗
      const known = new Set([...GROUP_ORDER, "分享前检查", "日记与推送", "工具链"])
      const leftovers = groups.filter((g) => !known.has(g.name))
      const ci = { className: "blw-input" };

      return h("div", { className: "blw" },
        h("h3", { className: "blw-title" }, "B 站"),
        !compact?h("div",{className:"blw-actions",style:{marginTop:0,paddingTop:0,borderTop:0}},
          h("button",{className:"blw-btn",onClick:()=>control(fishState.enabled||['checking','login-required','model-login-required'].includes(fishState.phase)?'pause':'start')},fishState.enabled||['checking','login-required','model-login-required'].includes(fishState.phase)?'暂停养鱼':'开始养鱼'),
          h("span",{role:"status",className:"blw-hint"},fishState.reason)):null,
        fishState.phase==='model-login-required'?h('button',{type:'button',className:'blw-btn blw-btn2',onClick:()=>document.querySelector('[data-slot="settings.launcher"] button[aria-haspopup="menu"]')?.click()},'登录账号'):null,

        h("div", { className: "blw-group" }, "B 站登录"),
        h("div", { className: "blw-row" },
          h("div", null,
            h("div", { className: "blw-label" }, cfg.self?.mid ? `当前账号：${cfg.self.name || '已登录'}` : "连接 B 站账号"),
            h("div", { className: "blw-hint" }, "手机确认后验证并保存登录态；失败或取消保留原登录态。")),
          h(QrLogin, { disabled: !!busy, onAccount: updateAccount, onActiveChange: setQrActive, autoStart:fishState.phase==='login-required' })),

        h("details", { className: "blw-details", 'data-settings': 'bilibili' },
        h("summary", null, "B 站详细设置"),
        h("p", {className:"blw-hint"},"使用工作台已登录的模型账号路线；可用额度与实际扣费需以账号记录为准。"),
        ...orderedTop.map(renderGroup),
        ...orderedPreShare.map(renderGroup),

        h(ShareEditor, { cfg, set }),
        h(ListenEditor, { cfg, set }),

        ...orderedMid.map(renderGroup),
        h(NotifyEditor, { cfg, set, save }),
        ...leftovers.map(renderGroup),
        h("details",null,h("summary",{className:"blw-hint",style:{cursor:"pointer"}},"高级设置"),...orderedTool.map(renderGroup)),

        h("details", null,
          h("summary", { className: "blw-hint", style: { cursor: "pointer", marginTop: "8px" } }, "手动导入 Cookie"),
        h("div", { className: "blw-rows" },
          h("div", { className: "blw-row" },
            h("div", null,
              h("div", { className: "blw-label" }, "凭据"),
              h("div", { className: "blw-hint" }, "浏览器 F12 → Cookie 里复制（SESSDATA 是 HttpOnly，console 拿不到 ✗）；写入后永不回显 ✓")),
            h("div", { className: "blw-cookie" },
              h("input", { ...ci, type: "password", autoComplete: "off", placeholder: "SESSDATA", value: ck.sessdata, onChange: (e) => setCk((s) => ({ ...s, sessdata: e.target.value })) }),
              h("input", { ...ci, type: "password", autoComplete: "off", placeholder: "bili_jct", value: ck.bili_jct, onChange: (e) => setCk((s) => ({ ...s, bili_jct: e.target.value })) }),
              h("input", { ...ci, type: "password", autoComplete: "off", placeholder: "buvid3（可空）", value: ck.buvid3, onChange: (e) => setCk((s) => ({ ...s, buvid3: e.target.value })) }),
              h("button", { className: "blw-btn blw-btn2", onClick: saveCookie, disabled: !!busy || qrActive || !ck.sessdata || !ck.bili_jct },
                busy === "cookie" ? "写入中…" : "写入凭据"),
              ckMsg ? h("div", { className: (ckMsg.startsWith("✓") ? "blw-hint blw-pre" : "blw-err") }, ckMsg) : null)))),
        h("div", { className: "blw-actions" },
          h("button", { className: "blw-btn", onClick: save, disabled: !!busy || qrActive }, busy === "save" ? "保存中…" : "保存"),
          cfg && savedJson && JSON.stringify(cfg) !== savedJson
            ? h("span", { style: { marginLeft: "10px", color: "#ffb020", fontSize: "13px" } }, "有改动尚未保存")
            : null,
          h("button", { className: "blw-btn blw-btn2", onClick: deps, disabled: !!busy }, busy === "deps" ? "体检中…" : "依赖体检"),
          h("button", { className: "blw-btn blw-btn2", onClick: load, disabled: !!busy || qrActive }, "重新读取")),

        out ? h("div", { className: "blw-out" }, out) : null),
        err ? h("div", { className: "blw-err", role: "alert" }, err) : null);
    }

    const inject = ["slots"];
    const NS = "bili-whale";
    const NAMES = { nav: "养鱼" };
    // Existing workbench Bigfish avatar; encoded locally for the embedded client.
    const FISH_ENTRY_AVATAR = "data:image/webp;base64,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";

    const ACTIVE_PHASES = ['checking','starting','login-required','model-login-required','scope-required','bound','connecting','running'];
    const channelActive = state => state?.enabled === true || ACTIVE_PHASES.includes(state?.phase);
    function channelStatus(state, qq = false) {
      if(!state)return '正在检查…';
      const labels={paused:'已暂停',checking:'正在检查',starting:'正在准备',
        'login-required':'等待扫码授权','model-login-required':'需要登录工作台账号',
        'scope-required':'请选择私聊或群聊服务范围',bound:'已绑定',connecting:'正在连接网关',running:'运行中',error:'未能启动'};
      const connection=qq?(state.connected===true?'网关已连接':state.bound===true?'已绑定；网关未连接':'尚未确认网关连接'):'';
      return [labels[state.phase]||'状态待确认',connection,state.reason].filter(Boolean).join(' · ');
    }
    function simpleStatus(state) {
      if(!state)return '正在检查…';
      if(state.phase==='error')return state.reason||'连接未完成，请重试';
      if(state.phase==='scope-required')return '请展开 QQ 详细设置，选择服务范围';
      if(state.phase==='running')return state.connected===false?'正在连接…':'已就绪';
      return {paused:'已暂停',checking:'正在检查…',starting:'正在准备…',
        'login-required':'请扫码连接','model-login-required':'请先登录工作台账号',
        bound:'已绑定，正在连接…',connecting:'正在连接…'}[state.phase]||'正在检查…';
    }

    function QQPrivatePairing({available}) {
      const [state,setState]=useState(null),[challenge,setChallenge]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState(''),[completed,setCompleted]=useState(false);
      const alive=useRef(false),revision=useRef(0);
      const request=useCallback(async(action)=>{
        const options=action?{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({action})}:{headers:{accept:'application/json'}};
        const response=await fetch('/qqbot-workbench/private-pairing',options);
        const value=await response.json();
        if(!response.ok) throw new Error(value?.code||'PAIRING_REQUEST_FAILED');
        return value;
      },[]);
      const refresh=useCallback(async()=>{
        if(!available)return;
        const version=revision.current;
        try{const next=await request();if(alive.current&&version===revision.current){setState(next);if(!next.active)setChallenge('');}}
        catch{if(alive.current)setError('配对状态暂不可用，请重试。');}
      },[available,request]);
      useEffect(()=>{
        alive.current=true;
        if(available){void refresh();const timer=setInterval(()=>void refresh(),1500);return()=>{alive.current=false;clearInterval(timer);};}
        setState(null);setChallenge('');return()=>{alive.current=false;};
      },[available,refresh]);
      const action=async(name)=>{
        if(pending)return;
        revision.current++;setPending(true);setError('');
        try{
          const next=await request(name);
          revision.current++;
          if(!alive.current)return;
          if(name==='begin'){setCompleted(false);setChallenge(next.challenge||'');setState(next);}
          else {setChallenge('');setState(null);setCompleted(name==='confirm');}
          if(name!=='confirm')await refresh();
        }catch(e){revision.current++;if(alive.current)setError(e?.message==='PAIRING_SCOPE_CHANGED'?'请关闭群聊，并将私聊范围设为关闭或仅保留一个白名单账号后重试。':e?.message==='PAIRING_ALREADY_ACTIVE'?'已有配对进行中，请先取消。':e?.message==='PAIRING_NOT_CONNECTED'?'QQ 机器人尚未绑定或网关未连接，请稍后重试。':'配对未完成，请重试。');}
        finally{if(alive.current)setPending(false);}
      };
      if(!available)return null;
      return h('section',{className:'blw-details','aria-label':'QQ 私聊账号配对'},
        h('h4',null,'QQ 私聊账号配对'),
        h('p',{className:'blw-hint'},'绑定机器人后，开始配对并从你的 QQ 私聊发送配对码。配对期间不会回复其他消息；确认后仅允许该 QQ 私聊，群聊保持关闭。'),
        completed?h('p',{role:'status'},'私聊配对已确认；仅允许该 QQ 私聊，群聊仍关闭。'):null,
        state?.active? h('div',null,
          challenge?h('p',null,'向 QQ 机器人发送：',h('code',{style:{userSelect:'text',wordBreak:'break-all'}},'QQ配对 '+challenge)):
            h('p',{className:'blw-hint'},'已有配对正在进行，如未保存配对码可取消后重新开始。'),
          h('p',{role:'status'},state.matched?'已收到配对码，请确认绑定。':state.connected?'等待 QQ 消息，配对码 5 分钟内有效。':'正在连接 QQ 网关…'),
          h('button',{type:'button',className:'blw-btn',disabled:pending||!state.matched||!state.connected,onClick:()=>void action('confirm')},'确认绑定此 QQ'),
          h('button',{type:'button',className:'blw-btn blw-btn2',disabled:pending,onClick:()=>void action('cancel')},'取消配对')):
          h('button',{type:'button',className:'blw-btn blw-btn2',disabled:pending||!state,onClick:()=>void action('begin')},'开始私聊配对'),
        error?h('p',{role:'alert',className:'blw-err'},error):null);
    }

    // The host controls the QQ plugin lifecycle. Its own UI owns binding and
    // access settings; mounting this view never starts QQ without a click.
    function QQBotSettings({ compact = false } = {}) {
      const [state,setState]=useState(null),[busy,setBusy]=useState(false),[section,setSection]=useState(null);
      const [moduleError,setModuleError]=useState(false),[moduleAttempt,setModuleAttempt]=useState(0),alive=useRef(false),flight=useRef(null),revision=useRef(0),operation=useRef(0);
      const settingsReady=state?.enabled===true&&!['starting','checking','model-login-required','paused'].includes(state?.phase);
      const invoke=useCallback(async action=>{
        if(flight.current&&(action!=='pause'||flight.current==='pause'))return;
        const bridge=window.nekoWorkbench;
        if(typeof bridge?.qqbot!=='function'){setState({enabled:false,phase:'error',reason:'QQ 服务尚不可用，请检查工作台连接。'});return;}
        const request=++operation.current,version=revision.current;
        flight.current=action;setBusy(true);
        try{
          const next=await bridge.qqbot(action);
          if(alive.current&&request===operation.current&&version===revision.current)setState(next&&typeof next==='object'?next:{enabled:false,phase:'error',reason:'QQ 服务状态不可用。'});
        }catch{
          if(alive.current&&request===operation.current&&version===revision.current)setState({enabled:false,phase:'error',reason:'QQ 服务操作未完成，请重试。'});
        }finally{if(request===operation.current){flight.current=null;if(alive.current)setBusy(false);}}
      },[]);
      useEffect(()=>{alive.current=true;const off=window.nekoWorkbench?.subscribe?.(next=>{const value=next.qqbot||next.fishQq?.qqbot;if(alive.current&&value){revision.current++;setState(value);}});void invoke('status');return()=>{alive.current=false;operation.current++;off?.();};},[invoke]);
      useEffect(()=>{
        if(!settingsReady){setSection(null);setModuleError(false);return;}
        let stopped=false,script;
        const resolveModule=()=>{
          if(stopped)return false;
          try{const mod=require('@bigfish/qqbot-settings');if(typeof mod?.QQBotSettingsSection==='function'){setSection(()=>mod.QQBotSettingsSection);setModuleError(false);return true;}}catch{}
          return false;
        };
        setModuleError(false);
        if(!resolveModule()){
          // Same-origin application-owned client bundle; never load a remote
          // script or expose the QQ credential to this panel.
          script=document.createElement('script');script.src='/qqbot-workbench/client.js';script.async=true;
          script.onload=()=>{if(!resolveModule()&&!stopped)setModuleError(true);};
          script.onerror=()=>{if(!stopped)setModuleError(true);};
          document.head.appendChild(script);
        }
        return()=>{stopped=true;if(script){script.onload=null;script.onerror=null;script.remove();}};
      },[settingsReady,moduleAttempt]);
      useEffect(()=>{
        if(state?.phase!=='starting')return;
        const timer=setInterval(()=>void invoke('status'),1000);return()=>clearInterval(timer);
      },[state?.phase,invoke]);
      const enabled=state?.enabled===true,active=channelActive(state)||flight.current==='start';
      return h('div',{className:'blw',role:'region','aria-label':'QQ 机器人设置'},
        h('h3',{className:'blw-title'},'QQ 机器人'),
        !compact?h('p',{className:'blw-intro'},'连接 QQ 机器人后，可按授权范围参与私聊或群聊。'):null,
        h('div',{className:'blw-actions',style:{marginTop:0,paddingTop:0,borderTop:0}},
          !compact||!active?h('button',{className:'blw-btn',type:'button',disabled:!state||(busy&&flight.current!=='start'),onClick:()=>void invoke(active?'pause':'start')},
            flight.current==='pause'?'正在暂停…':active?'暂停 QQ 机器人':busy?'正在处理…':compact?'扫码连接 QQ':'开始连接 QQ'):null,
          h('span',{role:'status',className:'blw-hint'},compact?simpleStatus(state):channelStatus(state,true))),
        state?.phase==='model-login-required'?h('button',{type:'button',className:'blw-btn blw-btn2',onClick:()=>document.querySelector('[data-slot="settings.launcher"] button[aria-haspopup="menu"]')?.click()},'登录工作台账号'):null,
        settingsReady?(section?h(section):moduleError?h('div',null,h('p',{className:'blw-err'},'QQ 设置暂未加载，请重试。'),h('button',{type:'button',className:'blw-btn blw-btn2',onClick:()=>setModuleAttempt(n=>n+1)},'重试 QQ 设置')):h('p',{className:'blw-hint'},'正在打开 QQ 绑定设置…')):enabled?h('p',{className:'blw-hint'},'工作台账号与 QQ 服务准备完成后，将显示绑定与服务范围设置。'):null,
        h(QQPrivatePairing,{available:settingsReady&&state?.bound===true}),
        compact&&active?h('details',{className:'blw-details'},h('summary',null,'QQ 连接管理'),
          h('p',{className:'blw-hint'},channelStatus(state,true)),
          h('button',{type:'button',className:'blw-btn blw-btn2',disabled:busy&&flight.current!=='start',onClick:()=>void invoke('pause')},'暂停 QQ 机器人')):null);
    }

    function FishLauncher(){
        useStyleOnce();
        const [opened,setOpened]=useState(false),[settingsTab,setSettingsTab]=useState('fish'),seen=useRef(0);
        const [snapshot,setSnapshot]=useState(null),[pending,setPending]=useState(null),[error,setError]=useState('');
        const alive=useRef(false),request=useRef(0),flight=useRef(null),suppressAuthorization=useRef(false),lastAuthorization=useRef(''),lastOverall=useRef('idle');
        const update=useCallback(next=>{
          if(!alive.current)return;
          const revision=Number(next?.navigation?.fishSettingsRevision||0);
          if(revision>seen.current){seen.current=revision;setOpened(true);}
          const value=next?.fishQq;
          if(!value)return;
          setSnapshot(value);
          if(value.overall==='starting'&&lastOverall.current!=='starting'&&flight.current!=='pause')suppressAuthorization.current=false;
          lastOverall.current=value.overall;
          const selection=value.selection||{fish:true,qqbot:false};
          const target=selection.fish&&['login-required','model-login-required'].includes(value.fish?.phase)?'fish':
            selection.qqbot&&['login-required','model-login-required','scope-required'].includes(value.qqbot?.phase)?'qq':'';
          if(!suppressAuthorization.current&&value.overall!=='pausing'&&target&&lastAuthorization.current!==target)setSettingsTab(target);
          lastAuthorization.current=target;
        },[]);
        useEffect(()=>{
          alive.current=true;let received=false;
          const bridge=window.nekoWorkbench;
          const off=bridge?.subscribe?.(next=>{received=true;update(next);});
          const initial=typeof bridge?.getState==='function'?bridge.getState():
            typeof bridge?.fishQq==='function'?bridge.fishQq({action:'status'}).then(fishQq=>({fishQq})):Promise.resolve({});
          Promise.resolve(initial).then(next=>{if(!received)update(next);}).catch(()=>{if(alive.current)setError('连接状态暂不可用，请重试。');});
          const escape=e=>{if(e.key==='Escape')setOpened(false);};window.addEventListener('keydown',escape);
          return()=>{alive.current=false;request.current++;off?.();window.removeEventListener('keydown',escape);};
        },[update]);
        const invoke=async(action,selection)=>{
          if(flight.current&&(action!=='pause'||flight.current==='pause'))return;
          if(typeof window.nekoWorkbench?.fishQq!=='function'){setError('统一启动服务尚不可用，请检查工作台连接。');return;}
          const generation=++request.current;
          flight.current=action;setPending(action);setError('');
          if(action==='pause'){suppressAuthorization.current=true;lastAuthorization.current='';}
          if(action==='start'){suppressAuthorization.current=false;lastAuthorization.current='';}
          try{
            const value=await window.nekoWorkbench.fishQq({action,...(selection?{selection}:{})});
            if(alive.current&&generation===request.current)update({fishQq:value});
          }catch{
            if(alive.current&&generation===request.current)setError('操作未能完成，请检查连接后重试。');
          }finally{if(generation===request.current){flight.current=null;if(alive.current)setPending(null);}}
        };
        const selection=snapshot?.selection||{fish:true,qqbot:false};
        const active=pending==='start'||snapshot?.overall==='starting'||channelActive(snapshot?.fish)||channelActive(snapshot?.qqbot);
        const pausing=pending==='pause'||snapshot?.overall==='pausing';
        const choosing=pending==='select';
        const open=()=>{if(window.nekoWorkbench?.action)window.nekoWorkbench.action('fish-settings').catch(()=>{});else setOpened(true);};
        return h(React.Fragment,null,
          h('button',{type:'button',title:'一键养鱼','aria-label':'养鱼设置',style:{display:'inline-flex',alignItems:'center',gap:8,cursor:'pointer',color:'inherit',background:'transparent',border:0,padding:'4px 10px',font:'inherit'},onClick:open},h('img',{src:FISH_ENTRY_AVATAR,alt:'',width:32,height:32,style:{objectFit:'contain',borderRadius:8}}),'养鱼'),
          opened?createPortal(h('aside',{role:'region','aria-label':'连接与生活设置',style:{position:'fixed',top:16,right:12,bottom:36,width:'min(760px,calc(100vw - 24px))',boxSizing:'border-box',zIndex:60,overflow:'auto',padding:24,background:'var(--dsw-alias-bg-layer-2)',color:'var(--dsw-alias-label-primary)',borderRadius:16,boxShadow:'0 8px 40px #0003'}},
            h('header',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:16}},h('strong',null,'一键养鱼'),h('button',{type:'button',onClick:()=>setOpened(false),style:{cursor:'pointer',color:'inherit',border:'1px solid var(--dsw-alias-border-l2)',background:'transparent',padding:'5px 10px',borderRadius:6}},'返回工作台')),
            h('section',{'aria-label':'统一启动与状态',className:'blw',style:{marginBottom:20}},
              h('div',{className:'blw-actions',style:{marginTop:4,paddingTop:0,borderTop:0}},
                h('button',{type:'button',className:'blw-btn',disabled:pausing||choosing||(!active&&!selection.fish&&!selection.qqbot),onClick:()=>void invoke(active?'pause':'start')},pausing?'正在暂停…':active?'全部暂停':'一键养鱼'),
                h('span',{className:'blw-hint'},'首次扫码连接，之后一键开始。保持电脑和工作台开启即可按作息活动。')),
              h('div',{role:'status','aria-live':'polite',className:'blw-hint'},`B 站：${selection.fish?simpleStatus(snapshot?.fish):'未启用'}`),
              h('div',{role:'status','aria-live':'polite',className:'blw-hint'},`QQ：${selection.qqbot?simpleStatus(snapshot?.qqbot):'未启用'}`),
              error?h('p',{role:'alert',className:'blw-err'},error):null),
            h('div',{role:'tablist','aria-label':'连接与生活设置',style:{display:'flex',gap:8,marginBottom:16}},
              h('button',{role:'tab',type:'button','aria-selected':settingsTab==='fish',onClick:()=>setSettingsTab('fish'),className:'blw-btn blw-btn2',style:{fontWeight:settingsTab==='fish'?600:400}},'B 站扫码'),
              h('button',{role:'tab',type:'button','aria-selected':settingsTab==='qq',onClick:()=>setSettingsTab('qq'),className:'blw-btn blw-btn2',style:{fontWeight:settingsTab==='qq'?600:400}},'QQ 扫码')),
            h('div',{hidden:settingsTab!=='fish'},h(BiliWhaleSection,{compact:true})),settingsTab==='qq'?h(QQBotSettings,{compact:true}):null,
            h('details',{className:'blw-details','data-settings':'channels'},h('summary',null,'启动详细设置'),
              h('div',{style:{display:'flex',gap:16,flexWrap:'wrap',marginTop:8}},
                ...[['fish','B 站养鱼'],['qqbot','QQ 机器人']].map(([key,label])=>h('label',{key,style:{display:'flex',alignItems:'center',gap:6}},
                  h('input',{type:'checkbox','aria-label':`启用${label}`,checked:selection[key]===true,disabled:!!pending||snapshot?.unified===true,onChange:event=>void invoke('select',{...selection,[key]:event.target.checked})}),label))),
              h('p',{className:'blw-hint'},'一键养鱼会启动勾选的功能。模型使用工作台已登录账号路线；额度无法确认，请以账号使用记录为准。'),
              h('div',{className:'blw-hint'},`B 站养鱼：${channelStatus(snapshot?.fish)}`),
              h('div',{className:'blw-hint'},`QQ 机器人：${channelStatus(snapshot?.qqbot,true)}`))),document.body):null);
    }

    function apply(ctx) {
      ctx.effect(()=>ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'neko-fish-care',order:30},FishLauncher)),'fish settings entry');
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.BiliWhaleSection = BiliWhaleSection;
    exports.QQBotSettings = QQBotSettings;
    exports.QQPrivatePairing = QQPrivatePairing;
    exports.FishLauncher = FishLauncher;
    exports.FIELDS = FIELDS;
    return module.exports;
  },
});
