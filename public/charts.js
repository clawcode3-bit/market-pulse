/* ==========================================================================
   轻量图表：迷你走势图 + K 线 / 分时主图（纯 SVG，无第三方依赖）
   ========================================================================== */

let uid = 0;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function readColors(host) {
  const cs = getComputedStyle(host);
  const pick = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return {
    up: pick('--up', '#ff4d5e'),
    down: pick('--down', '#0ecb81'),
    flat: pick('--flat', '#8b94a7'),
    text: pick('--text', '#eef2f8'),
    muted: pick('--muted', '#6c7689'),
    line: pick('--line', 'rgba(255,255,255,.08)'),
    panel: pick('--panel', '#0d1017'),
    accent: pick('--accent', '#ffb020'),
  };
}

/* -------------------------------------------------------------------- */
/* 迷你走势                                                              */
/* -------------------------------------------------------------------- */

export function sparkline(values, opts = {}) {
  const { width = 100, height = 30, color = '#ff4d5e', fill = true } = opts;
  const vals = (values || []).filter((v) => Number.isFinite(v));
  if (vals.length < 2) {
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  }
  const gid = `sg${++uid}`;
  const pad = 1.5;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || Math.abs(max) || 1;
  const stepX = (width - pad * 2) / (vals.length - 1);
  const y = (v) => pad + (height - pad * 2) * (1 - (v - min) / span);

  const pts = vals.map((v, i) => [pad + i * stepX, y(v)]);
  const line = pts.map(([x, py], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${py.toFixed(2)}`).join('');
  const area = `${line}L${(width - pad).toFixed(2)},${height - pad}L${pad},${height - pad}Z`;
  const last = pts[pts.length - 1];

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity="0.26"/>
        <stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${fill ? `<path d="${area}" fill="url(#${gid})"/>` : ''}
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.4"
          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0].toFixed(2)}" cy="${last[1].toFixed(2)}" r="1.7" fill="${color}"/>
  </svg>`;
}

/* -------------------------------------------------------------------- */
/* 主图                                                                  */
/* -------------------------------------------------------------------- */

function niceTicks(min, max, count = 4) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  let out = [];
  for (let pass = 0; pass < 3; pass++) {
    const start = Math.ceil(min / step) * step;
    out = [];
    for (let v = start; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
    if (out.length >= 3) break;
    step /= 2; // 标签太少就细分，避免整张图只有两条参考线
  }
  return out;
}

function tickLabel(t, range) {
  if (!t) return '';
  if (range === '1d') return t.slice(-5);
  if (range === '5d') return t.slice(6, 11);
  if (range === '5y') return t.slice(0, 7);
  return t.slice(5);
}

function fullLabel(t, range) {
  if (!t) return '';
  if (range === '1d' || range === '5d') return t;
  return t;
}

/**
 * 在 host 内绘制行情图。
 * @returns {Function} 清理函数
 */
export function mountChart(host, points, opts = {}) {
  const {
    mode = 'area',
    range = '1d',
    digits = 2,
    prevClose = null,
    currency = 'CNY',
  } = opts;

  const data = (points || []).filter((p) => Number.isFinite(p.c));
  let observer = null;
  let raf = 0;

  const fmt = (n) =>
    Number.isFinite(n)
      ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
      : '—';

  function draw() {
    const W = Math.max(280, host.clientWidth);
    const H = Math.max(200, host.clientHeight);
    const C = readColors(host);

    host.onpointermove = null;
    host.onpointerleave = null;

    if (!data.length) {
      host.innerHTML = '<div class="chart-empty">暂无数据</div>';
      return;
    }

    const up = data[0] && data[data.length - 1].c >= data[0].c;
    const color = up ? C.up : C.down;

    const padT = 12;
    const padB = 22;
    const padL = 10;
    const padR = 56;
    const volH = 42;
    const gap = 16;
    const plotW = W - padL - padR;
    const priceH = H - padT - padB - volH - gap;
    const volTop = padT + priceH + gap;

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of data) {
      lo = Math.min(lo, mode === 'candle' ? p.l : p.c);
      hi = Math.max(hi, mode === 'candle' ? p.h : p.c);
    }
    if (range === '1d' && Number.isFinite(prevClose)) {
      lo = Math.min(lo, prevClose);
      hi = Math.max(hi, prevClose);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    if (hi === lo) { hi += Math.abs(hi) * 0.002 || 1; lo -= Math.abs(lo) * 0.002 || 1; }
    const padding = (hi - lo) * 0.09;
    lo -= padding;
    hi += padding;

    const ticks = niceTicks(lo, hi, 4);
    if (ticks.length) {
      lo = Math.min(lo, ticks[0]);
      hi = Math.max(hi, ticks[ticks.length - 1]);
    }

    const x = (i) => padL + (data.length === 1 ? plotW / 2 : (plotW * i) / (data.length - 1));
    const y = (v) => padT + priceH * (1 - (v - lo) / (hi - lo || 1));
    const stepX = data.length > 1 ? plotW / (data.length - 1) : plotW;

    /* 成交量：用 95 分位作为上限，避免收盘集合竞价等异常值把其它柱子压扁 */
    const vols = data.map((p) => p.v).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    const p95 = vols.length ? vols[Math.floor((vols.length - 1) * 0.95)] : 0;
    const maxV = Math.max(p95, 1);
    const vy = (v) => volTop + volH * (1 - clamp(v / maxV, 0, 1));

    /* ---------- 网格 + 右侧价格轴 ---------- */
    let grid = '';
    let yLabels = '';
    for (const t of ticks) {
      const py = y(t);
      if (py < padT - 1 || py > padT + priceH + 1) continue;
      grid += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${W - padR}" y2="${py.toFixed(1)}"
        stroke="${C.line}" stroke-width="1" stroke-dasharray="2 4"/>`;
      yLabels += `<text x="${W - padR + 8}" y="${(py + 3.2).toFixed(1)}" fill="${C.muted}"
        font-size="9.5" font-family="SF Mono, Menlo, monospace">${fmt(t)}</text>`;
    }

    /* ---------- 底部日期轴 ---------- */
    let xLabels = '';
    const labelCount = Math.max(2, Math.min(5, Math.floor(plotW / 110)));
    const seen = new Set();
    for (let k = 0; k < labelCount; k++) {
      const i = Math.round((k * (data.length - 1)) / (labelCount - 1));
      if (seen.has(i)) continue;
      seen.add(i);
      const px = x(i);
      const anchor = k === 0 ? 'start' : k === labelCount - 1 ? 'end' : 'middle';
      xLabels += `<text x="${px.toFixed(1)}" y="${H - 7}" text-anchor="${anchor}" fill="${C.muted}"
        font-size="9" font-family="SF Mono, Menlo, monospace">${tickLabel(data[i].t, range)}</text>`;
    }

    /* ---------- 主图 ---------- */
    let chartBody = '';
    if (mode === 'candle') {
      const bw = clamp(stepX * 0.62, 1.1, 13);
      data.forEach((p, i) => {
        const cx = x(i);
        const rising = p.c >= p.o;
        const col = rising ? C.up : C.down;
        const yo = y(p.o);
        const yc = y(p.c);
        const top = Math.min(yo, yc);
        const hgt = Math.max(1.1, Math.abs(yc - yo));
        chartBody += `<line x1="${cx.toFixed(1)}" y1="${y(p.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(p.l).toFixed(1)}"
          stroke="${col}" stroke-width="1" opacity="0.85"/>`;
        chartBody += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}"
          height="${hgt.toFixed(1)}" fill="${col}" opacity="${rising ? 0.9 : 0.9}"/>`;
      });
    } else {
      const pts = data.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join('');
      const gid = `cg${++uid}`;
      const areaPath = `${pts}L${x(data.length - 1).toFixed(1)},${(padT + priceH).toFixed(1)}L${padL},${(padT + priceH).toFixed(1)}Z`;
      chartBody += `<defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${color}" stop-opacity="0.22"/>
          <stop offset="0.85" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#${gid})"/>
      <path d="${pts}" fill="none" stroke="${color}" stroke-width="1.6"
        stroke-linejoin="round" stroke-linecap="round"/>`;
    }

    /* ---------- 昨收参考线 ---------- */
    let baseline = '';
    if (range === '1d' && Number.isFinite(prevClose)) {
      const by = y(prevClose);
      if (by >= padT && by <= padT + priceH) {
        baseline = `<line x1="${padL}" y1="${by.toFixed(1)}" x2="${W - padR}" y2="${by.toFixed(1)}"
          stroke="${C.muted}" stroke-width="1" stroke-dasharray="3 3" opacity="0.55"/>
          <text x="${W - padR + 8}" y="${(by + 3.2).toFixed(1)}" fill="${C.muted}"
          font-size="8.5" font-family="SF Mono, Menlo, monospace" opacity="0.75">昨收</text>`;
      }
    }

    /* ---------- 成交量 ---------- */
    let volBars = '';
    const bwv = clamp(stepX * 0.55, 0.8, 9);
    data.forEach((p, i) => {
      if (!Number.isFinite(p.v) || !maxV) return;
      const h = Math.max(0.6, volTop + volH - vy(p.v));
      const rising = p.c >= p.o;
      volBars += `<rect x="${(x(i) - bwv / 2).toFixed(1)}" y="${(volTop + volH - h).toFixed(1)}"
        width="${bwv.toFixed(1)}" height="${h.toFixed(1)}" rx="0.5"
        fill="${rising ? C.up : C.down}" opacity="0.32"/>`;
    });

    const lastX = x(data.length - 1);
    const lastY = y(data[data.length - 1].c);

    host.innerHTML = `
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="行情图">
        ${grid}${yLabels}${xLabels}${baseline}
        ${chartBody}
        <line x1="${padL}" y1="${vy(0).toFixed(1)}" x2="${W - padR}" y2="${vy(0).toFixed(1)}"
          stroke="${C.line}" stroke-width="1"/>
        ${volBars}
        ${mode === 'area' ? `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3"
          fill="${color}" stroke="${C.panel}" stroke-width="1.5"/>` : ''}
        <g class="cross" style="display:none">
          <line class="cx" x1="0" y1="${padT}" x2="0" y2="${volTop + volH}"
            stroke="${C.text}" stroke-width="1" stroke-dasharray="3 3" opacity="0.32"/>
          <line class="cy" x1="${padL}" y1="0" x2="${W - padR}" y2="0"
            stroke="${C.text}" stroke-width="1" stroke-dasharray="3 3" opacity="0.22"/>
          <circle class="cd" r="3.2" fill="${color}" stroke="${C.panel}" stroke-width="1.5"/>
        </g>
      </svg>
      <div class="chart-tip"></div>`;

    const cross = host.querySelector('.cross');
    const cxLine = host.querySelector('.cx');
    const cyLine = host.querySelector('.cy');
    const cDot = host.querySelector('.cd');
    const tip = host.querySelector('.chart-tip');

    let active = -1;
    const show = (mx) => {
      const i = clamp(Math.round(((mx - padL) / (stepX || 1))), 0, data.length - 1);
      if (i === active) return;
      active = i;
      const p = data[i];
      const px = x(i);
      const py = y(p.c);
      cross.style.display = '';
      cxLine.setAttribute('x1', px.toFixed(1));
      cxLine.setAttribute('x2', px.toFixed(1));
      cyLine.setAttribute('y1', py.toFixed(1));
      cyLine.setAttribute('y2', py.toFixed(1));
      cDot.setAttribute('cx', px.toFixed(1));
      cDot.setAttribute('cy', py.toFixed(1));

      const prev = i > 0 ? data[i - 1].c : range === '1d' ? prevClose : p.o;
      const chg = Number.isFinite(prev) && prev ? ((p.c - prev) / prev) * 100 : null;
      const chgCol = chg == null ? C.muted : chg >= 0 ? C.up : C.down;
      const volTxt = p.v > 0 ? compactVol(p.v) : '—';

      const rows =
        mode === 'candle'
          ? [
              ['开', fmt(p.o)],
              ['高', fmt(p.h)],
              ['低', fmt(p.l)],
              ['收', fmt(p.c)],
              ['量', volTxt],
            ]
          : [
              ['价', fmt(p.c)],
              ['涨跌', chg == null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`],
              ['量', volTxt],
            ];

      tip.innerHTML =
        `<div class="tt-date">${fullLabel(p.t, range)}</div>` +
        rows
          .map(
            ([k, v]) =>
              `<div class="tt-row"><span>${k}</span><span style="${
                k === '涨跌' ? `color:${chgCol}` : ''
              }">${v}</span></div>`
          )
          .join('');
      tip.classList.add('show');

      const tw = 138;
      const left = clamp(px + 14, 6, W - tw - 6);
      tip.style.left = `${left}px`;
      tip.style.top = `${clamp(py - 40, 6, H - 110)}px`;
    };

    const hide = () => {
      active = -1;
      cross.style.display = 'none';
      tip.classList.remove('show');
    };

    host.onpointermove = (ev) => {
      const rect = host.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      if (mx < padL - 6 || mx > W - padR + 6) return hide();
      show(mx);
    };
    host.onpointerleave = hide;
  }

  function schedule() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  }

  draw();
  observer = new ResizeObserver(schedule);
  observer.observe(host);

  return () => {
    cancelAnimationFrame(raf);
    if (observer) observer.disconnect();
    host.onpointermove = null;
    host.onpointerleave = null;
  };
}

export function compactVol(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
  return `${Math.round(v)}`;
}

/* -------------------------------------------------------------------- */
/* 多标的对比图（按日期对齐，可切换「归一化净值 / 回撤」）                */
/* -------------------------------------------------------------------- */

function toTs(t) {
  const v = Date.parse(`${t}T00:00:00Z`);
  return Number.isFinite(v) ? v : null;
}

function nearest(points, ts) {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  const a = points[Math.max(0, lo - 1)];
  const b = points[lo];
  return Math.abs(a.ts - ts) <= Math.abs(b.ts - ts) ? a : b;
}

export function mountMultiChart(host, series, opts = {}) {
  const { mode = 'index', height = 380 } = opts;
  let observer = null;
  let raf = 0;

  const prepared = series
    .map((s) => {
      const pts = (s.points || [])
        .map(([t, c]) => ({ ts: toTs(t), t, c }))
        .filter((p) => p.ts && Number.isFinite(p.c) && p.c > 0);
      if (pts.length < 2) return null;
      const first = pts[0].c;
      let peak = -Infinity;
      const values = pts.map((p) => {
        peak = Math.max(peak, p.c);
        const v = mode === 'drawdown' ? (p.c / peak - 1) * 100 : (p.c / first) * 100;
        return { ...p, v };
      });
      return { name: s.name, color: s.color, points: values };
    })
    .filter(Boolean);

  function draw() {
    const W = Math.max(320, host.clientWidth);
    const H = Math.max(220, host.clientHeight || height);
    const C = readColors(host);
    host.onpointermove = null;
    host.onpointerleave = null;

    if (!prepared.length) {
      host.innerHTML = '<div class="chart-empty">暂无可对比的数据</div>';
      return;
    }

    const padT = 14;
    const padB = 24;
    const padL = 10;
    const padR = 56;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const t0 = Math.min(...prepared.map((s) => s.points[0].ts));
    const t1 = Math.max(...prepared.map((s) => s.points[s.points.length - 1].ts));

    let lo = Infinity;
    let hi = -Infinity;
    for (const s of prepared) for (const p of s.points) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
    if (mode === 'drawdown') hi = 0;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const padY = (hi - lo) * 0.08;
    lo -= padY;
    hi += padY;

    const ticks = niceTicks(lo, hi, 5);
    if (ticks.length > 1) { lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]); }


    const x = (ts) => padL + ((ts - t0) / (t1 - t0 || 1)) * plotW;
    const y = (v) => padT + plotH * (1 - (v - lo) / (hi - lo || 1));

    let grid = '';
    let yLabels = '';
    for (const t of ticks) {
      const py = y(t);
      if (py < padT - 1 || py > padT + plotH + 1) continue;
      grid += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${W - padR}" y2="${py.toFixed(1)}"
        stroke="${C.line}" stroke-width="1" stroke-dasharray="2 4"/>`;
      yLabels += `<text x="${W - padR + 8}" y="${(py + 3.2).toFixed(1)}" fill="${C.muted}"
        font-size="9.5" font-family="SF Mono, Menlo, monospace">${
          mode === 'drawdown' ? `${t.toFixed(0)}%` : t.toFixed(0)
        }</text>`;
    }

    let xLabels = '';
    const n = 5;
    const seen = new Set();
    for (let k = 0; k < n; k++) {
      const ts = t0 + ((t1 - t0) * k) / (n - 1);
      const d = new Date(ts);
      const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      if (seen.has(label)) continue;
      seen.add(label);
      const px = x(ts);
      const anchor = k === 0 ? 'start' : k === n - 1 ? 'end' : 'middle';
      xLabels += `<text x="${px.toFixed(1)}" y="${H - 7}" text-anchor="${anchor}" fill="${C.muted}"
        font-size="9" font-family="SF Mono, Menlo, monospace">${label}</text>`;
    }

    let lines = '';
    for (const s of prepared) {
      const d = s.points
        .map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`)
        .join('');
      lines += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.7"
        stroke-linejoin="round" stroke-linecap="round" opacity="0.92"/>`;
      const last = s.points[s.points.length - 1];
      lines += `<circle cx="${x(last.ts).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.6"
        fill="${s.color}" stroke="${C.panel}" stroke-width="1.4"/>`;
    }

    const zeroLine =
      mode === 'drawdown'
        ? `<line x1="${padL}" y1="${y(0).toFixed(1)}" x2="${W - padR}" y2="${y(0).toFixed(1)}"
            stroke="${C.muted}" stroke-width="1" opacity="0.5"/>`
        : '';

    host.innerHTML = `
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="多标的走势对比">
        ${grid}${yLabels}${xLabels}${zeroLine}${lines}
        <g class="cross" style="display:none">
          <line class="cx" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}"
            stroke="${C.text}" stroke-width="1" stroke-dasharray="3 3" opacity="0.32"/>
        </g>
      </svg>
      <div class="chart-tip multi-tip"></div>`;

    const cross = host.querySelector('.cross');
    const cx = host.querySelector('.cx');
    const tip = host.querySelector('.chart-tip');
    let lastTs = null;

    const show = (mx) => {
      const ts = t0 + ((mx - padL) / plotW) * (t1 - t0);
      if (lastTs && Math.abs(ts - lastTs) < 86400000 / 8) return;
      lastTs = ts;
      const px = clamp(mx, padL, W - padR);
      cross.style.display = '';
      cx.setAttribute('x1', px.toFixed(1));
      cx.setAttribute('x2', px.toFixed(1));

      const rows = prepared.map((s) => {
        const p = nearest(s.points, ts);
        const chg = mode === 'index' ? ` (${p.v >= 100 ? '+' : ''}${(p.v - 100).toFixed(1)}%)` : '';
        const val = mode === 'drawdown' ? `${p.v.toFixed(1)}%` : p.v.toFixed(1);
        return `<div class="tt-row"><span><i class="dot" style="background:${s.color}"></i>${s.name}</span>
          <span>${val}<em>${chg}</em></span></div>`;
      });

      const dateStr = new Date(nearest(prepared[0].points, ts).ts).toISOString().slice(0, 10);
      tip.innerHTML = `<div class="tt-date">${dateStr}</div>${rows.join('')}`;
      tip.classList.add('show');
      const tw = 210;
      tip.style.left = `${clamp(px + 14, 6, W - tw - 6)}px`;
      tip.style.top = `${padT + 6}px`;
    };

    const hide = () => {
      lastTs = null;
      cross.style.display = 'none';
      tip.classList.remove('show');
    };

    host.onpointermove = (ev) => {
      const rect = host.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      if (mx < padL - 6 || mx > W - padR + 6) return hide();
      show(mx);
    };
    host.onpointerleave = hide;
  }

  function schedule() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  }

  draw();
  observer = new ResizeObserver(schedule);
  observer.observe(host);

  return () => {
    cancelAnimationFrame(raf);
    if (observer) observer.disconnect();
    host.onpointermove = null;
    host.onpointerleave = null;
  };
}
