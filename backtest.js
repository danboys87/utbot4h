/**
 * Backtest — UT Bot Alert 4H, simulasi MODE AUTO
 *
 * Meniru bot: BUY saat sinyal UT Bot, SELL saat sinyal SELL / SL / TP / trailing / max hold,
 * dengan batas max posisi dan budget tetap per trade.
 *
 * Cara pakai:
 *   node backtest.js                          # top 30 koin volume, 90 hari
 *   node backtest.js --days 180 --top 50
 *   node backtest.js --symbols BTCUSDT,ETHUSDT,SOLUSDT
 *   node backtest.js --compare                # bandingkan beberapa aturan exit & filter
 *   node backtest.js --demo --compare         # tes mesin dengan data acak (tanpa internet)
 *
 * Parameter (default diambil dari user-config.json):
 *   --days N          lama periode uji (default 90)
 *   --top N           jumlah koin teratas berdasarkan volume 24h (default 30)
 *   --symbols A,B,C   pakai daftar sendiri (menggantikan --top)
 *   --key N --atr N   parameter UT Bot
 *   --budget N        USDT per trade
 *   --max-pos N       maksimal posisi bersamaan
 *   --adx-min N       filter BUY: ADX 4H minimal N (0 = off)
 *   --ema N           filter BUY: close > EMA N di 4H (0 = off). 126 ≈ EMA21 1D
 *   --max-risk N      filter BUY: tolak sinyal bila jarak close→SL UT Bot > N% (0 = off)
 *   --sl-mode utbot|fixed|none   utbot = trailing stop UT Bot - buffer (default, = bot v4.3)
 *                                fixed = -sl-pct dari entry
 *   --max-sl-pct N    batasi jarak SL UT Bot maksimal N% dari entry (0 = tanpa batas)
 *   --sl-pct N        stop loss % (mode fixed)
 *   --tp-pct N        take profit % dari entry (0 = nonaktif)
 *   --tp-rr N         take profit berbasis R:R dari SL (dipakai bila tp-pct = 0)
 *   --trail-activate N  aktifkan trailing di profit N% (0 = nonaktif)
 *   --trail-pct N     callback trailing % dari peak
 *   --max-hold N      jam maksimal menahan posisi (0 = nonaktif)
 *   --no-sell-exit    jangan keluar saat sinyal SELL
 *   --fee N           fee % per sisi (default dari config, 0.1)
 *   --slip N          slippage % per eksekusi (default 0.05)
 *   --out DIR         folder hasil CSV/JSON (default ./backtest_out)
 *   --refresh         abaikan cache data candle
 */

import fs   from 'fs';
import path from 'path';
import { calcATR, calcADXSeries, calcEMASeries } from './indicators.js';
import { config }  from './config.js';

const PERIOD = 4 * 3600 * 1000;
const WARMUP = 250;                 // candle tambahan sebelum periode uji (ATR / trailing stop / EMA200)
const BASE   = 'https://api.bitget.com';

// ───────────────────────────── CLI ─────────────────────────────
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const num = (name, def) => { const v = opt(name, undefined); return v === undefined || v === true ? def : parseFloat(v); };

const mg   = config.management ?? {};
const cfgF = config.screening?.utbot?.filters ?? {};
const BASE_PARAMS = {
  key:           num('key',  config.screening?.utbot?.keyValue ?? 2),
  atr:           num('atr',  config.screening?.utbot?.atrPeriod ?? 10),
  budget:        num('budget', config.trading?.budgetPerTrade ?? 100),
  maxPos:        num('max-pos', config.trading?.maxOpenPositions ?? 5),
  adxMin:        num('adx-min', cfgF.adx?.enabled ? (cfgF.adx.min ?? 20) : 0),      // 0 = off
  emaPeriod:     num('ema',     cfgF.ema?.enabled ? (cfgF.ema.period ?? 50) : 0),   // 0 = off
  maxRiskPct:    num('max-risk', cfgF.maxRisk?.enabled ? (cfgF.maxRisk.maxPct ?? 8) : 0), // 0 = off
  slMode:        String(opt('sl-mode', mg.slMode ?? 'utbot')),
  maxSlPct:      num('max-sl-pct', mg.maxSlPct ?? 0),
  slPct:         Math.abs(num('sl-pct', Math.abs(mg.stopLossPct ?? 5))),
  slBuffer:      mg.slBuffer ?? 0.005,
  tpPct:         num('tp-pct', mg.useFixedTP === true ? (mg.takeProfitPct ?? 10) : 0),
  tpRR:          num('tp-rr', 0),
  trailActivate: num('trail-activate', mg.trailingStop?.activateAtProfitPct ?? 10),
  trailPct:      num('trail-pct', mg.trailingStop?.trailPct ?? 2),
  beBufPct:      1,                                   // SL saat trailing aktif = entry +1% (sama dengan manager.js)
  maxHoldH:      num('max-hold', mg.maxHoldHours ?? 120),
  exitOnSell:    !argv.includes('--no-sell-exit') && mg.exitOnUTBotSell !== false,
  feePct:        num('fee', config.trading?.feePct ?? 0.1),
  slipPct:       num('slip', 0.05),
};
const DAYS    = num('days', 90);
const TOP_N   = num('top', 30);
const OUT_DIR = String(opt('out', './backtest_out'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────────── DATA ─────────────────────────────
async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(1500 * (i + 1)); continue; }
      const j = await res.json();
      if (j.code && j.code !== '00000') throw new Error(`${j.code}: ${j.msg}`);
      return j;
    } catch (e) { lastErr = e; await sleep(800 * (i + 1)); }
  }
  throw lastErr;
}

async function fetchHistory(symbol, days) {
  const need     = Math.ceil(days * 6) + WARMUP + 5;
  const cacheDir = path.join(OUT_DIR, 'cache');
  const cacheKey = path.join(cacheDir, `${symbol}_4h_${days}d_w${WARMUP}_${new Date().toISOString().slice(0, 10)}.json`);
  if (!argv.includes('--refresh') && fs.existsSync(cacheKey)) {
    try { return JSON.parse(fs.readFileSync(cacheKey, 'utf8')); } catch {}
  }

  const rows = new Map();
  let end = Date.now(), prevOldest = Infinity;
  while (rows.size < need) {
    const j = await getJson(`${BASE}/api/v2/spot/market/candles?symbol=${symbol}&granularity=4h&endTime=${end}&limit=1000`);
    const data = j.data;
    if (!Array.isArray(data) || !data.length) break;
    let oldest = Infinity;
    for (const r of data) { const ts = parseInt(r[0]); rows.set(ts, r); if (ts < oldest) oldest = ts; }
    if (oldest >= prevOldest) break;            // tidak ada kemajuan → API mengabaikan endTime
    prevOldest = oldest;
    end = oldest - 1;
    await sleep(150);
  }

  const periodStart = Date.now() - (Date.now() % PERIOD);
  const candles = [...rows.values()]
    .map(r => ({ t: parseInt(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
    .filter(x => x.t < periodStart && x.o > 0)         // hanya candle yang sudah closed
    .sort((a, b) => a.t - b.t);

  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheKey, JSON.stringify(candles)); } catch {}
  return candles;
}

async function pickSymbols() {
  const listed = opt('symbols', undefined);
  if (listed && listed !== true) return String(listed).toUpperCase().split(',').map(s => s.trim()).filter(Boolean);

  const minVol = config.screening?.utbot?.minVolume24h ?? 1_000_000;
  const j = await getJson(`${BASE}/api/v2/spot/market/tickers`);
  let crypto = null;
  try {
    const s = await getJson(`${BASE}/api/v2/spot/public/symbols`);
    crypto = new Set(s.data.filter(x => x.areaSymbol === 'no').map(x => x.symbol));
  } catch {}
  return j.data
    .filter(t => t.symbol.endsWith('USDT'))
    .filter(t => !(config.blacklist ?? []).includes(t.symbol))
    .filter(t => !crypto || crypto.has(t.symbol))
    .filter(t => parseFloat(t.usdtVol || t.quoteVolume || 0) >= minVol)
    .sort((a, b) => parseFloat(b.usdtVol || 0) - parseFloat(a.usdtVol || 0))
    .slice(0, TOP_N)
    .map(t => t.symbol);
}

// Data acak untuk menguji mesin tanpa internet (BUKAN data pasar)
function demoHistory(n = 8, days = 200) {
  let seed = 12345;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const end = Date.now() - (Date.now() % PERIOD);
  const out = {};
  for (let k = 0; k < n; k++) {
    let p = 1 + rnd() * 50, drift = 0;
    const total = days * 6 + WARMUP + 5, arr = [];
    for (let i = 0; i < total; i++) {
      if (i % 60 === 0) drift = (rnd() - 0.48) * 0.004;           // rezim tren berganti-ganti
      const o = p, ret = drift + gauss() * 0.012;
      const c = o * (1 + ret);
      const h = Math.max(o, c) * (1 + Math.abs(gauss()) * 0.004);
      const l = Math.min(o, c) * (1 - Math.abs(gauss()) * 0.004);
      arr.push({ t: end - (total - i) * PERIOD, o, h, l, c, v: 1000 });
      p = c;
    }
    out[`DEMO${k + 1}USDT`] = arr;
  }
  return out;
}

// ───────────────────────────── UT BOT (seri penuh) ─────────────────────────────
// Logika identik dengan calcUTBot di indicators.js, tapi mengembalikan seluruh seri.
function utbotSeries(c, keyValue, atrPeriod) {
  const highs = c.map(x => x.h), lows = c.map(x => x.l), closes = c.map(x => x.c);
  const atrArr = calcATR(highs, lows, closes, atrPeriod);
  if (!atrArr) return null;
  const start = atrArr.findIndex(v => v !== null);
  if (start === -1) return null;

  const stops = new Array(closes.length).fill(null);
  const sig   = new Array(closes.length).fill(null);
  stops[start] = closes[start] - atrArr[start] * keyValue;

  for (let i = start + 1; i < closes.length; i++) {
    const atr = atrArr[i];
    if (!atr) { stops[i] = stops[i - 1]; continue; }
    const nLoss = atr * keyValue, close = closes[i], prevClose = closes[i - 1];
    const prevStop = stops[i - 1] ?? (close - nLoss);

    if (close > prevStop && prevClose > prevStop)      stops[i] = Math.max(prevStop, close - nLoss);
    else if (close < prevStop && prevClose < prevStop) stops[i] = Math.min(prevStop, close + nLoss);
    else                                                stops[i] = close > prevStop ? close - nLoss : close + nLoss;

    if (prevClose <= prevStop && close > stops[i]) sig[i] = 'BUY';
    if (prevClose >= prevStop && close < stops[i]) sig[i] = 'SELL';
  }
  return { sig, stops };
}

// ───────────────────────────── FILTER BUY ─────────────────────────────
function emaOf(s, p) {
  s.emaCache ??= new Map();
  if (!s.emaCache.has(p)) s.emaCache.set(p, calcEMASeries(s.c.map(x => x.c), p));
  return s.emaCache.get(p);
}

// i = index candle sinyal (sama dengan yang dievaluasi screener live)
function passFilters(P, s, i) {
  if (P.adxMin > 0) {
    const a = s.adx.adx[i];
    if (a == null || a < P.adxMin) return false;
  }
  if (P.emaPeriod > 0) {
    const e = emaOf(s, P.emaPeriod)[i];
    if (e == null || s.c[i].c <= e) return false;
  }
  if (P.maxRiskPct > 0) {
    const stop = s.stops[i];
    if (stop == null) return false;
    const sl   = stop * (1 - P.slBuffer);
    const risk = (s.c[i].c - sl) / s.c[i].c * 100;
    if (risk > P.maxRiskPct) return false;
  }
  return true;
}

// ───────────────────────────── SIMULASI ─────────────────────────────
function simulate(P, S, order, tStart) {
  const times = [...new Set(order.flatMap(s => S.get(s).c.filter(x => x.t >= tStart).map(x => x.t)))].sort((a, b) => a - b);
  const slip = P.slipPct / 100, fee = P.feePct / 100;
  const open = new Map(), trades = [], eq = [];
  let realized = 0;

  const finish = (pos, rawPrice, t, reason) => {
    const px       = rawPrice * (1 - slip);
    const entryVal = pos.entry * pos.qty, exitVal = px * pos.qty;
    const pnl      = exitVal - entryVal - (entryVal + exitVal) * fee;
    trades.push({
      symbol: pos.sym, entryT: pos.t0, exitT: t, entry: pos.entry, exit: px, pnl,
      pnlPct: pnl / entryVal * 100, reason, holdH: (t - pos.t0) / 3600000,
    });
    realized += pnl;
    open.delete(pos.sym);
  };

  // Aturan exit per candle. Urutan konservatif: harga turun dulu (SL), baru naik (TP).
  const manage = (pos, c, T) => {
    const be = pos.entry * (1 + P.beBufPct / 100);

    // a) stop level (SL awal, atau max(BEP+1%, trailing dari peak) bila trailing aktif)
    let stop = pos.sl;
    if (pos.trailing) stop = Math.max(be, pos.peak * (1 - P.trailPct / 100));
    if (stop != null) {
      if (c.o <= stop) return finish(pos, c.o, T, pos.trailing ? (stop === be ? 'break_even_sl' : 'trailing_stop') : 'stop_loss');
      if (c.l <= stop) return finish(pos, stop, T, pos.trailing ? (stop === be ? 'break_even_sl' : 'trailing_stop') : 'stop_loss');
    }

    // b) take profit / aktivasi trailing saat harga naik ke high
    let tp = null;
    if (P.tpPct > 0)                    tp = pos.entry * (1 + P.tpPct / 100);
    else if (P.tpRR > 0 && pos.sl)      tp = pos.entry + (pos.entry - pos.sl) * P.tpRR;
    if (tp != null && c.h >= tp) return finish(pos, Math.max(tp, c.o), T, 'take_profit');

    if (P.trailActivate > 0 && !pos.trailing && c.h >= pos.entry * (1 + P.trailActivate / 100)) pos.trailing = true;
    if (pos.trailing) pos.peak = Math.max(pos.peak, c.h);

    // c) trailing: bila close sudah di bawah level trailing, anggap tertembus
    if (pos.trailing) {
      const lvl = Math.max(be, pos.peak * (1 - P.trailPct / 100));
      if (c.c <= lvl) return finish(pos, lvl, T, lvl === be ? 'break_even_sl' : 'trailing_stop');
    }

    // d) max hold
    if (P.maxHoldH > 0 && (c.t + PERIOD - pos.t0) / 3600000 >= P.maxHoldH) return finish(pos, c.c, T, 'max_hold_time');
    pos.last = c.c;
  };

  for (const T of times) {
    // A1. SELL dari candle sebelumnya → keluar di open candle ini
    for (const sym of order) {
      const s = S.get(sym), j = s.idx.get(T);
      if (j === undefined || j === 0 || s.c[j - 1].t !== T - PERIOD) continue;
      if (P.exitOnSell && s.sig[j - 1] === 'SELL' && open.has(sym)) finish(open.get(sym), s.c[j].o, T, 'utbot_sell');
    }
    // A2. BUY dari candle sebelumnya → masuk di open candle ini (urutan = ranking volume, sama seperti scan bot)
    for (const sym of order) {
      if (open.size >= P.maxPos) break;
      const s = S.get(sym), j = s.idx.get(T);
      if (j === undefined || j === 0 || s.c[j - 1].t !== T - PERIOD) continue;
      if (s.sig[j - 1] !== 'BUY' || open.has(sym)) continue;
      if (!passFilters(P, s, j - 1)) continue;                       // filter ADX / EMA
      const entry = s.c[j].o * (1 + slip);
      let sl = null;
      if (P.slMode === 'fixed')      sl = entry * (1 - P.slPct / 100);
      else if (P.slMode === 'utbot') {
        sl = s.stops[j - 1] * (1 - P.slBuffer);
        if (entry <= sl) continue;                                   // harga sudah di bawah SL → bot batal beli
        if (P.maxSlPct > 0) sl = Math.max(sl, entry * (1 - P.maxSlPct / 100));
      }
      open.set(sym, { sym, entry, qty: P.budget / entry, t0: T, sl, peak: entry, trailing: false, last: entry });
    }
    // B. manajemen posisi di dalam candle ini
    for (const [sym, pos] of [...open]) {
      const s = S.get(sym), j = s.idx.get(T);
      if (j !== undefined) manage(pos, s.c[j], T);
    }
    // C. equity mark-to-market
    let unreal = 0;
    for (const pos of open.values()) unreal += (pos.last - pos.entry) * pos.qty - pos.entry * pos.qty * fee;
    eq.push({ t: T, v: realized + unreal });
  }

  // posisi yang masih terbuka di akhir periode: tutup di harga terakhir (ditandai)
  const tEnd = times[times.length - 1];
  for (const pos of [...open.values()]) finish(pos, pos.last, tEnd, 'end_of_test');

  return { trades, eq };
}

// ───────────────────────────── METRIK ─────────────────────────────
function metrics(P, { trades, eq }) {
  const done   = trades.filter(t => t.reason !== 'end_of_test');
  const wins   = done.filter(t => t.pnl > 0), losses = done.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let peak = 0, maxDD = 0;
  for (const p of eq) { peak = Math.max(peak, p.v); maxDD = Math.max(maxDD, peak - p.v); }

  const byReason = {}, bySymbol = {}, byMonth = {};
  for (const t of trades) {
    (byReason[t.reason] ??= { n: 0, pnl: 0, w: 0 });
    byReason[t.reason].n++; byReason[t.reason].pnl += t.pnl; if (t.pnl > 0) byReason[t.reason].w++;
    (bySymbol[t.symbol] ??= { n: 0, pnl: 0 }); bySymbol[t.symbol].n++; bySymbol[t.symbol].pnl += t.pnl;
    const m = new Date(t.exitT).toISOString().slice(0, 7);
    byMonth[m] = (byMonth[m] ?? 0) + t.pnl;
  }

  return {
    trades: trades.length, closedTrades: done.length, wins: wins.length,
    winRate: done.length ? wins.length / done.length * 100 : 0,
    totalPnl: total,
    returnPct: total / (P.budget * P.maxPos) * 100,
    profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0),
    avgWin:  wins.length ? gp / wins.length : 0,
    avgLoss: losses.length ? -gl / losses.length : 0,
    expectancy: done.length ? done.reduce((s, t) => s + t.pnl, 0) / done.length : 0,
    avgHoldH: trades.length ? trades.reduce((s, t) => s + t.holdH, 0) / trades.length : 0,
    maxDD, maxDDPct: maxDD / (P.budget * P.maxPos) * 100,
    byReason, bySymbol, byMonth,
  };
}

// ───────────────────────────── LAPORAN ─────────────────────────────
const f2  = n => (n >= 0 ? '+' : '') + n.toFixed(2);
const pad = (s, n) => String(s).padEnd(n);

function printReport(label, P, m, extra = {}) {
  console.log('\n' + '═'.repeat(68));
  console.log(`  ${label}`);
  console.log('═'.repeat(68));
  console.log(`  Filter : ADX ${P.adxMin > 0 ? '> ' + P.adxMin : 'off'} | EMA ${P.emaPeriod > 0 ? 'close > EMA' + P.emaPeriod + ' (4H)' : 'off'} | Risiko SL ${P.maxRiskPct > 0 ? '<= ' + P.maxRiskPct + '%' : 'off'}`);
  console.log(`  Aturan : SL ${P.slMode === 'fixed' ? `-${P.slPct}%` : P.slMode === 'utbot' ? 'UT Bot trail' : 'tanpa SL'} | TP ${P.tpPct > 0 ? `+${P.tpPct}%` : P.tpRR > 0 ? `R:R 1:${P.tpRR}` : 'tanpa TP'} | Trailing ${P.trailActivate > 0 ? `@${P.trailActivate}% cb ${P.trailPct}%` : 'off'} | SELL-exit ${P.exitOnSell ? 'on' : 'off'} | MaxHold ${P.maxHoldH || 'off'}h`);
  console.log(`  Modal  : ${P.budget} USDT/trade x maks ${P.maxPos} posisi (basis ${P.budget * P.maxPos} USDT) | fee ${P.feePct}%/sisi | slip ${P.slipPct}%`);
  console.log('─'.repeat(68));
  console.log(`  Trade           : ${m.trades} (${m.closedTrades} selesai)  | Win rate ${m.winRate.toFixed(1)}%`);
  console.log(`  Total PnL       : ${f2(m.totalPnl)} USDT  (${f2(m.returnPct)}% dari basis modal)`);
  console.log(`  Profit factor   : ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}`);
  console.log(`  Avg win / loss  : ${f2(m.avgWin)} / ${f2(m.avgLoss)} USDT   | Expectancy ${f2(m.expectancy)}/trade`);
  console.log(`  Max drawdown    : -${m.maxDD.toFixed(2)} USDT (${m.maxDDPct.toFixed(1)}% dari basis modal)`);
  console.log(`  Rata2 hold      : ${m.avgHoldH.toFixed(1)} jam`);
  if (extra.buyHold != null) console.log(`  Pembanding      : buy&hold rata-rata koin ${f2(extra.buyHold)}% (periode sama, tanpa leverage)`);

  console.log('\n  Alasan exit:');
  for (const [r, v] of Object.entries(m.byReason).sort((a, b) => b[1].n - a[1].n))
    console.log(`    ${pad(r, 15)} ${String(v.n).padStart(4)}x  win ${String(Math.round(v.w / v.n * 100)).padStart(3)}%  PnL ${f2(v.pnl)}`);

  const syms = Object.entries(m.bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
  if (syms.length > 1) {
    console.log('\n  Koin terbaik : ' + syms.slice(0, 3).map(([s, v]) => `${s} ${f2(v.pnl)}`).join(' | '));
    console.log('  Koin terburuk: ' + syms.slice(-3).reverse().map(([s, v]) => `${s} ${f2(v.pnl)}`).join(' | '));
  }
  const months = Object.entries(m.byMonth).sort();
  if (months.length) console.log('\n  PnL per bulan: ' + months.map(([k, v]) => `${k} ${f2(v)}`).join(' | '));
}

function writeFiles(P, res, m) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const head = 'symbol,entry_time,exit_time,entry,exit,pnl_usdt,pnl_pct,reason,hold_hours';
    const rows = res.trades.sort((a, b) => a.exitT - b.exitT).map(t =>
      [t.symbol, new Date(t.entryT).toISOString(), new Date(t.exitT).toISOString(), t.entry, t.exit, t.pnl.toFixed(4), t.pnlPct.toFixed(3), t.reason, t.holdH.toFixed(1)].join(','));
    fs.writeFileSync(path.join(OUT_DIR, 'backtest-trades.csv'), [head, ...rows].join('\n'));
    fs.writeFileSync(path.join(OUT_DIR, 'backtest-result.json'), JSON.stringify({ params: P, metrics: m, equity: res.eq }, null, 2));
    console.log(`\n  📁 Detail trade & equity: ${OUT_DIR}/backtest-trades.csv , backtest-result.json`);
  } catch (e) { console.log(`  (gagal tulis file: ${e.message})`); }
}

// ───────────────────────────── MAIN ─────────────────────────────
async function main() {
  console.log(`\n🧪 Backtest UT Bot 4H — mode auto | key=${BASE_PARAMS.key} atr=${BASE_PARAMS.atr} | ${DAYS} hari`);

  // 1) data
  const raw = new Map();
  if (argv.includes('--demo')) {
    console.log('⚠ MODE DEMO: data acak, hasil TIDAK mencerminkan pasar. Hanya untuk tes mesin.');
    for (const [s, c] of Object.entries(demoHistory(8, DAYS))) raw.set(s, c);
  } else {
    const symbols = await pickSymbols();
    console.log(`Mengambil data ${symbols.length} koin (cache: ${OUT_DIR}/cache)...`);
    let i = 0;
    for (const s of symbols) {
      i++;
      try {
        const c = await fetchHistory(s, DAYS);
        if (c.length >= BASE_PARAMS.atr + WARMUP / 2) { raw.set(s, c); process.stdout.write(`\r  ${i}/${symbols.length} ${s}        `); }
      } catch (e) { console.log(`\n  ⚠ ${s} dilewati: ${e.message}`); }
    }
    console.log('');
  }
  if (!raw.size) { console.log('❌ Tidak ada data candle. Cek koneksi / daftar symbol.'); process.exit(1); }

  // 2) indikator per koin (sekali saja, dipakai ulang oleh semua skenario)
  const tStart = Date.now() - DAYS * 86400000;
  const S = new Map(), order = [...raw.keys()];
  for (const [sym, c] of raw) {
    const u = utbotSeries(c, BASE_PARAMS.key, BASE_PARAMS.atr);
    if (!u) continue;
    const adx = calcADXSeries(c.map(x => x.h), c.map(x => x.l), c.map(x => x.c), 14);
    S.set(sym, { c, idx: new Map(c.map((x, i) => [x.t, i])), ...u, adx });
  }
  const usable = order.filter(s => S.has(s));
  const inWindow = usable.map(s => S.get(s).c.filter(x => x.t >= tStart));
  const bh = inWindow.filter(a => a.length > 1).map(a => (a[a.length - 1].c / a[0].o - 1) * 100);
  const buyHold = bh.length ? bh.reduce((a, b) => a + b, 0) / bh.length : null;
  const nBuy = usable.reduce((s, k) => s + S.get(k).sig.filter((x, i) => x === 'BUY' && S.get(k).c[i].t >= tStart).length, 0);
  console.log(`Koin dipakai: ${usable.length} | total sinyal BUY di periode uji (sebelum filter): ${nBuy}`);

  // 3) jalankan skenario
  if (argv.includes('--compare')) {
    // A–E sengaja tanpa filter → baseline. F–N menambahkan filter di atas aturan A.
    const NOF = { adxMin: 0, emaPeriod: 0, maxRiskPct: 0 };
    const presets = [
      { name: 'A. Baseline (SL UT Bot + trailing, tanpa filter)', o: { ...NOF } },
      { name: 'B. A + batas SL maks 8% (SL digeser)',             o: { ...NOF, maxSlPct: 8 } },
      { name: 'C. SL UT Bot, tanpa trailing',                     o: { ...NOF, trailActivate: 0 } },
      { name: 'D. Lama (SL -5% fixed + TP 10%)',                  o: { ...NOF, slMode: 'fixed', tpPct: 10 } },
      { name: 'E. Murni UT Bot (tanpa SL/TP/trailing)',           o: { ...NOF, slMode: 'none', tpPct: 0, trailActivate: 0, maxHoldH: 0 } },
      { name: 'F. A + ADX > 20',                                  o: { ...NOF, adxMin: 20 } },
      { name: 'G. A + ADX > 25',                                  o: { ...NOF, adxMin: 25 } },
      { name: 'H. A + close > EMA50 4H',                          o: { ...NOF, emaPeriod: 50 } },
      { name: 'I. A + close > EMA126 4H (≈EMA21 1D)',             o: { ...NOF, emaPeriod: 126 } },
      { name: 'J. A + close > EMA200 4H',                         o: { ...NOF, emaPeriod: 200 } },
      { name: 'K. A + ADX>22 + EMA50',                            o: { ...NOF, adxMin: 22, emaPeriod: 50 } },
      { name: 'L. A + tolak sinyal risiko SL > 6%',               o: { ...NOF, maxRiskPct: 6 } },
      { name: 'M. A + tolak sinyal risiko SL > 8%',               o: { ...NOF, maxRiskPct: 8 } },
      { name: 'N. A + tolak sinyal risiko SL > 10%',              o: { ...NOF, maxRiskPct: 10 } },
      { name: 'O. ADX>22 + EMA50 + risiko SL > 8% (semua)',       o: { adxMin: 22, emaPeriod: 50, maxRiskPct: 8 } },
    ];
    console.log('\n' + '═'.repeat(104));
    console.log(`  ${pad('Skenario', 52)}${pad('Trade', 7)}${pad('Win%', 7)}${pad('PnL USDT', 11)}${pad('PF', 7)}${pad('MaxDD', 10)}Hold(j)`);
    console.log('═'.repeat(104));
    for (const p of presets) {
      const P = { ...BASE_PARAMS, ...p.o };
      const res = simulate(P, S, usable, tStart);
      const m = metrics(P, res);
      console.log(`  ${pad(p.name, 52)}${pad(m.trades, 7)}${pad(m.winRate.toFixed(0) + '%', 7)}${pad(f2(m.totalPnl), 11)}${pad(Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞', 7)}${pad('-' + m.maxDD.toFixed(1), 10)}${m.avgHoldH.toFixed(0)}`);
    }
    if (buyHold != null) console.log(`\n  Pembanding buy&hold rata-rata koin: ${f2(buyHold)}%`);
    console.log('  Catatan: aturan exit/SL mengikuti user-config.json. Untuk detail satu skenario, jalankan tanpa --compare (mis. --adx-min 22 --ema 50).');
  } else {
    const P = { ...BASE_PARAMS };
    const res = simulate(P, S, usable, tStart);
    const m = metrics(P, res);
    printReport('HASIL BACKTEST', P, m, { buyHold });
    writeFiles(P, res, m);
  }

  console.log(`
  ⚠ Batasan: (1) koin dipilih dari volume HARI INI → bias survivorship/look-ahead; (2) entry di open candle
    berikutnya, SL/TP diasumsikan terkena di level (urutan konservatif: SL dulu), fill nyata bisa lebih buruk;
    (3) filter AI (sentimen/unlock/makro) TIDAK ikut karena tidak ada data historis yang bisa dipakai tanpa
    look-ahead; (4) hasil masa lalu bukan jaminan.\n`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
