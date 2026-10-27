/**
 * Screener — UT Bot Alert (4H only)
 *
 * Mendeteksi sinyal BUY dan SELL dari ATR Trailing Stop crossover di timeframe 4H.
 *
 * BUY  : close crosses ABOVE trailing stop  (+ lolos filter ADX / EMA)
 * SELL : close crosses BELOW trailing stop (dipakai untuk exit posisi yang sudah open)
 *
 * v4.1: koin dengan posisi terbuka SELALU di-scan lebih dulu (tidak kena filter volume),
 *       dan SELL untuk posisi terbuka tidak di-dedupe.
 * v4.4: filter untuk BUY (ADX 4H, close > EMA, maxRisk jarak SL), diatur di user-config.json
 *       → screening.utbot.filters. SELL tidak pernah difilter.
 */

import { getCandles, getAllTickers } from './bitget.js';
import { calcUTBot, calcADX, calcEMA } from './indicators.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition, getOpenSymbols } from './state.js';
import { filterCryptoOnly }          from './symbolFilter.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _sentSignals = new Map();

function signalKey(symbol, signal, tf, timestamp) {
  return `${symbol}_${signal}_${tf}_${timestamp}`;
}

// ── Filter rezim (khusus BUY) ─────────────────────────────────────────────────
// Return string alasan penolakan, atau null bila lolos.
function checkBuyFilters(highs, lows, closes, f = {}, trailingStop = null) {
  const close = closes[closes.length - 1];

  // Jarak risiko: dari close ke SL (trailing stop UT Bot - buffer). Terlalu lebar → tolak.
  if (f.maxRisk?.enabled && trailingStop) {
    const buf     = config.management?.slBuffer ?? 0.005;
    const sl      = trailingStop * (1 - buf);
    const riskPct = (close - sl) / close * 100;
    const max     = f.maxRisk.maxPct ?? 8;
    if (riskPct > max) return `risiko ${riskPct.toFixed(1)}% > ${max}% (SL ${sl.toFixed(6)})`;
  }

  if (f.adx?.enabled) {
    const a = calcADX(highs, lows, closes, f.adx.period ?? 14);
    if (!a) return 'ADX tidak bisa dihitung (data kurang)';
    const min = f.adx.min ?? 20;
    if (a.adx < min) return `ADX ${a.adx.toFixed(1)} < ${min}`;
    if (f.adx.requirePlusDI === true && a.plusDI <= a.minusDI)
      return `+DI ${a.plusDI.toFixed(1)} <= -DI ${a.minusDI.toFixed(1)}`;
  }

  if (f.ema?.enabled) {
    const p = f.ema.period ?? 50;
    const e = calcEMA(closes, p);
    if (e === null) return `data kurang untuk EMA${p}`;
    if (close <= e) return `close ${close} <= EMA${p} ${e.toFixed(6)}`;
  }

  return null;
}

// ── Scan 4H untuk satu symbol ─────────────────────────────────────────────────
async function scanSymbol4H(symbol, cfg, _retry = 0) {
  const { keyValue, atrPeriod } = cfg;
  const MAX_RETRY = 2;
  const TF        = '4H';       // label tampilan (dipakai di log & hasil)
  const API_TF    = '4h';       // param valid utk Bitget API
  const periodMs  = 14400000;   // 4 jam

  try {
    // 300 candle ≈ 50 hari: cukup untuk EMA200, ADX, dan trailing stop yang path-dependent
    const candleLimit = Math.max(atrPeriod * 8, 300);
    const raw         = await getCandles(symbol, API_TF, candleLimit);
    if (!Array.isArray(raw) || raw.length < atrPeriod + 10) return null;

    const now         = Date.now();
    const periodStart = now - (now % periodMs);
    const closed      = raw
      .filter(c => parseInt(c[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    if (closed.length < atrPeriod + 5) return null;

    const highs  = closed.map(c => parseFloat(c[2]));
    const lows   = closed.map(c => parseFloat(c[3]));
    const closes = closed.map(c => parseFloat(c[4]));
    const lastTs = parseInt(closed[closed.length - 1][0]);

    const result = calcUTBot(highs, lows, closes, keyValue, atrPeriod);
    if (!result || !result.signal) return null;

    // ── Filter rezim (hanya BUY) ──
    if (result.signal === 'BUY') {
      const reject = checkBuyFilters(highs, lows, closes, cfg.filters, result.trailingStop);
      if (reject) {
        log('utbot', `  ⛔ ${symbol} BUY ditolak filter: ${reject}`);
        return null;
      }
    }

    // Deduplikasi per sinyal
    // SELL untuk posisi terbuka tidak boleh di-dedupe (harus selalu bisa memicu exit)
    const key = signalKey(symbol, result.signal, TF, lastTs);
    if (_sentSignals.has(key) && !(result.signal === 'SELL' && hasPosition(symbol))) return null;

    _sentSignals.set(key, Date.now());

    // Cleanup signal cache (buang yang sudah lebih dari 24 jam)
    const cutoff = Date.now() - 86400000;
    for (const [k, ts] of _sentSignals.entries()) {
      if (ts < cutoff) _sentSignals.delete(k);
    }

    const slBuffer = config.management?.slBuffer ?? 0.005;
    const slPrice  = result.trailingStop * (1 - slBuffer);
    const low20    = Math.min(...lows.slice(-20));

    return {
      symbol,
      signal:       result.signal,  // 'BUY' atau 'SELL'
      close:        result.close,
      trailingStop: result.trailingStop,
      prevStop:     result.prevStop,
      atr:          result.atr,
      nLoss:        result.nLoss,
      candleTs:     lastTs,
      lastPrice:    result.close,
      slPrice,
      low20,
      timeframe:    TF,
      strategy:     'utbot',
      triggered:    true,
      signals: {
        utbotSignal: {
          bullish: result.signal === 'BUY',
          label: `UT Bot ${result.signal} [4H] — close ${result.close} ${result.signal === 'BUY' ? 'cross above' : 'cross below'} trailing stop ${result.trailingStop.toFixed(6)}`,
        },
      },
      zones: result.signal === 'BUY' ? [{
        type:        'UTBot',
        entryPct:    100,
        priceTop:    result.close * 1.005,
        priceBottom: result.trailingStop,
        label:       `UT Bot BUY zone ${result.trailingStop.toFixed(6)} - ${(result.close * 1.005).toFixed(6)}`,
      }] : [],
      matchCount: 1,
      score: 65,
    };

  } catch (err) {
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.message?.includes('exceeded');

    if (isTimeout && _retry < MAX_RETRY) {
      const waitMs = 3000 * (_retry + 1);
      log('utbot', `  ⏳ ${symbol} [4H] timeout — retry ${_retry + 1}/${MAX_RETRY} dalam ${waitMs / 1000}s`);
      await sleep(waitMs);
      return scanSymbol4H(symbol, cfg, _retry + 1);
    }

    if (isTimeout) log('utbot', `  ⚠ ${symbol} [4H] timeout setelah ${MAX_RETRY + 1}x — skip`);
    else           log('utbot_error', `Scan ${symbol} [4H]: ${err.message}`);
    return null;
  }
}

// ── Main screener ─────────────────────────────────────────────────────────────
/**
 * @param {Array}  tickersOrSymbols  - Daftar ticker/symbol yang akan di-scan
 * @param {object} opts              - Opsi tambahan
 * @param {string} opts.mode         - 'buy_only' | 'sell_only' | 'all' (default: 'all')
 * @param {number} opts.maxSignals   - Batas sinyal BUY (default: dari config)
 */
export async function runUTBotScreener(tickersOrSymbols, opts = {}) {
  const utCfg = config.screening?.utbot ?? {};

  const keyValue   = utCfg.keyValue        ?? 2;
  const atrPeriod  = utCfg.atrPeriod       ?? 10;
  const minVol     = utCfg.minVolume24h    ?? config.screening?.minVolume24h ?? 5_000_000;
  const maxSignals = opts.maxSignals        ?? utCfg.maxSignalsPerRun ?? 10;
  const quoteAsset = config.trading.quoteAsset || 'USDT';
  const mode       = opts.mode ?? 'all'; // 'buy_only' | 'sell_only' | 'all'
  const filters    = utCfg.filters ?? {};

  const fDesc = [
    filters.adx?.enabled ? `ADX>${filters.adx.min ?? 20}` : null,
    filters.ema?.enabled ? `close>EMA${filters.ema.period ?? 50}` : null,
    filters.maxRisk?.enabled ? `risiko<=${filters.maxRisk.maxPct ?? 8}%` : null,
  ].filter(Boolean).join(' + ') || 'tanpa filter';

  log('utbot', `══ UT Bot Alert Screener (4H | key=${keyValue} atr=${atrPeriod} | mode=${mode} | filter BUY: ${fDesc}) ══`);

  const tickers       = Array.isArray(tickersOrSymbols) ? tickersOrSymbols : [];
  const cryptoTickers = await filterCryptoOnly(tickers);

  const filtered = cryptoTickers
    .filter(t => {
      if (!t.symbol.endsWith(quoteAsset))                        return false;
      if (config.blacklist?.includes(t.symbol))                  return false;
      if (parseFloat(t.usdtVol || t.quoteVolume || 0) < minVol) return false;
      return true;
    })
    .sort((a, b) => parseFloat(b.usdtVol || 0) - parseFloat(a.usdtVol || 0));

  // Posisi terbuka SELALU di-scan (paling dulu), walau volumenya di bawah filter
  const openSyms  = getOpenSymbols();
  const openSet   = new Set(openSyms);
  const openCoins = openSyms.map(s => cryptoTickers.find(t => t.symbol === s) ?? { symbol: s });
  const scanList  = [...openCoins, ...filtered.filter(t => !openSet.has(t.symbol))];

  log('utbot', `Scanning ${scanList.length} koin (4H) — ${openCoins.length} posisi terbuka diprioritaskan...`);

  const signals  = [];
  let   timeouts = 0;
  const MAX_CONSEC_TIMEOUT = 3;

  for (let i = 0; i < scanList.length; i++) {
    const coin   = scanList[i];
    const before = Date.now();
    const result = await scanSymbol4H(coin.symbol, { keyValue, atrPeriod, filters });
    const elapsed = Date.now() - before;

    if (elapsed > 20000) {
      timeouts++;
      if (timeouts >= MAX_CONSEC_TIMEOUT) {
        log('utbot', `  ⚠ ${timeouts} timeout berturut-turut — jeda 10s`);
        await sleep(10000);
        timeouts = 0;
      }
    } else {
      timeouts = 0;
    }

    if (result) {
      // Filter berdasarkan mode
      if (mode === 'buy_only'  && result.signal !== 'BUY')  { await sleep(100); continue; }
      if (mode === 'sell_only' && result.signal !== 'SELL') { await sleep(100); continue; }

      result.hasPosition = hasPosition(result.symbol);
      result.vol24h      = parseFloat(coin.usdtVol || coin.quoteVolume || 0);
      result.change24h   = parseFloat(coin.change24h || 0);
      signals.push(result);

      log('utbot', `  ${result.signal === 'BUY' ? '🟢' : '🔴'} ${result.signal} [4H]: ${result.symbol} @ ${result.close} | TS=${result.trailingStop.toFixed(6)}`);

      // Batas hanya menghitung BUY baru; posisi terbuka (di awal list) sudah pasti ter-scan
      const buyCount = signals.filter(x => x.signal === 'BUY' && !x.hasPosition).length;
      if (buyCount >= maxSignals && i >= openCoins.length - 1) {
        log('utbot', `  Max ${maxSignals} sinyal tercapai, berhenti`);
        break;
      }
    }

    // Jeda adaptif
    if (i % 10 === 9)        await sleep(1500);
    else if (i % 5 === 4)    await sleep(800);
    else if (elapsed > 8000) await sleep(800);
    else                     await sleep(300);
  }

  const buySignals  = signals.filter(s => s.signal === 'BUY');
  const sellSignals = signals.filter(s => s.signal === 'SELL');

  log('utbot', `UT Bot selesai → ${buySignals.length} BUY, ${sellSignals.length} SELL signal`);

  // Sort: BUY by score, SELL by volume (prioritas yang sudah punya posisi)
  const sortedBuy  = buySignals.sort((a, b) => b.score - a.score);
  const sortedSell = sellSignals.sort((a, b) => (b.hasPosition ? 1 : 0) - (a.hasPosition ? 1 : 0));

  return [...sortedBuy, ...sortedSell];
}
