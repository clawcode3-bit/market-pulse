/* ==========================================================================
   市场脉搏 · 研究台
   历史收益 / 回撤 / 季节性 / 相关性 / 财务概览
   ========================================================================== */

import { mountMultiChart } from './charts.js';

const COLORS = ['#ffb020', '#5b8cff', '#b06cff', '#2dd4bf', '#ff7a45'];
const MAX_ASSETS = 5;
const LS = 'marketpulse.research.v1';

const DEFAULTS = [
  { secid: '1.000300', name: '沪深300' },
  { secid: '1.000001', name: '上证指数' },
  { secid: '100.NDX', name: '纳斯达克' },
  { secid: '1.600519', name: '贵州茅台' },
];

const PRESETS = [
  ['1.000001', '上证指数'],
  ['1.000300', '沪深300'],
  ['0.399006', '创业板指'],
  ['100.HSI', '恒生指数'],
  ['124.HSTECH', '恒生科技'],
  ['100.NDX', '纳斯达克'],
  ['100.SPX', '标普500'],
  ['100.N225', '日经225'],
  ['101.GC00Y', 'COMEX黄金'],
  ['102.CL00Y', 'NYMEX原油'],
  ['100.UDI', '美元指数'],
  ['1.600519', '贵州茅台'],
  ['116.00700', '腾讯控股'],
  ['105.NVDA', '英伟达'],
  ['105.AAPL', '苹果'],
];

const RANGES = [
  ['3y', '3年'],
  ['5y', '5年'],
  ['10y', '10年'],
  ['max', '全部'],
];

const state = {
  assets: [],
  active: null,
  range: '5y',
  mode: 'index',
  quotes: new Map(),
  closes: new Map(),
  monthly: new Map(),
  fundamentals: new Map(),
  chartCleanup: null,
  seq: 0,
  searchItems: [],
  searchActive: -1,
};

/* ------------------------------ 工具 ------------------------------ */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (n, d = 1) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';

const pct = (n, d = 1) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${(n * 100).toFixed(d)}%` : '—');
const pctAbs = (n, d = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : '—');
const pctRaw = (n, d = 1) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(d)}%` : '—');

const sign = (n) => (!Number.isFinite(n) || Math.abs(n) < 1e-9 ? 'flat' : n > 0 ? 'up' : 'down');

const big = (n) => {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
  if (a >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return n.toFixed(0);
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (n, f) => (cs.getPropertyValue(n) || '').trim() || f;
  return {
    up: pick('--up', '#ff4d5e'),
    down: pick('--down', '#0ecb81'),
    muted: pick('--muted', '#6c7689'),
    line: pick('--line', 'rgba(255,255,255,.08)'),
    text2: pick('--text-2', '#a8b1c2'),
  };
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
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

/* ------------------------------ 状态持久化 ------------------------------ */

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS) || 'null');
    if (raw && Array.isArray(raw.assets) && raw.assets.length) {
      return {
        assets: raw.assets.filter((a) => a && a.secid).slice(0, MAX_ASSETS),
        range: RANGES.some((r) => r[0] === raw.range) ? raw.range : '5y',
        mode: raw.mode === 'drawdown' ? 'drawdown' : 'index',
      };
    }
  } catch {
    /* ignore */
  }
  return { assets: DEFAULTS.map((a) => ({ ...a })), range: '5y', mode: 'index' };
}

function save() {
  try {
    localStorage.setItem(LS, JSON.stringify({ assets: state.assets, range: state.range, mode: state.mode }));
  } catch {
    /* ignore */
  }
}

function isAStock(secid) {
  const [market, code] = String(secid).split('.');
  if (market === '1') return /^6/.test(code);
  if (market === '0') return /^399/.test(code) ? false : /^(000|001|002|003|300|301|4|8)/.test(code);
  return false;
}

const nameOf = (secid) => state.quotes.get(secid)?.name || state.assets.find((a) => a.secid === secid)?.name || secid;
const colorOf = (secid) => {
  const i = state.assets.findIndex((a) => a.secid === secid);
  return COLORS[i % COLORS.length];
};

/* ------------------------------ 统计 ------------------------------ */

function computeStats(points) {
  if (!points || points.length < 2) return null;
  const cs = points.map((p) => p[1]);
  const ts = points.map((p) => Date.parse(`${p[0]}T00:00:00Z`));
  const total = cs[cs.length - 1] / cs[0] - 1;
  const days = (ts[ts.length - 1] - ts[0]) / 86400000;
  const years = days / 365.25;
  const ann = years > 0.02 ? Math.pow(1 + total, 1 / years) - 1 : null;

  const rets = [];
  for (let i = 1; i < cs.length; i++) if (cs[i - 1] > 0) rets.push(cs[i] / cs[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  const sharpe = vol > 0 ? (mean * 252) / vol : null;

  let peak = cs[0];
  let mdd = 0;
  for (const c of cs) {
    peak = Math.max(peak, c);
    mdd = Math.min(mdd, c / peak - 1);
  }

  return { total, ann, vol, mdd, sharpe, days, n: cs.length, start: points[0][0], end: points[points.length - 1][0] };
}

function monthlyReturns(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const [t, c] = points[i];
    const prev = points[i - 1][1];
    if (prev > 0) out.push({ t, y: Number(t.slice(0, 4)), m: Number(t.slice(5, 7)), r: c / prev - 1 });
  }
  return out;
}

function dailyReturns(points) {
  const map = new Map();
  for (let i = 1; i < points.length; i++) {
    const [t, c] = points[i];
    const prev = points[i - 1][1];
    if (prev > 0) map.set(t, c / prev - 1);
  }
  return map;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 8) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : null;
}

function pairCorr(idA, idB) {
  const a = state.closes.get(idA);
  const b = state.closes.get(idB);
  if (!a || !b) return null;
  const ra = dailyReturns(a);
  const rb = dailyReturns(b);
  const dates = [...ra.keys()].filter((d) => rb.has(d));
  if (dates.length < 20) return null;
  return pearson(dates.map((d) => ra.get(d)), dates.map((d) => rb.get(d)));
}

/* ------------------------------ 渲染：资产 ------------------------------ */

function renderChips() {
  $('#assetChips').innerHTML = state.assets
    .map((a) => {
      const c = COLORS[state.assets.indexOf(a) % COLORS.length];
      return `<button class="asset-chip ${a.secid === state.active ? 'on' : ''}" data-asset="${a.secid}"
        title="${esc(nameOf(a.secid))}">
        <i class="dot" style="background:${c}"></i>${esc(nameOf(a.secid))}
        ${state.assets.length > 1 ? `<span class="rm" data-rm="${a.secid}" title="移除">×</span>` : ''}
      </button>`;
    })
    .join('');
}

function renderRanges() {
  $('#rangeTabs').innerHTML = RANGES.map(
    ([k, label]) => `<button data-range="${k}" class="${state.range === k ? 'on' : ''}">${label}</button>`
  ).join('');
}

function renderLegend() {
  $('#legend').innerHTML = state.assets
    .map((a) => {
      const c = colorOf(a.secid);
      return `<span class="lg-item ${a.secid === state.active ? '' : ''}" data-legend="${a.secid}">
        <i class="dot" style="background:${c}"></i>${esc(nameOf(a.secid))}</span>`;
    })
    .join('');
}

/* ------------------------------ 渲染：KPI ------------------------------ */

function renderKpis() {
  const pts = state.closes.get(state.active);
  const st = computeStats(pts);
  const grid = $('#kpiGrid');

  if (!st) {
    grid.innerHTML = [1, 2, 3, 4, 5, 6]
      .map(() => `<div class="kpi"><i>加载中</i><b>—</b><small>&nbsp;</small></div>`)
      .join('');
    $('#kpiSub').textContent = '';
    return;
  }

  const months = monthlyReturns(state.monthly.get(state.active) || []);
  const inRange = months.filter((m) => m.t >= st.start);
  const win = inRange.length ? inRange.filter((m) => m.r > 0).length / inRange.length : null;

  const card = (label, value, cls, sub) =>
    `<div class="kpi"><i>${label}</i><b class="${cls}">${value}</b><small>${sub}</small></div>`;

  grid.innerHTML = [
    card('累计收益', pct(st.total), sign(st.total), `${st.n} 个交易日`),
    card('年化收益', st.ann == null ? '—' : pct(st.ann), sign(st.ann), `约 ${(st.days / 365.25).toFixed(1)} 年`),
    card('最大回撤', pct(st.mdd), 'down', '区间内峰值回落'),
    card('年化波动', pctAbs(st.vol), 'flat', '日收益标准差 × √252'),
    card('夏普', st.sharpe == null ? '—' : st.sharpe.toFixed(2), 'flat', '无风险利率按 0'),
    card('月度胜率', win == null ? '—' : `${(win * 100).toFixed(0)}%`, win != null && win >= 0.5 ? 'up' : 'flat', `${inRange.length} 个月`),
  ].join('');

  $('#kpiSub').textContent = `${nameOf(state.active)} · ${st.start} → ${st.end} · 后复权`;
}

/* ------------------------------ 渲染：对比图 ------------------------------ */

function renderChart() {
  const host = $('#rChart');
  const series = state.assets
    .map((a) => ({ name: nameOf(a.secid), color: colorOf(a.secid), points: state.closes.get(a.secid) }))
    .filter((s) => s.points && s.points.length > 1);

  if (state.chartCleanup) {
    state.chartCleanup();
    state.chartCleanup = null;
  }

  if (!series.length) {
    host.innerHTML = '<div class="chart-empty">暂无可对比的数据</div>';
    return;
  }

  state.chartCleanup = mountMultiChart(host, series, { mode: state.mode, height: 380 });
  $('#chartHint').textContent = state.mode === 'drawdown' ? '相对区间前高 %' : '起点 = 100';
  $('#chartNote').textContent =
    state.mode === 'drawdown'
      ? '回撤 = 当前价格相对区间内历史最高价的跌幅；越接近 0 表示离前高越近。'
      : '全部标的以区间首个交易日为 100 归一化；股票使用后复权价格，跨市场未做汇率调整。';
}

/* ------------------------------ 渲染：热力图 ------------------------------ */

function renderHeatmap() {
  const host = $('#heatmap');
  const pts = state.monthly.get(state.active);
  if (!pts) {
    host.innerHTML = '<div class="chart-empty">加载中…</div>';
    return;
  }
  const rets = monthlyReturns(pts);
  const byYear = new Map();
  for (const r of rets) {
    if (!byYear.has(r.y)) byYear.set(r.y, {});
    byYear.get(r.y)[r.m] = r;
  }
  const years = [...byYear.keys()].sort((a, b) => b - a).slice(0, 15);
  $('#heatTitle').textContent = `${nameOf(state.active)} · ${years[years.length - 1]}–${years[0]}`;

  const maxAbs = 0.08;
  const cellBg = (r) => {
    const a = clamp(Math.abs(r) / maxAbs, 0.06, 1);
    const p = (6 + a * 62).toFixed(0);
    return `background:color-mix(in srgb, var(--${r >= 0 ? 'up' : 'down'}) ${p}%, transparent)`;
  };

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  let html = '<div class="hm-grid">';
  html += '<div class="hm-head year">年份</div>';
  for (let m = 1; m <= 12; m++) html += `<div class="hm-head">${m}月</div>`;
  html += '<div class="hm-head total">全年</div>';

  for (const y of years) {
    html += `<div class="hm-year">${y}</div>`;
    let total = 1;
    let hasAny = false;
    for (let m = 1; m <= 12; m++) {
      const r = byYear.get(y)[m];
      if (!r) {
        html += '<div class="hm-cell hm-empty">·</div>';
        continue;
      }
      hasAny = true;
      total *= 1 + r.r;
      const cur = y === curY && m === curM ? ' cur' : '';
      html += `<div class="hm-cell${cur}" style="${cellBg(r.r)}"
        title="${y}年${m}月 ${pct(r.r, 2)}">${(r.r * 100).toFixed(1)}</div>`;
    }
    const tr = hasAny ? total - 1 : null;
    html += tr == null
      ? '<div class="hm-cell total hm-empty">·</div>'
      : `<div class="hm-cell total" style="${cellBg(tr)}" title="${y}年 ${pct(tr, 2)}">${(tr * 100).toFixed(1)}</div>`;
  }
  html += '</div>';

  html += `<div class="hm-legend"><span>-8%</span>
    <i style="background:color-mix(in srgb, var(--down) 62%, transparent)"></i>
    <i style="background:color-mix(in srgb, var(--down) 32%, transparent)"></i>
    <i style="background:transparent;border:1px solid var(--line)"></i>
    <i style="background:color-mix(in srgb, var(--up) 32%, transparent)"></i>
    <i style="background:color-mix(in srgb, var(--up) 62%, transparent)"></i>
    <span>+8%</span><span style="margin-left:10px">虚线框 = 当月（未结束）</span></div>`;

  host.innerHTML = html;
}

/* ------------------------------ 渲染：月份效应 ------------------------------ */

function renderMonthEffect() {
  const host = $('#monthEffect');
  const pts = state.monthly.get(state.active);
  if (!pts) {
    host.innerHTML = '';
    return;
  }
  const W = Math.max(320, host.clientWidth);
  const H = 190;
  const rets = monthlyReturns(pts).slice(-15 * 12);
  const groups = Array.from({ length: 12 }, () => []);
  for (const r of rets) groups[r.m - 1].push(r.r);

  const stats = groups.map((g) => ({
    avg: g.length ? g.reduce((a, b) => a + b, 0) / g.length : null,
    win: g.length ? g.filter((v) => v > 0).length / g.length : null,
    n: g.length,
  }));

  const C = themeColors();
  const maxAbs = Math.max(0.02, ...stats.map((s) => (s.avg == null ? 0 : Math.abs(s.avg))));
  const padL = 36;
  const padR = 8;
  const padT = 18;
  const plotH = 118;
  const plotW = W - padL - padR;
  const band = plotW / 12;
  const zero = padT + plotH / 2;
  const scale = (v) => (v / maxAbs) * (plotH / 2 - 6);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="月份效应">`;
  svg += `<line x1="${padL}" y1="${zero}" x2="${W - padR}" y2="${zero}" stroke="${C.line}" stroke-width="1"/>`;
  svg += `<text x="${padL - 6}" y="${zero + 3}" text-anchor="end" font-size="8.5"
    fill="${C.muted}" font-family="SF Mono, Menlo, monospace">0</text>`;
  svg += `<text x="${padL - 6}" y="${(zero - scale(maxAbs) + 3).toFixed(1)}" text-anchor="end" font-size="8.5"
    fill="${C.muted}" font-family="SF Mono, Menlo, monospace">+${(maxAbs * 100).toFixed(1)}%</text>`;

  stats.forEach((s, i) => {
    const cx = padL + band * i + band / 2;
    const bw = Math.min(26, band * 0.52);
    if (s.avg == null) return;
    const h = Math.abs(scale(s.avg));
    const y = s.avg >= 0 ? zero - h : zero;
    const col = s.avg >= 0 ? C.up : C.down;
    svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}"
      rx="2" fill="${col}" opacity="0.72"><title>${i + 1}月 平均 ${pctRaw(s.avg * 100, 2)} · 胜率 ${(s.win * 100).toFixed(0)}%</title></rect>`;
    svg += `<text x="${cx.toFixed(1)}" y="${(s.avg >= 0 ? y - 4 : y + h + 10).toFixed(1)}" text-anchor="middle"
      font-size="8.5" fill="${col}"
      font-family="SF Mono, Menlo, monospace">${(s.avg * 100).toFixed(1)}</text>`;
    svg += `<text x="${cx.toFixed(1)}" y="${H - 22}" text-anchor="middle" font-size="9"
      fill="${C.text2}" font-family="sans-serif">${i + 1}月</text>`;
    svg += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="8"
      fill="${C.muted}" font-family="SF Mono, Menlo, monospace">${(s.win * 100).toFixed(0)}%</text>`;
  });
  svg += '</svg>';
  host.innerHTML = svg;
}

/* ------------------------------ 渲染：相关性 ------------------------------ */

function renderCorr() {
  const host = $('#corr');
  const ids = state.assets.map((a) => a.secid);
  if (ids.length < 2) {
    host.innerHTML = '<div class="chart-empty" style="height:120px">至少选择 2 个标的</div>';
    return;
  }
  const n = ids.length;
  const cols = `minmax(74px, 1.1fr) repeat(${n}, minmax(44px, 1fr))`;

  let html = `<div class="corr-grid" style="grid-template-columns:${cols}">`;
  html += '<div class="corr-head"></div>';
  ids.forEach((id) => (html += `<div class="corr-head">${esc(nameOf(id))}</div>`));
  for (let i = 0; i < n; i++) {
    html += `<div class="corr-name">${esc(nameOf(ids[i]))}</div>`;
    for (let j = 0; j < n; j++) {
      const r = i === j ? 1 : pairCorr(ids[i], ids[j]);
      if (r == null) {
        html += '<div class="corr-cell" style="background:var(--panel-2);color:var(--muted)">—</div>';
        continue;
      }
      const a = Math.max(0, Math.abs(r) - 0.15) / 0.85;
      const bg =
        i === j
          ? 'background:var(--panel-3);color:var(--muted)'
          : r >= 0
          ? `background:color-mix(in srgb, var(--blue) ${(6 + a * 55).toFixed(0)}%, transparent)`
          : `background:color-mix(in srgb, var(--accent) ${(6 + a * 55).toFixed(0)}%, transparent)`;
      html += `<div class="corr-cell" style="${bg}" title="${esc(nameOf(ids[i]))} × ${esc(nameOf(ids[j]))} = ${r.toFixed(3)}">${r.toFixed(2)}</div>`;
    }
  }
  html += '</div>';
  host.innerHTML = html;
}

/* ------------------------------ 渲染：统计表 ------------------------------ */

function renderStats() {
  const body = $('#statBody');
  body.innerHTML = state.assets
    .map((a) => {
      const st = computeStats(state.closes.get(a.secid));
      const corr = a.secid === state.active ? null : pairCorr(a.secid, state.active);
      const months = monthlyReturns(state.monthly.get(a.secid) || []);
      const inRange = st ? months.filter((m) => m.t >= st.start) : [];
      const win = inRange.length ? inRange.filter((m) => m.r > 0).length / inRange.length : null;
      return `<tr data-asset="${a.secid}" class="${a.secid === state.active ? 'on' : ''}">
        <td class="name-cell"><i class="dot" style="background:${colorOf(a.secid)}"></i>${esc(nameOf(a.secid))}</td>
        <td class="${sign(st?.total)}">${st ? pct(st.total) : '—'}</td>
        <td class="${sign(st?.ann)}">${st && st.ann != null ? pct(st.ann) : '—'}</td>
        <td class="down">${st ? pct(st.mdd) : '—'}</td>
        <td>${st ? pctAbs(st.vol) : '—'}</td>
        <td>${st && st.sharpe != null ? st.sharpe.toFixed(2) : '—'}</td>
        <td>${win == null ? '—' : `${(win * 100).toFixed(0)}%`}</td>
        <td>${corr == null ? '—' : corr.toFixed(2)}</td>
      </tr>`;
    })
    .join('');

  const st = computeStats(state.closes.get(state.active));
  $('#statHint').textContent = st ? `${st.start} → ${st.end} · ${st.n} 个交易日` : '';
}

/* ------------------------------ 渲染：公司档案 ------------------------------ */

function renderCompany() {
  const panel = $('#companyPanel');
  const secid = state.active;
  const fund = state.fundamentals.get(secid);

  if (!isAStock(secid)) {
    panel.hidden = true;
    return;
  }
  if (!fund) {
    panel.hidden = false;
    $('#companyName').textContent = nameOf(secid);
    $('#companyValuation').innerHTML = '<div class="val-item"><i>状态</i><b>加载中</b></div>';
    $('#companyLatest').innerHTML = '';
    $('#finBody').innerHTML = '';
    return;
  }

  if (!fund.annual || !fund.annual.length) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  const q = state.quotes.get(secid) || {};
  const latest = fund.latest?.[0] || null;
  const st = computeStats(state.closes.get(secid));

  $('#companyName').textContent = fund.name || nameOf(secid);

  const vals = [
    ['总市值', big(q.mcap)],
    ['市盈率 TTM', Number.isFinite(q.pe) ? q.pe.toFixed(1) : '—'],
    ['市净率', Number.isFinite(q.pb) ? q.pb.toFixed(2) : '—'],
    ['每股收益', latest && Number.isFinite(latest.eps) ? latest.eps.toFixed(2) : '—'],
  ];
  $('#companyValuation').innerHTML = vals
    .map(([k, v]) => `<div class="val-item"><i>${k}</i><b>${v}</b></div>`)
    .join('');

  if (latest) {
    $('#companyLatest').innerHTML = `
      <div class="lb-title">最新报告期 · ${esc(latest.label || latest.date)}</div>
      <div class="lb-row">
        <div class="lb-item"><i>营业收入</i><b>${big(latest.revenue)}</b></div>
        <div class="lb-item"><i>同比</i><b class="${sign(latest.revenueYoY)}">${Number.isFinite(latest.revenueYoY) ? pctRaw(latest.revenueYoY, 1) : '—'}</b></div>
        <div class="lb-item"><i>净利润</i><b>${big(latest.netProfit)}</b></div>
        <div class="lb-item"><i>同比</i><b class="${sign(latest.profitYoY)}">${Number.isFinite(latest.profitYoY) ? pctRaw(latest.profitYoY, 1) : '—'}</b></div>
        <div class="lb-item"><i>ROE</i><b>${Number.isFinite(latest.roe) ? latest.roe.toFixed(1) : '—'}</b></div>
      </div>`;
  } else {
    $('#companyLatest').innerHTML = '';
  }

  const years = (fund.annual || []).slice(0, 6);
  $('#finBody').innerHTML = years
    .map(
      (r) => `<tr>
        <td class="name-cell">${esc(r.label || r.date)}</td>
        <td>${big(r.revenue)}</td>
        <td class="yoy ${sign(r.revenueYoY)}">${Number.isFinite(r.revenueYoY) ? pctRaw(r.revenueYoY, 1) : '—'}</td>
        <td>${big(r.netProfit)}</td>
        <td class="yoy ${sign(r.profitYoY)}">${Number.isFinite(r.profitYoY) ? pctRaw(r.profitYoY, 1) : '—'}</td>
        <td>${Number.isFinite(r.roe) ? r.roe.toFixed(1) : '—'}</td>
        <td>${Number.isFinite(r.grossMargin) ? `${r.grossMargin.toFixed(1)}%` : '—'}</td>
        <td>${Number.isFinite(r.netMargin) ? `${r.netMargin.toFixed(1)}%` : '—'}</td>
        <td>${Number.isFinite(r.debtRatio) ? `${r.debtRatio.toFixed(1)}%` : '—'}</td>
      </tr>`
    )
    .join('');

  $('#companyNote').textContent = st ? `A 股 · 后复权 · ${st.start} 起` : 'A 股 · 年报口径';
}

/* ------------------------------ 数据加载 ------------------------------ */

async function loadQuotes() {
  try {
    const ids = state.assets.map((a) => a.secid);
    const res = await getJSON(`/api/quotes?secids=${ids.join(',')}`);
    (res.items || []).forEach((q) => state.quotes.set(q.secid, q));
  } catch {
    /* 名称回退到本地缓存 */
  }
}

async function loadCloses() {
  const seq = ++state.seq;
  $('#rChart').innerHTML = '<div class="chart-loading"><span></span></div>';
  try {
    const ids = state.assets.map((a) => a.secid);
    const res = await getJSON(`/api/closes?secids=${ids.join(',')}&range=${state.range}`);
    if (seq !== state.seq) return;
    state.closes = new Map(Object.entries(res.items || {}));
    $('#netBanner').hidden = true;
  } catch (err) {
    if (seq === state.seq) {
      $('#netBanner').hidden = false;
      $('#netBannerText').textContent = `历史数据加载失败：${err.message}`;
      state.closes = new Map();
    }
  }
  if (seq === state.seq) renderAll();
}

async function loadMonthlyAll() {
  const missing = state.assets.map((a) => a.secid).filter((id) => !state.monthly.has(id));
  if (!missing.length) return;
  try {
    const res = await getJSON(`/api/monthly?secids=${missing.join(',')}&lmt=480`);
    Object.entries(res.items || {}).forEach(([id, pts]) => state.monthly.set(id, pts));
  } catch {
    /* 月度数据失败时热力图留空 */
  }
  renderHeatmap();
  renderMonthEffect();
  renderKpis();
  renderStats();
}

async function loadFundamentals(secid) {
  if (!isAStock(secid)) return;
  if (state.fundamentals.has(secid)) {
    renderCompany();
    return;
  }
  renderCompany();
  try {
    const res = await getJSON(`/api/fundamentals?secid=${encodeURIComponent(secid)}`);
    state.fundamentals.set(secid, res);
    if (secid === state.active) renderCompany();
  } catch {
    state.fundamentals.set(secid, { annual: [], latest: [], name: nameOf(secid) });
    if (secid === state.active) renderCompany();
  }
}

function renderAll() {
  renderChips();
  renderKpis();
  renderChart();
  renderStats();
  renderCorr();
  renderLegend();

  const pts = state.closes.get(state.active);
  if (pts?.length) {
    $('#asof').textContent = `数据截至 ${pts[pts.length - 1][0]}`;
  }
  if (state.monthly.has(state.active)) {
    renderHeatmap();
    renderMonthEffect();
  } else {
    $('#heatmap').innerHTML = '<div class="chart-loading" style="height:180px"><span></span></div>';
    $('#monthEffect').innerHTML = '';
    loadMonthlyAll();
  }
  renderCompany();
  loadFundamentals(state.active);

  $('#metaCount').textContent = String(state.assets.length);
  $('#metaRange').textContent = RANGES.find((r) => r[0] === state.range)?.[1] || '5年';
}

/* ------------------------------ 交互 ------------------------------ */

function setActive(secid) {
  if (secid === state.active) return;
  state.active = secid;
  save();
  renderChips();
  renderKpis();
  renderStats();
  renderCorr();
  renderHeatmap();
  renderMonthEffect();
  renderCompany();
  loadFundamentals(secid);
}

function addAsset(item) {
  if (state.assets.some((a) => a.secid === item.secid)) {
    toast(`${item.name} 已在对比列表`);
    return;
  }
  if (state.assets.length >= MAX_ASSETS) {
    toast(`最多同时对比 ${MAX_ASSETS} 个标的`);
    return;
  }
  state.assets.push({ secid: item.secid, name: item.name });
  save();
  state.closes.delete(item.secid);
  renderChips();
  loadQuotes().then(() => {
    renderChips();
    renderLegend();
  });
  loadCloses();
  loadMonthlyAll();
  toast(`已添加 · ${item.name}`);
}

function removeAsset(secid) {
  if (state.assets.length <= 1) {
    toast('至少保留 1 个标的');
    return;
  }
  state.assets = state.assets.filter((a) => a.secid !== secid);
  state.closes.delete(secid);
  if (state.active === secid) state.active = state.assets[0].secid;
  save();
  renderAll();
}

function showPresets() {
  const box = $('#assetDropdown');
  const chosen = (id) => (state.assets.some((a) => a.secid === id) ? 1 : 0);
  state.searchItems = [...PRESETS]
    .sort((a, b) => chosen(a[0]) - chosen(b[0]))
    .map(([secid, name]) => ({ secid, name, code: secid.split('.')[1] }));
  state.searchActive = -1;
  box.hidden = false;
  box.innerHTML = state.searchItems
    .map((it) => {
      const on = state.assets.some((a) => a.secid === it.secid);
      return `<div class="ad-item" data-secid="${it.secid}" data-name="${esc(it.name)}">
        <span class="ad-name">${esc(it.name)}</span>
        <span class="ad-code">${esc(it.code)}</span>
        ${on ? '<span class="ad-on">已选</span>' : ''}
      </div>`;
    })
    .join('');
}

async function doSearch(q) {
  const keyword = q.trim();
  const box = $('#assetDropdown');
  if (!keyword) {
    box.hidden = true;
    return;
  }
  try {
    const res = await getJSON(`/api/search?q=${encodeURIComponent(keyword)}`);
    state.searchItems = res.items || [];
    state.searchActive = state.searchItems.length ? 0 : -1;
    box.hidden = false;
    box.innerHTML = state.searchItems.length
      ? state.searchItems
          .map((it, i) => {
            const on = state.assets.some((a) => a.secid === it.secid);
            return `<div class="ad-item ${i === state.searchActive ? 'on' : ''}" data-i="${i}" data-secid="${it.secid}" data-name="${esc(it.name)}">
              <span class="ad-name">${esc(it.name)}</span>
              <span class="ad-code">${esc(it.code)}</span>
              ${on ? '<span class="ad-on">已选</span>' : ''}
            </div>`;
          })
          .join('')
      : '<div class="ad-empty">没有找到匹配的标的</div>';
  } catch {
    box.hidden = false;
    box.innerHTML = '<div class="ad-empty">搜索失败，请稍后重试</div>';
  }
}

function bind() {
  document.addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-rm]');
    if (rm) {
      ev.stopPropagation();
      removeAsset(rm.dataset.rm);
      return;
    }
    const chip = ev.target.closest('[data-asset]');
    if (chip) {
      setActive(chip.dataset.asset);
      return;
    }
    const legend = ev.target.closest('[data-legend]');
    if (legend) {
      setActive(legend.dataset.legend);
      return;
    }
    const range = ev.target.closest('[data-range]');
    if (range) {
      state.range = range.dataset.range;
      save();
      renderRanges();
      loadCloses();
      return;
    }
    const mode = ev.target.closest('[data-mode]');
    if (mode) {
      state.mode = mode.dataset.mode;
      save();
      document.querySelectorAll('#chartMode button').forEach((b) => b.classList.toggle('on', b === mode));
      renderChart();
      return;
    }
    const ad = ev.target.closest('.ad-item');
    if (ad) {
      addAsset({ secid: ad.dataset.secid, name: ad.dataset.name });
      $('#assetInput').value = '';
      $('#assetDropdown').hidden = true;
      return;
    }
    if (!ev.target.closest('.asset-add')) $('#assetDropdown').hidden = true;
  });

  const input = $('#assetInput');
  input.addEventListener('focus', () => {
    if (!input.value.trim()) showPresets();
  });
  input.addEventListener('click', () => {
    if (!input.value.trim()) showPresets();
  });
  input.addEventListener(
    'input',
    debounce((ev) => doSearch(ev.target.value), 260)
  );
  input.addEventListener('keydown', (ev) => {
    const n = state.searchItems.length;
    if (ev.key === 'ArrowDown' && n) {
      ev.preventDefault();
      state.searchActive = (state.searchActive + 1) % n;
      doRenderSearchActive();
    } else if (ev.key === 'ArrowUp' && n) {
      ev.preventDefault();
      state.searchActive = (state.searchActive - 1 + n) % n;
      doRenderSearchActive();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const it = state.searchItems[state.searchActive];
      if (it) {
        addAsset(it);
        input.value = '';
        $('#assetDropdown').hidden = true;
      }
    } else if (ev.key === 'Escape') {
      $('#assetDropdown').hidden = true;
    }
  });

  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('marketpulse.theme.v1', next);
    renderChart();
    renderMonthEffect();
  });

  $('#retryBtn').addEventListener('click', () => loadCloses());

  window.addEventListener('resize', debounce(() => {
    if (state.mode) renderMonthEffect();
  }, 200));
}

function doRenderSearchActive() {
  document.querySelectorAll('.ad-item').forEach((el) => {
    el.classList.toggle('on', Number(el.dataset.i) === state.searchActive);
  });
}

/* ------------------------------ 启动 ------------------------------ */

function init() {
  const saved = load();
  state.assets = saved.assets;
  state.range = saved.range;
  state.mode = saved.mode;

  const focus = new URLSearchParams(location.search).get('s');
  if (focus && /^[0-9]{1,3}\.[A-Za-z0-9_-]{1,12}$/.test(focus)) {
    if (!state.assets.some((a) => a.secid === focus)) {
      if (state.assets.length >= MAX_ASSETS) state.assets.pop();
      state.assets.push({ secid: focus, name: focus });
      save();
    }
    state.active = focus;
  } else {
    state.active = state.assets[0].secid;
  }

  const theme = localStorage.getItem('marketpulse.theme.v1');
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';

  renderRanges();
  document.querySelectorAll('#chartMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
  renderChips();
  bind();

  (async () => {
    await loadQuotes();
    renderChips();
    renderLegend();
    await loadCloses();
    await loadMonthlyAll();
    renderAll();
    await loadFundamentals(state.active);
  })();
}

init();
