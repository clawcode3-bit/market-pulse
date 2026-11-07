/* ==========================================================================
   市场脉搏 · 个股分析
   六维评分：盈利 / 成长 / 健康 / 效率 / 估值 / 回报
   ========================================================================== */

const LS_WATCH = 'marketpulse.watchlist.v1';
const LS_LAST = 'marketpulse.stock.last';

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

const DIMS = [
  { key: 'profit', name: '盈利', weight: 0.25 },
  { key: 'growth', name: '成长', weight: 0.2 },
  { key: 'health', name: '健康', weight: 0.15 },
  { key: 'efficiency', name: '效率', weight: 0.1 },
  { key: 'valuation', name: '估值', weight: 0.2 },
  { key: 'return', name: '回报', weight: 0.1 },
];

const state = {
  watch: [],
  active: null,
  quotes: new Map(),
  company: new Map(),
  closes: new Map(),
  hist: { secid: null, range: '5y', mode: 'return', bench: 'auto', points: [], benchPoints: null, benchName: null, cache: new Map(), ro: null },
  profileExpanded: false,
  searchItems: [],
  searchActive: -1,
  loading: false,
};

/* ------------------------------ 工具 ------------------------------ */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (n, d = 2) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const pct = (n, d = 1) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${(n * 100).toFixed(d)}%` : '—');
const pctRaw = (n, d = 1) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(d)}%` : '—');
const plain = (n, d = 1) => (Number.isFinite(n) ? `${n.toFixed(d)}%` : '—');
const big = (n) => {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
  if (a >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return n.toFixed(0);
};
const sign = (n) => (!Number.isFinite(n) || Math.abs(n) < 1e-9 ? 'flat' : n > 0 ? 'up' : 'down');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 250);
  }, 2000);
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok === false) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

/* ------------------------------ 自选 ------------------------------ */

function loadWatch() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_WATCH) || 'null');
    if (Array.isArray(raw) && raw.length) return raw.filter((x) => x && x.secid);
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

const isWatched = (secid) => state.watch.some((w) => w.secid === secid);
const nameOf = (secid) =>
  state.quotes.get(secid)?.name || state.company.get(secid)?.profile?.name || state.watch.find((w) => w.secid === secid)?.name || secid;

/* ------------------------------ 统计 ------------------------------ */

function lin(v, pts) {
  if (!Number.isFinite(v)) return null;
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0 || 1);
    }
  }
  return pts[pts.length - 1][1];
}

function closeStats(points) {
  const arr = (points || []).slice(-751);
  if (arr.length < 30) return null;
  const cs = arr.map((p) => p[1]);
  const total = cs[cs.length - 1] / cs[0] - 1;
  let peak = cs[0];
  let mdd = 0;
  const rets = [];
  for (let i = 1; i < cs.length; i++) {
    peak = Math.max(peak, cs[i]);
    mdd = Math.min(mdd, cs[i] / peak - 1);
    if (cs[i - 1] > 0) rets.push(cs[i] / cs[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return { total, mdd, vol: Math.sqrt(variance) * Math.sqrt(252), start: arr[0][0], end: arr[arr.length - 1][0] };
}

function ttmDps(dividends) {
  const now = Date.now();
  let sum = 0;
  for (const d of dividends || []) {
    if (!/实施/.test(d.progress || '')) continue;
    const t = Date.parse(d.exDate || d.date || '');
    if (!Number.isFinite(t) || now - t > 400 * 86400000) continue;
    const m = /派([\d.]+)元/.exec(d.plan || '');
    if (m) sum += parseFloat(m[1]) / 10;
  }
  if (sum) return sum;
  for (const d of dividends || []) {
    if (!/实施/.test(d.progress || '')) continue;
    const m = /派([\d.]+)元/.exec(d.plan || '');
    if (m) return parseFloat(m[1]) / 10;
  }
  return null;
}

/* ------------------------------ 分析 ------------------------------ */

function analyze(company, quote, closes, price) {
  const annual = company.financials?.annual || [];
  const latest = company.financials?.latest || [];
  const a = annual[0] || null;
  const a3 = annual[3] || null;
  const l = latest[0] || null;

  const cagr = (now, then) => (now > 0 && then > 0 ? Math.pow(now / then, 1 / 3) - 1 : null);
  const revCagr = a && a3 ? cagr(a.revenue, a3.revenue) : null;
  const profitCagr = a && a3 ? cagr(a.netProfit, a3.netProfit) : null;

  const stats = closeStats(closes);
  const dps = ttmDps(company.dividends || []);
  const payout = dps && a?.eps ? dps / a.eps : null;
  const divYield = dps && price ? dps / price : null;
  const cashToProfit = a?.cashPerShare && a?.eps ? a.cashPerShare / a.eps : null;
  const peg = quote?.pe && profitCagr > 0 ? quote.pe / (profitCagr * 100) : null;

  const p = (label, value, display, w, score) => ({ label, value, display, w, score });

  const dims = {
    profit: [
      p('ROE', a?.roe, plain(a?.roe), 0.5, lin(a?.roe, [[0, 0], [5, 25], [10, 50], [15, 70], [20, 85], [30, 100]])),
      p('毛利率', a?.grossMargin, plain(a?.grossMargin), 0.25, lin(a?.grossMargin, [[0, 0], [15, 30], [30, 55], [50, 80], [70, 95], [90, 100]])),
      p('净利率', a?.netMargin, plain(a?.netMargin), 0.25, lin(a?.netMargin, [[0, 0], [5, 30], [10, 50], [20, 75], [30, 90], [50, 100]])),
    ],
    growth: [
      p('营收3年CAGR', revCagr, pct(revCagr), 0.35, lin(revCagr != null ? revCagr * 100 : null, [[-10, 0], [0, 20], [5, 40], [10, 60], [20, 80], [30, 95], [50, 100]])),
      p('净利3年CAGR', profitCagr, pct(profitCagr), 0.35, lin(profitCagr != null ? profitCagr * 100 : null, [[-10, 0], [0, 20], [5, 40], [10, 60], [20, 80], [30, 95], [50, 100]])),
      p('最新营收同比', l?.revenueYoY, pctRaw(l?.revenueYoY), 0.15, lin(l?.revenueYoY, [[-20, 0], [0, 25], [10, 55], [20, 75], [40, 95], [80, 100]])),
      p('最新净利同比', l?.profitYoY, pctRaw(l?.profitYoY), 0.15, lin(l?.profitYoY, [[-20, 0], [0, 25], [10, 55], [20, 75], [40, 95], [80, 100]])),
    ],
    health: [
      p('资产负债率', a?.debtRatio, plain(a?.debtRatio), 0.3, lin(a?.debtRatio, [[0, 100], [30, 90], [50, 65], [70, 30], [85, 5], [100, 0]])),
      p('流动比率', a?.currentRatio, fmt(a?.currentRatio, 2), 0.3, lin(a?.currentRatio, [[0.5, 10], [1, 40], [1.5, 70], [2, 90], [3, 100], [6, 100]])),
      p('现金流/利润', cashToProfit, fmt(cashToProfit, 2), 0.4, lin(cashToProfit, [[0, 0], [0.3, 25], [0.7, 55], [1, 80], [1.5, 100], [3, 100]])),
    ],
    efficiency: [
      p('总资产周转', a?.assetTurnover, fmt(a?.assetTurnover, 2), 0.4, lin(a?.assetTurnover, [[0.1, 20], [0.3, 40], [0.5, 60], [0.8, 80], [1.2, 95], [2, 100]])),
      p('存货周转', a?.inventoryTurnover, fmt(a?.inventoryTurnover, 2), 0.3, lin(a?.inventoryTurnover, [[0.1, 15], [0.5, 40], [1, 60], [3, 80], [6, 95], [12, 100]])),
      p('应收周转', a?.receivableTurnover, fmt(a?.receivableTurnover, 1), 0.3, lin(a?.receivableTurnover, [[0, 10], [2, 40], [5, 70], [10, 90], [50, 100], [1000, 100]])),
    ],
    valuation: [
      p('PE(TTM)', quote?.pe, fmt(quote?.pe, 1), 0.3, lin(quote?.pe, [[0, 100], [10, 100], [15, 90], [25, 65], [40, 35], [60, 15], [100, 0]])),
      p('PB', quote?.pb, fmt(quote?.pb, 2), 0.2, lin(quote?.pb, [[0, 100], [1, 100], [2, 90], [4, 70], [8, 40], [15, 10], [30, 0]])),
      p('PEG', peg, fmt(peg, 2), 0.3, lin(peg, [[0, 100], [0.7, 100], [1, 85], [1.5, 65], [2.5, 40], [4, 15], [8, 0]])),
      p('股息率', divYield, pctRaw(divYield != null ? divYield * 100 : null), 0.2, lin(divYield != null ? divYield * 100 : null, [[0, 20], [1, 40], [2, 65], [3, 80], [5, 95], [8, 100]])),
    ],
    return: [
      p('分红率', payout, pctRaw(payout != null ? payout * 100 : null), 0.4, lin(payout != null ? payout * 100 : null, [[0, 20], [20, 45], [30, 65], [50, 85], [70, 95], [100, 90]])),
      p('股息率', divYield, pctRaw(divYield != null ? divYield * 100 : null), 0.2, lin(divYield != null ? divYield * 100 : null, [[0, 20], [1, 40], [2, 65], [3, 80], [5, 95], [8, 100]])),
      p('3年收益', stats?.total, pct(stats?.total), 0.4, lin(stats != null ? stats.total * 100 : null, [[-50, 0], [-20, 20], [0, 45], [20, 65], [50, 85], [100, 100]])),
    ],
  };

  const result = DIMS.map((d) => {
    const parts = dims[d.key].filter((x) => x.score != null);
    const wsum = parts.reduce((s, x) => s + x.w, 0);
    const score = wsum ? parts.reduce((s, x) => s + x.score * x.w, 0) / wsum : null;
    return { ...d, score, parts: dims[d.key] };
  });

  const avail = result.filter((d) => d.score != null);
  const wsum = avail.reduce((s, d) => s + d.weight, 0);
  const overall = wsum ? avail.reduce((s, d) => s + d.score * d.weight, 0) / wsum : null;

  return { dims: result, overall, stats, revCagr, profitCagr, payout, divYield, cashToProfit, peg, dps };
}

/* ------------------------------ 渲染：头部 ------------------------------ */

const MARKET_NAME = { 1: '沪A', 0: '深A', 105: '美股', 106: '美股', 107: '美股', 116: '港股', 124: '港指', 100: '指数' };
const CURRENCY = { CNY: '¥', HKD: 'HK$', USD: '$' };

function renderHeader() {
  const secid = state.active;
  const q = state.quotes.get(secid);
  const co = state.company.get(secid);
  const p = co?.profile;
  const a = co?.financials?.annual?.[0];

  if (!q) {
    $('#shName').textContent = nameOf(secid);
    $('#shMarket').textContent = '—';
    $('#shSub').textContent = secid;
    $('#shPrice').textContent = '—';
    return;
  }

  $('#shName').textContent = q.name || p?.name || secid;
  $('#shMarket').textContent = MARKET_NAME[q.market] || '—';
  const ind = $('#shIndustry');
  if (p?.industry) {
    ind.textContent = p.industry;
    ind.hidden = false;
  } else ind.hidden = true;

  const parts = [q.code, q.currency || '', p?.province || p?.market || ''].filter(Boolean);
  if (p?.listed) parts.push(`上市 ${p.listed}`);
  $('#shSub').textContent = parts.join(' · ');

  const d = sign(q.pct);
  $('#shPrice').textContent = fmt(q.price, q.digits ?? 2);
  $('#shDelta').innerHTML = `<span class="${d}">${q.change > 0 ? '+' : ''}${fmt(q.change, q.digits ?? 2)}</span>
    <span class="${d}" style="margin-left:8px">${pctRaw(q.pct)}</span>`;

  const stats = [
    ['总市值', big(q.mcap)],
    ['市盈率', Number.isFinite(q.pe) ? q.pe.toFixed(1) : '—'],
    ['市净率', Number.isFinite(q.pb) ? q.pb.toFixed(2) : '—'],
    ['成交额', big(q.amount)],
  ];
  const an = co ? analyze(co, q, state.closes.get(secid), q.price) : null;
  if (an?.divYield != null) stats.push(['股息率', pctRaw(an.divYield * 100)]);
  if (a?.date) stats.push(['财报', a.label]);

  $('#shStats').innerHTML = stats
    .map(([k, v]) => `<span class="sh-stat"><i>${k}</i><b>${v}</b></span>`)
    .join('');

  const wBtn = $('#watchBtn');
  wBtn.textContent = isWatched(secid) ? '移出自选' : '加入自选';
  wBtn.classList.toggle('btn-primary', !isWatched(secid));
  $('#researchLink').href = `/research.html?s=${encodeURIComponent(secid)}`;

  const site = p?.website ? (/^https?:/.test(p.website) ? p.website : `http://${p.website}`) : '';
  const siteLink = $('#siteLink');
  siteLink.hidden = !site;
  if (site) siteLink.href = site;

  $('#asof').textContent = `行情 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  $('#metaMarket').textContent = MARKET_NAME[q.market] || '—';
  $('#metaTime').textContent = co ? new Date(co.ts).toLocaleDateString('zh-CN') : '—';
}

/* ------------------------------ 渲染：评分 ------------------------------ */

function renderScore() {
  const secid = state.active;
  const co = state.company.get(secid);
  const q = state.quotes.get(secid);
  const wrap = $('#scoreWrap');

  if (!co?.financials?.annual?.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const an = analyze(co, q, state.closes.get(secid), q?.price);
  $('#scoreHint').innerHTML = an.overall == null
    ? ''
    : `综合 <b style="font-family:var(--mono);color:var(--accent);font-size:13px">${an.overall.toFixed(0)}</b> / 100 · ${label(an.overall)}`;

  renderRadar($('#radar'), an.dims);

  $('#scoreList').innerHTML = an.dims
    .map((d) => {
      const parts = d.parts.filter((x) => x.display && x.display !== '—').map((x) => `${x.label} ${x.display}`).join(' · ');
      return `<div class="score-row">
        <span class="score-name">${d.name}</span>
        <span class="score-bar"><span style="width:${d.score == null ? 0 : clamp(d.score, 0, 100).toFixed(0)}%"></span></span>
        <span class="score-val">${d.score == null ? '—' : d.score.toFixed(0)}</span>
        <span class="score-parts">${parts || '数据不足'}</span>
      </div>`;
    })
    .join('');
}

function label(score) {
  if (score >= 80) return '优秀';
  if (score >= 65) return '良好';
  if (score >= 50) return '一般';
  return '偏弱';
}

function renderRadar(host, dims) {
  const size = Math.min(host.clientWidth || 300, 300);
  const R = size / 2 - 38;
  const cx = size / 2;
  const cy = size / 2;
  const n = dims.length;
  const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i, r) => [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r];

  let svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`;

  for (const ring of [0.25, 0.5, 0.75, 1]) {
    const pts = dims.map((_, i) => pt(i, R * ring).map((v) => v.toFixed(1)).join(',')).join(' ');
    svg += `<polygon class="radar-grid" points="${pts}"/>`;
  }

  dims.forEach((_, i) => {
    const [x, y] = pt(i, R);
    svg += `<line class="radar-axis" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
  });

  const poly = dims
    .map((d, i) => pt(i, (R * clamp(d.score == null ? 0 : d.score, 0, 100)) / 100).map((v) => v.toFixed(1)).join(','))
    .join(' ');
  svg += `<polygon class="radar-area" points="${poly}"/>`;

  dims.forEach((d, i) => {
    const [x, y] = pt(i, (R * clamp(d.score == null ? 0 : d.score, 0, 100)) / 100);
    svg += `<circle class="radar-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4"/>`;
    const [lx, ly] = pt(i, R + 20);
    const anchor = Math.abs(lx - cx) < 8 ? 'middle' : lx > cx ? 'start' : 'end';
    svg += `<text class="radar-label" x="${lx.toFixed(1)}" y="${(ly - 1).toFixed(1)}" text-anchor="${anchor}">${d.name}</text>`;
    svg += `<text class="radar-score" x="${lx.toFixed(1)}" y="${(ly + 10).toFixed(1)}" text-anchor="${anchor}">${d.score == null ? '—' : d.score.toFixed(0)}</text>`;
  });

  svg += '</svg>';
  host.innerHTML = svg;
}

/* ------------------------------ 渲染：KPI ------------------------------ */

function renderKpis() {
  const secid = state.active;
  const co = state.company.get(secid);
  const q = state.quotes.get(secid);
  const hasFin = !!co?.financials?.annual?.length;
  const an = analyze(co || { financials: { annual: [], latest: [] } }, q, state.closes.get(secid), q?.price);
  const a = co?.financials?.annual?.[0];

  const card = (labelText, value, sub, cls = '') =>
    `<div class="kpi"><i>${labelText}</i><b class="${cls}">${value}</b><small>${sub}</small></div>`;

  if (hasFin) {
    $('#kpiGrid').innerHTML = [
      card('ROE', plain(a?.roe), a?.label || '', ''),
      card('毛利率', plain(a?.grossMargin), a?.label || ''),
      card('净利率', plain(a?.netMargin), a?.label || ''),
      card('营收 3 年 CAGR', pct(an.revCagr), '年报复合增速', sign(an.revCagr)),
      card('净利 3 年 CAGR', pct(an.profitCagr), '年报复合增速', sign(an.profitCagr)),
      card('资产负债率', plain(a?.debtRatio), '越低越稳健'),
      card('流动比率', fmt(a?.currentRatio, 2), '短期偿债能力'),
      card('现金流/利润', fmt(an.cashToProfit, 2), '每股经营现金流 ÷ EPS'),
      card('PE(TTM)', fmt(q?.pe, 1), '当前'),
      card('PB', fmt(q?.pb, 2), '当前'),
      card('股息率', an.divYield == null ? '—' : pctRaw(an.divYield * 100), '近 12 个月分红'),
      card('3 年收益', an.stats ? pct(an.stats.total) : '—', an.stats ? `${an.stats.start} 起` : '', sign(an.stats?.total)),
    ].join('');
    $('#kpiSub').textContent = `财务口径：${a?.label || '最新年报'} · 市场表现：${an.stats?.start || '—'} → ${an.stats?.end || '—'}（后复权）`;
  } else {
    $('#kpiGrid').innerHTML = [
      card('PE(TTM)', fmt(q?.pe, 1), '当前'),
      card('PB', fmt(q?.pb, 2), '当前'),
      card('总市值', big(q?.mcap), '当前'),
      card('3 年收益', an.stats ? pct(an.stats.total) : '—', '后复权', sign(an.stats?.total)),
      card('最大回撤', an.stats ? pct(an.stats.mdd) : '—', '3 年区间'),
      card('年化波动', an.stats ? plain(an.stats.vol * 100) : '—', '3 年'),
    ].join('');
    $('#kpiSub').textContent = '该市场暂不提供完整财务数据，以上为行情与估值指标。';
  }
}

/* ------------------------------ 渲染：财务图 ------------------------------ */

function finColors() {
  return { rev: '#5b8cff', profit: '#ffb020', gross: '#2dd4bf', net: '#b06cff' };
}

function renderFinChart() {
  const host = $('#finChart');
  const co = state.company.get(state.active);
  const annual = co?.financials?.annual || [];
  if (annual.length < 2) {
    host.innerHTML = '<div class="chart-empty">暂无财务数据</div>';
    $('#finLegend').innerHTML = '';
    return;
  }
  const rows = annual.slice(0, 8).reverse();
  const W = host.clientWidth || 800;
  const H = host.clientHeight || 330;
  const padL = 44;
  const padR = 42;
  const padT = 18;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const C = finColors();

  const maxRev = Math.max(...rows.map((r) => r.revenue || 0)) / 1e8;
  const yL = (v) => padT + plotH * (1 - v / (maxRev * 1.08 || 1));
  const yR = (p) => padT + plotH * (1 - p / 100);
  const band = plotW / rows.length;
  const bw = Math.min(18, band * 0.18);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;

  for (let i = 0; i <= 4; i++) {
    const v = (maxRev * 1.08 * i) / 4;
    const y = yL(v);
    svg += `<line class="fin-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`;
    svg += `<text class="fin-axis" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${v.toFixed(0)}</text>`;
  }
  [0, 25, 50, 75, 100].forEach((p) => {
    const y = yR(p);
    svg += `<text class="fin-axis" x="${W - padR + 6}" y="${(y + 3).toFixed(1)}">${p}%</text>`;
  });

  rows.forEach((r, i) => {
    const cx = padL + band * i + band / 2;
    const revH = ((r.revenue || 0) / 1e8 / (maxRev * 1.08 || 1)) * plotH;
    const proH = ((r.netProfit || 0) / 1e8 / (maxRev * 1.08 || 1)) * plotH;
    svg += `<rect x="${(cx - bw - 2).toFixed(1)}" y="${(padT + plotH - revH).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, revH).toFixed(1)}" rx="2" fill="${C.rev}" opacity="0.55"><title>${r.label} 营收 ${(r.revenue / 1e8).toFixed(1)} 亿</title></rect>`;
    svg += `<rect x="${(cx + 2).toFixed(1)}" y="${(padT + plotH - proH).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, proH).toFixed(1)}" rx="2" fill="${C.profit}" opacity="0.9"><title>${r.label} 净利 ${(r.netProfit / 1e8).toFixed(1)} 亿</title></rect>`;
    svg += `<text class="fin-axis" x="${cx.toFixed(1)}" y="${H - 7}" text-anchor="middle">${(r.label || '').slice(0, 4)}</text>`;
  });

  for (const [key, color] of [['grossMargin', C.gross], ['netMargin', C.net]]) {
    const pts = rows
      .map((r, i) => {
        const v = r[key];
        if (!Number.isFinite(v)) return null;
        return `${(padL + band * i + band / 2).toFixed(1)},${yR(v).toFixed(1)}`;
      })
      .filter(Boolean);
    if (pts.length > 1) {
      svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round"/>`;
      pts.forEach((pt) => {
        const [x, y] = pt.split(',');
        svg += `<circle cx="${x}" cy="${y}" r="2.2" fill="${color}"/>`;
      });
    }
  }

  svg += '</svg>';
  host.innerHTML = svg;

  $('#finLegend').innerHTML = `
    <span class="fl-item"><i style="background:${C.rev}"></i>营收</span>
    <span class="fl-item"><i style="background:${C.profit}"></i>净利润</span>
    <span class="fl-item"><i style="background:${C.gross}"></i>毛利率</span>
    <span class="fl-item"><i style="background:${C.net}"></i>净利率</span>`;
  $('#finHint').textContent = `${rows[0].label?.slice(0, 4) || ''}–${rows[rows.length - 1].label?.slice(0, 4) || ''} 年报`;
}

function renderCashChart() {
  const host = $('#cashChart');
  const co = state.company.get(state.active);
  const annual = co?.financials?.annual || [];
  if (annual.length < 2) {
    host.innerHTML = '<div class="chart-empty">暂无数据</div>';
    return;
  }
  const rows = annual.slice(0, 8).reverse().map((r) => ({
    label: (r.label || '').slice(0, 4),
    ratio: r.eps ? r.cashPerShare / r.eps : null,
  }));
  const W = host.clientWidth || 500;
  const H = host.clientHeight || 200;
  const padL = 34;
  const padR = 10;
  const padT = 14;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(1.6, ...rows.map((r) => (r.ratio == null ? 0 : Math.abs(r.ratio)))) * 1.05;
  const band = plotW / rows.length;
  const bw = Math.min(26, band * 0.42);
  const y = (v) => padT + plotH * (1 - v / max);
  const cs = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--accent').trim() || '#ffb020';
  const muted = cs.getPropertyValue('--muted').trim() || '#6c7689';

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  [0, 0.5, 1, 1.5].forEach((v) => {
    if (v > max) return;
    svg += `<line class="fin-grid" x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}"/>`;
    svg += `<text class="fin-axis" x="${padL - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text>`;
  });
  svg += `<line x1="${padL}" y1="${y(1).toFixed(1)}" x2="${W - padR}" y2="${y(1).toFixed(1)}" stroke="${accent}" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>`;

  rows.forEach((r, i) => {
    const cx = padL + band * i + band / 2;
    if (r.ratio == null) return;
    const h = Math.max(1, (Math.abs(r.ratio) / max) * plotH);
    const top = padT + plotH - h;
    const color = r.ratio >= 1 ? accent : muted;
    svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" opacity="${r.ratio >= 1 ? 0.8 : 0.45}"><title>${r.label} ${r.ratio.toFixed(2)}</title></rect>`;
    svg += `<text class="fin-axis" x="${cx.toFixed(1)}" y="${(top - 4).toFixed(1)}" text-anchor="middle">${r.ratio.toFixed(2)}</text>`;
    svg += `<text class="fin-axis" x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">${r.label}</text>`;
  });
  svg += '</svg>';
  host.innerHTML = svg;
}

/* ------------------------------ 渲染：估值 / 简介 / 股东 / 分红 ------------------------------ */

function renderValuation(an) {
  const q = state.quotes.get(state.active);
  const a = state.company.get(state.active)?.financials?.annual?.[0];
  const items = [
    ['PE(TTM)', fmt(q?.pe, 1)],
    ['PB', fmt(q?.pb, 2)],
    ['PEG', fmt(an.peg, 2)],
    ['股息率', an.divYield == null ? '—' : pctRaw(an.divYield * 100)],
    ['分红率', an.payout == null ? '—' : pctRaw(an.payout * 100)],
    ['每股股息', an.dps == null ? '—' : `${an.dps.toFixed(2)} 元`],
  ];
  $('#valGrid').innerHTML = items
    .map(([k, v]) => `<div class="val-item"><i>${k}</i><b>${v}</b></div>`)
    .join('');
  $('#valNote').textContent = 'PEG = PE ÷ 近 3 年净利复合增速；分红率 = 近 12 个月每股分红 ÷ 最新年报 EPS。';
  if (!a) $('#valNote').textContent = '港股/美股暂不提供分红与 EPS 数据，仅展示估值指标。';
}

function renderProfile() {
  const co = state.company.get(state.active);
  const p = co?.profile;
  const panel = $('#profilePanel');
  if (!p || (!p.profile && !p.name)) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('#profileName').textContent = p.fullName || p.name || '';
  $('#profileText').textContent = p.profile || '暂无公司简介';
  $('#profileText').classList.toggle('clamped', !state.profileExpanded);
  const long = (p.profile || '').length > 260;
  let more = panel.querySelector('.profile-more');
  if (long && !more) {
    more = document.createElement('button');
    more.className = 'profile-more';
    more.addEventListener('click', () => {
      state.profileExpanded = !state.profileExpanded;
      $('#profileText').classList.toggle('clamped', !state.profileExpanded);
      more.textContent = state.profileExpanded ? '收起' : '展开全文';
    });
    $('#profileText').parentElement.appendChild(more);
  }
  if (more) {
    more.hidden = !long;
    more.textContent = state.profileExpanded ? '收起' : '展开全文';
  }

  const site = p.website ? (/^https?:/.test(p.website) ? p.website : `http://${p.website}`) : '';
  const link = $('#profileSite');
  link.hidden = !site;
  if (site) link.href = site;

  const info = [
    ['董事长', p.chairman],
    ['总经理', p.president],
    ['行业', p.industry],
    ['上市日期', p.listed],
    ['员工人数', p.employees ? (typeof p.employees === 'string' ? p.employees : Number(p.employees).toLocaleString('zh-CN')) : ''],
    ['注册资本', p.regCapital],
    ['地址', p.address],
    ['官网', p.website],
    ['邮箱', p.email],
    ['电话', p.phone],
  ].filter(([, v]) => v);

  $('#infoGrid').innerHTML = info
    .map(([k, v]) => `<div class="info-item"><i>${k}</i><b>${esc(v)}</b></div>`)
    .join('');
}

function renderHolders() {
  const co = state.company.get(state.active);
  const panel = $('#holdersPanel');
  const holders = co?.holders || [];
  if (!holders.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('#holdersHint').textContent = holders[0]?.date || '';
  $('#holdersBody').innerHTML = holders
    .map(
      (h) => `<tr>
        <td class="name-cell">${esc(h.name)}</td>
        <td>${Number.isFinite(h.ratio) ? `${h.ratio.toFixed(2)}%` : '—'}</td>
        <td>${esc(h.change || '—')}</td>
      </tr>`
    )
    .join('');
  const hc = co.holderCount;
  $('#holderCountNote').textContent = hc
    ? `股东户数 ${Number(hc.num).toLocaleString('zh-CN')}（${hc.date}），较上期 ${hc.change > 0 ? '+' : ''}${Number(hc.change).toLocaleString('zh-CN')}（${Number(hc.ratio).toFixed(1)}%）`
    : '';
}

function renderDividends() {
  const co = state.company.get(state.active);
  const panel = $('#divPanel');
  const list = (co?.dividends || []).filter((d) => /派|转|送/.test(d.plan || ''));
  if (!list.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('#divBody').innerHTML = list
    .map(
      (d) => `<tr>
        <td class="name-cell">${esc(d.date || '—')}</td>
        <td class="th-left">${esc(d.plan || '—')}</td>
        <td>${esc(d.progress || '—')}</td>
        <td>${esc(d.exDate || '—')}</td>
      </tr>`
    )
    .join('');
}

/* ------------------------------ 主渲染 ------------------------------ */

function renderAll() {
  const secid = state.active;
  const co = state.company.get(secid);
  const q = state.quotes.get(secid);
  const hasFin = !!co?.financials?.annual?.length;

  renderChips();
  renderHeader();

  const an = analyze(co || { financials: { annual: [], latest: [] } }, q, state.closes.get(secid), q?.price);

  renderScore();
  renderKpis();
  if (hasFin) {
    $('#valPanel').hidden = false;
    renderFinChart();
    renderCashChart();
    renderValuation(an);
  } else {
    $('#finPanel').hidden = true;
    $('#cashPanel').hidden = true;
    $('#valPanel').hidden = true;
    renderValuation(an);
  }
  renderProfile();
  renderHolders();
  renderDividends();

  $('#watchBtn').textContent = isWatched(secid) ? '移出自选' : '加入自选';
  $('#watchBtn').classList.toggle('btn-primary', !isWatched(secid));
}

/* ------------------------------ 加载 ------------------------------ */

function setLoading(on) {
  state.loading = on;
  if (on) {
    $('#shName').textContent = '加载中…';
    $('#shPrice').textContent = '—';
    $('#shStats').innerHTML = '';
  }
}

function syncHistTabs() {
  document.querySelectorAll('#histModes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.hist.mode));
  document.querySelectorAll('#histRanges button').forEach((b) => b.classList.toggle('on', b.dataset.range === state.hist.range));
  const sel = $('#histBench');
  if (sel) {
    sel.value = state.hist.bench;
    sel.disabled = state.hist.mode === 'price';
  }
}

async function fetchCloses(secid, range) {
  const key = `${secid}|${range}`;
  if (state.hist.cache.has(key)) return state.hist.cache.get(key);
  let pts;
  if (range === '5y' && state.closes.get(secid)?.length) {
    pts = state.closes.get(secid);
  } else {
    const res = await getJSON(`/api/closes?secids=${encodeURIComponent(secid)}&range=${range}`);
    pts = res.items?.[secid] || [];
  }
  state.hist.cache.set(key, pts || []);
  return pts || [];
}

function benchFor(secid) {
  if (state.hist.bench === 'none') return null;
  if (state.hist.bench === 'sh300') return { secid: '1.000300', name: '沪深300' };
  if (state.hist.bench === 'hsi') return { secid: '100.HSI', name: '恒生指数' };
  if (state.hist.bench === 'spx') return { secid: '100.SPX', name: '标普500' };
  const m = secid.split('.')[0];
  if (m === '1' || m === '0') return { secid: '1.000300', name: '沪深300' };
  if (m === '116' || m === '124') return { secid: '100.HSI', name: '恒生指数' };
  if (m === '105' || m === '106' || m === '107') return { secid: '100.SPX', name: '标普500' };
  return null;
}

async function loadHist(secid, range) {
  state.hist.secid = secid;
  state.hist.range = range;
  syncHistTabs();
  const host = $('#histChart');
  host.innerHTML = '<div class="chart-loading"><span></span></div>';
  try {
    const pts = await fetchCloses(secid, range);
    const bench = benchFor(secid);
    let bpts = null;
    if (bench && state.hist.mode === 'return') bpts = await fetchCloses(bench.secid, range);
    if (state.hist.secid !== secid || state.hist.range !== range) return;
    state.hist.points = pts;
    state.hist.benchPoints = bpts;
    state.hist.benchName = bench?.name || null;
    renderHist();
  } catch (err) {
    host.innerHTML = `<div class="chart-empty">历史数据加载失败：${esc(err.message)}</div>`;
  }
}

function alignSeries(a, b) {
  const bm = new Map(b.map(([t, c]) => [t, c]));
  const common = a.filter(([t]) => bm.has(t));
  if (common.length < 2) return null;
  const a0 = common[0][1];
  const b0 = bm.get(common[0][0]);
  return {
    t: common.map(([t]) => t),
    s: common.map(([t, c]) => (c / a0 - 1) * 100),
    b: common.map(([t]) => (bm.get(t) / b0 - 1) * 100),
  };
}

function histStatsFor(points) {
  const cs = points.map((p) => p[1]);
  const total = cs[cs.length - 1] / cs[0] - 1;
  const days = (Date.parse(points[points.length - 1][0]) - Date.parse(points[0][0])) / 86400000;
  const years = days / 365.25;
  const ann = years > 0.1 ? Math.pow(1 + total, 1 / years) - 1 : null;
  let peak = cs[0];
  let mdd = 0;
  const rets = [];
  for (let i = 1; i < cs.length; i++) {
    peak = Math.max(peak, cs[i]);
    mdd = Math.min(mdd, cs[i] / peak - 1);
    if (cs[i - 1] > 0) rets.push(cs[i] / cs[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  return { total, ann, mdd, vol: Math.sqrt(variance) * Math.sqrt(252), hi: Math.max(...cs), lo: Math.min(...cs) };
}

function fmtHistPrice(v) {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 0 : 2 });
}

function annualRows(points) {
  const byYear = new Map();
  for (const [t, c] of points) {
    const y = t.slice(0, 4);
    const cur = byYear.get(y);
    if (cur) cur.last = c;
    else byYear.set(y, { first: c, last: c });
  }
  return [...byYear.entries()].map(([y, v]) => ({ y, r: v.last / v.first - 1 }));
}

function renderHist() {
  const pts = state.hist.points;
  const host = $('#histChart');
  if (!pts || pts.length < 2) {
    host.innerHTML = '<div class="chart-empty">暂无足够的历史数据</div>';
    $('#histStats').innerHTML = '';
    $('#histYears').innerHTML = '';
    $('#histLegend').hidden = true;
    return;
  }
  const bench = state.hist.mode === 'return' && state.hist.benchPoints ? alignSeries(pts, state.hist.benchPoints) : null;
  drawHistChart(pts, state.hist.mode, bench);

  const s = histStatsFor(pts);
  const years = annualRows(pts);
  const best = years.length ? years.reduce((a, b) => (b.r > a.r ? b : a)) : null;
  const worst = years.length ? years.reduce((a, b) => (b.r < a.r ? b : a)) : null;
  const cards = [
    ['区间收益', `${s.total > 0 ? '+' : ''}${(s.total * 100).toFixed(1)}%`],
    ['年化', s.ann == null ? '—' : `${s.ann > 0 ? '+' : ''}${(s.ann * 100).toFixed(1)}%`],
    ['最大回撤', `${(s.mdd * 100).toFixed(1)}%`],
    ['年化波动', `${(s.vol * 100).toFixed(1)}%`],
    ['最好年份', best ? `${best.y} +${(best.r * 100).toFixed(0)}%` : '—'],
    ['最差年份', worst && worst.r < 0 ? `${worst.y} ${(worst.r * 100).toFixed(0)}%` : '—'],
  ];
  if (bench) {
    const diff = bench.s[bench.s.length - 1] - bench.b[bench.b.length - 1];
    cards.push(['相对' + (state.hist.benchName || '基准'), `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`]);
    $('#histLegend').hidden = false;
    $('#histLegend').innerHTML = `
      <span><i style="background:${getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffb020'}"></i>${esc(nameOf(state.hist.secid))}</span>
      <span><i style="background:#5b8cff"></i>${esc(state.hist.benchName || '基准')}<b>${bench.b[bench.b.length - 1] > 0 ? '+' : ''}${bench.b[bench.b.length - 1].toFixed(1)}%</b></span>`;
  } else {
    $('#histLegend').hidden = true;
  }
  $('#histStats').innerHTML = cards.map(([k, v]) => `<span>${k}<b>${v}</b></span>`).join('');
  $('#histHint').textContent = `后复权 · ${pts[0][0]} → ${pts[pts.length - 1][0]}`;
  $('#histNote').textContent = state.hist.mode === 'return'
    ? '累计收益以区间起点为 0%，按后复权收盘价计算（已包含分红送转）。'
    : '价格按当前股价折算（前复权口径）；切到“累计收益”可看收益率变化。';
  renderHistYears(pts);
}

function drawHistChart(points, mode, bench) {
  const host = $('#histChart');
  const W = Math.max(320, host.clientWidth);
  const H = Math.max(200, host.clientHeight || 300);
  const padL = 46;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const cs = points.map((p) => p[1]);
  const q = state.quotes.get(state.hist.secid);
  const factor = q?.price ? q.price / cs[cs.length - 1] : 1;
  const dates = bench ? bench.t : points.map((p) => p[0]);
  const stockVals = bench ? bench.s : mode === 'return' ? cs.map((c) => (c / cs[0] - 1) * 100) : cs.map((c) => c * factor);
  const benchVals = bench ? bench.b : null;
  const all = benchVals ? [...stockVals, ...benchVals] : stockVals;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (mode === 'return') { min = Math.min(min, 0); max = Math.max(max, 0); }
  const span = max - min || Math.abs(max) || 1;
  min -= span * 0.08;
  max += span * 0.08;
  const ts = dates.map((t) => Date.parse(t));
  const t0 = ts[0];
  const t1 = ts[ts.length - 1] || t0 + 1;
  const X = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const Y = (v) => padT + (1 - (v - min) / (max - min || 1)) * plotH;
  const up = '#ff4d5e';
  const down = '#0ecb81';
  const cssVar = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
  const accent = cssVar('--accent', '#ffb020');
  const panelBg = cssVar('--panel', '#0b1220');
  const color = mode === 'return' ? (cs[cs.length - 1] >= cs[0] ? up : down) : accent;

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="历史走势">`;
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    const y = Y(v).toFixed(1);
    svg += `<line class="hc-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>`;
    svg += `<text class="hc-axis" x="${padL - 6}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${mode === 'return' ? `${v.toFixed(0)}%` : fmtHistPrice(v)}</text>`;
  }
  if (mode === 'return' && min < 0 && max > 0) {
    svg += `<line class="hc-zero" x1="${padL}" y1="${Y(0).toFixed(1)}" x2="${W - padR}" y2="${Y(0).toFixed(1)}"/>`;
  }
  const line = stockVals.map((v, i) => `${i ? 'L' : 'M'}${X(ts[i]).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${X(t1).toFixed(1)},${(padT + plotH).toFixed(1)} L${X(t0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  svg += `<path d="${area}" fill="${color}" opacity="0.09"/>`;
  svg += `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>`;
  if (benchVals) {
    const bline = benchVals.map((v, i) => `${i ? 'L' : 'M'}${X(ts[i]).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    svg += `<path d="${bline}" fill="none" stroke="#5b8cff" stroke-width="1.2" stroke-linejoin="round" opacity="0.85" stroke-dasharray="4 3"/>`;
  }

  const tickN = 5;
  for (let i = 0; i < tickN; i++) {
    const idx = Math.round((dates.length - 1) * (i / (tickN - 1)));
    const label = dates[idx].slice(0, 7);
    svg += `<text class="hc-axis" x="${X(ts[idx]).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === tickN - 1 ? 'end' : 'middle'}">${label}</text>`;
  }
  svg += `<line class="hc-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" visibility="hidden"/>`;
  svg += `<circle class="hc-dot" r="3.2" fill="${color}" stroke="${panelBg}" stroke-width="1.5" visibility="hidden"/>`;
  svg += '</svg>';
  host.innerHTML = svg;

  const tip = document.createElement('div');
  tip.className = 'hist-tip';
  tip.hidden = true;
  host.appendChild(tip);
  const cross = host.querySelector('.hc-cross');
  const dot = host.querySelector('.hc-dot');

  host.onpointermove = (ev) => {
    const rect = host.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    if (x < padL || x > W - padR) { host.onpointerleave(); return; }
    const target = t0 + ((x - padL) / plotW) * (t1 - t0);
    let lo = 0;
    let hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(0, Math.min(ts.length - 1, lo));
    const px = X(ts[i]);
    const py = Y(stockVals[i]);
    cross.setAttribute('x1', px.toFixed(1));
    cross.setAttribute('x2', px.toFixed(1));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px.toFixed(1));
    dot.setAttribute('cy', py.toFixed(1));
    dot.setAttribute('visibility', 'visible');
    const fmt = (v) => (mode === 'return' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : fmtHistPrice(v));
    let extra = '';
    if (benchVals) {
      const diff = stockVals[i] - benchVals[i];
      extra = `<em style="color:#5b8cff">基准 ${fmt(benchVals[i])}</em><em>相对 ${diff > 0 ? '+' : ''}${diff.toFixed(1)}%</em>`;
    }
    tip.hidden = false;
    tip.style.left = `${Math.max(70, Math.min(W - 70, px))}px`;
    tip.style.top = `${Math.max(30, py - 8)}px`;
    tip.innerHTML = `<b>${dates[i]}</b><strong>${fmt(stockVals[i])}</strong>${extra}`;
  };
  host.onpointerleave = () => {
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
  };

  if (state.hist.ro) state.hist.ro.disconnect();
  state.hist.ro = new ResizeObserver(() => drawHistChart(points, mode, bench));
  state.hist.ro.observe(host);
}

function renderHistYears(points) {
  const host = $('#histYears');
  const rows = annualRows(points);
  if (!rows.length) { host.innerHTML = ''; return; }
  const W = Math.max(320, host.clientWidth);
  const H = Math.max(80, host.clientHeight || 132);
  const padL = 40;
  const padR = 8;
  const padT = 16;
  const padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxAbs = Math.max(0.06, ...rows.map((r) => Math.abs(r.r))) * 1.12;
  const zero = padT + plotH / 2;
  const band = plotW / rows.length;
  const bw = Math.min(30, band * 0.5);
  const scale = (v) => (v / maxAbs) * (plotH / 2);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  svg += `<line class="hc-grid" x1="${padL}" y1="${zero}" x2="${W - padR}" y2="${zero}"/>`;
  rows.forEach((r, i) => {
    const cx = padL + band * i + band / 2;
    const h = Math.max(1, Math.abs(scale(r.r)));
    const y = r.r >= 0 ? zero - h : zero;
    const color = r.r >= 0 ? '#ff4d5e' : '#0ecb81';
    svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" opacity="0.75"><title>${r.y} ${(r.r * 100).toFixed(1)}%</title></rect>`;
    svg += `<text class="hc-axis" x="${cx.toFixed(1)}" y="${(r.r >= 0 ? y - 4 : y + h + 10).toFixed(1)}" text-anchor="middle" fill="${color}">${(r.r * 100).toFixed(0)}%</text>`;
    svg += `<text class="hc-axis" x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">${r.y}</text>`;
  });
  svg += '</svg>';
  host.innerHTML = svg;
}

async function loadStock(secid) {
  if (!secid) return;
  state.active = secid;
  state.profileExpanded = false;
  try {
    localStorage.setItem(LS_LAST, secid);
  } catch {
    /* ignore */
  }
  try {
    history.replaceState(null, '', `?s=${encodeURIComponent(secid)}`);
  } catch {
    /* ignore */
  }
  renderChips();
  setLoading(true);

  try {
    const [qRes, coRes, clRes] = await Promise.all([
      getJSON(`/api/quotes?secids=${encodeURIComponent(secid)}`),
      state.company.has(secid) ? Promise.resolve(state.company.get(secid)) : getJSON(`/api/company?secid=${encodeURIComponent(secid)}`),
      state.closes.has(secid) ? Promise.resolve({ items: { [secid]: state.closes.get(secid) } }) : getJSON(`/api/closes?secids=${encodeURIComponent(secid)}&range=5y`),
    ]);
    const q = qRes.items?.[0];
    if (q) state.quotes.set(secid, q);
    state.company.set(secid, coRes);
    state.closes.set(secid, clRes.items?.[secid] || []);
    $('#netBanner').hidden = true;
    renderAll();
    loadHist(secid, state.hist.range);
  } catch (err) {
    $('#netBanner').hidden = false;
    $('#netBannerText').textContent = `加载失败：${err.message}`;
  }
}

/* ------------------------------ 自选 / 搜索 ------------------------------ */

function renderChips() {
  const chips = [...state.watch];
  if (!isWatched(state.active)) chips.unshift({ secid: state.active, name: nameOf(state.active) });
  $('#stockChips').innerHTML = chips
    .map((w) => {
      const on = w.secid === state.active;
      return `<button class="asset-chip ${on ? 'on' : ''}" data-secid="${w.secid}">
        <i class="dot" style="background:${on ? 'var(--accent)' : 'var(--muted)'}"></i>${esc(w.name || w.secid)}
      </button>`;
    })
    .join('');
}

function toggleWatch() {
  const secid = state.active;
  if (isWatched(secid)) {
    state.watch = state.watch.filter((w) => w.secid !== secid);
    saveWatch();
    toast('已移出自选');
  } else {
    state.watch.push({ secid, name: nameOf(secid) });
    saveWatch();
    toast('已加入自选');
  }
  renderChips();
  renderHeader();
}

/* ------------------------------ 搜索 ------------------------------ */

function openDropdown(items) {
  state.searchItems = items;
  state.searchActive = items.length ? 0 : -1;
  const box = $('#stockDropdown');
  box.hidden = !items.length;
  box.innerHTML = items.length
    ? items
        .map((it, i) => `<div class="ad-item ${i === state.searchActive ? 'on' : ''}" data-i="${i}" data-secid="${it.secid}" data-name="${esc(it.name)}">
            <span class="ad-name">${esc(it.name)}</span>
            <span class="ad-code">${esc(it.code || '')}</span>
            ${isWatched(it.secid) ? '<span class="ad-on">已选</span>' : ''}
          </div>`)
        .join('')
    : '';
}

async function doSearch(q) {
  const keyword = q.trim();
  if (!keyword) {
    $('#stockDropdown').hidden = true;
    return;
  }
  try {
    const res = await getJSON(`/api/search?q=${encodeURIComponent(keyword)}`);
    state.searchItems = res.items || [];
    openDropdown(state.searchItems);
  } catch {
    $('#stockDropdown').hidden = true;
  }
}

function bind() {
  $('#histModes').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-mode]');
    if (!b) return;
    state.hist.mode = b.dataset.mode;
    syncHistTabs();
    if (state.hist.mode === 'return' && state.hist.bench !== 'none' && !state.hist.benchPoints) {
      loadHist(state.hist.secid || state.active, state.hist.range);
    } else if (state.hist.points.length) {
      renderHist();
    }
  });

  $('#histBench').addEventListener('change', (ev) => {
    state.hist.bench = ev.target.value;
    if (state.hist.bench !== 'none' && state.hist.mode === 'price') state.hist.mode = 'return';
    syncHistTabs();
    if (state.hist.secid) loadHist(state.hist.secid, state.hist.range);
  });

  $('#histRanges').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-range]');
    if (!b) return;
    const secid = state.hist.secid || state.active;
    if (secid) loadHist(secid, b.dataset.range);
  });

  document.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.asset-chip');
    if (chip) {
      loadStock(chip.dataset.secid);
      return;
    }
    const ad = ev.target.closest('.ad-item');
    if (ad) {
      loadStock(ad.dataset.secid);
      $('#stockInput').value = '';
      $('#stockDropdown').hidden = true;
      return;
    }
    if (!ev.target.closest('.asset-add')) $('#stockDropdown').hidden = true;
  });

  $('#watchBtn').addEventListener('click', toggleWatch);
  $('#retryBtn').addEventListener('click', () => loadStock(state.active));

  const input = $('#stockInput');
  input.addEventListener('input', debounce((ev) => doSearch(ev.target.value), 260));
  input.addEventListener('keydown', (ev) => {
    const n = state.searchItems.length;
    if (ev.key === 'ArrowDown' && n) {
      ev.preventDefault();
      state.searchActive = (state.searchActive + 1) % n;
      document.querySelectorAll('.ad-item').forEach((el) => el.classList.toggle('on', Number(el.dataset.i) === state.searchActive));
    } else if (ev.key === 'ArrowUp' && n) {
      ev.preventDefault();
      state.searchActive = (state.searchActive - 1 + n) % n;
      document.querySelectorAll('.ad-item').forEach((el) => el.classList.toggle('on', Number(el.dataset.i) === state.searchActive));
    } else if (ev.key === 'Enter') {
      const it = state.searchItems[state.searchActive];
      if (it) {
        loadStock(it.secid);
        input.value = '';
        $('#stockDropdown').hidden = true;
      }
    } else if (ev.key === 'Escape') {
      $('#stockDropdown').hidden = true;
    }
  });

  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('marketpulse.theme.v1', next);
    renderAll();
  });

  window.addEventListener('resize', debounce(() => {
    const co = state.company.get(state.active);
    if (co?.financials?.annual?.length) {
      renderFinChart();
      renderCashChart();
      const q = state.quotes.get(state.active);
      const an = analyze(co, q, state.closes.get(state.active), q?.price);
      renderRadar($('#radar'), an.dims);
    }
  }, 200));
}

/* ------------------------------ 启动 ------------------------------ */

function init() {
  const theme = localStorage.getItem('marketpulse.theme.v1');
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';

  state.watch = loadWatch();
  const param = new URLSearchParams(location.search).get('s');
  const last = localStorage.getItem(LS_LAST);
  const fallback = state.watch[0]?.secid || '1.600519';
  state.active = param && /^[0-9]{1,3}\.[A-Za-z0-9_-]{1,12}$/.test(param) ? param : last || fallback;

  renderChips();
  bind();
  loadStock(state.active);
}

init();
