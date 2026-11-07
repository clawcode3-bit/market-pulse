'use strict';

/**
 * 市场脉搏 · Market Pulse
 * 零依赖 Node 服务：静态站点 + 东方财富行情代理（含缓存 / 失败回退）
 *
 * 启动：node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const EM_PUSH = 'https://push2.eastmoney.com';
const EM_HIS = 'https://push2his.eastmoney.com';
const EM_SEARCH = 'https://searchapi.eastmoney.com';
const EM_DATA = 'https://datacenter.eastmoney.com';
const EM_WEB = 'https://emweb.securities.eastmoney.com';
const INDEX_MAP = require('./data/indices.json');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

/* 带 TTL 的缓存；过期后若上游失败则回退旧值 */
const store = new Map();
const inflight = new Map();

function cacheSet(key, value, ttl) {
  store.set(key, { value, exp: Date.now() + ttl });
  if (store.size > 600) {
    const now = Date.now();
    for (const [k, v] of store) if (v.exp + 3600_000 < now) store.delete(k);
    if (store.size > 600) store.delete(store.keys().next().value);
  }
}

async function cached(key, ttl, producer) {
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) return { data: hit.value, cache: 'hit' };
  if (inflight.has(key)) return { data: await inflight.get(key), cache: 'shared' };

  const task = (async () => {
    try {
      const value = await producer();
      cacheSet(key, value, ttl);
      return value;
    } catch (err) {
      if (hit) return hit.value; // 上游失败 → 回退陈旧数据
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  const data = await task;
  return { data, cache: hit ? 'stale' : 'miss' };
}

async function fetchJSON(url, timeout = 9000, extraHeaders = null) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://quote.eastmoney.com/',
      ...(extraHeaders || {}),
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/^[^(]*\((.*)\)[^)]*$/s);
    if (m) return JSON.parse(m[1]);
    throw new Error('upstream returned non-JSON');
  }
}

/* 并发受限的 map */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await worker(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(runners);
  return out;
}

/* ------------------------------------------------------------------ */
/* 东方财富数据处理                                                     */
/* ------------------------------------------------------------------ */

const QUOTE_FIELDS = [
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10',
  'f12', 'f13', 'f14', 'f15', 'f16', 'f17', 'f18', 'f20', 'f21', 'f23',
].join(',');

const MARKET_CURRENCY = { 1: 'CNY', 0: 'CNY', 100: 'HKD', 124: 'HKD', 116: 'HKD', 105: 'USD', 106: 'USD', 107: 'USD', 155: 'GBP', 176: 'JPY', 177: 'KRW', 178: 'TWD', 185: 'EUR', 186: 'EUR' };

function normalizeQuote(d) {
  if (!d || !d.f12) return null;
  return {
    secid: `${d.f13}.${d.f12}`,
    code: String(d.f12),
    market: Number(d.f13),
    name: d.f14,
    currency: MARKET_CURRENCY[Number(d.f13)] || 'CNY',
    digits: clampInt(d.f1, 0, 4, 2),
    price: num(d.f2),
    pct: num(d.f3),
    change: num(d.f4),
    volume: num(d.f5),
    amount: num(d.f6),
    amplitude: num(d.f7),
    turnover: num(d.f8),
    pe: num(d.f9),
    volRatio: num(d.f10),
    high: num(d.f15),
    low: num(d.f16),
    open: num(d.f17),
    prevClose: num(d.f18),
    mcap: num(d.f20),
    floatMcap: num(d.f21),
    pb: num(d.f23),
  };
}

async function getQuotes(secids) {
  const url =
    `${EM_PUSH}/api/qt/ulist.np/get?fltt=2&invt=2&secids=${secids.join(',')}` +
    `&fields=${QUOTE_FIELDS}&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  const json = await fetchJSON(url);
  const diff = json?.data?.diff;
  const rows = Array.isArray(diff) ? diff : diff ? Object.values(diff) : [];
  const map = new Map();
  rows.forEach((row) => {
    const q = normalizeQuote(row);
    if (q) map.set(q.secid, q);
  });
  return map;
}

/* K 线：date,open,close,high,low,volume,amount（klt 101 日线 / 103 月线；fqt 0 不复权 / 1 前复权 / 2 后复权） */
async function getKline(secid, lmt, klt = 101, fqt = 1) {
  const url =
    `${EM_HIS}/api/qt/stock/kline/get?secid=${encodeURIComponent(secid)}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57` +
    `&klt=${klt}&fqt=${fqt}&end=20500101&lmt=${lmt}&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  const json = await fetchJSON(url);
  const raw = json?.data?.klines || [];
  return raw.map((line) => {
    const [t, o, c, h, l, v, a] = line.split(',');
    return { t, o: +o, c: +c, h: +h, l: +l, v: +v, a: +a };
  });
}

/* 分时：time,price,volume,avg */
async function getTrends(secid, ndays) {
  const url =
    `${EM_HIS}/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}` +
    `&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=${ndays}` +
    `&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  const json = await fetchJSON(url);
  const raw = json?.data?.trends || [];
  return raw.map((line) => {
    const [t, p, v] = line.split(',');
    const price = +p;
    const time = t.length > 10 ? t.slice(5) : t;
    return { t: time, o: price, h: price, l: price, c: price, v: +v, a: 0 };
  });
}

const CLOSE_RANGES = { '1y': 250, '3y': 750, '5y': 1250, '10y': 2500, max: 6000 };

/* 市场规模：按上市地汇总全部个股的总市值 / 流通市值 */
const MARKET_LISTS = [
  { id: 'a', fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048' },
  { id: 'hk', fs: 'm:116' },
  { id: 'us', fs: 'm:105,m:106,m:107' },
];

function mapFinanceRow(r) {
  return {
    date: String(r.REPORT_DATE || '').slice(0, 10),
    label: r.REPORT_DATE_NAME || '',
    type: r.REPORT_TYPE || '',
    revenue: num(r.TOTALOPERATEREVE),
    netProfit: num(r.PARENTNETPROFIT),
    revenueYoY: num(r.TOTALOPERATEREVETZ),
    profitYoY: num(r.PARENTNETPROFITTZ),
    deductedProfit: num(r.KCFJCXSYJLR),
    deductedYoY: num(r.KCFJCXSYJLRTZ),
    roe: num(r.ROEJQ),
    grossMargin: num(r.XSMLL),
    netMargin: num(r.XSJLL),
    debtRatio: num(r.ZCFZL),
    currentRatio: num(r.LD),
    quickRatio: num(r.SD),
    cashRatio: num(r.XJLLB),
    assetTurnover: num(r.TOAZZL),
    inventoryTurnover: num(r.CHZZL),
    receivableTurnover: num(r.YSZKZZL),
    eps: num(r.EPSJB),
    bps: num(r.BPS),
    cashPerShare: num(r.MGJYXJJE),
  };
}

const FIN_COLUMNS = [
  'SECUCODE', 'SECURITY_NAME_ABBR', 'REPORT_DATE', 'REPORT_TYPE', 'REPORT_DATE_NAME',
  'TOTALOPERATEREVE', 'PARENTNETPROFIT', 'TOTALOPERATEREVETZ', 'PARENTNETPROFITTZ',
  'KCFJCXSYJLR', 'KCFJCXSYJLRTZ', 'ROEJQ', 'XSMLL', 'XSJLL', 'ZCFZL',
  'LD', 'SD', 'XJLLB', 'TOAZZL', 'CHZZL', 'YSZKZZL', 'EPSJB', 'BPS', 'MGJYXJJE',
].join(',');

async function fetchFinance(secucode, size, type) {
  const filter = type
    ? `(SECUCODE="${secucode}")(REPORT_TYPE="${type}")`
    : `(SECUCODE="${secucode}")`;
  const url =
    `${EM_DATA}/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA` +
    `&columns=${FIN_COLUMNS}&filter=${encodeURIComponent(filter)}` +
    `&pageNumber=1&pageSize=${size}&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC`;
  const json = await fetchJSON(url, 12000, { Referer: EM_WEB });
  return (json?.result?.data || []).map(mapFinanceRow);
}

function secucodeOf(secid) {
  const [market, code] = String(secid).split('.');
  if (market === '1') return `${code}.SH`;
  if (market === '0') return `${code}.${/^[489]/.test(code) ? 'BJ' : 'SZ'}`;
  return null;
}

const RANGES = {
  '1d': { kind: 'trend', ndays: 1 },
  '5d': { kind: 'trend', ndays: 5 },
  '1m': { kind: 'kline', lmt: 24 },
  '3m': { kind: 'kline', lmt: 66 },
  '6m': { kind: 'kline', lmt: 132 },
  '1y': { kind: 'kline', lmt: 250 },
  '3y': { kind: 'kline', lmt: 750 },
  '5y': { kind: 'kline', lmt: 1250 },
  '10y': { kind: 'kline', lmt: 2500 },
};

/* ------------------------------------------------------------------ */
/* 市场规模                                                            */
/* ------------------------------------------------------------------ */

async function clistPage(fs, pn, attempt = 0) {
  const url =
    `${EM_PUSH}/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2` +
    `&fid=f20&fs=${encodeURIComponent(fs)}&fields=f12,f14,f20,f21,f3`;
  const json = await fetchJSON(url, 15000);
  if (!json?.data) throw new Error('clist 无数据');
  return json;
}

async function clistAll(fs) {
  const first = await clistPage(fs, 1);
  const total = Number(first.data.total) || 0;
  const pages = Math.ceil(total / 100);
  const rows = [...(first.data.diff || [])];

  if (pages > 1) {
    const idx = Array.from({ length: pages - 1 }, (_, i) => i + 2);
    const rest = await pool(idx, 6, async (pn) => {
      try {
        return await clistPage(fs, pn);
      } catch {
        return await clistPage(fs, pn); // 重试一次
      }
    });
    if (rest.some((r) => !r)) throw new Error('分页抓取不完整');
    rest.forEach((r) => rows.push(...(r.data.diff || [])));
  }
  return rows;
}

const sumField = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
function weightedChange(rows, key) {
  const base = sumField(rows, key);
  if (!base) return null;
  const w = rows.reduce((s, r) => s + (Number(r[key]) || 0) * (Number(r.f3) || 0), 0);
  return w / base;
}

function marketOf(id, name, currency, secid, rows) {
  return {
    id,
    name,
    currency,
    secid,
    count: rows.filter((r) => Number(r.f21) > 0).length,
    total: sumField(rows, 'f20'),
    float: sumField(rows, 'f21'),
    chgTotal: weightedChange(rows, 'f20'),
    chgFloat: weightedChange(rows, 'f21'),
  };
}

async function buildMarketCaps() {
  const [a, hk, us] = await Promise.all(MARKET_LISTS.map((m) => clistAll(m.fs)));

  const sh = a.filter((r) => /^6/.test(r.f12));
  const sz = a.filter((r) => /^[03]/.test(r.f12));
  const bj = a.filter((r) => /^[489]/.test(r.f12));
  const hkRows = hk.filter((r) => Number(r.f12) < 10000);
  const usRows = us.filter((r) => Number(r.f20) > 0);

  const markets = [
    marketOf('us', '美国', 'USD', '100.SPX', usRows),
    marketOf('sh', '上海', 'CNY', '1.000001', sh),
    marketOf('hk', '中国香港', 'HKD', '100.HSI', hkRows),
    marketOf('sz', '深圳', 'CNY', '0.399001', sz),
    marketOf('bj', '北京', 'CNY', '0.899050', bj),
  ];

  return { markets, generatedAt: Date.now() };
}

async function buildFx() {
  const url =
    `${EM_PUSH}/api/qt/ulist.np/get?fltt=2&secids=133.USDCNH,133.HKDCNH` +
    `&fields=f2,f3,f12,f14,f18&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  const json = await fetchJSON(url);
  const rows = json?.data?.diff || [];
  const usdcnh = rows.find((r) => r.f12 === 'USDCNH');
  const hkdcnh = rows.find((r) => r.f12 === 'HKDCNH');
  if (!usdcnh || !hkdcnh) throw new Error('汇率不可用');

  const usdCny = Number(usdcnh.f2);
  const hkdCnh = Number(hkdcnh.f2);
  let history = [];
  try {
    const k = await getKline('133.USDCNH', 40, 101, 0);
    history = k.map((p) => [p.t, p.c]);
  } catch {
    /* 汇率历史失败不影响主数据 */
  }

  return {
    date: (history[history.length - 1] || [])[0] || null,
    usdCnh: usdCny,
    usdCnhPct: num(usdcnh.f3),
    usdHkd: usdCny / hkdCnh,
    usdPerCny: 1 / usdCny,
    usdPerHkd: hkdCnh / usdCny,
    cnyPct: num(usdcnh.f3),
    history,
    generatedAt: Date.now(),
  };
}

function usdCapOf(q, per) {
  if (!q) return 0;
  let cap = q.mcap || 0;
  if (q.currency === 'GBP') cap /= 100; // 英股总市值以便士计
  const rate = per[q.currency];
  return rate ? cap / rate : 0;
}

/* ------------------------------------------------------------------ */
/* 个股资料                                                            */
/* ------------------------------------------------------------------ */

async function fetchCompanySurvey(secid) {
  const [market, code] = String(secid).split('.');
  if (market === '1' || market === '0') {
    const prefix = market === '1' ? 'SH' : /^[489]/.test(code) ? 'BJ' : 'SZ';
    const json = await fetchJSON(
      `${EM_WEB}/PC_HSF10/CompanySurvey/PageAjax?code=${prefix}${code}`,
      12000,
      { Referer: EM_WEB }
    );
    return json?.jbzl?.[0] || null;
  }
  if (market === '116') {
    const json = await fetchJSON(
      `${EM_WEB}/PC_HKF10/CompanyProfile/PageAjax?code=${code}`,
      12000,
      { Referer: EM_WEB }
    );
    return json ? { __hk: true, ...json } : null;
  }
  return null;
}

function mapProfile(secid, raw) {
  if (!raw) return null;
  if (raw.__hk) {
    const g = raw.gszl || {};
    const q = raw.zqzl || {};
    return {
      name: g.gsmc || q.zqjc || '',
      fullName: g.gsmc || '',
      enName: g.ywmc || '',
      industry: g.sshy || '',
      listed: (q.ssrq || '').slice(0, 10).replaceAll('/', '-'),
      chairman: g.dsz || '',
      president: g.gsy || '',
      website: g.gswz || '',
      email: g.email || '',
      phone: g.lxdh || '',
      address: g.bgdz || '',
      employees: g.ygrs || null,
      regCapital: g.zczb || '',
      profile: g.gsjs || '',
      market: '港股',
    };
  }
  return {
    name: raw.ORG_NAME || raw.SECURITY_NAME_ABBR || '',
    fullName: raw.ORG_NAME || '',
    enName: raw.ORG_NAME_EN || '',
    industry: raw.EM2016 || raw.INDUSTRYCSRC1 || '',
    listed: '',
    chairman: raw.CHAIRMAN || '',
    president: raw.PRESIDENT || '',
    website: raw.ORG_WEB || '',
    email: raw.ORG_EMAIL || '',
    phone: raw.ORG_TEL || '',
    address: raw.ADDRESS || raw.REG_ADDRESS || '',
    employees: num(raw.EMP_NUM),
    regCapital: raw.REG_CAPITAL ? `${raw.REG_CAPITAL} 万元` : '',
    profile: raw.ORG_PROFILE || '',
    business: raw.BUSINESS_SCOPE || raw.MAIN_BUSINESS || '',
    province: raw.PROVINCE || '',
    market: 'A股',
  };
}

async function fetchHolders(secucode) {
  const url =
    `${EM_DATA}/securities/api/data/v1/get?reportName=RPT_F10_EH_HOLDERS&columns=ALL` +
    `&filter=${encodeURIComponent(`(SECUCODE="${secucode}")`)}` +
    `&pageNumber=1&pageSize=10&sortTypes=-1,1&sortColumns=END_DATE,HOLDER_RANK&source=HSF10&client=PC`;
  const json = await fetchJSON(url, 12000, { Referer: EM_WEB });
  const rows = json?.result?.data || [];
  return rows.map((r) => ({
    date: String(r.END_DATE || '').slice(0, 10),
    rank: num(r.HOLDER_RANK),
    name: r.HOLDER_NAME || '',
    shares: num(r.HOLD_NUM),
    ratio: num(r.HOLD_NUM_RATIO),
    change: r.HOLD_NUM_CHANGE || '',
  }));
}

async function fetchHolderCount(secucode) {
  const url =
    `${EM_DATA}/securities/api/data/v1/get?reportName=RPT_HOLDERNUMLATEST&columns=ALL` +
    `&filter=${encodeURIComponent(`(SECUCODE="${secucode}")`)}` +
    `&pageNumber=1&pageSize=1&sortTypes=-1&sortColumns=END_DATE&source=HSF10&client=PC`;
  const json = await fetchJSON(url, 12000, { Referer: EM_WEB });
  const r = (json?.result?.data || [])[0];
  if (!r) return null;
  return {
    date: String(r.END_DATE || '').slice(0, 10),
    num: num(r.HOLDER_NUM),
    prev: num(r.PRE_HOLDER_NUM),
    change: num(r.HOLDER_NUM_CHANGE),
    ratio: num(r.HOLDER_NUM_RATIO),
  };
}

async function fetchDividends(secid) {
  const [market, code] = String(secid).split('.');
  if (market !== '1' && market !== '0') return [];
  const prefix = market === '1' ? 'SH' : /^[489]/.test(code) ? 'BJ' : 'SZ';
  const json = await fetchJSON(
    `${EM_WEB}/PC_HSF10/BonusFinancing/PageAjax?code=${prefix}${code}`,
    12000,
    { Referer: EM_WEB }
  );
  return (json?.fhyx || []).slice(0, 10).map((r) => ({
    date: String(r.NOTICE_DATE || '').slice(0, 10),
    plan: r.IMPL_PLAN_PROFILE || '',
    progress: r.ASSIGN_PROGRESS || '',
    exDate: String(r.EX_DIVIDEND_DATE || '').slice(0, 10),
    payDate: String(r.PAY_CASH_DATE || '').slice(0, 10),
  }));
}


/* ------------------------------------------------------------------ */
/* 全球市场规模（世界银行年度市值 × 指数推算 × 当日汇率）               */
/* ------------------------------------------------------------------ */

const WORLD_MARKETS = [
  { id: 'us', iso: 'US', name: '美国', region: '美洲', cur: 'USD', idx: '100.SPX' },
  { id: 'ca', iso: 'CA', name: '加拿大', region: '美洲', cur: 'CAD', idx: '100.TSX' },
  { id: 'br', iso: 'BR', name: '巴西', region: '美洲', cur: 'BRL', idx: '100.BVSP' },
  { id: 'mx', iso: 'MX', name: '墨西哥', region: '美洲', cur: 'MXN', idx: '100.MXX' },
  { id: 'cl', iso: 'CL', name: '智利', region: '美洲', cur: 'CLP' },
  { id: 'co', iso: 'CO', name: '哥伦比亚', region: '美洲', cur: 'COP' },
  { id: 'pe', iso: 'PE', name: '秘鲁', region: '美洲', cur: 'PEN' },
  { id: 'ar', iso: 'AR', name: '阿根廷', region: '美洲', cur: 'ARS' },
  { id: 'gb', iso: 'GB', name: '英国', region: '欧洲', cur: 'GBP', idx: '100.FTSE' },
  { id: 'de', iso: 'DE', name: '德国', region: '欧洲', cur: 'EUR', idx: '100.GDAXI' },
  { id: 'fr', iso: 'FR', name: '法国', region: '欧洲', cur: 'EUR', idx: '100.FCHI' },
  { id: 'nl', iso: 'NL', name: '荷兰', region: '欧洲', cur: 'EUR', idx: '100.AEX' },
  { id: 'ch', iso: 'CH', name: '瑞士', region: '欧洲', cur: 'CHF', idx: '100.SSMI' },
  { id: 'es', iso: 'ES', name: '西班牙', region: '欧洲', cur: 'EUR', idx: '100.IBEX' },
  { id: 'it', iso: 'IT', name: '意大利', region: '欧洲', cur: 'EUR', idx: '100.MIB' },
  { id: 'se', iso: 'SE', name: '瑞典', region: '欧洲', cur: 'SEK', idx: '100.OMXSPI' },
  { id: 'dk', iso: 'DK', name: '丹麦', region: '欧洲', cur: 'DKK', idx: '100.OMXC20' },
  { id: 'no', iso: 'NO', name: '挪威', region: '欧洲', cur: 'NOK', idx: '100.OSEBX' },
  { id: 'fi', iso: 'FI', name: '芬兰', region: '欧洲', cur: 'EUR', idx: '100.HEX' },
  { id: 'be', iso: 'BE', name: '比利时', region: '欧洲', cur: 'EUR', idx: '100.BFX' },
  { id: 'pt', iso: 'PT', name: '葡萄牙', region: '欧洲', cur: 'EUR', idx: '100.PSI20' },
  { id: 'ie', iso: 'IE', name: '爱尔兰', region: '欧洲', cur: 'EUR', idx: '100.ISEQ' },
  { id: 'at', iso: 'AT', name: '奥地利', region: '欧洲', cur: 'EUR', idx: '100.ATX' },
  { id: 'pl', iso: 'PL', name: '波兰', region: '欧洲', cur: 'PLN', idx: '100.WIG' },
  { id: 'gr', iso: 'GR', name: '希腊', region: '欧洲', cur: 'EUR', idx: '100.ASE' },
  { id: 'tr', iso: 'TR', name: '土耳其', region: '欧洲', cur: 'TRY' },
  { id: 'ru', iso: 'RU', name: '俄罗斯', region: '欧洲', cur: 'RUB', idx: '100.RTS' },
  { id: 'cn', iso: 'CN', name: '中国内地', region: '亚太', cur: 'CNY', idx: '1.000300' },
  { id: 'hk', iso: 'HK', name: '中国香港', region: '亚太', cur: 'HKD', idx: '100.HSI' },
  { id: 'jp', iso: 'JP', name: '日本', region: '亚太', cur: 'JPY', idx: '100.N225' },
  { id: 'kr', iso: 'KR', name: '韩国', region: '亚太', cur: 'KRW', idx: '100.KS11' },
  { id: 'in', iso: 'IN', name: '印度', region: '亚太', cur: 'INR', idx: '100.SENSEX' },
  { id: 'sg', iso: 'SG', name: '新加坡', region: '亚太', cur: 'SGD', idx: '100.STI' },
  { id: 'id', iso: 'ID', name: '印尼', region: '亚太', cur: 'IDR', idx: '100.JKSE' },
  { id: 'my', iso: 'MY', name: '马来西亚', region: '亚太', cur: 'MYR', idx: '100.KLSE' },
  { id: 'th', iso: 'TH', name: '泰国', region: '亚太', cur: 'THB', idx: '100.SET' },
  { id: 'ph', iso: 'PH', name: '菲律宾', region: '亚太', cur: 'PHP', idx: '100.PSI' },
  { id: 'vn', iso: 'VN', name: '越南', region: '亚太', cur: 'VND', idx: '100.VNINDEX' },
  { id: 'au', iso: 'AU', name: '澳大利亚', region: '亚太', cur: 'AUD', idx: '100.AS51' },
  { id: 'nz', iso: 'NZ', name: '新西兰', region: '亚太', cur: 'NZD', idx: '100.NZ50' },
  { id: 'sa', iso: 'SA', name: '沙特', region: '中东非洲', cur: 'SAR', idx: '100.FISAULMU' },
  { id: 'ae', iso: 'AE', name: '阿联酋', region: '中东非洲', cur: 'AED' },
  { id: 'il', iso: 'IL', name: '以色列', region: '中东非洲', cur: 'ILS' },
  { id: 'za', iso: 'ZA', name: '南非', region: '中东非洲', cur: 'ZAR' },
  { id: 'eg', iso: 'EG', name: '埃及', region: '中东非洲', cur: 'EGP' },
  { id: 'ng', iso: 'NG', name: '尼日利亚', region: '中东非洲', cur: 'NGN' },
  { id: 'ke', iso: 'KE', name: '肯尼亚', region: '中东非洲', cur: 'KES' },
  { id: 'ma', iso: 'MA', name: '摩洛哥', region: '中东非洲', cur: 'MAD' },
];

const WB_BASE = 'https://api.worldbank.org/v2/country';
const WB_ISO = WORLD_MARKETS.map((m) => m.iso).join(';');

async function fetchWorldBank(indicator) {
  const url = `${WB_BASE}/${WB_ISO}/indicator/${indicator}?format=json&date=2000:2026&per_page=5000`;
  const json = await fetchJSON(url, 20000, { Referer: 'https://data.worldbank.org/' });
  const rows = Array.isArray(json) ? json[1] || [] : [];
  const best = new Map();
  for (const r of rows) {
    if (r.value == null) continue;
    const iso = r.country?.id;
    const year = Number(r.date);
    const prev = best.get(iso);
    if (!prev || year > prev.year) best.set(iso, { year, value: Number(r.value) });
  }
  return best;
}

async function fetchNowFx() {
  const json = await fetchJSON('https://open.er-api.com/v6/latest/USD', 12000, { Referer: 'https://open.er-api.com/' });
  if (!json?.rates) throw new Error('汇率不可用');
  return {
    date: String(json.time_last_update_utc || '').slice(0, 16),
    source: 'open.er-api.com',
    rates: json.rates,
  };
}

function closeAtYear(points, year) {
  let out = null;
  for (const p of points) {
    if (Number(p.t.slice(0, 4)) <= year) out = p.c;
    else break;
  }
  return out;
}

async function buildWorldMarkets() {
  const [caps, wbFx, nowFx] = await Promise.all([
    cached('wb:cap', 7 * 86400_000, () => fetchWorldBank('CM.MKT.LCAP.CD')).then((r) => r.data),
    cached('wb:fx', 7 * 86400_000, () => fetchWorldBank('PA.NUS.FCRF')).then((r) => r.data),
    cached('fx:now', 3600_000, fetchNowFx).then((r) => r.data),
  ]);

  const idxList = WORLD_MARKETS.filter((m) => m.idx);
  const idxRows = await pool(idxList, 6, async (m) => {
    const k = await getKline(m.idx, 360, 103, 0); // 月线，足够覆盖到基准年
    return { id: m.id, points: k.map((p) => ({ t: p.t, c: p.c })) };
  });
  const idxMap = new Map(idxRows.filter(Boolean).map((r) => [r.id, r.points]));

  const markets = [];
  for (const m of WORLD_MARKETS) {
    const base = caps.get(m.iso);
    const annualFx = wbFx.get(m.iso);
    if (!base || !base.value || !annualFx || !annualFx.value) continue;

    // 芬兰在世界银行的口径异常（2004 年仅 0.02 万亿），直接跳过
    if (m.id === 'fi') continue;
    const localCap = base.value * annualFx.value; // 基准年本币市值（LCU = USD × LCU/USD）
    const points = idxMap.get(m.id) || [];
    const baseClose = points.length ? closeAtYear(points, base.year) : null;
    const nowClose = points.length ? points[points.length - 1].c : null;
    const ratio = baseClose && nowClose ? nowClose / baseClose : 1;
    const localNow = localCap * ratio;
    const fxNow = nowFx.rates[m.cur];
    const usd = fxNow ? localNow / fxNow : base.value * ratio;

    markets.push({
      id: m.id,
      name: m.name,
      region: m.region,
      currency: m.cur,
      baseYear: base.year,
      baseUsd: base.value,
      localCap: localNow,
      usd,
      ratio,
      method: ratio !== 1 ? 'index' : 'wb',
      indexId: m.idx || null,
    });
  }

  markets.sort((a, b) => b.usd - a.usd);
  return { markets, fx: nowFx, generatedAt: Date.now() };
}

/* ------------------------------------------------------------------ */
/* 路由处理                                                            */
/* ------------------------------------------------------------------ */

function parseSecids(param, limit = 60) {
  if (!param) return [];
  const out = [];
  for (const raw of String(param).split(',')) {
    const id = raw.trim();
    if (/^[0-9]{1,3}\.[A-Za-z0-9_-]{1,12}$/.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

const api = {
  async quotes(ctx) {
    const secids = parseSecids(ctx.query.get('secids'));
    if (!secids.length) throw httpError(400, '缺少 secids 参数');
    const { data, cache } = await cached(`q:${secids.join(',')}`, 8000, () => getQuotes(secids));
    return {
      ok: true,
      ts: Date.now(),
      cache,
      items: secids.map((id) => data.get(id)).filter(Boolean),
    };
  },

  async sparks(ctx) {
    const secids = parseSecids(ctx.query.get('secids'));
    const days = clampInt(ctx.query.get('days'), 5, 120, 30);
    if (!secids.length) throw httpError(400, '缺少 secids 参数');
    const { data, cache } = await cached(`s:${days}:${secids.join(',')}`, 600_000, async () => {
      const rows = await pool(secids, 6, async (id) => {
        const k = await getKline(id, days + 2);
        return { id, closes: k.map((p) => p.c) };
      });
      return rows.filter((r) => r && r.closes.length > 1);
    });
    const map = {};
    data.forEach((r) => (map[r.id] = r.closes));
    return { ok: true, ts: Date.now(), cache, days, items: map };
  },

  async history(ctx) {
    const secid = String(ctx.query.get('secid') || '');
    const range = String(ctx.query.get('range') || '1d');
    if (!/^[0-9]{1,3}\.[A-Za-z0-9_-]{1,12}$/.test(secid)) throw httpError(400, 'secid 不合法');
    const conf = RANGES[range];
    if (!conf) throw httpError(400, 'range 不合法');

    const ttl = conf.kind === 'trend' ? 45_000 : 300_000;
    const { data, cache } = await cached(`h:${secid}:${range}`, ttl, async () => {
      const points =
        conf.kind === 'trend' ? await getTrends(secid, conf.ndays) : await getKline(secid, conf.lmt);
      return { kind: conf.kind, points };
    });

    return {
      ok: true,
      ts: Date.now(),
      cache,
      secid,
      range,
      kind: data.kind,
      points: data.points,
    };
  },

  async search(ctx) {
    const q = String(ctx.query.get('q') || '').trim().slice(0, 40);
    if (!q) return { ok: true, items: [] };
    const { data } = await cached(`f:${q.toLowerCase()}`, 300_000, async () => {
      const url =
        `${EM_SEARCH}/api/suggest/get?input=${encodeURIComponent(q)}&type=14` +
        `&token=D43BF722C8E33BDC906FB84D85E326E8&count=24`;
      const json = await fetchJSON(url);
      return json?.QuotationCodeTable?.Data || [];
    });

    const blocked = /(债|ETF|基金|购|沽|窝轮|牛熊|期权|期货|板块|做多|做空|两倍|三倍|杠杆|反向)/;
    const seen = new Set();
    const items = [];
    for (const it of data) {
      if (!it || !it.QuoteID || !it.QuoteID.includes('.')) continue;
      if (String(it.MarketType) === '90') continue; // 板块/概念，不可交易
      if (blocked.test(it.SecurityTypeName || '') || blocked.test(it.Name || '')) continue;
      if (seen.has(it.QuoteID)) continue;
      seen.add(it.QuoteID);
      items.push({
        secid: it.QuoteID,
        code: it.Code,
        name: it.Name,
        market: it.SecurityTypeName || it.MarketType,
      });
      if (items.length >= 12) break;
    }
    return { ok: true, query: q, items };
  },

  /* 研究用：批量取后复权收盘价（只返回 [日期, 收盘] ，体积小） */
  async closes(ctx) {
    const secids = parseSecids(ctx.query.get('secids'));
    const range = String(ctx.query.get('range') || '5y');
    if (!secids.length) throw httpError(400, '缺少 secids 参数');
    const lmt = CLOSE_RANGES[range];
    if (!lmt) throw httpError(400, 'range 不合法');

    const { data, cache } = await cached(`cl:${range}:${secids.join(',')}`, 900_000, async () => {
      const rows = await pool(secids, 5, async (id) => {
        const k = await getKline(id, lmt, 101, 2); // 后复权，保证长周期收益率正确
        return { id, points: k.map((p) => [p.t, p.c]) };
      });
      return rows.filter((r) => r && r.points.length > 1);
    });

    const items = {};
    data.forEach((r) => (items[r.id] = r.points));
    return { ok: true, ts: Date.now(), cache, range, lmt, items };
  },

  /* 研究用：批量取月线收盘价（用于月度收益热力图） */
  async monthly(ctx) {
    const secids = parseSecids(ctx.query.get('secids'));
    const lmt = clampInt(ctx.query.get('lmt'), 60, 600, 480);
    if (!secids.length) throw httpError(400, '缺少 secids 参数');

    const { data, cache } = await cached(`m:${lmt}:${secids.join(',')}`, 1800_000, async () => {
      const rows = await pool(secids, 5, async (id) => {
        const k = await getKline(id, lmt, 103, 2);
        return { id, points: k.map((p) => [p.t, p.c]) };
      });
      return rows.filter((r) => r && r.points.length > 1);
    });

    const items = {};
    data.forEach((r) => (items[r.id] = r.points));
    return { ok: true, ts: Date.now(), cache, items };
  },

  /* 研究用：A 股主要财务指标（港股/美股暂不可用） */
  async fundamentals(ctx) {
    const secid = String(ctx.query.get('secid') || '');
    if (!/^[0-9]{1,3}\.[A-Za-z0-9_-]{1,12}$/.test(secid)) throw httpError(400, 'secid 不合法');
    const [market, code] = secid.split('.');
    if (market !== '1' && market !== '0') throw httpError(400, '暂只支持 A 股财务数据');

    const suffix = market === '1' ? 'SH' : /^[48]/.test(code) ? 'BJ' : 'SZ';
    const secucode = `${code}.${suffix}`;

    const { data, cache } = await cached(`f:${secucode}`, 6 * 3600_000, async () => {
      const base =
        `${EM_DATA}/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA` +
        `&columns=SECUCODE,SECURITY_NAME_ABBR,REPORT_DATE,REPORT_TYPE,REPORT_DATE_NAME,` +
        `TOTALOPERATEREVE,PARENTNETPROFIT,TOTALOPERATEREVETZ,PARENTNETPROFITTZ,` +
        `ROEJQ,XSMLL,XSJLL,ZCFZL,EPSJB,BPS,MGJYXJJE` +
        `&source=HSF10&client=PC&pageNumber=1&pageSize=%d&sortTypes=-1&sortColumns=REPORT_DATE`;

      const [annualRes, latestRes] = await Promise.all([
        fetchJSON(`${base.replace('%d', 8)}&filter=${encodeURIComponent(
          `(SECUCODE="${secucode}")(REPORT_TYPE="年报")`
        )}`, 12000, { Referer: 'https://emweb.securities.eastmoney.com/' }),
        fetchJSON(`${base.replace('%d', 4)}&filter=${encodeURIComponent(
          `(SECUCODE="${secucode}")`
        )}`, 12000, { Referer: 'https://emweb.securities.eastmoney.com/' }),
      ]);

      const annual = annualRes?.result?.data || [];
      const latest = latestRes?.result?.data || [];
      return {
        name: (annual[0] || latest[0] || {}).SECURITY_NAME_ABBR || '',
        annual: annual.map(mapFinanceRow),
        latest: latest.map(mapFinanceRow),
      };
    });

    return { ok: true, ts: Date.now(), cache, secid, ...data };
  },

  /* 个股分析：公司资料 + 财务 + 股东 + 分红 */
  async company(ctx) {
    const secid = String(ctx.query.get('secid') || '');
    if (!/^[0-9]{1,3}\.[A-Za-z0-9_-]{1,12}$/.test(secid)) throw httpError(400, 'secid 不合法');

    const { data, cache } = await cached(`co:${secid}`, 6 * 3600_000, async () => {
      const [survey, dividends] = await Promise.all([
        fetchCompanySurvey(secid).catch(() => null),
        fetchDividends(secid).catch(() => []),
      ]);
      const profile = mapProfile(secid, survey);

      let financials = { annual: [], latest: [] };
      let holders = [];
      let holderCount = null;
      const sc = secucodeOf(secid);
      if (sc) {
        const [annual, latest, hold, count] = await Promise.all([
          fetchFinance(sc, 8, '年报').catch(() => []),
          fetchFinance(sc, 4).catch(() => []),
          fetchHolders(sc).catch(() => []),
          fetchHolderCount(sc).catch(() => null),
        ]);
        financials = { annual, latest };
        holders = hold;
        holderCount = count;
      }

      return { profile, financials, holders, holderCount, dividends };
    });

    return { ok: true, ts: Date.now(), cache, secid, ...data };
  },

  /* 指数清单（用于选择器） */
  async 'index-list'() {
    return {
      ok: true,
      items: INDEX_MAP.map((x) => ({
        id: x.id,
        name: x.name,
        en: x.en,
        publisher: x.publisher,
        inception: x.inception,
        count: x.count,
        partial: !!x.partial,
        secid: x.secid,
      })),
    };
  },

  /* 指数市值排名：每个指数已覆盖成分股的市值合计 */
  'index-ranking': async function () {
    const GROUP_OF = {
      a50: '中国内地', hsi: '中国香港', dji: '美国', spx: '美国', ndx: '美国',
      n225: '日本', dax: '欧洲', cac: '欧洲', ftse: '欧洲', sx5e: '欧洲', ibex: '欧洲', mib: '欧洲',
      asx200: '亚太其他', nifty: '亚太其他', ibov: '拉美',
    };
    const allIds = [...new Set(INDEX_MAP.flatMap((c) => c.constituents.map((x) => x.secid)).filter(Boolean))];
    const quotes = await getQuotes(allIds);
    const fx = (await cached('fx:now', 3600_000, fetchNowFx)).data.rates;
    const per = { USD: 1, HKD: fx.HKD, CNY: fx.CNY, JPY: fx.JPY, EUR: fx.EUR, GBP: fx.GBP, KRW: fx.KRW, TWD: fx.TWD };

    const items = INDEX_MAP.map((c) => {
      let total = 0;
      let covered = 0;
      for (const it of c.constituents) {
        const q = quotes.get(it.secid);
        const usd = usdCapOf(q, per);
        if (usd > 0) { total += usd; covered++; }
      }
      return {
        id: c.id,
        name: c.name,
        en: c.en,
        group: GROUP_OF[c.id] || '其他',
        publisher: c.publisher,
        inception: c.inception,
        declared: c.count,
        configured: c.constituents.length,
        covered,
        totalUsd: total,
        partial: !!c.partial,
      };
    })
      .filter((x) => x.totalUsd > 0)
      .sort((a, b) => b.totalUsd - a.totalUsd);

    const uniq = new Set(INDEX_MAP.flatMap((c) => c.constituents.map((x) => x.secid)).filter(Boolean));
    const seen = new Set();
    let overlap = 0;
    const map = new Map();
    for (const c of INDEX_MAP) {
      for (const it of c.constituents) {
        if (!it.secid) continue;
        if (map.has(it.secid)) { if (!seen.has(it.secid)) { overlap++; seen.add(it.secid); } }
        else map.set(it.secid, true);
      }
    }
    return { ok: true, ts: Date.now(), items, uniqueCompanies: uniq.size, overlap };
  },

  /* 指数成分股：返回主要成分股的实时市值（美元）；id=all 时返回全部指数去重并集 */
  'index-map': async function (ctx) {
    const id = String(ctx.query.get('id') || '');
    const isAll = id === 'all';
    const conf = isAll ? null : INDEX_MAP.find((x) => x.id === id);
    if (!isAll && !conf) throw httpError(404, '未知指数');

    const GROUP_OF = {
      a50: '中国内地', hsi: '中国香港', dji: '美国', spx: '美国', ndx: '美国',
      n225: '日本', dax: '欧洲', cac: '欧洲', ftse: '欧洲', sx5e: '欧洲', ibex: '欧洲', mib: '欧洲',
      asx200: '亚太其他', nifty: '亚太其他', ibov: '拉美',
    };

    let entries;
    if (isAll) {
      const map = new Map();
      for (const c of INDEX_MAP) {
        for (const it of c.constituents) {
          if (!it.secid) continue;
          const prev = map.get(it.secid);
          if (prev) {
            if (!prev.indices.includes(c.name)) prev.indices.push(c.name);
          } else {
            map.set(it.secid, {
              name: it.name,
              ticker: it.ticker,
              secid: it.secid,
              indices: [c.name],
              group: GROUP_OF[c.id] || '其他',
            });
          }
        }
      }
      entries = [...map.values()];
    } else {
      entries = conf.constituents
        .filter((c) => c.secid)
        .map((c) => ({ ...c, indices: [conf.name], group: GROUP_OF[conf.id] || '其他' }));
    }

    const quotes = await getQuotes(entries.map((c) => c.secid));
    const fx = (await cached('fx:now', 3600_000, fetchNowFx)).data.rates;
    const per = { USD: 1, HKD: fx.HKD, CNY: fx.CNY, JPY: fx.JPY, EUR: fx.EUR, GBP: fx.GBP, KRW: fx.KRW, TWD: fx.TWD };

    const items = entries
      .map((c) => {
        const q = quotes.get(c.secid);
        if (!q) return null;
        let capLocal = q.mcap || 0;
        if (q.currency === 'GBP') capLocal /= 100; // 英股总市值以便士计
        const capUsd = usdCapOf(q, per);
        return {
          name: c.name,
          ticker: c.ticker,
          secid: c.secid,
          currency: q.currency,
          price: q.price,
          pct: q.pct,
          capLocal,
          capUsd,
          indices: c.indices,
          group: c.group,
        };
      })
      .filter((x) => x && x.capUsd > 0)
      .sort((a, b) => b.capUsd - a.capUsd);

    if (!isAll && conf.weights) {
      const wmap = new Map(conf.weights.items.map((x) => [x.code, x.weight]));
      for (const it of items) {
        if (wmap.has(it.ticker)) it.weight = wmap.get(it.ticker);
      }
    }

    const total = items.reduce((s, x) => s + x.capUsd, 0);
    const overlap = items.filter((x) => x.indices.length > 1).length;

    return {
      ok: true,
      ts: Date.now(),
      index: isAll
        ? {
            id: 'all',
            name: '全部指数（去重）',
            en: 'All tracked indices · unique constituents',
            publisher: `${INDEX_MAP.length} 个指数`,
            inception: '—',
            count: items.length,
            desc: '把 15 个指数的所有已接入成分股合并，同一家公司只计一次；面积按总市值，颜色按所属市场分组。',
            partial: false,
            aggregate: true,
          }
        : {
            id: conf.id,
            name: conf.name,
            en: conf.en,
            publisher: conf.publisher,
            inception: conf.inception,
            count: conf.count,
            desc: conf.desc,
            partial: !!conf.partial,
            secid: conf.secid,
            weights: conf.weights || null,
          },
      constituents: items,
      covered: items.length,
      declared: isAll ? items.length : conf.constituents.length,
      overlap,
      totalUsd: total,
    };
  },

  /* 全球市场规模：世界银行年度市值 + 指数推算 + 当日汇率 */
  'world-markets': async function (ctx) {
    const [data] = await Promise.all([cached('world:mkt', 6 * 3600_000, buildWorldMarkets).then((r) => r.data)]);
    const total = data.markets.reduce((s, m) => s + m.usd, 0);
    return {
      ok: true,
      ts: Date.now(),
      asOf: data.fx.date,
      fxSource: data.fx.source,
      fx: data.fx.rates,
      totalUsd: total,
      markets: data.markets,
      generatedAt: data.generatedAt,
    };
  },

  /* 市场规模：各市场总市值/流通市值，按当日汇率折算所需的汇率一起返回 */
  async markets() {
    const [caps, fx] = await Promise.all([
      cached('mkt:caps', 6 * 3600_000, buildMarketCaps),
      cached('mkt:fx', 30 * 60_000, buildFx),
    ]);
    return {
      ok: true,
      ts: Date.now(),
      capsAt: caps.data.generatedAt,
      fxAt: fx.data.generatedAt,
      markets: caps.data.markets,
      fx: fx.data,
    };
  },

  async health() {
    return { ok: true, service: 'market-pulse', ts: Date.now(), uptime: process.uptime() };
  },
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 服务启动                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const ctx = { query: url.searchParams, req };

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5);
    const handler = api[name];
    if (!handler) return sendJSON(res, 404, { ok: false, error: '未知接口' });
    try {
      const payload = await handler(ctx);
      payload.ms = Date.now() - started;
      sendJSON(res, 200, payload);
    } catch (err) {
      const status = err.status || 502;
      console.error(`[api] ${name} ${url.search} → ${err.message}`);
      sendJSON(res, status, { ok: false, error: err.message || '行情上游请求失败' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }
  serveStatic(req, res, pathname);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请用 PORT=其他端口 node server.js 启动`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  市场脉搏 · Market Pulse`);
  console.log(`  ➜  http://${HOST}:${PORT}\n`);
});
