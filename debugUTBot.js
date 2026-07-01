/**
 * Debug UTBot — Print trailing stop per-candle
 *
 * Cara pakai:
 *   node debugUTBot.js SYMBOL [candleLimit] [keyValue] [atrPeriod] [showLastN]
 *
 * Contoh:
 *   node debugUTBot.js AIUSDT 150 2 10 30
 *   node debugUTBot.js SUIUSDT 300
 *
 * Tujuan: cocokkan angka trailingStop di sini dengan level yang
 * kelihatan di indikator "UT Bot Alerts" TradingView, candle-by-candle.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

import { getCandles } from './bitget.js';
import { calcATR }    from './indicators.js';

const args        = process.argv.slice(2);
const symbol      = args[0]?.toUpperCase();
const candleLimit = parseInt(args[1] || '150');
const keyValue    = parseFloat(args[2] || '2');
const atrPeriod   = parseInt(args[3] || '10');
const showLastN   = parseInt(args[4] || '30');

if (!symbol) {
  console.log('');
  console.log('❌ Format: node debugUTBot.js SYMBOL [candleLimit] [keyValue] [atrPeriod] [showLastN]');
  console.log('   Contoh : node debugUTBot.js AIUSDT 150 2 10 30');
  console.log('');
  process.exit(1);
}

function fmtTs(ms) {
  return new Date(parseInt(ms)).toISOString().replace('T', ' ').slice(0, 16);
}

async function main() {
  console.log('');
  console.log(`═══ Debug UTBot — ${symbol} [4H] ═══`);
  console.log(`candleLimit=${candleLimit} keyValue=${keyValue} atrPeriod=${atrPeriod}`);
  console.log('');

  const raw = await getCandles(symbol, '4h', candleLimit);
  if (!Array.isArray(raw) || raw.length < atrPeriod + 10) {
    console.log('❌ Data candle tidak cukup atau kosong.');
    process.exit(1);
  }

  // Filter candle yang sudah closed, sama seperti screenerUTBot.js
  const periodMs     = 14400000;
  const now          = Date.now();
  const periodStart  = now - (now % periodMs);
  const closed = raw
    .filter(c => parseInt(c[0]) < periodStart)
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

  console.log(`Total candle diterima: ${raw.length} | Candle closed dipakai: ${closed.length}`);
  console.log(`Range: ${fmtTs(closed[0][0])}  →  ${fmtTs(closed[closed.length - 1][0])}`);
  console.log('');

  const highs  = closed.map(c => parseFloat(c[2]));
  const lows   = closed.map(c => parseFloat(c[3]));
  const closes = closed.map(c => parseFloat(c[4]));
  const times  = closed.map(c => c[0]);

  const atrArr = calcATR(highs, lows, closes, atrPeriod);
  if (!atrArr) { console.log('❌ ATR gagal dihitung (data kurang).'); process.exit(1); }

  const startIdx = atrArr.findIndex(v => v !== null);
  const stops = new Array(closes.length).fill(null);
  stops[startIdx] = closes[startIdx] - atrArr[startIdx] * keyValue;

  const signals = new Array(closes.length).fill(null);

  for (let i = startIdx + 1; i < closes.length; i++) {
    const atr = atrArr[i];
    if (!atr) { stops[i] = stops[i - 1]; continue; }

    const nLoss    = atr * keyValue;
    const close    = closes[i];
    const prevStop = stops[i - 1] ?? (close - nLoss);
    const prevClose = closes[i - 1];

    stops[i] = close > prevStop
      ? Math.max(prevStop, close - nLoss)
      : Math.min(prevStop, close + nLoss);

    if (prevClose <= prevStop && close > stops[i]) signals[i] = 'BUY';
    if (prevClose >= prevStop && close < stops[i]) signals[i] = 'SELL';
  }

  console.log(`Timestamp         Close       TrailingStop   ATR          Signal`);
  console.log('─'.repeat(78));

  const start = Math.max(startIdx, closes.length - showLastN);
  for (let i = start; i < closes.length; i++) {
    const sig = signals[i] ? (signals[i] === 'BUY' ? '🟢 BUY' : '🔴 SELL') : '';
    console.log(
      `${fmtTs(times[i]).padEnd(18)} ${closes[i].toFixed(6).padEnd(11)} ${stops[i]?.toFixed(6).padEnd(14) ?? '—'.padEnd(14)} ${atrArr[i]?.toFixed(6).padEnd(12) ?? '—'.padEnd(12)} ${sig}`
    );
  }

  console.log('');
  console.log(`Trailing stop TERKINI: ${stops[stops.length - 1]?.toFixed(6)}`);
  console.log(`Close TERKINI        : ${closes[closes.length - 1]}`);
  console.log(`Signal candle terakhir: ${signals[signals.length - 1] || '— (tidak ada crossing)'}`);
  console.log('');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
