'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ArrowRight, Plus, Search, Bookmark, Check, X, Menu, Copy, Trash2, LoaderCircle, Gamepad2, Lightbulb, Sparkles, Eye, Layers, Shield, ChevronRight } from 'lucide-react';
import { curated, categories, type Entry } from './catalog';

type ApiResponse = { entries?: Entry[]; signedIn?: boolean; displayName?: string; canPublish?: boolean; error?: string; saved?: boolean; id?: string };
const stages = { concept: '规则创意', prototype: '原型展示', playable: '可游玩' };
const clips = [
  { id: 'workbench', name: '创造台记录', caption: 'Nekofans 办公版中的任务与交付记录。' },
  { id: 'rules', name: '私密规则提交', caption: '玩家在本方页面填写并提交隐藏规则的界面实录。' },
  { id: 'host', name: '主持台界面', caption: '主持台的受控操作区。此片段不代表完整自动模型对局。' },
];

function Brand() {
  return <a href="#top" className="brand" aria-label="Nekofans.Game 首页"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M8 29V11l24 18V11M20 5v30" /></svg><span>Nekofans<span className="brand-dot">.</span>Game</span></a>;
}

function EntryArt({ entry }: { entry: Entry }) {
  if (entry.curated && entry.kind === 'game') return <div className="game-art original-art"><img src="/assets/rules-poster.webp" alt="开源与抹除的棋盘与规则提交界面实录" loading="lazy" /><span className="art-caption"><span className="live-dot" /> 界面实录</span><span className="game-art-title">开源 <em>×</em> 抹除</span></div>;
  return <div className={`game-art generated-art tone-${categories.indexOf(entry.category)}`} aria-hidden="true"><div className="art-grid" /><span className="art-symbol">{entry.category === '棋盘智斗' ? '♜' : entry.category === '文字博弈' ? '言' : entry.category === '派对推理' ? '?' : '∞'}</span><span className="art-label">{entry.category}</span></div>;
}

export default function GameWorld() {
  const [entries, setEntries] = useState<Entry[]>(curated);
  const [signedIn, setSignedIn] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [canPublish, setCanPublish] = useState(false);
  const [serviceError, setServiceError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [sort, setSort] = useState('latest');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [menu, setMenu] = useState(false);
  const [detail, setDetail] = useState<Entry | null>(null);
  const [compose, setCompose] = useState<'game' | 'rule' | null>(null);
  const [toast, setToast] = useState('');
  const [activeClip, setActiveClip] = useState(0);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/entries', { cache: 'no-store' });
      const data = await response.json() as ApiResponse;
      if (Array.isArray(data.entries)) setEntries(data.entries);
      setSignedIn(!!data.signedIn); setDisplayName(data.displayName || '');
      setCanPublish(!!data.canPublish); setServiceError(data.error || '');
    } catch { setServiceError('暂时无法连接投稿服务，已有作品仍可浏览。'); setCanPublish(false); }
  }, []);
  useEffect(() => { refresh(); try { const saved = JSON.parse(localStorage.getItem('nekofans-game-favorites') || '[]'); if (Array.isArray(saved)) setFavorites(saved.filter(x => typeof x === 'string')); } catch { /* empty local preference */ } }, [refresh]);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(''), 3200); return () => window.clearTimeout(t); }, [toast]);
  useEffect(() => {
    const el = dialog.current; if (!el) return;
    if (detail || compose) { if (!el.open) el.showModal(); document.body.classList.add('modal-open'); }
    else { if (el.open) el.close(); document.body.classList.remove('modal-open'); }
    return () => document.body.classList.remove('modal-open');
  }, [detail, compose]);
  useEffect(() => { const url = new URL(window.location.href); if (url.searchParams.get('publish') === 'game' || url.searchParams.get('publish') === 'rule') { setCompose(url.searchParams.get('publish') as 'game' | 'rule'); url.searchParams.delete('publish'); window.history.replaceState(null, '', url.pathname + url.search + url.hash); } }, []);

  function bookmark(id: string) {
    const next = favorites.includes(id) ? favorites.filter(x => x !== id) : [...favorites, id];
    setFavorites(next);
    try { localStorage.setItem('nekofans-game-favorites', JSON.stringify(next)); setToast(next.includes(id) ? '已加入本机收藏' : '已移出本机收藏'); }
    catch { setToast('浏览器无法保存收藏，请检查存储权限。'); }
  }
  function openCompose(kind: 'game' | 'rule') { setDetail(null); setCompose(kind); setFormError(''); setDeleteConfirm(false); }
  function closeModal() { if (pending) return; setDetail(null); setCompose(null); setDeleteConfirm(false); setFormError(''); }
  async function copyRule(entry: Entry) {
    try { await navigator.clipboard.writeText(entry.title + '\n\n' + entry.body + '\n\n创作者：' + entry.creator + ' · Nekofans.Game'); setToast('规则已复制，使用前记得与对手约定边界。'); }
    catch { setToast('复制未成功，可以在详情中选择规则文字。'); setDetail(entry); }
  }
  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!compose || pending) return;
    const form = new FormData(event.currentTarget);
    setFormError(''); setPending(true);
    try {
      const payload = Object.fromEntries(form.entries());
      const response = await fetch('/api/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, kind: compose, tags: String(payload.tags || '').split(/[,，]/).map(x => x.trim()).filter(Boolean) }) });
      const data = await response.json() as ApiResponse;
      if (!response.ok || !data.saved) throw new Error(data.error || '发布失败，请稍后再试。');
      setCompose(null); setToast(compose === 'game' ? '游戏已发布，去广场看看吧。' : '规则已发布，你的灵感已加入规则库。');
      setQuery(''); setCategory('全部'); setFavoritesOnly(false); await refresh();
    } catch (error) { setFormError(error instanceof Error ? error.message : '保存失败，请稍后再试。'); }
    finally { setPending(false); }
  }
  async function removeEntry() {
    if (!detail || pending) return; setPending(true);
    try {
      const response = await fetch('/api/entries/' + encodeURIComponent(detail.id), { method: 'DELETE' });
      const data = await response.json() as ApiResponse; if (!response.ok) throw new Error(data.error || '删除失败');
      setDetail(null); setDeleteConfirm(false); setToast('已删除这份投稿。'); await refresh();
    } catch (error) { setToast(error instanceof Error ? error.message : '删除失败'); }
    finally { setPending(false); }
  }

  const matches = (entry: Entry) => (!query.trim() || [entry.title, entry.summary, entry.creator, ...entry.tags].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && (!favoritesOnly || favorites.includes(entry.id));
  const games = entries.filter(e => e.kind === 'game' && matches(e) && (category === '全部' || e.category === category)).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh') : b.createdAt - a.createdAt);
  const rules = entries.filter(e => e.kind === 'rule' && matches(e)).sort((a, b) => b.createdAt - a.createdAt);
  const creatorCount = new Set(entries.map(e => e.creator)).size;

  return <>
    <a href="#games" className="skip-link">跳转到游戏广场</a>
    <header className="site-header">
      <div className="nav-wrap"><Brand />
        <nav className={menu ? 'main-nav is-open' : 'main-nav'} aria-label="主导航">
          <a href="#games" onClick={() => setMenu(false)}>发现游戏</a><a href="#rules" onClick={() => setMenu(false)}>规则灵感</a><a href="#creators" onClick={() => setMenu(false)}>创作者</a><a href="#about" onClick={() => setMenu(false)}>关于智斗</a>
        </nav>
        <div className="nav-actions"><button className="icon-button nav-bookmark" title="查看本机收藏" aria-label="查看本机收藏" onClick={() => { setFavoritesOnly(true); setQuery(''); setCategory('全部'); document.getElementById('games')?.scrollIntoView({ behavior: 'smooth' }); }}><Bookmark size={19} /></button><button className="button small lime" onClick={() => openCompose('game')}><Plus size={16} /><span>发布创作</span></button><button className="menu-toggle icon-button" aria-label={menu ? '关闭导航' : '打开导航'} aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X /> : <Menu />}</button></div>
      </div>
    </header>

    <main id="top">
      <section className="hero" aria-labelledby="hero-title">
        <img className="hero-image" src="/assets/duel-concept.webp" alt="梁文峰抱着大肥鱼，与达里奥和端庄的 Claude 角色隔棋盘对峙的概念插画" fetchPriority="high" />
        <div className="hero-shade" /><div className="hero-grid" aria-hidden="true" />
        <div className="hero-inner container">
          <div className="eyebrow hero-eyebrow"><span className="live-dot" /> PLAYER-CREATED WORLDS</div>
          <h1 id="hero-title">游戏人生，<br />规则由你<span className="hero-accent">来写。</span></h1>
          <p className="hero-copy">发现玩家创造的智斗游戏，分享天马行空的规则。<br className="desktop-break" />和人类、AI 队友一起，让每一步都值得猜。</p>
          <div className="hero-buttons"><a className="button lime" href="#games">发现智斗游戏 <ArrowUpRight size={19} /></a><button className="hero-text-button" onClick={() => openCompose('rule')}>分享我的规则 <ArrowRight size={18} /></button></div>
          <div className="hero-note"><span className="hero-note-line" /><span>一个约定，无限种游戏。<br /><b>Nekofans.Game · 玩家原创企划</b></span></div>
        </div>
        <span className="concept-label">角色与对局概念演绎</span>
        <div className="hero-side-note" aria-hidden="true">CREATE. PLAY. OUTSMART.</div>
      </section>

      <div className="world-strip"><div className="container strip-inner"><span><span className="tiny-star">✳</span> 想象力是入场券</span><span>游戏由玩家创造</span><span>规则由双方约定</span><span>胜负在思考之间</span><a href="#about">了解智斗 <ArrowUpRight size={16} /></a></div></div>

      <section className="games-section container section-space" id="games" aria-labelledby="games-title">
        <div className="section-heading"><div><div className="eyebrow">01 / GAME GALLERY</div><h2 id="games-title">下一场智斗，<span className="muted">玩什么？</span></h2><p>从棋盘到文字，从一个脑洞到一场对局。来发现玩家的游戏世界。</p></div><button className="text-link" onClick={() => openCompose('game')}>投稿你的游戏 <Plus size={18} /></button></div>
        <div className="discovery-toolbar"><label className="search-box"><Search size={18} /><input ref={search} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索游戏、规则、创作者" aria-label="搜索游戏、规则、创作者" />{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="清除搜索"><X size={16} /></button>}</label><label className="sort-label"><span>排序</span><select value={sort} onChange={e => setSort(e.target.value)} aria-label="游戏排序"><option value="latest">最新发布</option><option value="title">标题顺序</option></select></label></div>
        <div className="filter-row"><div className="category-filters" role="group" aria-label="游戏分类">{['全部', ...categories].map(c => <button key={c} className={category === c && !favoritesOnly ? 'filter-chip active' : 'filter-chip'} aria-pressed={category === c && !favoritesOnly} onClick={() => { setCategory(c); setFavoritesOnly(false); }}>{c}</button>)}</div><button className={'favorite-filter ' + (favoritesOnly ? 'active' : '')} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}><Bookmark size={15} /> 本机收藏</button></div>
        {serviceError && <div className="service-note" role="status">{serviceError} <button onClick={refresh}>重试连接</button></div>}
        {games.length > 0 ? <div className="game-list">{games.map(entry => <article key={entry.id} className={'game-card ' + (entry.curated ? 'featured-game' : '')}>
          <button className="game-cover-button" onClick={() => { setDetail(entry); setDeleteConfirm(false); }} aria-label={'查看' + entry.title}><EntryArt entry={entry} /></button>
          <div className="game-content"><div className="game-topline"><span className="status-tag">{entry.stage === 'concept' ? '玩法概念' : stages[entry.stage]}</span>{entry.curated && <span className="first-release"><Sparkles size={13} /> 首位创作者作品</span>}</div><button className="title-button" onClick={() => { setDetail(entry); setDeleteConfirm(false); }}><h3>{entry.title}</h3></button><p>{entry.summary}</p><div className="tags">{entry.tags.map(t => <span key={t}>{t}</span>)}</div><div className="game-footer"><span className="creator-inline"><span className="avatar">{entry.creator.slice(0, 1)}</span><span>{entry.creator}<small>{entry.curated ? '首位创作者' : '原创投稿'}</small></span></span><div className="card-actions"><button className={'icon-button bookmark-button ' + (favorites.includes(entry.id) ? 'saved' : '')} onClick={() => bookmark(entry.id)} aria-label={favorites.includes(entry.id) ? '取消收藏' + entry.title : '收藏' + entry.title}><Bookmark size={18} fill={favorites.includes(entry.id) ? 'currentColor' : 'none'} /></button><button className="round-arrow" onClick={() => setDetail(entry)} aria-label={'打开' + entry.title}><ArrowUpRight size={21} /></button></div></div></div>
        </article>)}</div> : <div className="empty-state"><Gamepad2 size={32} /><h3>{query ? '还没有找到这个脑洞' : favoritesOnly ? '你的游戏收藏夹还是空的' : '这个世界，等第一份作品'}</h3><p>{query ? '换个关键词试试，或把它变成你自己的游戏。' : favoritesOnly ? '点一下作品旁的书签，就能在这台设备上找到它。' : '你可以成为这个分区的第一位创作者。'}</p><button className="button dark" onClick={() => { if (favoritesOnly || query) { setFavoritesOnly(false); setQuery(''); setCategory('全部'); } else openCompose('game'); }}>{favoritesOnly || query ? '查看全部游戏' : '发布第一个游戏'}<ArrowRight size={17} /></button></div>}
        <div className="gallery-foot"><span>{games.length} 款游戏{query ? '符合搜索' : '正在展示'}</span><span>更多世界，等你来创造 <span aria-hidden="true">↗</span></span></div>
      </section>

      <section className="rules-section" id="rules" aria-labelledby="rules-title"><div className="container section-space">
        <div className="section-heading"><div><div className="eyebrow">02 / RULE LABORATORY</div><h2 id="rules-title">一个好规则，<span className="muted">能改变整局。</span></h2><p>分享可公开的规则灵感。对局中的秘密，留给女神私密接收。</p></div><button className="text-link" onClick={() => openCompose('rule')}>分享规则创意 <Plus size={18} /></button></div>
        <div className="rule-grid">{rules.map((entry, i) => <article key={entry.id} className="rule-card"><div className="rule-top"><span className="rule-index">{String(i + 1).padStart(2, '0')}</span><span className="rule-category">{entry.tags[0] || entry.category}</span><button className={'icon-button ' + (favorites.includes(entry.id) ? 'saved' : '')} onClick={() => bookmark(entry.id)} aria-label={favorites.includes(entry.id) ? '取消收藏' + entry.title : '收藏' + entry.title}><Bookmark size={17} fill={favorites.includes(entry.id) ? 'currentColor' : 'none'} /></button></div><button className="title-button" onClick={() => setDetail(entry)}><h3>{entry.title}</h3></button><p>{entry.summary}</p><div className="rule-tags">{entry.tags.slice(1).map(t => <span key={t}># {t}</span>)}</div><div className="rule-bottom"><span>by {entry.creator}</span><button className="rule-open" onClick={() => setDetail(entry)} aria-label={'阅读' + entry.title + '的完整规则'}>展开规则 <ArrowUpRight size={16} /></button></div></article>)}<button className="rule-invitation" onClick={() => openCompose('rule')}><span className="idea-mark"><Lightbulb size={32} strokeWidth={1.3} /></span><span className="invitation-title">你的脑洞，<br />值得成为一条规则。</span><span className="invitation-copy">胜负条件、信息差、意外的代价……<br />下一次让人拍桌的反转，或许来自你。</span><span className="invitation-action">写下你的规则 <Plus size={18} /></span></button></div>
        {rules.length === 0 && <p className="rule-empty">{favoritesOnly ? '还没有收藏的规则。可以清除上方收藏筛选，再去寻找灵感。' : '没有匹配的规则，试试别的关键词。'}</p>}
      </div></section>

      <section className="creator-section container section-space" id="creators" aria-labelledby="creators-title"><div className="creator-heading"><div className="eyebrow">03 / THE FIRST CREATOR</div><h2 id="creators-title">世界的第一笔，<br />有人已经写下。</h2><p>每个新世界，都从某个人的一个想法开始。<br />接下来的故事，欢迎你一起创造。</p><span className="creator-count">{creatorCount} 位创作者 · {entries.filter(e => e.kind === 'game').length} 款游戏 · {entries.filter(e => e.kind === 'rule').length} 条规则</span></div><div className="founder-card"><div className="founder-illustration"><div className="founder-ring" /><img src="/assets/bigfish.webp" alt="A.kira 创作中的大肥鱼桌宠形象" loading="lazy" /><span className="pet-note">决策队友 · 大肥鱼</span></div><div className="founder-copy"><span className="founder-badge"><span className="live-dot" /> 首位创作者</span><h3>A.kira<span>↗</span></h3><p>从「开源与抹除」开始，<br />探索隐藏规则与 AI 队友的智斗可能。</p><button className="text-link" onClick={() => { setQuery('A.kira'); setCategory('全部'); setFavoritesOnly(false); document.getElementById('games')?.scrollIntoView({ behavior: 'smooth' }); }}>查看 A.kira 的创作 <ArrowRight size={17} /></button></div></div></section>

      <section className="about-section" id="about" aria-labelledby="about-title"><div className="container section-space"><div className="about-top"><div><div className="eyebrow">THE SPIRIT OF MIND GAMES</div><h2 id="about-title">共同约定舞台，<br />用想象力展开智斗。</h2></div><p>从《游戏人生》的规则博弈中汲取灵感，让玩家创造自己的游戏。棋盘只是起点；文字、派对、推理，都可以成为新的舞台。玩法、边界和胜利条件，由对局双方共同约定。</p></div><div className="play-steps">{[['01', '先约定', '确定共同规则、能力边界与胜利条件。'], ['02', '藏一条', '把本方秘密规则私下交给女神。'], ['03', '再试探', '观察公开行动，和本方队友一起推理。'], ['04', '见分晓', '按本局约定决出胜负，复盘你的妙手。']].map(([n, title, copy]) => <div className="play-step" key={n}><span>{n}</span><h3>{title}</h3><p>{copy}</p></div>)}</div><div className="role-line"><div><Layers size={22} /><span><b>创造台</b><small>做游戏、改游戏、分享链接</small></span></div><div><Shield size={22} /><span><b>女神</b><small>中立接收双方隐藏规则，主持本局</small></span></div><div><Eye size={22} /><span><b>大肥鱼</b><small>本方决策队友，只看允许的信息</small></span></div></div></div></section>

      <section className="footage-section container section-space" aria-labelledby="footage-title"><div className="section-heading"><div><div className="eyebrow">FROM IMAGINATION TO SCREEN</div><h2 id="footage-title">脑洞之外，<span className="muted">也有实机。</span></h2><p>A.kira 的开发记录。先看看这个世界是怎样被做出来的。</p></div><span className="footage-label"><span className="live-dot" /> 本地录屏 · 无音轨</span></div><div className="footage-layout"><div className="video-frame"><video key={clips[activeClip].id} controls playsInline preload="none" poster={'/assets/' + clips[activeClip].id + '-poster.webp'} aria-label={clips[activeClip].name + '实机录屏'}><source src={'/assets/' + clips[activeClip].id + '.mp4'} type="video/mp4" />你的浏览器暂不支持视频播放。</video></div><div className="clip-list">{clips.map((clip, i) => <button key={clip.id} className={activeClip === i ? 'clip-choice active' : 'clip-choice'} aria-pressed={activeClip === i} onClick={() => setActiveClip(i)}><span className="clip-number">0{i + 1}</span><span><b>{clip.name}</b><small>{clip.caption}</small></span><ChevronRight size={20} /></button>)}<div className="footage-note">概念图用于表达创作方向，实录用于展示已有界面。完整连续智斗对局仍在补充。</div></div></div></section>

      <section className="closing-section"><div className="container closing-inner"><span className="closing-star" aria-hidden="true">✳</span><div><div className="eyebrow">YOUR WORLD IS NEXT</div><h2>下一条规则，<br className="mobile-break" />由你创造。</h2><p>分享你的游戏，或先写下一个让人意想不到的规则。</p></div><button className="button lime" onClick={() => openCompose('game')}>发布我的创作 <ArrowUpRight size={20} /></button></div></section>
    </main>
    <footer className="site-footer container"><Brand /><p>玩家原创的智斗游戏与规则交流站</p><a href="#top">回到顶部 ↑</a><span>© 2026 Nekofans.Game</span></footer>

    <dialog ref={dialog} className={'modal ' + (compose ? 'compose-modal' : '')} onCancel={e => { e.preventDefault(); closeModal(); }} onClick={e => { if (e.target === e.currentTarget) closeModal(); }} aria-labelledby={compose ? 'compose-title' : 'detail-title'}>
      <div className="modal-shell"><button className="modal-close icon-button" onClick={closeModal} aria-label="关闭弹窗" disabled={pending}><X size={22} /></button>
        {detail && <><div className="eyebrow">{detail.kind === 'game' ? 'PLAYER-CREATED GAME' : 'ORIGINAL RULE'}</div><div className="detail-title-row"><h2 id="detail-title">{detail.title}</h2><span className="status-tag">{detail.kind === 'game' && detail.stage === 'concept' ? '玩法概念' : stages[detail.stage]}</span></div><p className="detail-byline">创作者 <b>{detail.creator}</b>{detail.curated && <span>首位创作者</span>}</p>{detail.kind === 'game' && <EntryArt entry={detail} />}<p className="detail-summary">{detail.summary}</p><div className="detail-body">{detail.body}</div><div className="tags">{detail.tags.map(t => <span key={t}>{t}</span>)}</div><div className="detail-actions">{detail.url && detail.kind === 'game' ? <a className="button lime" href={detail.url} target="_blank" rel="noopener noreferrer">打开游戏链接 <ArrowUpRight size={18} /></a> : detail.kind === 'rule' ? <button className="button lime" onClick={() => copyRule(detail)}><Copy size={17} /> 复制规则灵感</button> : <a className="button lime" href="#about" onClick={closeModal}>了解智斗玩法 <ArrowRight size={17} /></a>}<button className="button outline-dark" onClick={() => bookmark(detail.id)}><Bookmark size={16} fill={favorites.includes(detail.id) ? 'currentColor' : 'none'} />{favorites.includes(detail.id) ? '已收藏' : '本机收藏'}</button></div>{detail.isOwner && <div className="delete-area">{deleteConfirm ? <><span>删除后这份投稿将从网站移除。</span><button className="danger-button" onClick={removeEntry} disabled={pending}>{pending ? '正在删除…' : '确认删除'}</button><button onClick={() => setDeleteConfirm(false)}>取消</button></> : <button onClick={() => setDeleteConfirm(true)}><Trash2 size={14} /> 删除我的投稿</button>}</div>}</>}
        {compose && <><div className="eyebrow">LET YOUR IMAGINATION PLAY</div><h2 id="compose-title">{compose === 'game' ? '把你的世界，带给大家。' : '让一个脑洞，成为规则。'}</h2><p className="compose-intro">{compose === 'game' ? '分享游戏链接、原型或玩法概念，让更多人看见你的创作。' : '分享可公开的规则创意；不要在这里泄露正在进行的对局秘密。'}</p><div className="compose-tabs" role="group" aria-label="投稿类型"><button className={compose === 'game' ? 'active' : ''} aria-pressed={compose === 'game'} onClick={() => { setCompose('game'); setFormError(''); }} disabled={pending}><Gamepad2 size={17} /> 分享游戏</button><button className={compose === 'rule' ? 'active' : ''} aria-pressed={compose === 'rule'} onClick={() => { setCompose('rule'); setFormError(''); }} disabled={pending}><Lightbulb size={17} /> 分享规则</button></div>
          {!signedIn && <div className="sign-in-note"><span>登录后即可发布并管理自己的创作。</span><a href={'/signin-with-chatgpt?return_to=' + encodeURIComponent('/?publish=' + compose)} target="_top">登录后继续 <ArrowUpRight size={16} /></a></div>}
          <form key={compose} onSubmit={publish} className="publish-form"><div className="form-row"><label>作品标题 <span>必填</span><input name="title" required minLength={2} maxLength={60} placeholder={compose === 'game' ? '给你的游戏起个名字' : '给这条规则起个名字'} /></label><label>创作者署名 <span>必填</span><input name="creator" required maxLength={30} defaultValue={displayName} placeholder="大家该怎样称呼你" autoComplete="nickname" /></label></div><label>一句话介绍 <span>8–180 字</span><textarea name="summary" required minLength={8} maxLength={180} rows={2} placeholder={compose === 'game' ? '这款游戏最有意思的地方是什么？' : '这条规则会带来怎样的选择或反转？'} /></label><div className="form-row"><label>玩法类型<select name="category" defaultValue="棋盘智斗">{categories.map(c => <option key={c}>{c}</option>)}</select></label>{compose === 'game' && <label>当前阶段<select name="stage" defaultValue="prototype"><option value="concept">玩法概念</option><option value="prototype">原型展示</option><option value="playable">可游玩（需要链接）</option></select></label>}</div>{compose === 'game' && <label>游戏链接 <span>可选，HTTPS 地址</span><input name="url" type="url" pattern="https://.*" placeholder="https://你的游戏地址" /></label>}<label>{compose === 'game' ? '玩法详情' : '完整规则'} <span>15–2000 字</span><textarea name="body" required minLength={15} maxLength={2000} rows={5} placeholder={compose === 'game' ? '怎样开始、怎样行动、怎样获胜？如果还是概念，也可以写下你想实现的体验。' : '写清触发条件、效果、次数限制与冲突边界，方便大家理解和讨论。'} /></label><label>创意标签 <span>最多 3 个，用逗号分隔</span><input name="tags" placeholder="例如：隐藏规则，名字，信息差" maxLength={40} /></label>{formError && <p role="alert" className="form-error">{formError}</p>}{!canPublish && <p className="form-service-note">{serviceError || '正在连接投稿服务…'} <button type="button" onClick={refresh}>重新连接</button></p>}<div className="form-bottom"><span>发布内容会显示在本网站，署名由你填写。</span><button className="button dark" type="submit" disabled={pending || !signedIn || !canPublish}>{pending ? <LoaderCircle className="spin" size={17} /> : <ArrowUpRight size={17} />}{pending ? '正在发布…' : '发布创作'}</button></div></form>
        </>}
        {toast && (detail || compose) && <div className="toast modal-toast" role="status"><Check size={17} />{toast}</div>}
      </div>
    </dialog>
    {toast && !detail && !compose && <div className="toast" role="status"><Check size={17} />{toast}</div>}
  </>;
}
