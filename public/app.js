/* ==========================================================================
   市场脉搏 · 前端应用
   ========================================================================== */

import { sparkline, mountChart } from './charts.js';

/* ------------------------------ 静态配置 ------------------------------ */

const HERO = ['1.000001', '100.HSI', '100.NDX', '100.SPX'];

const GROUPS = [
  {
    id: 'cn',
    name: '中国内地',
    ids: ['1.000001', '0.399001', '0.399006', '1.000300', '1.000688', '1.000905', '1.000016', '0.899050'],
  },
  { id: 'hk', name: '中国香港', ids: ['100.HSI', '124.HSTECH', '100.HSCEI'] },
  { id: 'us', name: '美国', ids: ['100.DJIA', '100.NDX', '100.SPX'] },
  { id: 'ap', name: '亚太', ids: ['100.N225', '100.KS11', '100.AS51', '100.SENSEX'] },
  { id: 'eu', name: '欧洲', ids: ['100.GDAXI', '100.FTSE', '100.FCHI', '100.SX5E'] },
  { id: 'cmd', name: '商品与汇率', ids: ['101.GC00Y', '102.CL00Y', '101.SI00Y', '100.UDI'] },
];

const TAPE = [
  '1.000001', '0.399001', '0.399006', '100.HSI', '124.HSTECH',
  '100.DJIA', '100.NDX', '100.SPX', '100.N225', '100.GDAXI',
  '101.GC00Y', '100.UDI',
];

const DEFAULT_WATCH = [
  ['1.600519', '贵州茅台'],
  ['0.300750', '宁德时代'],
  ['116.00700', '腾讯控股'],
  ['116.09988', '阿里巴巴-W'],
  ['105.AAPL', '苹果'],
  ['105.NVDA', '英伟达'],
  ['105.MSFT', '微软'],
  ['105.TSLA', '特斯拉'],
  ['1.600036', '招商银行'],
  ['0.002594', '比亚迪'],
];

const RANGES = [
  ['1d', '分时'],
  ['5d', '5日'],
  ['1m', '1月'],
  ['3m', '3月'],
  ['6m', '半年'],
  ['1y', '1年'],
  ['5y', '5年'],
];

const HOT = [
  ['600519', '贵州茅台'],
  ['00700', '腾讯控股'],
  ['NVDA', '英伟达'],
  ['300750', '宁德时代'],
  ['AAPL', '苹果'],
  ['TSLA', '特斯拉'],
];

const MARKET_TAG = {
  0: '深A',
  1: '沪A',
  90: '板块',
  100: '指数',
  101: '商品',
  102: '商品',
  105: '美股',
  106: '美股',
  107: '美股',
  116: '港股',
  124: '港指',
};

const CURRENCY_LABEL = { CNY: '人民币 · CNY', HKD: '港元 · HKD', USD: '美元 · USD' };
const CURRENCY_UNIT = { CNY: '元', HKD: '港元', USD: '美元' };

const LS_WATCH = 'marketpulse.watchlist.v1';
const LS_THEME = 'marketpulse.theme.v1';
const LS_COLORS = 'marketpulse.colors.v1';
const REFRESH_MS = 30000;
const SECID_RE = /^[0-9]{1,3}\.[A-Za-z0-9_-]{1,12}$/;

/* ------------------------------ 状态 ------------------------------ */

const state = {
  quotes: new Map(),
  sparks: new Map(),
  watch: loadWatch(),
  names: new Map(DEFAULT_WATCH),
  sort: { key: null, dir: -1 },
  region: 'all',
  auto: true,
  timer: null,
  refreshing: false,
  lastTs: 0,
  prevPrices: new Map(),
  sparksKey: '',
  sparksBusy: false,
  chartCache: new Map(),
  drawer: { secid: null, range: '1d', mode: 'auto', points: [], kind: 'trend', quote: null, cleanup: null },
  search: { items: [], active: -1, timer: null, query: '' },
};

/* ------------------------------ 工具 ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function fmt(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtChange(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${fmt(n, digits)}`;
}

function fmtBig(n) {
  if (!Number.isFinite(n) || n === 0) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toFixed(0);
}

const signClass = (v) => (!Number.isFinite(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');

function digitsOf(q) {
  return q && Number.isFinite(q.digits) ? q.digits : 2;
}

function marketTag(q) {
  if (!q) return '—';
  return MARKET_TAG[q.market] || '—';
}

function priceClass(secid, price) {
  const prev = state.prevPrices.get(secid);
  if (!Number.isFinite(prev) || !Number.isFinite(price) || prev === price) return '';
  return price > prev ? 'flash-up' : 'flash-down';
}

function hueOf(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360;
  return h;
}

function avatar(name) {
  const ch = String(name || '?').trim().charAt(0);
  const h = hueOf(name);
  return `<span class="avatar" style="background:hsl(${h} 42% 15%);color:hsl(${h} 68% 68%);border-color:hsl(${h} 40% 26%)">${esc(ch)}</span>`;
}

function col(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartColors() {
  return { up: col('--up') || '#ff4d5e', down: col('--down') || '#0ecb81' };
}

function sparkColor(secid, colors) {
  const q = state.quotes.get(secid);
  const v = state.sparks.get(secid) || [];
  const basis = q && Number.isFinite(q.pct) ? q.pct : v.length > 1 ? ((v[v.length - 1] - v[0]) / v[0]) * 100 : 0;
  if (basis > 0) return colors.up;
  if (basis < 0) return colors.down;
  return colors.flat;
}

function bjNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '0';
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')] ?? 1;
  const h = Number(get('hour')) % 24;
  const m = Number(get('minute'));
  return { wd, h, m, mins: h * 60 + m, text: `${String(h).padStart(2, '0')}:${get('minute')}:${get('second')}` };
}

/* ------------------------------ 存储 ------------------------------ */

function loadWatch() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_WATCH) || 'null');
    if (Array.isArray(raw) && raw.length) {
      return raw.filter((x) => x && SECID_RE.test(x.secid)).map((x) => ({ secid: x.secid, name: x.name || x.secid }));
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_WATCH.map(([secid, name]) => ({ secid, name }));
}

function saveWatch() {
  try {
    localStorage.setItem(LS_WATCH, JSON.stringify(state.watch));
  } catch {
    /* ignore */
  }
}

function loadTheme() {
  const saved = localStorage.getItem(LS_THEME);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function loadColors() {
  return localStorage.getItem(LS_COLORS) === 'western' ? 'western' : 'china';
}

/* ------------------------------ 网络 ------------------------------ */

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || !body || body.ok === false) {
    throw new Error(body?.error || `请求失败 (${res.status})`);
  }
  return body;
}

function allSecids() {
  const set = new Set([...HERO, ...GROUPS.flatMap((g) => g.ids), ...state.watch.map((w) => w.secid)]);
  return Array.from(set);
}

/* ------------------------------ 渲染 ------------------------------ */

function renderAll() {
  renderTape();
  renderHero();
  renderPulse();
  renderWatch();
  renderGroups();
  patchSparks();
  renderDrawerQuote();
  updateStamp();
}

function renderTape() {
  const track = $('#tapeTrack');
  const build = (ids) =>
    ids
      .map((id) => {
        const q = state.quotes.get(id);
        const d = signClass(q?.pct);
        return `<span class="tape-item" data-tape="${id}">
          <span class="tname">${esc(q?.name || '—')}</span>
          <span class="tval">${fmt(q?.price, digitsOf(q))}</span>
          <span class="tpct ${d}">${fmtPct(q?.pct)}</span>
        </span>`;
      })
      .join('');

  if (!track.childElementCount) {
    track.innerHTML = build(TAPE) + build(TAPE);
    return;
  }
  TAPE.forEach((id, idx) => {
    const q = state.quotes.get(id);
    const d = signClass(q?.pct);
    [idx, idx + TAPE.length].forEach((i) => {
      const node = track.children[i];
      if (!node) return;
      node.querySelector('.tname').textContent = q?.name || '—';
      node.querySelector('.tval').textContent = fmt(q?.price, digitsOf(q));
      const pctEl = node.querySelector('.tpct');
      pctEl.textContent = fmtPct(q?.pct);
      pctEl.className = `tpct ${d}`;
    });
  });
}

function heroCard(id, i) {
  const q = state.quotes.get(id);
  const d = signClass(q?.pct);
  const digits = digitsOf(q);
  return `<article class="hero-card ${q ? (q.pct > 0 ? 'is-up' : q.pct < 0 ? 'is-down' : '') : ''}"
      data-secid="${id}" style="--i:${i}" tabindex="0" role="button" aria-label="${esc(q?.name || '')} 详情">
    <div class="hc-top">
      <span class="hc-name">${esc(q?.name || '加载中')}</span>
      <span class="hc-badge">${marketTag(q)}</span>
      <span class="hc-pct ${d}">${q ? fmtPct(q.pct) : '—'}</span>
    </div>
    <div class="hc-price">
      <span class="hc-value ${priceClass(id, q?.price)}">${q ? fmt(q.price, digits) : '—'}</span>
      <span class="hc-change ${d}">${q ? fmtChange(q.change, digits) : '—'}</span>
    </div>
    <div class="hc-spark" data-spark="${id}"></div>
    <div class="hc-stats">
      <span class="hc-stat"><i>今开</i><b>${fmt(q?.open, digits)}</b></span>
      <span class="hc-stat"><i>最高</i><b>${fmt(q?.high, digits)}</b></span>
      <span class="hc-stat"><i>最低</i><b>${fmt(q?.low, digits)}</b></span>
      <span class="hc-stat"><i>${Number.isFinite(q?.amount) && q.amount > 0 ? '成交额' : '昨收'}</i>
        <b>${Number.isFinite(q?.amount) && q.amount > 0 ? fmtBig(q.amount) : fmt(q?.prevClose, digits)}</b></span>
    </div>
  </article>`;
}

function renderHero() {
  $('#heroGrid').innerHTML = HERO.map((id, i) => heroCard(id, i)).join('');
}

function renderPulse() {
  const list = GROUPS.flatMap((g) => g.ids)
    .map((id) => state.quotes.get(id))
    .filter((q) => q && Number.isFinite(q.pct));

  const up = list.filter((q) => q.pct > 0).length;
  const down = list.filter((q) => q.pct < 0).length;
  const flat = list.length - up - down;
  $('#pulseUp').textContent = String(up);
  $('#pulseDown').textContent = String(down);
  $('#pulseFlat').textContent = String(flat);

  const sorted = [...list].sort((a, b) => b.pct - a.pct);
  const avg = list.length ? list.reduce((s, q) => s + q.pct, 0) / list.length : null;

  $('#pulseBar').innerHTML = sorted
    .map((q) => {
      const c = q.pct > 0 ? 'var(--up)' : q.pct < 0 ? 'var(--down)' : 'var(--flat)';
      const o = clamp(0.3 + Math.abs(q.pct) / 4, 0.3, 1).toFixed(2);
      return `<span style="background:${c};opacity:${o}" title="${esc(q.name)} ${fmtPct(q.pct)}"></span>`;
    })
    .join('');

  const row = (q) =>
    `<div class="pulse-row" data-secid="${q.secid}">
      <span class="pr-name">${esc(q.name)}</span>
      <span class="pr-val ${signClass(q.pct)}">${fmtPct(q.pct)}</span>
    </div>`;

  const top = sorted.slice(0, 3);
  const bottom = sorted.slice(-3).reverse();
  $('#pulseList').innerHTML =
    `<div class="pl-label">领涨</div>${top.map(row).join('')}` +
    `<div class="pl-label">领跌</div>${bottom.map(row).join('')}`;

  const avgEl = $('#pulseAvg');
  avgEl.textContent = avg == null ? '—' : fmtPct(avg);
  avgEl.className = signClass(avg);
}

function watchRows() {
  const rows = state.watch.map((w) => {
    const q = state.quotes.get(w.secid);
    return { secid: w.secid, name: q?.name || w.name, q };
  });
  const { key, dir } = state.sort;
  if (key) {
    rows.sort((a, b) => {
      const av = a.q && Number.isFinite(a.q[key]) ? a.q[key] : null;
      const bv = b.q && Number.isFinite(b.q[key]) ? b.q[key] : null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }
  return rows;
}

function renderWatch() {
  const body = $('#watchBody');
  const rows = watchRows();
  $('#watchCount').textContent = `${state.watch.length} 只`;
  $('#watchEmpty').hidden = state.watch.length > 0;

  body.innerHTML = rows
    .map(({ secid, name, q }) => {
      const d = signClass(q?.pct);
      const digits = digitsOf(q);
      const price = q ? fmt(q.price, digits) : '—';
      return `<tr data-secid="${secid}">
      <td class="name-cell">
        <div class="name-wrap">
          ${avatar(name)}
          <span class="name-info">
            <b>${esc(name)}</b>
            <span>${esc(q?.code || secid.split('.')[1])}<i class="mkt-tag">${marketTag(q)}</i></span>
          </span>
        </div>
      </td>
      <td class="cell-price ${priceClass(secid, q?.price)}">${price}</td>
      <td class="cell-pct"><span class="pill ${d}">${q ? fmtPct(q.pct) : '—'}</span></td>
      <td class="col-opt ${d}">${q ? fmtChange(q.change, digits) : '—'}</td>
      <td class="col-opt">${fmt(q?.open, digits)}</td>
      <td class="col-opt">${fmt(q?.high, digits)}</td>
      <td class="col-opt">${fmt(q?.low, digits)}</td>
      <td class="col-opt">${fmtBig(q?.amount)}</td>
      <td class="col-opt">${fmtBig(q?.mcap)}</td>
      <td class="col-opt">${Number.isFinite(q?.pe) ? q.pe.toFixed(1) : '—'}</td>
      <td class="spark-cell" data-spark="${secid}"></td>
      <td>
        <button class="act-btn" data-remove="${secid}" title="移出关注" aria-label="移出关注">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>
      </td>
    </tr>`;
    })
    .join('');

  $$('#watchTable th.sortable').forEach((th) => {
    const on = th.dataset.sort === state.sort.key;
    th.classList.toggle('on', on);
    th.classList.toggle('asc', on && state.sort.dir === 1);
  });
}

function renderGroups() {
  const wrap = $('#indexGroups');
  const groups = state.region === 'all' ? GROUPS : GROUPS.filter((g) => g.id === state.region);
  const total = GROUPS.reduce((s, g) => s + g.ids.length, 0);
  $('#indexCount').textContent = `${total} 个指数`;

  wrap.innerHTML = groups
    .map((g, gi) => {
      const cards = g.ids
        .map((id) => {
          const q = state.quotes.get(id);
          const d = signClass(q?.pct);
          const digits = digitsOf(q);
          return `<article class="idx-card" data-secid="${id}" tabindex="0" role="button" aria-label="${esc(q?.name || '')}">
            <div class="idx-top">
              <span class="idx-name">${esc(q?.name || g.name)}</span>
              <span class="idx-pct ${d}">${q ? fmtPct(q.pct) : '—'}</span>
            </div>
            <div class="idx-mid">
              <span class="idx-value">${q ? fmt(q.price, digits) : '—'}</span>
              <span class="idx-change ${d}">${q ? fmtChange(q.change, digits) : ''}</span>
            </div>
            <div class="idx-spark" data-spark="${id}"></div>
          </article>`;
        })
        .join('');
      return `<div class="group" style="animation-delay:${gi * 40}ms">
        <div class="group-head">
          <span class="group-name">${g.name}</span>
          <span class="group-line"></span>
          <span class="group-count">${g.ids.length}</span>
        </div>
        <div class="idx-grid">${cards}</div>
      </div>`;
    })
    .join('');
}

function renderChips() {
  const items = [{ id: 'all', name: '全部' }, ...GROUPS.map((g) => ({ id: g.id, name: g.name }))];
  $('#regionChips').innerHTML = items
    .map(
      (it) =>
        `<button class="chip ${state.region === it.id ? 'on' : ''}" data-region="${it.id}">${it.name}</button>`
    )
    .join('');
}

function patchSparks() {
  const colors = { ...chartColors(), flat: col('--flat') || '#8b94a7' };
  $$('[data-spark]').forEach((el) => {
    const id = el.dataset.spark;
    const values = state.sparks.get(id);
    const h = el.classList.contains('hc-spark') ? 54 : el.classList.contains('idx-spark') ? 30 : 26;
    if (!values || values.length < 2) {
      el.innerHTML = '';
      return;
    }
    const sx = el.classList.contains('spark-cell') ? 88 : 260;
    el.innerHTML = sparkline(values, { width: sx, height: h, color: sparkColor(id, colors) });
  });
}

function updateStamp() {
  if (!state.lastTs) return;
  const t = new Date(state.lastTs);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  $('#lastUpdate').textContent = `更新于 ${hh}:${mm}:${ss}`;
}

function renderSessions() {
  const { wd, mins } = bjNow();
  const weekday = wd >= 1 && wd <= 5;
  const cn = weekday && ((mins >= 570 && mins < 690) || (mins >= 780 && mins < 900));
  const cnLunch = weekday && mins >= 690 && mins < 780;
  const hk = weekday && ((mins >= 570 && mins < 720) || (mins >= 780 && mins < 960));
  const hkLunch = weekday && mins >= 720 && mins < 780;
  let us = false;
  if (mins >= 1290) us = weekday;
  else if (mins < 240) us = ((wd + 6) % 7) >= 1 && ((wd + 6) % 7) <= 5;

  const item = (label, open, lunch) => {
    const cls = open ? 'is-open' : lunch ? 'is-lunch' : '';
    const txt = open ? '交易中' : lunch ? '午间休市' : '休市';
    return `<span class="session ${cls}"><i class="sdot"></i><b>${label}</b>${txt}</span>`;
  };

  $('#sessions').innerHTML = item('A股', cn, cnLunch) + item('港股', hk, hkLunch) + item('美股', us, false);
}

/* ------------------------------ 抽屉 ------------------------------ */

function drawerQuote() {
  return state.drawer.secid ? state.quotes.get(state.drawer.secid) : null;
}

function renderDrawerQuote() {
  const id = state.drawer.secid;
  if (!id) return;
  const q = drawerQuote() || state.drawer.quote;
  if (!q) return;
  const digits = digitsOf(q);
  const d = signClass(q.pct);

  $('#dName').textContent = q.name;
  $('#dMarket').textContent = marketTag(q);
  $('#dCode').textContent = q.code;
  $('#dCurrency').textContent = CURRENCY_LABEL[q.currency] || q.currency;
  $('#dUnit').textContent = CURRENCY_UNIT[q.currency] || '';
  $('#dPrice').textContent = fmt(q.price, digits);
  $('#dDelta').innerHTML = `<span class="dp-change ${d}">${fmtChange(q.change, digits)}</span>
    <span class="dp-pct ${d}">${fmtPct(q.pct)}</span>`;

  const stats = [
    ['今开', fmt(q.open, digits)],
    ['昨收', fmt(q.prevClose, digits)],
    ['最高', fmt(q.high, digits)],
    ['最低', fmt(q.low, digits)],
    ['成交额', fmtBig(q.amount)],
    ['换手率', Number.isFinite(q.turnover) ? `${q.turnover.toFixed(2)}%` : '—'],
    ['市盈率', Number.isFinite(q.pe) ? q.pe.toFixed(1) : '—'],
    ['总市值', fmtBig(q.mcap)],
  ];
  $('#dStats').innerHTML = stats
    .map(([k, v]) => `<div class="stat"><i>${k}</i><b>${v}</b></div>`)
    .join('');

  const inWatch = state.watch.some((w) => w.secid === id);
  const btn = $('#drawerWatch');
  btn.textContent = inWatch ? '移出关注' : '加入关注';
  btn.dataset.secid = id;
  btn.classList.toggle('btn-danger', inWatch);

  $('#drawerLink').href = `https://quote.eastmoney.com/unify/r/${id}`;
  $('#drawerResearch').href = `/research.html?s=${encodeURIComponent(id)}`;
  $('#drawerAnalyze').href = `/stock.html?s=${encodeURIComponent(id)}`;
}

function buildRangeTabs() {
  $('#rangeTabs').innerHTML = RANGES.map(
    ([k, label]) => `<button data-range="${k}" class="${state.drawer.range === k ? 'on' : ''}">${label}</button>`
  ).join('');
}

function setDrawerLoading() {
  const host = $('#dChart');
  if (state.drawer.cleanup) {
    state.drawer.cleanup();
    state.drawer.cleanup = null;
  }
  host.innerHTML = '<div class="chart-loading"><span></span></div>';
  $('#dSummary').innerHTML = '';
}

async function loadChart() {
  const { secid, range } = state.drawer;
  if (!secid) return;
  setDrawerLoading();

  const key = `${secid}|${range}`;
  let payload = state.chartCache.get(key);
  try {
    if (!payload) {
      payload = await getJSON(`/api/history?secid=${encodeURIComponent(secid)}&range=${range}`);
      if (state.chartCache.size > 60) state.chartCache.clear();
      state.chartCache.set(key, payload);
    }
  } catch (err) {
    $('#dChart').innerHTML = `<div class="chart-empty">${esc(err.message || '数据加载失败')}</div>`;
    return;
  }

  if (state.drawer.secid !== secid || state.drawer.range !== range) return;

  state.drawer.points = payload.points || [];
  state.drawer.kind = payload.kind || 'kline';
  const mode = state.drawer.mode === 'auto' ? (state.drawer.kind === 'kline' ? 'candle' : 'area') : state.drawer.mode;

  state.drawer.cleanup = mountChart($('#dChart'), state.drawer.points, {
    mode,
    range,
    digits: digitsOf(drawerQuote() || state.drawer.quote),
    prevClose: drawerQuote()?.prevClose ?? state.drawer.quote?.prevClose ?? null,
  });

  renderSummary();
}

function renderSummary() {
  const pts = state.drawer.points;
  const q = drawerQuote() || state.drawer.quote;
  const digits = digitsOf(q);
  if (!pts.length) {
    $('#dSummary').innerHTML = '';
    return;
  }
  const first = pts.find((p) => Number.isFinite(p.c));
  const last = [...pts].reverse().find((p) => Number.isFinite(p.c));
  const hi = Math.max(...pts.map((p) => (Number.isFinite(p.h) ? p.h : p.c)).filter(Number.isFinite));
  const lo = Math.min(...pts.map((p) => (Number.isFinite(p.l) ? p.l : p.c)).filter(Number.isFinite));
  const chg = first && last && first.c ? ((last.c - first.c) / first.c) * 100 : null;
  const d = signClass(chg);
  $('#dSummary').innerHTML = `
    <span>区间涨跌 <b class="${d}">${chg == null ? '—' : fmtPct(chg)}</b></span>
    <span>区间最高 <b>${fmt(hi, digits)}</b></span>
    <span>区间最低 <b>${fmt(lo, digits)}</b></span>
    <span>数据点 <b>${pts.length}</b></span>`;
}

async function openDrawer(secid) {
  if (!secid) return;
  state.drawer.secid = secid;
  state.drawer.quote = state.quotes.get(secid) || null;
  state.drawer.mode = 'auto';
  state.drawer.range = '1d';
  buildRangeTabs();
  $$('#modeTabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === 'area'));

  try {
    history.replaceState(null, '', `#s=${secid}`);
  } catch {
    /* ignore */
  }

  const drawer = $('#drawer');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  document.body.style.overflow = 'hidden';

  renderDrawerQuote();
  loadChart();
}

function closeDrawer() {
  const drawer = $('#drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
  if (state.drawer.cleanup) {
    state.drawer.cleanup();
    state.drawer.cleanup = null;
  }
  state.drawer.secid = null;
  state.drawer.points = [];
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* ignore */
  }
}

/* ------------------------------ 关注 ------------------------------ */

function addWatch(item) {
  if (!item || !SECID_RE.test(item.secid)) return;
  if (state.watch.some((w) => w.secid === item.secid)) {
    toast(`${item.name} 已在关注列表`);
    return;
  }
  state.watch.push({ secid: item.secid, name: item.name });
  state.names.set(item.secid, item.name);
  saveWatch();
  renderAll();
  refreshQuotes([item.secid]).then(() => loadSparks([item.secid]));
  toast(`已加入关注 · ${item.name}`);
}

function removeWatch(secid) {
  const target = state.watch.find((w) => w.secid === secid);
  state.watch = state.watch.filter((w) => w.secid !== secid);
  saveWatch();
  renderAll();
  toast(`已移出关注${target ? ` · ${target.name}` : ''}`);
}

/* ------------------------------ 搜索 ------------------------------ */

function openSearch() {
  const modal = $('#searchModal');
  modal.hidden = false;
  const input = $('#searchInput');
  input.value = '';
  state.search.items = [];
  state.search.active = -1;
  $('#searchResults').innerHTML = '';
  $('#searchHint').textContent = '支持 A 股、港股、美股与指数';
  $('#searchSuggest').hidden = false;
  $('#searchSuggest').innerHTML = HOT.map(
    ([code, name]) => `<button class="sg-btn" data-hot="${code}">${name} <span style="opacity:.5">${code}</span></button>`
  ).join('');
  setTimeout(() => input.focus(), 30);
}

function closeSearch() {
  $('#searchModal').hidden = true;
  $('#searchInput').blur();
}

function renderSearchResults() {
  const list = $('#searchResults');
  const items = state.search.items;
  if (!items.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = items
    .map((it, i) => {
      const on = state.watch.some((w) => w.secid === it.secid);
      return `<li class="sr-item ${i === state.search.active ? 'active' : ''}" data-i="${i}" data-secid="${it.secid}" data-name="${esc(it.name)}">
        ${avatar(it.name)}
        <span class="sr-name">${esc(it.name)}</span>
        <span class="sr-meta"><span>${esc(it.code)}</span><span>${esc(it.market || '')}</span>
        <span class="sr-add ${on ? 'on' : ''}">${on ? '已关注' : '+ 关注'}</span></span>
      </li>`;
    })
    .join('');
}

async function doSearch(q) {
  const keyword = String(q || '').trim();
  state.search.query = keyword;
  if (!keyword) {
    state.search.items = [];
    renderSearchResults();
    $('#searchHint').textContent = '支持 A 股、港股、美股与指数';
    return;
  }
  $('#searchHint').textContent = '搜索中…';
  try {
    const res = await getJSON(`/api/search?q=${encodeURIComponent(keyword)}`);
    if (state.search.query !== keyword) return;
    state.search.items = res.items || [];
    state.search.active = state.search.items.length ? 0 : -1;
    renderSearchResults();
    $('#searchHint').textContent = state.search.items.length
      ? `找到 ${state.search.items.length} 个结果`
      : '没有找到匹配的标的，试试输入代码或拼音首字母';
  } catch (err) {
    $('#searchHint').textContent = `搜索失败：${err.message}`;
  }
}

function pickSearchResult(index) {
  const it = state.search.items[index];
  if (!it) return;
  const exists = state.watch.some((w) => w.secid === it.secid);
  if (exists) {
    toast(`${it.name} 已在关注列表`);
    return;
  }
  addWatch({ secid: it.secid, name: it.name });
  state.search.items = [];
  state.search.active = -1;
  renderSearchResults();
  $('#searchInput').value = '';
  $('#searchHint').textContent = '已加入关注，可继续搜索';
  $('#searchInput').focus();
}

/* ------------------------------ 数据刷新 ------------------------------ */

async function refreshQuotes(extraIds = []) {
  if (state.refreshing) return;
  state.refreshing = true;
  $('#refreshBtn').classList.add('busy');
  try {
    const ids = Array.from(new Set([...allSecids(), ...extraIds]));
    const res = await getJSON(`/api/quotes?secids=${ids.join(',')}`);
    (res.items || []).forEach((q) => {
      state.quotes.set(q.secid, q);
      if (q.name) state.names.set(q.secid, q.name);
    });
    // 更新关注列表中的名称
    state.watch.forEach((w) => {
      const q = state.quotes.get(w.secid);
      if (q?.name) w.name = q.name;
    });
    state.lastTs = res.ts || Date.now();
    renderAll();
    $('#netBanner').hidden = true;
    document.body.classList.add('ready');
    loadSparks(ids);
  } catch (err) {
    showBanner(`行情连接中断：${err.message}`);
  } finally {
    state.refreshing = false;
    $('#refreshBtn').classList.remove('busy');
    // 记录价格，供下次刷新判断闪烁方向
    state.quotes.forEach((q, id) => state.prevPrices.set(id, q.price));
  }
}

async function loadSparks(ids) {
  const list = ids.filter((id) => state.quotes.has(id));
  const key = list.sort().join(',');
  if (!list.length || state.sparksBusy || key === state.sparksKey) return;
  state.sparksBusy = true;
  try {
    const CHUNK = 40;
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      const res = await getJSON(`/api/sparks?secids=${chunk.join(',')}&days=30`);
      Object.entries(res.items || {}).forEach(([id, values]) => state.sparks.set(id, values));
    }
    state.sparksKey = key;
    patchSparks();
  } catch {
    /* 迷你图失败不影响主行情 */
  } finally {
    state.sparksBusy = false;
  }
}

function showBanner(msg) {
  $('#netBannerText').textContent = msg;
  $('#netBanner').hidden = false;
}

/* ------------------------------ 交互绑定 ------------------------------ */

function bindEvents() {
  // 全局点击委托
  document.addEventListener('click', (ev) => {
    const removeBtn = ev.target.closest('[data-remove]');
    if (removeBtn) {
      ev.stopPropagation();
      removeWatch(removeBtn.dataset.remove);
      return;
    }

    const card = ev.target.closest('[data-secid]');
    if (card && !ev.target.closest('.search-results') && !ev.target.closest('#drawer')) {
      openDrawer(card.dataset.secid);
      return;
    }

    const chip = ev.target.closest('[data-region]');
    if (chip) {
      state.region = chip.dataset.region;
      renderChips();
      renderGroups();
      patchSparks();
      return;
    }

    const srItem = ev.target.closest('.sr-item');
    if (srItem) {
      pickSearchResult(Number(srItem.dataset.i));
      return;
    }

    const hot = ev.target.closest('[data-hot]');
    if (hot) {
      $('#searchInput').value = hot.dataset.hot;
      doSearch(hot.dataset.hot);
      $('#searchSuggest').hidden = true;
      return;
    }

    const th = ev.target.closest('th.sortable');
    if (th) {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === -1 ? 1 : -1;
        if (!state.sort.dir) state.sort.key = null;
      } else {
        state.sort.key = key;
        state.sort.dir = -1;
      }
      renderWatch();
      patchSparks();
      return;
    }
  });

  // 键盘可达性：卡片回车
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && document.activeElement?.matches('[data-secid][tabindex]')) {
      openDrawer(document.activeElement.dataset.secid);
    }
  });

  $('#refreshBtn').addEventListener('click', () => {
    refreshQuotes().then(() => toast('行情已刷新'));
  });
  $('#netRetry').addEventListener('click', () => refreshQuotes());

  $('#addStockBtn').addEventListener('click', openSearch);
  $('#searchBtn').addEventListener('click', openSearch);
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);

  $('#drawerWatch').addEventListener('click', (ev) => {
    const id = ev.currentTarget.dataset.secid;
    if (!id) return;
    const exists = state.watch.some((w) => w.secid === id);
    if (exists) {
      removeWatch(id);
      renderDrawerQuote();
    } else {
      const q = state.quotes.get(id);
      addWatch({ secid: id, name: q?.name || state.names.get(id) || id });
      renderDrawerQuote();
    }
  });

  $('#rangeTabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-range]');
    if (!btn) return;
    state.drawer.range = btn.dataset.range;
    $$('#rangeTabs button').forEach((b) => b.classList.toggle('on', b === btn));
    loadChart();
  });

  $('#modeTabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-mode]');
    if (!btn) return;
    state.drawer.mode = btn.dataset.mode;
    $$('#modeTabs button').forEach((b) => b.classList.toggle('on', b === btn));
    loadChart();
  });

  // 搜索
  $('#searchModal').addEventListener('click', (ev) => {
    if (ev.target === $('#searchModal')) closeSearch();
  });
  const input = $('#searchInput');
  input.addEventListener(
    'input',
    debounce((ev) => {
      $('#searchSuggest').hidden = true;
      doSearch(ev.target.value);
    }, 260)
  );
  input.addEventListener('keydown', (ev) => {
    const n = state.search.items.length;
    if (ev.key === 'ArrowDown' && n) {
      ev.preventDefault();
      state.search.active = (state.search.active + 1) % n;
      renderSearchResults();
    } else if (ev.key === 'ArrowUp' && n) {
      ev.preventDefault();
      state.search.active = (state.search.active - 1 + n) % n;
      renderSearchResults();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (state.search.active >= 0) pickSearchResult(state.search.active);
    }
  });

  // 主题 / 颜色
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(LS_THEME, next);
    document.querySelector('meta[name="theme-color"]').setAttribute('content', next === 'dark' ? '#06070b' : '#f4f6fa');
    patchSparks();
    if (state.drawer.secid) loadChart();
  });

  $('#colorToggle').addEventListener('click', () => {
    const western = document.documentElement.dataset.colors === 'western';
    document.documentElement.dataset.colors = western ? 'china' : 'western';
    localStorage.setItem(LS_COLORS, western ? 'china' : 'western');
    $('#colorToggle').textContent = western ? '红涨' : '绿涨';
    renderAll();
    if (state.drawer.secid) loadChart();
  });

  // 自动刷新
  $('#autoRefreshToggle').addEventListener('click', (ev) => {
    state.auto = !state.auto;
    ev.currentTarget.textContent = state.auto ? '暂停' : '继续';
    $('#liveDot').classList.toggle('paused', !state.auto);
    toast(state.auto ? '已恢复自动刷新' : '已暂停自动刷新');
  });

  // 快捷键
  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (ev.key === 'Escape') {
      if (!$('#searchModal').hidden) closeSearch();
      else if (state.drawer.secid) closeDrawer();
      return;
    }
    if (typing) return;
    if (ev.key === '/') {
      ev.preventDefault();
      openSearch();
    } else if (ev.key.toLowerCase() === 'r' && !ev.metaKey && !ev.ctrlKey) {
      refreshQuotes().then(() => toast('行情已刷新'));
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - state.lastTs > 15000) refreshQuotes();
  });
}

/* ------------------------------ 提示 ------------------------------ */

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 250);
  }, 2200);
}

/* ------------------------------ 启动 ------------------------------ */

function startTimers() {
  setInterval(renderSessions, 30000);
  setInterval(() => {
    $('#clock .clock-time').textContent = bjNow().text;
  }, 1000);
  setInterval(() => {
    if (!state.auto || document.hidden) return;
    refreshQuotes();
  }, REFRESH_MS);
}

function init() {
  const themeParam = new URLSearchParams(location.search).get('theme');
  if (themeParam === 'light' || themeParam === 'dark') localStorage.setItem(LS_THEME, themeParam);
  document.documentElement.dataset.theme = loadTheme();
  document.documentElement.dataset.colors = loadColors() === 'western' ? 'western' : 'china';
  $('#colorToggle').textContent = loadColors() === 'western' ? '绿涨' : '红涨';

  state.watch.forEach((w) => state.names.set(w.secid, w.name));
  buildRangeTabs();
  renderChips();
  renderSessions();
  bindEvents();
  startTimers();

  // 先用缓存/默认名渲染一次骨架
  renderAll();

  refreshQuotes().finally(() => {
    const m = location.hash.match(/^#s=([0-9]{1,3}\.[A-Za-z0-9_-]{1,12})$/);
    if (m) openDrawer(m[1]);
    else if (location.hash === '#search') openSearch();
  });
}

init();
