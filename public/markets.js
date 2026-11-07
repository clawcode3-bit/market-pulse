/* ==========================================================================
   市场脉搏 · 市场规模
   全球口径：世界银行年度市值 × 指数推算 × 当日汇率
   实时口径：中美港全市场个股汇总
   ========================================================================== */

import { mountChart } from './charts.js';

const GROUP_COLORS = {
  美国: '#5b8cff',
  中国内地: '#ffb020',
  中国香港: '#b06cff',
  日本: '#2dd4bf',
  欧洲: '#ff9f43',
  亚太其他: '#22c55e',
  拉美: '#f472b6',
};

const REGION_COLORS = {
  美洲: '#5b8cff',
  欧洲: '#b06cff',
  亚太: '#2dd4bf',
  中东非洲: '#ff9f43',
};

const LIVE_COLORS = { us: '#5b8cff', hk: '#b06cff', sh: '#ffb020', sz: '#2dd4bf', bj: '#ff7a45' };

const SYMBOL = { USD: '$', HKD: 'HK$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥', INR: '₹', BRL: 'R$' };

const REGIONS = ['全部', '美洲', '欧洲', '亚太', '中东非洲'];

const state = {
  scope: 'world',
  region: '全部',
  mode: 'float',
  world: null,
  live: null,
  index: 'all',
  indexList: [],
  indexData: null,
  ranking: null,
  hist: { secid: null, range: '5y', points: [], cache: new Map(), cleanup: null },
  tip: null,
  busy: false,
};

/* ------------------------------ 工具 ------------------------------ */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const t = (v, d = 1) => `$${(v / 1e12).toFixed(d)}T`;
const tSmart = (v) => (v / 1e12 >= 1 ? `$${(v / 1e12).toFixed(1)}T` : `$${(v / 1e12).toFixed(2)}T`);
const localT = (v, cur) => `${SYMBOL[cur] || `${cur} `}${(v / 1e12).toFixed(v / 1e12 >= 1 ? 1 : 2)}T`;
const shareOf = (v, total) => (total ? (v / total) * 100 : 0);
const sign = (n) => (!Number.isFinite(n) || Math.abs(n) < 1e-9 ? 'flat' : n > 0 ? 'up' : 'down');
const pct = (n) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%` : '—');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok === false) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
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

/* ------------------------------ Treemap ------------------------------ */

function worstAspect(areas, side) {
  const sum = areas.reduce((a, b) => a + b, 0);
  if (!sum || side <= 0) return Infinity;
  const thickness = sum / side;
  let worst = 1;
  for (const a of areas) {
    const len = a / thickness;
    if (!len) continue;
    worst = Math.max(worst, thickness / len, len / thickness);
  }
  return worst;
}

function squarify(items, x, y, w, h) {
  const out = [];
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  const areas = items.map((it) => ({ ...it, area: it.value * scale }));

  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;
  let i = 0;

  while (i < areas.length) {
    const short = Math.min(rw, rh);
    if (short <= 0.5) break;
    let end = i;
    let rowSum = 0;
    let worst = Infinity;
    while (end < areas.length) {
      const cand = worstAspect(areas.slice(i, end + 1).map((a) => a.area), short);
      if (cand > worst && end > i) break;
      worst = cand;
      rowSum += areas[end].area;
      end++;
    }
    const row = areas.slice(i, end);
    if (rw >= rh) {
      const cw = rowSum / rh;
      let cy = ry;
      for (const it of row) {
        const ih = it.area / cw;
        out.push({ ...it, x: rx, y: cy, w: cw, h: ih });
        cy += ih;
      }
      rx += cw;
      rw -= cw;
    } else {
      const ch = rowSum / rw;
      let cx = rx;
      for (const it of row) {
        const iw = it.area / ch;
        out.push({ ...it, x: cx, y: ry, w: iw, h: ch });
        cx += iw;
      }
      ry += ch;
      rh -= ch;
    }
    i = end;
  }
  return out;
}

/* ------------------------------ 数据整理 ------------------------------ */

function liveRate(cur) {
  if (cur === 'USD') return 1;
  if (cur === 'HKD') return state.live.fx.usdPerHkd;
  return state.live.fx.usdPerCny;
}

function liveUsd(m) {
  return (state.mode === 'float' ? m.float : m.total) * liveRate(m.currency);
}

function worldItems() {
  const markets = state.world?.markets || [];
  const total = markets.reduce((s, m) => s + m.usd, 0);
  return markets.map((m) => ({
    id: m.id,
    name: m.name,
    region: m.region,
    color: REGION_COLORS[m.region] || '#8b94a7',
    usd: m.usd,
    usdTotal: total,
    local: m.localCap,
    cur: m.currency,
    baseYear: m.baseYear,
    method: m.method,
    indexId: m.indexId,
  }));
}

function liveItems() {
  const markets = state.live?.markets || [];
  const total = markets.reduce((s, m) => s + liveUsd(m), 0);
  return markets
    .map((m) => ({
      id: m.id,
      name: m.name,
      color: LIVE_COLORS[m.id] || '#8b94a7',
      usd: liveUsd(m),
      usdTotal: total,
      local: state.mode === 'float' ? m.float : m.total,
      cur: m.currency,
      chg: state.mode === 'float' ? m.chgFloat : m.chgTotal,
      count: m.count,
      indexId: m.secid,
    }))
    .sort((a, b) => b.usd - a.usd);
}

function indexItems() {
  const d = state.indexData;
  if (!d) return [];
  const aggregate = !!d.index.aggregate;
  return d.constituents.map((c) => ({
    id: c.secid,
    name: c.name,
    color: aggregate ? GROUP_COLORS[c.group] || '#ffb020' : '#ffb020',
    usd: c.capUsd,
    ticker: c.ticker,
    pct: c.pct,
    weight: c.weight,
    group: c.group,
    indices: c.indices || [],
    cur: 'USD',
  }));
}

function currentItems() {
  if (state.scope === 'world') return worldItems();
  if (state.scope === 'index') return indexItems();
  return liveItems();
}

function filteredItems() {
  const items = currentItems();
  if (state.scope !== 'world' || state.region === '全部') return items;
  return items.filter((m) => m.region === state.region);
}

function renderIndexChips() {
  const list = [{ id: 'all', name: '全部指数' }, ...(state.indexList || [])];
  $('#indexChips').innerHTML = list
    .map((x) => `<button class="chip ${x.id === state.index ? 'on' : ''}" data-index="${x.id}">${esc(x.name)}</button>`)
    .join('');
}

/* ------------------------------ 渲染：摘要 ------------------------------ */

function renderSummary() {
  const items = currentItems();
  const total = items.reduce((s, m) => s + m.usd, 0);
  const byId = new Map(items.map((m) => [m.id, m]));
  const card = (label, value, sub) => `<div class="kpi"><i>${label}</i><b>${value}</b><small>${sub}</small></div>`;

  if (state.scope === 'index') {
    const d = state.indexData;
    if (!d) return;
    const top = items[0];
    if (d.index.aggregate) {
      const top5 = items.slice(0, 5).reduce((s, m) => s + m.usd, 0);
      $('#sizeCards').innerHTML = [
        card('合计市值', t(total), `${d.covered} 家公司 · 去重后`),
        card('重叠公司', `${d.overlap} 家`, '同时属于 2 个以上指数'),
        card('Top 5 集中度', `${shareOf(top5, total).toFixed(1)}%`, '前五大占合计市值'),
        card('最大成分', top ? top.name : '—', top ? `${t(top.usd)} · ${shareOf(top.usd, total).toFixed(1)}%` : ''),
      ].join('');
      $('#sizeSub').textContent = `15 个指数 · 去重后 ${d.covered} 家公司 · 合计 ${t(total)} · 市值 ${fmtTime(d.ts)}`;
      $('#metaMode').textContent = '指数成分';
      $('#metaFx').textContent = state.world ? `USD/CNY ${state.world.fx.CNY?.toFixed(2)}` : '—';
      $('#metaTime').textContent = fmtTime(d.ts);
      $('#asof').textContent = `成分市值 ${fmtTime(d.ts)}`;
      $('#scopeNote').textContent = '全部指数成分股去重 · 按市场分组';
      return;
    }
    const top5 = items.slice(0, 5).reduce((s, m) => s + m.usd, 0);
    $('#sizeCards').innerHTML = [
      card('已覆盖成分市值', t(total), `${d.covered} 只主要成分股`),
      card('最大成分', top ? top.name : '—', top ? `${shareOf(top.usd, total).toFixed(1)}% · ${t(top.usd)}` : ''),
      card('Top 5 集中度', `${shareOf(top5, total).toFixed(1)}%`, '前五大占已覆盖市值'),
      card(
        '指数成分数',
        `${d.index.count} 只`,
        d.covered >= d.index.count ? '已全部覆盖' : d.index.partial ? '本页仅覆盖部分' : '完整成分清单未接入'
      ),
    ].join('');
    $('#sizeSub').textContent = `${d.index.name} · ${d.index.publisher} · 成立 ${d.index.inception} · 市值 ${fmtTime(d.ts)}`;
    $('#metaMode').textContent = '指数成分';
    $('#metaFx').textContent = state.world ? `USD/CNY ${state.world.fx.CNY?.toFixed(2)}` : '—';
    $('#metaTime').textContent = fmtTime(d.ts);
    $('#asof').textContent = `成分市值 ${fmtTime(d.ts)}`;
    $('#scopeNote').textContent = '主要成分股实时市值 · 面积 = 美元市值';
    return;
  }

  if (state.scope === 'world') {
    const us = byId.get('us');
    const cn = byId.get('cn');
    const jp = byId.get('jp');
    const india = byId.get('in');
    $('#sizeCards').innerHTML = [
      card('全球总市值', t(total), `${items.length} 个市场 · 美元计价`),
      card('美国', t(us?.usd || 0), `${shareOf(us?.usd || 0, total).toFixed(1)}% · 全球第一`),
      card('中国内地', t(cn?.usd || 0), `${shareOf(cn?.usd || 0, total).toFixed(1)}% · 含沪深北`),
      card('印度 / 日本', `${t(india?.usd || 0)} / ${t(jp?.usd || 0)}`, `${shareOf(india?.usd || 0, total).toFixed(1)}% / ${shareOf(jp?.usd || 0, total).toFixed(1)}%`),
    ].join('');
    $('#sizeSub').textContent =
      `${items.length} 个市场 · 世界银行年度市值 × 当地指数推算 × 当日汇率 · 汇率 ${state.world.fx.CNY?.toFixed(3)} CNH/USD`;
  } else {
    const us = byId.get('us');
    const hk = byId.get('hk');
    const cn = (byId.get('sh')?.usd || 0) + (byId.get('sz')?.usd || 0) + (byId.get('bj')?.usd || 0);
    $('#sizeCards').innerHTML = [
      card('覆盖总市值', t(total), `${items.length} 个市场 · ${items.reduce((s, m) => s + (m.count || 0), 0).toLocaleString('en-US')} 个标的`),
      card('美国', t(us?.usd || 0), `${shareOf(us?.usd || 0, total).toFixed(1)}% · 日涨 ${pct(us?.chg)}`),
      card('中国内地（沪+深+北）', t(cn), `${shareOf(cn, total).toFixed(1)}% · 3 个交易所`),
      card('中国香港', t(hk?.usd || 0), `${shareOf(hk?.usd || 0, total).toFixed(1)}% · 日涨 ${pct(hk?.chg)}`),
    ].join('');
    $('#sizeSub').textContent =
      `${state.mode === 'float' ? '流通市值' : '总市值'}口径 · 汇率 1 USD = ${state.live.fx.usdCnh.toFixed(3)} CNH · 市值汇总于 ${fmtTime(state.live.capsAt)}`;
  }

  $('#metaMode').textContent = state.scope === 'world' ? '全球统一' : '中美港实时';
  $('#metaFx').textContent = state.scope === 'world' ? `USD/CNY ${state.world.fx.CNY?.toFixed(2)}` : `USD/CNH ${state.live.fx.usdCnh.toFixed(2)}`;
  $('#metaTime').textContent = state.scope === 'world' ? (state.world.asOf || '').slice(5, 16) : fmtTime(state.live.capsAt);
  $('#asof').textContent = state.scope === 'world' ? `汇率 ${(state.world.asOf || '').slice(5, 16)}` : `市值截至 ${fmtTime(state.live.capsAt)}`;
  $('#scopeNote').textContent =
    state.scope === 'world' ? '世界银行年度市值 × 指数推算 × 当日汇率' : '中美港全市场个股逐日汇总（含 ADR / ETF）';
}

/* ------------------------------ 渲染：Treemap ------------------------------ */

function renderTreemap() {
  const host = $('#treemap');
  const items = filteredItems();
  if (!items.length) {
    host.innerHTML = '<div class="chart-empty">暂无数据</div>';
    return;
  }
  const W = host.clientWidth;
  const H = host.clientHeight;
  if (W < 40 || H < 40) return;

  const total = items.reduce((s, m) => s + m.usd, 0);
  const sorted = [...items].sort((a, b) => b.usd - a.usd);
  const rects = squarify(sorted.map((m) => ({ ...m, value: m.usd })), 0, 0, W, H);
  const gap = 3;

  const tiles = rects
    .map((r) => {
      const w = r.w - gap;
      const h = r.h - gap;
      if (w < 6 || h < 6) return '';
      const x = r.x + gap / 2;
      const y = r.y + gap / 2;
      const share = shareOf(r.usd, total);
      const color = r.color;

      let label = '';
      if (w > 230 && h > 120) {
        label = `
          <text class="tm-name" x="${x + 15}" y="${y + 28}" font-size="13.5">${esc(r.name)}</text>
          <text class="tm-value" x="${x + 15}" y="${y + 60}" font-size="26">${tSmart(r.usd)}</text>
          <text class="tm-meta" x="${x + 15}" y="${y + 80}" font-size="10.5">${share.toFixed(1)}%${r.region ? ` · ${esc(r.region)}` : ''}</text>
          ${state.scope !== 'index' && w > 360 && h > 230 ? `<text x="${x + w - 18}" y="${y + h - 20}" text-anchor="end" font-size="${Math.min(100, h * 0.3).toFixed(0)}" fill="${color}" opacity="0.08" font-family="SF Mono, Menlo, monospace" font-weight="700">${share.toFixed(0)}%</text>` : ''}`;
      } else if (w > 130 && h > 76) {
        label = `
          <text class="tm-name" x="${x + 11}" y="${y + 22}" font-size="11.5">${esc(r.name)}</text>
          <text class="tm-value" x="${x + 11}" y="${y + 46}" font-size="17">${tSmart(r.usd)}</text>
          <text class="tm-meta" x="${x + 11}" y="${y + 63}" font-size="9.5">${share.toFixed(1)}%</text>`;
      } else if (w > 64 && h > 38) {
        label = `<text class="tm-name" x="${x + 8}" y="${y + 17}" font-size="10.5">${esc(r.name)}</text>
          <text class="tm-meta" x="${x + 8}" y="${y + 32}" font-size="9">${share.toFixed(1)}%</text>`;
      }

      return `<g class="tm-tile" data-id="${r.id}" data-tile="${color}" style="--tile:${color}" tabindex="0" role="button" aria-label="${esc(r.name)} ${t(r.usd)}">
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="6"
          fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-opacity="0.5" stroke-width="1"/>
        ${label}
      </g>`;
    })
    .join('');

  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="各市场市值面积图">${tiles}</svg>`;

  const tip = document.createElement('div');
  tip.className = 'tm-tip';
  host.appendChild(tip);

  const position = (ev) => {
    const rect = host.getBoundingClientRect();
    const tw = tip.offsetWidth || 190;
    const th = tip.offsetHeight || 140;
    tip.style.left = `${clamp(ev.clientX - rect.left + 14, 6, rect.width - tw - 6)}px`;
    tip.style.top = `${clamp(ev.clientY - rect.top - th / 2, 6, rect.height - th - 6)}px`;
  };

  host.querySelectorAll('.tm-tile').forEach((g) => {
    const m = sorted.find((x) => x.id === g.dataset.id);
    if (!m) return;
    g.addEventListener('pointerenter', (ev) => {
      tip.innerHTML =
        state.scope === 'index'
          ? `<div class="tt-title"><i style="background:${m.color}"></i>${esc(m.name)}</div>
             <div class="tt-line"><span>市值</span><span>${tSmart(m.usd)}</span></div>
             <div class="tt-line"><span>占已覆盖</span><span>${shareOf(m.usd, total).toFixed(1)}%</span></div>
             <div class="tt-line"><span>代码</span><span>${esc(m.ticker || '')}</span></div>
             <div class="tt-line"><span>日涨跌</span><span class="${sign(m.pct)}">${pct(m.pct)}</span></div>
             ${m.indices && m.indices.length ? `<div class="tt-line"><span>所属指数</span><span>${esc(m.indices.join('、'))}</span></div>` : ''}`
          : state.scope === 'world'
          ? `<div class="tt-title"><i style="background:${m.color}"></i>${esc(m.name)}</div>
             <div class="tt-line"><span>美元市值</span><span>${tSmart(m.usd)}</span></div>
             <div class="tt-line"><span>本币市值</span><span>${localT(m.local, m.cur)}</span></div>
             <div class="tt-line"><span>占比</span><span>${shareOf(m.usd, total).toFixed(1)}%</span></div>
             <div class="tt-line"><span>基准</span><span>${m.baseYear} 年 · ${m.method === 'index' ? '指数推算' : '年度值'}</span></div>`
          : `<div class="tt-title"><i style="background:${m.color}"></i>${esc(m.name)}</div>
             <div class="tt-line"><span>美元市值</span><span>${tSmart(m.usd)}</span></div>
             <div class="tt-line"><span>本币市值</span><span>${localT(m.local, m.cur)}</span></div>
             <div class="tt-line"><span>占比</span><span>${shareOf(m.usd, total).toFixed(1)}%</span></div>
             <div class="tt-line"><span>日涨跌</span><span class="${sign(m.chg)}">${pct(m.chg)}</span></div>`;
      tip.classList.add('show');
      position(ev);
    });
    g.addEventListener('pointermove', position);
    g.addEventListener('pointerleave', () => tip.classList.remove('show'));
    if (state.scope === 'index') {
      g.addEventListener('click', () => {
        window.location.href = `/stock.html?s=${encodeURIComponent(m.id)}`;
      });
    } else if (m.indexId) {
      g.addEventListener('click', () => {
        window.location.href = `/research.html?s=${encodeURIComponent(m.indexId)}`;
      });
    }
  });
}

function renderLegend() {
  const items = filteredItems();
  const total = items.reduce((s, m) => s + m.usd, 0);
  const host = $('#tmLegend');

  if (state.scope === 'index') {
    const d = state.indexData;
    if (!d) return;
    if (d.index.aggregate) {
      const groups = new Map();
      items.forEach((m) => {
        const g = m.group || '其他';
        groups.set(g, (groups.get(g) || 0) + m.usd);
      });
      host.innerHTML = [...groups.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(
          ([g, sum]) =>
            `<span class="tm-lg"><i style="background:${GROUP_COLORS[g] || '#8b94a7'}"></i>${esc(g)}
              <b style="font-family:var(--mono);font-weight:500;color:var(--muted)">${shareOf(sum, total).toFixed(1)}%</b></span>`
        )
        .join('');
      return;
    }
    host.innerHTML = `<span class="tm-lg"><i style="background:var(--accent)"></i>已覆盖 ${d.covered} 只 · 合计 ${t(total)}
      <b style="font-family:var(--mono);font-weight:500;color:var(--muted)">${d.index.partial ? '（部分覆盖）' : ''}</b></span>`;
    return;
  }

  if (state.scope === 'world') {
    const groups = REGIONS.filter((r) => r !== '全部')
      .map((r) => {
        const list = items.filter((m) => m.region === r);
        const sum = list.reduce((s, m) => s + m.usd, 0);
        return { r, sum, n: list.length };
      })
      .filter((g) => g.n);
    host.innerHTML = groups
      .map(
        (g) =>
          `<span class="tm-lg" data-region="${g.r}"><i style="background:${REGION_COLORS[g.r]}"></i>${g.r}
            <b style="font-family:var(--mono);font-weight:500;color:var(--muted)">${shareOf(g.sum, total).toFixed(1)}% · ${g.n}</b></span>`
      )
      .join('');
    host.querySelectorAll('[data-region]').forEach((el) => {
      el.addEventListener('click', () => setRegion(el.dataset.region));
    });
  } else {
    host.innerHTML = items
      .map(
        (m) =>
          `<span class="tm-lg" data-id="${m.id}"><i style="background:${m.color}"></i>${esc(m.name)}
            <b style="font-family:var(--mono);font-weight:500;color:var(--muted)">${shareOf(m.usd, total).toFixed(1)}%</b></span>`
      )
      .join('');
  }
}

/* ------------------------------ 渲染：表格 ------------------------------ */

function renderTable() {
  const items = filteredItems();
  const total = items.reduce((s, m) => s + m.usd, 0);
  const sorted = [...items].sort((a, b) => b.usd - a.usd);

  if (state.scope === 'index') {
    const aggregate = !!state.indexData?.index.aggregate;
    $('#marketHead').innerHTML = `<tr>
      <th class="th-left">成分股</th><th class="col-ticker">代码</th><th>市值</th>
      <th class="th-share">占比</th>${!aggregate && state.indexData?.index?.weights ? '<th class="col-weight">权重</th>' : ''}<th>日涨跌</th>${aggregate ? '<th class="th-left col-indices">所属指数</th>' : ''}</tr>`;
    $('#marketBody').innerHTML = sorted
      .map((m) => {
        const share = shareOf(m.usd, total);
        return `<tr data-secid="${m.id}" class="stock-row" title="查看个股分析">
          <td class="name-cell">${esc(m.name)}</td>
          <td class="col-ticker">${esc(m.ticker || '')}</td>
          <td>${tSmart(m.usd)}</td>
          <td><div class="share-wrap"><span class="share-track"><span class="share-fill" style="width:${share.toFixed(1)}%"></span></span><span class="share-num">${share.toFixed(1)}%</span></div></td>
          ${!aggregate && state.indexData?.index?.weights ? `<td class="col-weight">${m.weight != null ? `${m.weight.toFixed(2)}%` : '—'}</td>` : ''}
          <td class="${sign(m.pct)}">${pct(m.pct)}</td>
          ${aggregate ? `<td class="col-indices idx-list">${esc((m.indices || []).join('、'))}</td>` : ''}
        </tr>`;
      })
      .join('');
    $('#tableHint').textContent = aggregate
      ? `${sorted.length} 家公司（去重） · 按市值排序`
      : `${sorted.length} 只主要成分股 · 按市值排序 · 点击行查看个股分析`;
    $('#marketBody').querySelectorAll('tr[data-secid]').forEach((tr) => {
      tr.addEventListener('click', () => {
        window.location.href = `/stock.html?s=${encodeURIComponent(tr.dataset.secid)}`;
      });
    });
    return;
  }

  if (state.scope === 'world') {
    $('#marketHead').innerHTML = `<tr>
      <th class="th-left">市场</th><th class="col-region">地区</th><th class="col-local">本币市值</th><th>美元市值</th>
      <th class="th-share">占比</th><th class="col-base">基准</th></tr>`;
    $('#marketBody').innerHTML = sorted
      .map((m) => {
        const share = shareOf(m.usd, total);
        return `<tr data-id="${m.id}">
          <td class="name-cell"><i class="dot" style="background:${m.color}"></i>${esc(m.name)}</td>
          <td class="col-region">${esc(m.region)}</td>
          <td class="col-local">${localT(m.local, m.cur)}</td>
          <td>${tSmart(m.usd)}</td>
          <td><div class="share-wrap"><span class="share-track"><span class="share-fill" style="width:${share.toFixed(1)}%"></span></span><span class="share-num">${share.toFixed(1)}%</span></div></td>
          <td class="base-cell col-base">${m.baseYear} · ${m.method === 'index' ? '推算' : '年度'}</td>
        </tr>`;
      })
      .join('');
    $('#tableHint').textContent = `${sorted.length} 个市场 · 按美元市值排序`;
  } else {
    $('#marketHead').innerHTML = `<tr>
      <th class="th-left">市场</th><th class="col-local">本币市值</th><th>美元市值</th>
      <th class="th-share">占比</th><th>日涨跌</th><th class="col-count">公司数</th></tr>`;
    $('#marketBody').innerHTML = sorted
      .map((m) => {
        const share = shareOf(m.usd, total);
        return `<tr data-id="${m.id}">
          <td class="name-cell"><i class="dot" style="background:${m.color}"></i>${esc(m.name)}</td>
          <td class="col-local">${localT(m.local, m.cur)}</td>
          <td>${tSmart(m.usd)}</td>
          <td><div class="share-wrap"><span class="share-track"><span class="share-fill" style="width:${share.toFixed(1)}%"></span></span><span class="share-num">${share.toFixed(1)}%</span></div></td>
          <td class="${sign(m.chg)}">${pct(m.chg)}</td>
          <td class="col-count">${Number(m.count || 0).toLocaleString('en-US')}</td>
        </tr>`;
      })
      .join('');
    $('#tableHint').textContent = `按${state.mode === 'float' ? '流通市值' : '总市值'}排序`;
  }
}

/* ------------------------------ 渲染：汇率 ------------------------------ */

function renderFx() {
  const host = $('#fxGrid');
  if (state.scope === 'world' || state.scope === 'index') {
    const fx = state.world.fx;
    const cards = [
      ['美元 / 人民币 USD/CNY', fx.CNY?.toFixed(4)],
      ['美元 / 日元 USD/JPY', fx.JPY?.toFixed(2)],
      ['欧元 / 美元 EUR/USD', (1 / fx.EUR).toFixed(4)],
      ['美元 / 印度卢比 USD/INR', fx.INR?.toFixed(2)],
    ];
    host.innerHTML = cards
      .map(([k, v]) => `<div class="fx-card"><i>${k}</i><b>${v || '—'}</b><small>每日更新</small></div>`)
      .join('');
    $('#fxNote').textContent = `汇率来源 open.er-api.com（${state.world.fxSource}），更新时间 ${state.world.asOf}；市值按最新汇率折算。`;
  } else {
    const fx = state.live.fx;
    host.innerHTML = `
      <div class="fx-card"><i>美元 / 离岸人民币 USD/CNH</i><b>${fx.usdCnh.toFixed(4)}</b><small>${fx.date || ''}</small></div>
      <div class="fx-card"><i>美元 / 港币 USD/HKD</i><b>${fx.usdHkd.toFixed(4)}</b><small>港币联系汇率 7.75–7.85</small></div>`;
    $('#fxNote').textContent = '汇率取自离岸人民币交叉盘；市值约每 6 小时汇总一次。';
  }
}

/* ------------------------------ 交互 ------------------------------ */

function renderAll() {
  if (state.scope === 'index' && state.index === 'all') {
    renderRankingAll();
    return;
  }
  renderSummary();
  renderTreemap();
  renderLegend();
  renderTable();
  renderFx();
  if (state.scope !== 'index') $('#indexHistory').hidden = true;
  $('#modeTabs').hidden = state.scope !== 'live';
  $('#regionChips').hidden = state.scope !== 'world';
  $('#indexChips').hidden = state.scope !== 'index';
  $('#indexDetail').hidden = state.scope !== 'index';
  if (state.scope === 'index') renderIndexDetail();
  const notice = $('#tmNotice');
  if (state.scope === 'index' && state.indexData?.index.partial) {
    notice.hidden = false;
    notice.textContent = `该市场缺少本地个股清单，仅展示已接入的 ${state.indexData.covered} 只主要成分股，面积不代表完整指数。`;
  } else {
    notice.hidden = true;
  }
  $('#tmFootHint').textContent =
    state.scope === 'index' ? '悬停看市值 · 点击成分股进入个股分析' : '点击方块 → 对应指数的历史研究';
  $('#tmTitle').textContent = '市值地图';
  $('#tmHint').textContent = state.scope === 'index' ? '面积 = 成分股美元市值' : '面积 = 美元市值';
}

function renderIndexDetail() {
  const d = state.indexData;
  if (!d) return;
  const idx = d.index;
  $('#idxName').textContent = idx.name;
  $('#idxEn').textContent = idx.en;
  const badge = $('#idxBadge');
  badge.textContent = idx.partial ? `仅覆盖 ${d.covered} 只主要成分股（缺少本地个股清单）` : `主要成分股 ${d.covered} 只`;
  badge.className = `ph-hint${idx.partial ? ' idx-badge-warn' : ''}`;
  const meta = idx.aggregate
    ? [
        ['覆盖指数', '15 个'],
        ['去重公司', `${d.covered} 家`],
        ['重叠公司', `${d.overlap} 家`],
        ['合计市值', t(d.totalUsd)],
      ]
    : [
        ['发布机构', idx.publisher],
        ['成立时间', idx.inception],
        ['成分股数', `${idx.count} 只`],
        ['本页覆盖', `${d.covered} 只`],
      ];
  $('#idxMeta').innerHTML = meta
    .map(([k, v]) => `<div><i>${k}</i><b>${esc(v)}</b></div>`)
    .join('');
  $('#idxDesc').textContent = idx.desc;

  const box = $('#idxWeights');
  if (!idx.weights || !idx.weights.items?.length) {
    box.hidden = true;
  } else {
    const names = new Set(d.constituents.map((c) => c.name));
    const miss = idx.weights.items.filter((x) => !names.has(x.name));
    box.hidden = false;
    box.innerHTML = `
      <div class="iw-head"><span>前十大权重</span><span>${esc(idx.weights.source)} · ${idx.weights.asOf}</span></div>
      <div class="iw-grid">${idx.weights.items.slice(0, 10)
        .map((x, i) => {
          const sid = x.secid || (/^6/.test(x.code) ? `1.${x.code}` : `0.${x.code}`);
          return `<div class="iw-row" data-secid="${sid}" title="查看个股分析"><span>${i + 1}</span><b>${esc(x.name)}</b><em>${x.weight.toFixed(2)}%</em></div>`;
        })
        .join('')}</div>
      ${miss.length ? `<p class="iw-warn">你提供的名单只覆盖前十大中的 ${idx.weights.items.length - miss.length} 只；${miss.map((x) => esc(x.name)).join('、')} 不在名单里，名单可能已过时。</p>` : ''}`;
    box.querySelectorAll('.iw-row[data-secid]').forEach((row) => {
      row.addEventListener('click', () => {
        window.location.href = `/stock.html?s=${encodeURIComponent(row.dataset.secid)}`;
      });
    });
  }
}

function setRegion(region) {
  state.region = region;
  renderChips();
  renderAll();
}

function renderChips() {
  $('#regionChips').innerHTML = REGIONS.map(
    (r) => `<button class="chip ${state.region === r ? 'on' : ''}" data-region="${r}">${r}</button>`
  ).join('');
}

async function switchScope(scope) {
  state.scope = scope;
  document.querySelectorAll('#scopeTabs button').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
  if (scope === 'world' && state.world) return renderAll();
  if (scope === 'live' && state.live) return renderAll();
  if (scope === 'index') {
    if (state.index === 'all') {
      if (!state.world || !state.ranking) return loadRanking();
      return renderAll();
    }
    if (!state.world || !state.indexData) {
      $('#treemap').innerHTML = '<div class="chart-loading"><span></span></div>';
      try {
        if (!state.world) state.world = await getJSON('/api/world-markets');
        if (!state.indexData) state.indexData = await getJSON(`/api/index-map?id=${state.index}`);
        $('#netBanner').hidden = true;
      } catch (err) {
        $('#netBanner').hidden = false;
        $('#netBannerText').textContent = `加载失败：${err.message}`;
        $('#treemap').innerHTML = '<div class="chart-empty">数据加载失败</div>';
        return;
      }
    }
    return renderAll();
  }
  $('#treemap').innerHTML = '<div class="chart-loading"><span></span></div>';
  try {
    if (scope === 'world') await loadWorld();
    else await loadLive();
  } catch (err) {
    $('#netBanner').hidden = false;
    $('#netBannerText').textContent = `加载失败：${err.message}`;
    $('#treemap').innerHTML = '<div class="chart-empty">数据加载失败</div>';
  }
}

async function loadWorld() {
  state.world = await getJSON('/api/world-markets');
  $('#netBanner').hidden = true;
  renderAll();
}

async function loadLive() {
  state.live = await getJSON('/api/markets');
  $('#netBanner').hidden = true;
  renderAll();
}

async function loadRanking() {
  $('#treemap').innerHTML = '<div class="chart-loading"><span></span></div>';
  try {
    const [rank] = await Promise.all([
      getJSON('/api/index-ranking'),
      state.world ? Promise.resolve(state.world) : getJSON('/api/world-markets').then((w) => (state.world = w)),
    ]);
    state.ranking = rank;
    $('#netBanner').hidden = true;
    renderAll();
  } catch (err) {
    $('#netBanner').hidden = false;
    $('#netBannerText').textContent = `指数排名加载失败：${err.message}`;
  }
}

function renderRankingAll() {
  const d = state.ranking;
  if (!d) return;
  const items = d.items;
  const top = items[0];
  const card = (label, value, sub) => `<div class="kpi"><i>${label}</i><b>${value}</b><small>${sub}</small></div>`;

  $('#sizeCards').innerHTML = [
    card('指数数量', `${items.length} 个`, '同一口径：主要成分股 Top 10'),
    card('最大指数', top ? top.name : '—', top ? `${t(top.totalUsd)} · ${top.covered}/${top.declared} 只` : ''),
    card('去重公司', `${d.uniqueCompanies} 家`, '跨指数重复只计一次'),
    card('重叠公司', `${d.overlap} 家`, '同时属于 2 个以上指数'),
  ].join('');
  $('#sizeSub').textContent = '各指数主要成分股（Top 10）市值合计，非完整指数市值 · 单位：美元';
  $('#metaMode').textContent = '指数排名';
  $('#metaFx').textContent = state.world ? `USD/CNY ${state.world.fx.CNY?.toFixed(2)}` : '—';
  $('#metaTime').textContent = fmtTime(d.ts);
  $('#asof').textContent = `指数排名 ${fmtTime(d.ts)}`;
  $('#scopeNote').textContent = '主要成分股市值合计 · 按指数排名';

  renderRankingChart(items);
  renderRankingLegend(items);
  renderRankingTable(items);
  renderFx();

  $('#modeTabs').hidden = true;
  $('#regionChips').hidden = true;
  $('#indexChips').hidden = false;
  $('#indexDetail').hidden = true;
  $('#indexHistory').hidden = true;
  $('#tmNotice').hidden = false;
  $('#tmNotice').textContent = '各指数只纳入主要成分股（Top 10），因此柱高低于指数完整市值；名称下方为「已覆盖 / 指数成分数」。';
  $('#tmFootHint').textContent = '点击柱子 → 查看该指数的成分股地图';
  $('#tmTitle').textContent = '指数成分市值排名';
  $('#tmHint').textContent = '柱长 = Top 10 市值合计';
}

function renderRankingChart(items) {
  const host = $('#treemap');
  const W = host.clientWidth;
  const H = host.clientHeight;
  if (W < 40 || H < 40) return;
  const padL = 168;
  const padR = 96;
  const padT = 18;
  const padB = 18;
  const rowH = (H - padT - padB) / items.length;
  const max = items[0]?.totalUsd || 1;
  const barH = Math.min(22, rowH * 0.56);
  const plotW = W - padL - padR;

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="指数市值排名">`;
  items.forEach((m, i) => {
    const y = padT + i * rowH;
    const w = Math.max(2, (m.totalUsd / max) * plotW);
    const color = GROUP_COLORS[m.group] || '#8b94a7';
    svg += `<g class="rank-row" data-id="${m.id}" tabindex="0" role="button" aria-label="${esc(m.name)} ${tSmart(m.totalUsd)}">
      <rect x="0" y="${y.toFixed(1)}" width="${W}" height="${rowH.toFixed(1)}" fill="transparent"/>
      <text x="${padL - 12}" y="${(y + rowH / 2 - 2).toFixed(1)}" text-anchor="end" class="rank-name">${esc(m.name)}</text>
      <text x="${padL - 12}" y="${(y + rowH / 2 + 10).toFixed(1)}" text-anchor="end" class="rank-sub">${m.covered}/${m.declared} 只</text>
      <rect class="rank-bar" x="${padL}" y="${(y + (rowH - barH) / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="${color}" opacity="0.72"/>
      <text x="${(padL + w + 8).toFixed(1)}" y="${(y + rowH / 2 + 4).toFixed(1)}" class="rank-val">${tSmart(m.totalUsd)}</text>
    </g>`;
  });
  svg += '</svg>';
  host.innerHTML = svg;

  host.querySelectorAll('.rank-row').forEach((g) => {
    g.addEventListener('click', () => loadIndex(g.dataset.id));
    g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') loadIndex(g.dataset.id); });
  });
}

function renderRankingLegend(items) {
  const groups = new Map();
  items.forEach((m) => groups.set(m.group, (groups.get(m.group) || 0) + 1));
  $('#tmLegend').innerHTML = [...groups.entries()]
    .map(([g, n]) => `<span class="tm-lg"><i style="background:${GROUP_COLORS[g] || '#8b94a7'}"></i>${esc(g)} <b style="font-family:var(--mono);font-weight:500;color:var(--muted)">${n}</b></span>`)
    .join('');
}

function renderRankingTable(items) {
  $('#marketHead').innerHTML = `<tr>
    <th class="th-left">#</th><th class="th-left">指数</th><th>分组</th><th>覆盖市值</th>
    <th class="th-share">覆盖成分</th><th class="th-left">发布机构</th></tr>`;
  $('#marketBody').innerHTML = items
    .map(
      (m, i) => `<tr data-id="${m.id}">
        <td class="name-cell">${i + 1}</td>
        <td class="name-cell">${esc(m.name)}</td>
        <td>${esc(m.group)}</td>
        <td>${tSmart(m.totalUsd)}</td>
        <td>${m.covered}/${m.declared} 只</td>
        <td class="th-left idx-list">${esc(m.publisher)}</td>
      </tr>`
    )
    .join('');
  $('#marketBody').querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => loadIndex(tr.dataset.id));
  });
  $('#tableHint').textContent = `${items.length} 个指数 · 按覆盖市值排序`;
}

function histStats(pts) {
  const cs = pts.map((p) => p.c);
  const total = cs[cs.length - 1] / cs[0] - 1;
  const days = (Date.parse(pts[pts.length - 1].t) - Date.parse(pts[0].t)) / 86400000;
  const years = days / 365.25;
  const ann = years > 0.1 ? Math.pow(1 + total, 1 / years) - 1 : null;
  let peak = -Infinity;
  let mdd = 0;
  const rets = [];
  for (let i = 1; i < cs.length; i++) {
    peak = Math.max(peak, cs[i - 1]);
    mdd = Math.min(mdd, cs[i] / peak - 1);
    rets.push(cs[i] / cs[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  return {
    total,
    ann,
    mdd,
    vol: Math.sqrt(variance) * Math.sqrt(252),
    hi: Math.max(...cs),
    lo: Math.min(...cs),
    start: pts[0].t,
    end: pts[pts.length - 1].t,
  };
}

async function loadHistory(secid, range) {
  if (!secid) return;
  state.hist.secid = secid;
  state.hist.range = range;
  document.querySelectorAll('#histRanges button').forEach((b) => b.classList.toggle('on', b.dataset.range === range));
  $('#histChart').innerHTML = '<div class="chart-loading"><span></span></div>';
  $('#histStats').innerHTML = '';
  $('#histYears').innerHTML = '';
  const key = `${secid}|${range}`;
  try {
    let payload = state.hist.cache.get(key);
    if (!payload) {
      payload = await getJSON(`/api/history?secid=${encodeURIComponent(secid)}&range=${range}`);
      if (state.hist.cache.size > 40) state.hist.cache.clear();
      state.hist.cache.set(key, payload);
    }
    if (state.hist.secid !== secid || state.hist.range !== range) return;
    state.hist.points = payload.points || [];
    renderHistory();
  } catch (err) {
    $('#histChart').innerHTML = `<div class="chart-empty">历史数据加载失败：${esc(err.message)}</div>`;
  }
}

function renderHistory() {
  const pts = state.hist.points;
  const host = $('#histChart');
  if (state.hist.cleanup) { state.hist.cleanup(); state.hist.cleanup = null; }
  if (!pts.length) { host.innerHTML = '<div class="chart-empty">暂无历史数据</div>'; return; }

  const s0 = histStats(pts);
  const digits = s0.hi >= 1000 ? 0 : s0.hi >= 100 ? 1 : 2;
  state.hist.cleanup = mountChart(host, pts, { mode: 'area', range: state.hist.range, digits });
  const s = histStats(pts);
  $('#histStats').innerHTML = [
    ['区间涨跌', `${s.total > 0 ? '+' : ''}${(s.total * 100).toFixed(1)}%`],
    ['年化', s.ann == null ? '—' : `${s.ann > 0 ? '+' : ''}${(s.ann * 100).toFixed(1)}%`],
    ['最大回撤', `${(s.mdd * 100).toFixed(1)}%`],
    ['年化波动', `${(s.vol * 100).toFixed(1)}%`],
    ['区间最高', s.hi.toLocaleString('en-US', { maximumFractionDigits: 2 })],
    ['区间最低', s.lo.toLocaleString('en-US', { maximumFractionDigits: 2 })],
  ]
    .map(([k, v]) => `<span>${k}<b>${v}</b></span>`)
    .join('');

  $('#histHint').textContent = `${state.indexData?.index?.name || ''} · ${s.start} → ${s.end}`;
  $('#histNote').textContent = state.index === 'nifty'
    ? 'NIFTY 50 暂无行情源，暂以印度 SENSEX 走势代理；下方柱状为年度涨跌幅。'
    : '指数点位走势（非复权）；下方柱状为年度涨跌幅。';

  renderAnnual(pts);
}

function renderAnnual(pts) {
  const host = $('#histYears');
  const byYear = new Map();
  for (const p of pts) {
    const y = p.t.slice(0, 4);
    const cur = byYear.get(y);
    if (cur) cur.last = p.c;
    else byYear.set(y, { first: p.c, last: p.c });
  }
  const rows = [...byYear.entries()].map(([y, v]) => ({ y, r: v.last / v.first - 1 }));
  if (!rows.length) { host.innerHTML = ''; return; }

  const W = Math.max(320, host.clientWidth);
  const H = Math.max(80, host.clientHeight || 130);
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
  svg += `<line x1="${padL}" y1="${zero}" x2="${W - padR}" y2="${zero}" stroke="var(--line)" stroke-width="1"/>`;
  svg += `<text class="fin-axis" x="${padL - 6}" y="${zero + 3}" text-anchor="end">0</text>`;
  rows.forEach((r, i) => {
    const cx = padL + band * i + band / 2;
    const h = Math.max(1, Math.abs(scale(r.r)));
    const y = r.r >= 0 ? zero - h : zero;
    const color = r.r >= 0 ? '#ff4d5e' : '#0ecb81';
    svg += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" opacity="0.75"><title>${r.y} ${(r.r * 100).toFixed(1)}%</title></rect>`;
    svg += `<text class="fin-axis" x="${cx.toFixed(1)}" y="${(r.r >= 0 ? y - 4 : y + h + 10).toFixed(1)}" text-anchor="middle" fill="${color}">${(r.r * 100).toFixed(0)}%</text>`;
    svg += `<text class="fin-axis" x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">${r.y}</text>`;
  });
  svg += '</svg>';
  host.innerHTML = svg;
}

async function loadIndex(id) {
  if (id === 'all') {
    state.index = 'all';
    renderIndexChips();
    return loadRanking();
  }
  const prev = state.index;
  state.index = id;
  renderIndexChips();
  $('#treemap').innerHTML = '<div class="chart-loading"><span></span></div>';
  try {
    const [res] = await Promise.all([
      getJSON(`/api/index-map?id=${encodeURIComponent(id)}`),
      state.world ? Promise.resolve(state.world) : getJSON('/api/world-markets').then((w) => (state.world = w)),
    ]);
    state.indexData = res;
    $('#netBanner').hidden = true;
    renderAll();
    if (res?.index?.secid) {
      $('#indexHistory').hidden = false;
      loadHistory(res.index.secid, state.hist.range);
    }
  } catch (err) {
    state.index = prev;
    renderIndexChips();
    $('#netBanner').hidden = false;
    $('#netBannerText').textContent = `指数数据加载失败：${err.message}`;
  }
}

function bind() {
  $('#scopeTabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-scope]');
    if (btn && btn.dataset.scope !== state.scope) switchScope(btn.dataset.scope);
  });

  $('#regionChips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-region]');
    if (chip) setRegion(chip.dataset.region);
  });

  $('#indexChips').addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-index]');
    if (chip && chip.dataset.index !== state.index) loadIndex(chip.dataset.index);
  });

  $('#histRanges').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-range]');
    if (b && state.hist.secid) loadHistory(state.hist.secid, b.dataset.range);
  });

  $('#modeTabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-mode]');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    $('#modeTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    renderAll();
  });

  $('#retryBtn').addEventListener('click', () => switchScope(state.scope));

  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('marketpulse.theme.v1', next);
    renderAll();
  });

  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (state.world || state.live) renderTreemap();
    }, 180);
  });
}

/* ------------------------------ 启动 ------------------------------ */

function init() {
  const theme = localStorage.getItem('marketpulse.theme.v1');
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  renderChips();
  bind();
  switchScope('world');
  getJSON('/api/index-list')
    .then((r) => {
      state.indexList = r.items || [];
      renderIndexChips();
    })
    .catch(() => {});
}

init();
