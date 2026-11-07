#!/usr/bin/env node
/**
 * Market Pulse 每日检查
 *
 * 1. 本地站点/接口健康
 * 2. 上游数据源可用性（东方财富、世界银行、汇率）
 * 3. 指数基金报告是否有更新（中报/年报为全持仓，季报仅前十大）
 *
 * 只做检查，不修改文件；退出码 1 表示健康或上游检查失败。
 * 用法：node scripts/daily-check.mjs
 */
import fs from 'node:fs';

const LOCAL = process.env.LOCAL_URL || 'http://127.0.0.1:5173';
const UA = { 'User-Agent': 'market-pulse-daily-check/1.0' };

async function get(url, opts = {}, timeout = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, headers: { ...UA, ...(opts.headers || {}) } });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(r) {
  try { return JSON.parse(r.text); } catch { return null; }
}

const FUNDS = [
  ['a50', '512550', '富时中国A50'],
  ['hsi', '159920', '恒生指数'],
  ['spx', '513500', '标普500'],
  ['ndx', '513100', '纳斯达克100'],
  ['dji', '513400', '道琼斯'],
  ['dax', '159561', '德国DAX'],
  ['cac', '513080', '法国CAC40'],
];

function periodEnd(title) {
  let m = title.match(/(20\d{2})年中期报告/);
  if (m) return { end: `${m[1]}-06-30`, kind: 'full' };
  m = title.match(/(20\d{2})年年度报告/);
  if (m) return { end: `${m[1]}-12-31`, kind: 'full' };
  m = title.match(/(20\d{2})年第([1-4])季度报告/);
  if (m) {
    const day = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' }[m[2]];
    return { end: `${m[1]}-${day}`, kind: 'quarter' };
  }
  return null;
}

function mark(ok) { return ok ? 'OK  ' : 'FAIL'; }

const issues = [];
const notes = [];

// 1. 本地站点
console.log('== 本地站点 ==');
for (const path of ['/', '/markets.html', '/research.html', '/stock.html', '/api/health', '/api/index-list']) {
  const r = await get(LOCAL + path, {}, 6000);
  const ok = r.ok && r.status === 200;
  console.log(`${mark(ok)} ${path} ${r.status || r.error}`);
  if (!ok) issues.push(`local ${path}`);
}

// 2. 上游数据源
console.log('\n== 上游数据源 ==');
const upstream = [
  ['eastmoney quotes', 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.600519&fields=f12,f13,f14,f2'],
  ['eastmoney kline', 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=2&beg=0&end=20500101&lmt=5&ut=fa5fd1943c7b386f172d6893dbfba10b'],
  ['world bank', 'https://api.worldbank.org/v2/country/US/indicator/CM.MKT.LCAP.CD?format=json&per_page=1'],
  ['fx rates', 'https://open.er-api.com/v6/latest/USD'],
];
for (const [name, url] of upstream) {
  const r = await get(url, {}, 15000);
  let ok = r.ok && r.status === 200;
  if (ok) {
    const j = parseJson(r);
    if (!j) ok = false;
    else if (name === 'eastmoney quotes') ok = Array.isArray(j?.data?.diff) && j.data.diff.length > 0;
    else if (name === 'eastmoney kline') ok = Array.isArray(j?.data?.klines) && j.data.klines.length > 0;
    else if (name === 'world bank') ok = Array.isArray(j) && Array.isArray(j[1]);
    else if (name === 'fx rates') ok = !!j?.rates?.CNY;
  }
  console.log(`${mark(ok)} ${name} ${r.status || r.error}`);
  if (!ok) issues.push(`upstream ${name}`);
}

// 3. 基金报告
console.log('\n== 指数基金报告 ==');
let data = null;
try {
  data = JSON.parse(fs.readFileSync('data/indices.json', 'utf8'));
} catch (err) {
  console.log('FAIL data/indices.json:', err.message);
  issues.push('data/indices.json');
}
const updates = [];
if (data) {
  for (const [id, code, name] of FUNDS) {
    const entry = data.find((x) => x.id === id);
    const stored = entry?.weights?.asOf || '—';
    const url = `http://api.fund.eastmoney.com/f10/JJGG?fundcode=${code}&pageIndex=1&pageSize=40&type=3`;
    const r = await get(url, { headers: { Referer: 'http://fundf10.eastmoney.com/' } }, 15000);
    const j = parseJson(r);
    let full = null;
    let quarter = null;
    for (const item of j?.Data || []) {
      const p = periodEnd(item.TITLE || '');
      if (!p) continue;
      if (p.kind === 'full' && (!full || p.end > full.end)) full = { ...p, title: item.TITLE, date: item.PUBLISHDATEDesc };
      if (p.kind === 'quarter' && (!quarter || p.end > quarter.end)) quarter = { ...p, title: item.TITLE, date: item.PUBLISHDATEDesc };
    }
    const fullNewer = full && full.end > stored;
    const quarterNewer = quarter && quarter.end > stored;
    let state = 'OK';
    if (fullNewer) { state = 'NEW_FULL'; updates.push(`${id}: ${full.end} 全持仓（当前 ${stored}）`); }
    else if (quarterNewer) { state = 'NEW_QUARTER'; notes.push(`${name}: 已有 ${quarter.end} 季报，但季报仅前十大，未自动替换全持仓`); }
    console.log(`${name.padEnd(10)} 当前 ${stored}  最新全持仓 ${full?.end || '—'}  最新季报 ${quarter?.end || '—'}  ${state}`);
  }
}

console.log('\n== 结论 ==');
if (updates.length) console.log('需要更新全持仓：\n- ' + updates.join('\n- '));
else console.log('全持仓无需更新');
if (notes.length) console.log('提示：\n- ' + notes.join('\n- '));
console.log(issues.length ? `\n${issues.length} 项失败：${issues.join(', ')}` : '\n健康检查全部通过');

process.exit(issues.length ? 1 : 0);
