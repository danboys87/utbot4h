/**
 * Screener — UT Bot Alert (4H only)
 *
 * Mendeteksi sinyal BUY dan SELL dari ATR Trailing Stop crossover di timeframe 4H.
 *
 * BUY  : close crosses ABOVE trailing stop
 * SELL : close crosses BELOW trailing stop (untuk posisi yang sudah open)
 */

import { getCandles, getAllTickers } from './bitget.js';
import { calcUTBot }                 from './indicators.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition }               from './state.js';
import { filterCryptoOnly }          from './symbolFilter.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const _sentSignals = new Map();

function signalKey(symbol, signal, tf, timestamp) {
  return `${symbol}_${signal}_${tf}_${timestamp}`;
}

// ── Scan 4H untuk satu symbol ─────────────────────────────────────────────────
async function scanSymbol4H(symbol, cfg, _retry = 0) {
  const { keyValue, atrPeriod } = cfg;
  const MAX_RETRY = 2;
  const TF        = '4H';       // label tampilan (dipakai di log & hasil)
  const API_TF    = '4h';       // ⬅ TAMBAHKAN INI — param valid utk Bitget API
  const periodMs  = 14400000; // 4 jam

  try {
    const candleLimit = Math.max(atrPeriod * 8, 80); // atrPeriod=10 → 80 candle ≈ 13 hari
    const raw         = await getCandles(symbol, API_TF, candleLimit);  // ⬅ ganti TF → API_TF
    if (!Array.isArray(raw) || raw.length < atrPeriod + 10) return null;
    // ... sisanya tetap sama, TF tetap dipakai untuk timeframe: TF, signalKey, dll
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

    // Deduplikasi per sinyal
    const key = signalKey(symbol, result.signal, TF, lastTs);
    if (_sentSignals.has(key)) return null;

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
 * @param {number} opts.maxSignals   - Batas sinyal (default: dari config)
 */
export async function runUTBotScreener(tickersOrSymbols, opts = {}) {
  const utCfg = config.screening?.utbot ?? {};

  const keyValue   = utCfg.keyValue        ?? 2;
  const atrPeriod  = utCfg.atrPeriod       ?? 10;
  const minVol     = utCfg.minVolume24h    ?? config.screening?.minVolume24h ?? 5_000_000;
  const maxSignals = opts.maxSignals        ?? utCfg.maxSignalsPerRun ?? 10;
  const quoteAsset = config.trading.quoteAsset || 'USDT';
  const mode       = opts.mode ?? 'all'; // 'buy_only' | 'sell_only' | 'all'

  log('utbot', `══ UT Bot Alert Screener (4H | key=${keyValue} atr=${atrPeriod} | mode=${mode}) ══`);

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

  log('utbot', `Scanning ${filtered.length} koin (4H)...`);

  const signals  = [];
  let   timeouts = 0;
  const MAX_CONSEC_TIMEOUT = 3;

  for (let i = 0; i < filtered.length; i++) {
    const coin   = filtered[i];
    const before = Date.now();
    const result = await scanSymbol4H(coin.symbol, { keyValue, atrPeriod });
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

      if (signals.length >= maxSignals) {
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
