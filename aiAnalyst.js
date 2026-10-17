/**
 * AI Analyst — Multi-Provider
 * - analyzeOnDemand : analisa manual via /analyze SYMBOL
 * - rankCandidates  : filter + ranking kandidat hasil screening UT Bot
 *                     (sentimen, token unlock, jadwal makro, teknikal)
 *
 * Provider yang didukung (set di .env):
 *   AI_PROVIDER=openrouter
 *   AI_PROVIDER=gemini
 *   AI_PROVIDER=claude
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCandles, getCurrentPrice } from './bitget.js';
import { calcEMA, calcRSI, calcMACD, calcBollinger, calcADX } from './indicators.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getProvider() {
  return (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
}

export function isAIEnabled() {
  const p = getProvider();
  if (p === 'openrouter') return !!process.env.OPENROUTER_API_KEY;
  if (p === 'gemini')     return !!process.env.GEMINI_API_KEY;
  if (p === 'claude')     return !!process.env.ANTHROPIC_API_KEY;
  return false;
}

function getModelName() {
  const p = getProvider();
  if (p === 'openrouter') return process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';
  if (p === 'gemini')     return process.env.GEMINI_MODEL     || 'gemini-2.0-flash';
  if (p === 'claude')     return 'claude-sonnet-4-20250514';
  return '—';
}

async function callOpenRouter({ systemPrompt, userPrompt, maxTokens = 2000, _retry = 0 }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) { log('ai_analyst', '⚠ OPENROUTER_API_KEY tidak ada'); return null; }
  const model = getModelName();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'https://github.com/bitget-bot',
        'X-Title':       'Bitget Trading Bot',
      },
      body: JSON.stringify({
        model,
        max_tokens:  maxTokens,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) {
        if (_retry >= 2) { log('ai_analyst_warn', `OpenRouter rate limit — skip`); return null; }
        const wait = (_retry + 1) * 15;
        log('ai_analyst_warn', `OpenRouter rate limit, retry dalam ${wait}s...`);
        await sleep(wait * 1000);
        return callOpenRouter({ systemPrompt, userPrompt, maxTokens, _retry: _retry + 1 });
      }
      throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data    = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return content?.trim() || null;
  } catch (err) {
    log('ai_analyst_error', `OpenRouter error: ${err.message}`);
    return null;
  }
}

async function callGemini({ systemPrompt, userPrompt, maxTokens = 2000, _retry = 0 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { log('ai_analyst', '⚠ GEMINI_API_KEY tidak ada'); return null; }
  const MODEL_CHAIN = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  const envModel    = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const model       = _retry === 0 ? envModel : MODEL_CHAIN[Math.min(_retry, MODEL_CHAIN.length - 1)];
  const url         = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) {
        if (_retry >= 2) { log('ai_analyst_warn', `Gemini rate limit — skip`); return null; }
        const wait = (_retry + 1) * 15;
        log('ai_analyst_warn', `Gemini rate limit, retry dalam ${wait}s...`);
        await sleep(wait * 1000);
        return callGemini({ systemPrompt, userPrompt, maxTokens, _retry: _retry + 1 });
      }
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text && _retry > 0) log('ai_analyst', `  ✅ Berhasil dengan ${model}`);
    return text?.trim() || null;
  } catch (err) {
    log('ai_analyst_error', `Gemini error: ${err.message}`);
    return null;
  }
}

async function callClaude({ systemPrompt, userPrompt, maxTokens = 2000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { log('ai_analyst', '⚠ ANTHROPIC_API_KEY tidak ada'); return null; }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}`);
    const data = await res.json();
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || null;
  } catch (err) {
    log('ai_analyst_error', `Claude error: ${err.message}`);
    return null;
  }
}

async function callAI(opts) {
  const provider = getProvider();
  log('ai_analyst', `  Provider: ${provider} | Model: ${getModelName()}`);
  const callers = { openrouter: callOpenRouter, gemini: callGemini, claude: callClaude };
  let result = await (callers[provider] || callOpenRouter)(opts);
  if (!result) {
    const fallbacks = ['openrouter', 'gemini', 'claude'].filter(p => p !== provider);
    for (const fb of fallbacks) {
      const hasKey = { openrouter: !!process.env.OPENROUTER_API_KEY, gemini: !!process.env.GEMINI_API_KEY, claude: !!process.env.ANTHROPIC_API_KEY }[fb];
      if (hasKey) {
        log('ai_analyst', `  ${provider} gagal → fallback ke ${fb}...`);
        result = await callers[fb](opts);
        if (result) break;
      }
    }
  }
  return result;
}

async function buildMarketData(symbol) {
  try {
    const [raw1D, raw4H, raw1H, liveTicker] = await Promise.all([
      getCandles(symbol, '1day', 62),
      getCandles(symbol, '4h',  100),
      getCandles(symbol, '1h',  100),
      getCurrentPrice(symbol).catch(() => null),
    ]);

    const PERIOD_MS = { '1day': 86400000, '4h': 14400000, '1h': 3600000 };

    const parse = (raw, livePrice, granularity = '1day') => {
      if (!Array.isArray(raw) || raw.length < 3) return null;
      const now         = Date.now();
      const periodMs    = PERIOD_MS[granularity] ?? 86400000;
      const periodStart = now - (now % periodMs);
      const closedCandles = raw
        .filter(c => parseInt(c[0]) < periodStart)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
      if (closedCandles.length < 22) return null;

      const lastClosed = closedCandles[closedCandles.length - 1];
      const prevClosed = closedCandles[closedCandles.length - 2];
      const currentPrice = livePrice ?? parseFloat(lastClosed[4]);
      const closes = closedCandles.map(c => parseFloat(c[4]));
      const highs  = closedCandles.map(c => parseFloat(c[2]));
      const lows   = closedCandles.map(c => parseFloat(c[3]));
      const vols   = closedCandles.map(c => parseFloat(c[5]));
      const lastClose = parseFloat(lastClosed[4]);
      const prevClose = parseFloat(prevClosed?.[4] ?? lastClosed[4]);
      const changePct = ((currentPrice - lastClose) / lastClose * 100).toFixed(2);

      return {
        currentPrice,
        lastClosedPrice: lastClose,
        open:   parseFloat(lastClosed[1]),
        high:   parseFloat(lastClosed[2]),
        low:    parseFloat(lastClosed[3]),
        close:  lastClose,
        volume: parseFloat(lastClosed[5]),
        prevClose,
        change: changePct,
        ema9:   calcEMA(closes, 9),
        ema21:  calcEMA(closes, 21),
        ema50:  calcEMA(closes, 50),
        rsi14:  calcRSI(closes, 14),
        macd:   calcMACD(closes),
        bb:     calcBollinger(closes),
        adx:    calcADX(highs, lows, closes, 14),
        high20: Math.max(...highs.slice(-20)),
        low20:  Math.min(...lows.slice(-20)),
        high5:  Math.max(...highs.slice(-5)),
        low5:   Math.min(...lows.slice(-5)),
        avgVol10: vols.slice(-11, -1).reduce((s, v) => s + v, 0) / 10,
        lastVol:  parseFloat(lastClosed[5]),
        candleCount: closedCandles.length,
      };
    };

    const d1  = parse(raw1D, liveTicker, '1day');
    const d4  = parse(raw4H, liveTicker, '4h');
    const d1h = parse(raw1H, liveTicker, '1h');

    if (d1 && d4 && d1h) {
      log('ai_analyst', `  Data: live=${liveTicker?.toFixed(4)} | 1D_ema21=${d1.ema21?.toFixed(4)} | 4H_ema21=${d4.ema21?.toFixed(4)} | 1H_ema21=${d1h.ema21?.toFixed(4)}`);
    }

    return { '1D': d1, '4H': d4, '1H': d1h };
  } catch (err) {
    log('ai_analyst_error', `Build market data ${symbol}: ${err.message}`);
    return null;
  }
}

function formatMarketData(symbol, md) {
  const fmt = (tf, d) => {
    if (!d) return `[${tf}]: Data tidak tersedia`;
    return [
      `[${tf}]`,
      `  Price (live)  : ${d.currentPrice} | Change dari last close: ${d.change}%`,
      `  Last Closed   : ${d.lastClosedPrice?.toFixed(6) ?? 'N/A'} | Candles: ${d.candleCount}`,
      `  EMA9   : ${d.ema9?.toFixed(6) ?? 'N/A'} | EMA21: ${d.ema21?.toFixed(6) ?? 'N/A'} | EMA50: ${d.ema50?.toFixed(6) ?? 'N/A'}`,
      `  RSI14  : ${d.rsi14?.toFixed(1) ?? 'N/A'}`,
      `  MACD   : ${d.macd ? `line=${d.macd.macd.toFixed(6)} signal=${d.macd.signal.toFixed(6)} hist=${d.macd.histogram.toFixed(6)}` : 'N/A'}`,
      `  BB     : ${d.bb ? `upper=${d.bb.upper.toFixed(6)} mid=${d.bb.middle.toFixed(6)} lower=${d.bb.lower.toFixed(6)} %B=${d.bb.pctB.toFixed(2)}` : 'N/A'}`,
      `  ADX    : ${d.adx ? `adx=${d.adx.adx.toFixed(1)} +DI=${d.adx.plusDI.toFixed(1)} -DI=${d.adx.minusDI.toFixed(1)}` : 'N/A'}`,
      `  H/L 20 : ${d.high20?.toFixed(6)} / ${d.low20?.toFixed(6)}`,
      `  H/L 5  : ${d.high5?.toFixed(6)} / ${d.low5?.toFixed(6)}`,
      `  Vol    : ${d.lastVol?.toFixed(0)} (avg10: ${d.avgVol10?.toFixed(0)}) ratio=${d.avgVol10 > 0 ? (d.lastVol / d.avgVol10).toFixed(2) : 'N/A'}x`,
    ].join('\n');
  };

  return [`SYMBOL: ${symbol}`, fmt('1D', md['1D']), fmt('4H', md['4H']), fmt('1H', md['1H'])].join('\n\n');
}

async function getSentimentAnalysis(symbol) {
  const coinName = symbol.replace('USDT', '');

  if (getProvider() === 'gemini' && process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'Analis sentimen crypto. Jawab Bahasa Indonesia, max 200 kata, faktual.' }] },
          contents: [{ role: 'user', parts: [{ text: `Cari sentimen market terkini ${coinName} (${symbol}): berita 7 hari terakhir, katalis positif/negatif, risiko utama.` }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { maxOutputTokens: 500, temperature: 0.2 },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) { log('ai_analyst', '  Sentimen via Google Search Grounding ✅'); return text.trim(); }
      }
    } catch {}
  }

  const result = await callAI({
    maxTokens:    400,
    systemPrompt: `Kamu analis sentimen crypto. Jawab Bahasa Indonesia, max 150 kata. Fokus: tren umum, sentimen komunitas, risiko utama ${coinName}.`,
    userPrompt:   `Analisa sentimen market terkini untuk ${coinName} (${symbol}). Sebutkan faktor bullish dan bearish yang relevan saat ini.`,
  });

  return result || `Data sentimen ${coinName} tidak tersedia saat ini.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Technical analysis — UT Bot Alert 4H
// ─────────────────────────────────────────────────────────────────────────────
async function getTechnicalAnalysis(symbol, marketDataStr, sentimentSummary) {

  const systemPrompt = `Kamu adalah AI Trading Analyst senior spesialis crypto spot trading.

KONTEKS STRATEGI:
Bot ini menggunakan satu screener: UT Bot Alert pada timeframe 4 jam (4H) — ATR Trailing Stop crossover.
- Sinyal BUY  : close candle 4H baru saja menembus ke ATAS trailing stop
- Sinyal SELL : close candle 4H baru saja menembus ke BAWAH trailing stop (untuk exit posisi)

TUGASMU — evaluasi apakah setup BUY ini LAYAK di-trade sekarang:

A. VALIDASI MOMENTUM
   - Apakah ada dukungan volume yang sehat (vol ratio > 1.5x avg)?
   - Apakah RSI sudah overbought (>75) atau masih ada ruang?
   - Apakah ini breakout genuine atau sekadar pump tanpa struktur?

B. VALIDASI UT BOT SIGNAL
   - Level trailing stop UTBot = area SL kandidat
   - Apakah jarak entry ke SL (trailing stop) masuk akal vs potensi upside?
   - Apakah EMA stack 4H/1H mendukung arah naik?

C. KONDISI TREND BESAR (1D)
   - Apakah trend harian mendukung (price > EMA21 1D)?
   - Apakah ini searah trend atau counter-trend?
   - Kalau counter-trend: lebih berisiko, confidence harus lebih rendah

D. LEVEL KRITIS
   - Resistance terdekat di atas (target realistis TP1)
   - Support kuat di bawah (konfirmasi area SL)
   - R:R minimal 1:2 dari entry ke SL vs entry ke TP1

ATURAN VERDICT:
- BUY_NOW : Volume sehat + RSI tidak overbought + trend 1D bullish + R:R ≥ 1:2 + UTBot signal valid
- WAIT    : Setup menarik tapi salah satu belum terpenuhi (misal RSI tinggi, tunggu pullback, atau volume kurang meyakinkan)
- SKIP    : RSI sudah sangat overbought (>80) ATAU volume tidak mendukung ATAU trend 1D bearish ATAU R:R < 1:1.5

KEMBALIKAN JSON VALID SAJA, tanpa teks lain:
{
  "verdict": "BUY_NOW" | "WAIT" | "SKIP",
  "confidence": <0-100>,
  "summary": "<harga live — 1-2 kalimat kondisi keseluruhan>",
  "momentum": {
    "volumeRatio": "<vol kemarin vs avg10 — contoh: 2.3x>",
    "rsiStatus": "<contoh: RSI 4H=62 — ruang masih ada>",
    "pumpOrBreakout": "<genuine breakout / pump tanpa struktur / belum jelas>"
  },
  "utbotSignal": {
    "slLevel": "<trailing stop level — ini SL kandidat>",
    "entryIdeal": "<area entry ideal berdasarkan harga sekarang>",
    "tp1Level": "<resistance terdekat berdasarkan high20 atau struktur 4H>",
    "rrRatio": "<R:R dihitung dari entry ke SL dan entry ke TP1>",
    "riskPct": "<(entry - SL) / entry * 100>"
  },
  "trendAlignment": {
    "daily": "BULLISH" | "NEUTRAL" | "BEARISH",
    "h4": "BULLISH" | "NEUTRAL" | "BEARISH",
    "h1": "BULLISH" | "NEUTRAL" | "BEARISH",
    "aligned": true | false,
    "note": "<penjelasan singkat apakah 3 TF searah atau tidak>"
  },
  "sentiment": {
    "overall": "BULLISH" | "NEUTRAL" | "BEARISH",
    "catalysts": "<faktor positif>",
    "risks": "<faktor risiko / potensi reversal>"
  },
  "keyLevels": {
    "currentPrice": "<harga live>",
    "resistance1": "<resistance terdekat di atas>",
    "support1": "<support kuat di bawah>",
    "criticalLevel": "<level penentu — biasanya EMA21 1D atau swing low>"
  },
  "recommendation": "<paragraf rekomendasi konkret: entry di mana, SL di mana, TP1 di mana, dan kondisi apa yang membatalkan setup>"
}`;

  const maxSentimentLen = 300;
  const trimmedSentiment = sentimentSummary.length > maxSentimentLen
    ? sentimentSummary.slice(0, maxSentimentLen) + '...'
    : sentimentSummary;

  const userPrompt = `Analisa trading setup UT Bot Alert 4H untuk ${symbol}:

=== DATA TEKNIKAL ===
${marketDataStr}

=== SENTIMEN MARKET ===
${trimmedSentiment}

INSTRUKSI:
1. Fokus pada validasi UTBot signal 4H — bukan analisa MTF SMC
2. SL diasumsikan di level trailing stop UTBot (terlihat dari data 4H low terbaru / low5)
3. TP1 berdasarkan resistance terdekat — pakai high20 4H atau high5 1H sebagai referensi
4. R:R WAJIB dihitung dari harga ENTRY (bukan harga live jika berbeda)
5. Semua field angka WAJIB diisi dengan nilai konkret dari data
6. Verdict WAIT jika setup menarik tapi butuh konfirmasi lebih, bukan langsung SKIP

Kembalikan JSON valid sesuai format.`;

  const raw = await callAI({ systemPrompt, userPrompt, maxTokens: 2000 });
  if (!raw) {
    log('ai_analyst_error', 'Model mengembalikan response kosong');
    return null;
  }

  const attempts = [
    () => JSON.parse(raw.trim()),
    () => JSON.parse(raw.replace(/```json|```/g, '').trim()),
    () => { const m = raw.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; },
    () => {
      const lines = raw.split('\n');
      const start = lines.findIndex(l => l.trim().startsWith('{'));
      if (start === -1) return null;
      return JSON.parse(lines.slice(start).join('\n').replace(/```/g, '').trim());
    },
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const result = attempts[i]();
      if (result && result.verdict) {
        if (i > 0) log('ai_analyst', `  JSON parsed dengan method ${i + 1}`);
        return result;
      }
    } catch {}
  }

  log('ai_analyst_error', `Parse JSON gagal. Raw (200 char): ${raw.slice(0, 200)}`);

  log('ai_analyst', '  Retry dengan prompt strict...');
  const raw2 = await callAI({
    systemPrompt,
    userPrompt: `Berikan HANYA JSON valid untuk analisa ${symbol}. ${userPrompt.slice(0, 400)}`,
    maxTokens: 1500,
  });
  if (raw2) {
    try {
      const m = raw2.match(/\{[\s\S]*\}/);
      const result = m ? JSON.parse(m[0]) : null;
      if (result?.verdict) { log('ai_analyst', '  ✅ Retry berhasil'); return result; }
    } catch {}
  }

  log('ai_analyst_error', 'Semua parse attempt gagal');
  return null;
}

export async function analyzeOnDemand(symbol) {
  if (!isAIEnabled()) {
    log('ai_analyst', `⚠ AI tidak aktif — provider: ${getProvider()}`);
    return null;
  }

  log('ai_analyst', `🤖 On-demand: ${symbol} [${getProvider()}/${getModelName()}]`);
  try {
    log('ai_analyst', `  Step 1: Fetch market data...`);
    const marketData = await buildMarketData(symbol);
    if (!marketData) {
      log('ai_analyst_error', `  ❌ Market data gagal untuk ${symbol}`);
      return null;
    }
    log('ai_analyst', `  ✅ Market data OK`);

    const marketDataStr = formatMarketData(symbol, marketData);

    log('ai_analyst', `  Step 2: Fetch sentiment...`);
    const sentiment = await getSentimentAnalysis(symbol);
    log('ai_analyst', `  ✅ Sentiment OK`);

    log('ai_analyst', `  Step 3: Technical analysis...`);
    const analysis = await getTechnicalAnalysis(symbol, marketDataStr, sentiment);

    if (!analysis) {
      log('ai_analyst_error', `  ❌ Analisa gagal`);
      return null;
    }

    log('ai_analyst', `  ✅ Selesai: ${analysis.verdict} (${analysis.confidence}%)`);
    return analysis;

  } catch (err) {
    log('ai_analyst_error', `analyzeOnDemand ${symbol}: ${err.message}`);
    return null;
  }
}

export async function analyzeCandidate(candidate) {
  return analyzeOnDemand(candidate.symbol);
}

export function getAIStatus() {
  return {
    enabled:  isAIEnabled(),
    provider: getProvider(),
    model:    getModelName(),
    keySet: {
      openrouter: !!process.env.OPENROUTER_API_KEY,
      gemini:     !!process.env.GEMINI_API_KEY,
      claude:     !!process.env.ANTHROPIC_API_KEY,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// BATCH FILTER & RANKING — untuk kandidat hasil screening UT Bot
// ═════════════════════════════════════════════════════════════════════════════

// ── Simpan hasil ranking terakhir (memori + file) untuk dashboard ────────────
const RANK_FILE = path.join(__dirname, 'logs', 'last-ranking.json');
let _lastRanking = null;

try {
  if (fs.existsSync(RANK_FILE)) _lastRanking = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8'));
} catch {}

function saveLastRanking(data) {
  _lastRanking = data;
  try {
    fs.mkdirSync(path.dirname(RANK_FILE), { recursive: true });
    fs.writeFileSync(RANK_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log('ai_analyst_warn', `Gagal simpan last-ranking: ${err.message}`);
  }
}

export function getLastRanking() { return _lastRanking; }

function todayWIB() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' });
}

async function postJsonRetry(url, headers, body, tries = 2) {
  for (let i = 0; i <= tries; i++) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 429 && i < tries) {
      log('ai_analyst_warn', `Rate limit, retry dalam ${(i + 1) * 15}s...`);
      await sleep((i + 1) * 15000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error('rate limit');
}

/**
 * Panggil AI DENGAN akses web search.
 * Return { text, searched } — searched=false berarti fallback tanpa web (data tidak terverifikasi).
 */
async function callAIWithSearch({ systemPrompt, userPrompt, maxTokens = 900 }) {
  const provider = getProvider();
  try {
    if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
      const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const data  = await postJsonRetry(url, { 'Content-Type': 'application/json' }, {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
      });
      const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (text) return { text, searched: true };
    }

    if (provider === 'claude' && process.env.ANTHROPIC_API_KEY) {
      const data = await postJsonRetry('https://api.anthropic.com/v1/messages', {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      }, {
        model: getModelName(),
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (text) return { text, searched: true };
    }

    if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
      const data = await postJsonRetry('https://openrouter.ai/api/v1/chat/completions', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'X-Title': 'Bitget Trading Bot',
      }, {
        model: getModelName(),
        max_tokens: maxTokens,
        temperature: 0.2,
        plugins: [{ id: 'web', max_results: 5 }],
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      });
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return { text, searched: true };
    }
  } catch (err) {
    log('ai_analyst_error', `Search call (${provider}) gagal: ${err.message}`);
  }

  // Fallback tanpa web — hasil ditandai tidak terverifikasi
  const text = await callAI({ systemPrompt, userPrompt, maxTokens });
  return text ? { text, searched: false } : null;
}

function parseJsonLoose(raw) {
  if (!raw) return null;
  const tries = [
    () => JSON.parse(raw.trim()),
    () => JSON.parse(raw.replace(/```json|```/g, '').trim()),
    () => { const m = raw.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; },
  ];
  for (const t of tries) { try { const r = t(); if (r) return r; } catch {} }
  return null;
}

// ── Ringkasan teknikal singkat per kandidat ──────────────────────────────────
async function techSummary(c) {
  try {
    const md = await buildMarketData(c.symbol);
    const h4 = md?.['4H'], d1 = md?.['1D'];
    const riskPct = c.trailingStop && c.close ? ((c.close - c.trailingStop) / c.close * 100).toFixed(1) : 'N/A';
    const volRatio = h4?.avgVol10 > 0 ? (h4.lastVol / h4.avgVol10).toFixed(2) + 'x' : 'N/A';
    const d1Trend  = d1?.ema21 ? (d1.currentPrice > d1.ema21 ? 'di ATAS EMA21 1D' : 'di BAWAH EMA21 1D') : 'N/A';
    return `Close 4H ${c.close} | TrailStop ${c.trailingStop?.toFixed(6)} (jarak risiko ${riskPct}%) | ` +
           `RSI4H ${h4?.rsi14?.toFixed(1) ?? 'N/A'} | Vol4H ${volRatio} avg10 | Harga ${d1Trend} | ` +
           `Chg24h ${c.change24h ?? 'N/A'}% | Vol24h $${((c.vol24h || 0) / 1e6).toFixed(1)}M`;
  } catch {
    return `Close 4H ${c.close} | TrailStop ${c.trailingStop?.toFixed(6)} | (data teknikal tambahan gagal diambil)`;
  }
}

// ── Riset per koin: sentimen + token unlock ──────────────────────────────────
async function researchCoin(symbol) {
  const coin = symbol.replace('USDT', '');
  const systemPrompt =
`Kamu analis riset crypto. Hari ini: ${todayWIB()} (WIB).
Gunakan web search untuk data TERBARU. Jangan mengarang: jika tidak menemukan data, tulis "tidak ditemukan".
Jawab Bahasa Indonesia, MAKS 120 kata, format persis:
SENTIMEN: POSITIF|NETRAL|NEGATIF — <alasan + berita utama 7 hari terakhir, sebut tanggal>
UNLOCK: ADA|TIDAK_ADA|TIDAK_DITEMUKAN — <tanggal, jumlah token, % dari circulating supply, dalam 7 hari ke depan>
EVENT_LAIN: <listing/delisting, upgrade mainnet, hack, gugatan, burn, dll dalam 7 hari ke depan, atau "tidak ada">`;
  const userPrompt = `Riset ${coin} (${symbol}): berita & sentimen 7 hari terakhir, jadwal token unlock/vesting/emisi dalam 7 hari ke depan sejak hari ini, dan event penting lain yang bisa menekan atau mendorong harga.`;
  const r = await callAIWithSearch({ systemPrompt, userPrompt, maxTokens: 600 });
  if (!r) return { text: 'Riset gagal (tidak ada respons AI).', searched: false };
  return r;
}

// ── Riset makro (sekali per run) ─────────────────────────────────────────────
async function researchMacro() {
  const systemPrompt =
`Kamu analis makro untuk trader crypto. Hari ini: ${todayWIB()} (WIB).
Gunakan web search. Jangan mengarang; jika tidak yakin tulis "tidak ditemukan".
Jawab Bahasa Indonesia, MAKS 150 kata, format persis:
RISIKO_MAKRO: RENDAH|SEDANG|TINGGI
JADWAL: daftar event 7 hari ke depan (tanggal + jam WIB jika ada): FOMC/suku bunga, CPI, PPI, NFP/jobless claims, PCE, pidato Fed/ECB/BoJ, keputusan ETF crypto, event regulasi besar, dll
DAMPAK: 1-2 kalimat bagaimana event tsb bisa mempengaruhi crypto (volatilitas, arah)`;
  const userPrompt = `Apa jadwal makroekonomi dan event pasar global yang akan terjadi dalam 7 hari ke depan sejak hari ini dan berpotensi mempengaruhi pasar crypto?`;
  const r = await callAIWithSearch({ systemPrompt, userPrompt, maxTokens: 700 });
  return r || { text: 'Riset makro gagal.', searched: false };
}

/**
 * Filter + ranking kandidat.
 * @param {Array}  candidates  kandidat BUY (hasil screener UT Bot atau pending queue)
 * @param {object} opts        { delayMs, source }
 * @returns {Promise<null | {macro, results: Array}>}  results sudah terurut rank 1..N
 *   tiap item: { symbol, rank, score, decision, sentiment, unlockRisk, reason, searched }
 */
export async function rankCandidates(candidates, opts = {}) {
  if (!isAIEnabled() || !candidates?.length) return null;
  const delayMs = opts.delayMs ?? 4000;

  log('ai_analyst', `🧠 AI ranking ${candidates.length} kandidat [${getProvider()}/${getModelName()}]`);

  // 1) makro (sekali)
  const macro = await researchMacro();
  log('ai_analyst', `  ✅ Makro ${macro.searched ? '(web)' : '(TANPA web)'}`);

  // 2) per koin: teknikal + riset (sekuensial agar tidak kena rate limit)
  const blocks = [];
  for (const c of candidates) {
    const tech = await techSummary(c);
    const rs   = await researchCoin(c.symbol);
    log('ai_analyst', `  ✅ Riset ${c.symbol} ${rs.searched ? '(web)' : '(TANPA web)'}`);
    blocks.push({ symbol: c.symbol, tech, research: rs.text, searched: rs.searched });
    await sleep(delayMs);
  }

  // 3) ranking final (satu panggilan)
  const systemPrompt =
`Kamu manajer risiko untuk bot spot trading crypto. Hari ini: ${todayWIB()} (WIB).
Strategi bot: entry saat UT Bot Alert 4H memberi sinyal BUY, exit saat sinyal SELL atau SL. Holding bisa berhari-hari.
Tugas: nilai tiap kandidat berdasarkan DATA YANG DIBERIKAN (jangan menambah fakta sendiri), lalu urutkan dari yang paling layak dibeli.

ATURAN KEPUTUSAN:
- AVOID bila: sentimen NEGATIF kuat/berita buruk material (hack, delisting, gugatan, depeg), ATAU token unlock >=1% circulating supply dalam 7 hari, ATAU RSI4H >78 tanpa volume pendukung.
- WAIT bila: unlock kecil/dekat tapi belum material, sentimen netral dengan teknikal lemah, jarak risiko trailing stop >12%, atau data riset TIDAK_DITEMUKAN/tanpa web (unlockRisk=UNKNOWN).
- BUY bila: sentimen positif/netral-positif, tidak ada unlock material, teknikal mendukung.
- Jika RISIKO_MAKRO TINGGI: turunkan skor semua kandidat 10-20 poin dan jangan beri BUY pada koin berisiko tinggi/volatil.
- Skor 0-100 (gabungan sentimen 35%, risiko jadwal unlock/event 30%, teknikal 25%, makro 10%).
- Rank 1 = paling layak. Semua kandidat WAJIB muncul.

KEMBALIKAN JSON VALID SAJA:
{
  "macroRisk": "RENDAH"|"SEDANG"|"TINGGI",
  "macroSummary": "<1-2 kalimat ringkas jadwal makro yang relevan>",
  "ranking": [
    { "symbol": "XXXUSDT", "rank": 1, "score": 0-100, "decision": "BUY"|"WAIT"|"AVOID",
      "sentiment": "POSITIF"|"NETRAL"|"NEGATIF",
      "unlockRisk": "TIDAK_ADA"|"RENDAH"|"TINGGI"|"UNKNOWN",
      "reason": "<maks 25 kata, sebut faktor penentu>" }
  ]
}`;

  const userPrompt =
`=== MAKRO (7 hari ke depan) ===
${macro.text}${macro.searched ? '' : '\n[PERINGATAN: tanpa web search, tidak terverifikasi]'}

=== KANDIDAT (${blocks.length}) ===
${blocks.map((b, i) => `#${i + 1} ${b.symbol}${b.searched ? '' : ' [riset TANPA web — tidak terverifikasi]'}
TEKNIKAL: ${b.tech}
RISET: ${b.research}`).join('\n\n')}

Kembalikan JSON sesuai format.`;

  let parsed = parseJsonLoose(await callAI({ systemPrompt, userPrompt, maxTokens: 2500 }));
  if (!parsed?.ranking) {
    log('ai_analyst', '  Retry ranking...');
    parsed = parseJsonLoose(await callAI({ systemPrompt, userPrompt: 'HANYA JSON valid.\n\n' + userPrompt, maxTokens: 2500 }));
  }
  if (!parsed?.ranking?.length) {
    log('ai_analyst_error', 'Ranking AI gagal / JSON tidak valid');
    return null;
  }

  // Gabungkan: kandidat yang tidak dikembalikan AI → WAIT / UNKNOWN
  const bySym = new Map(parsed.ranking.map(r => [String(r.symbol).toUpperCase(), r]));
  const results = blocks.map(b => {
    const r = bySym.get(b.symbol) || {};
    return {
      symbol:     b.symbol,
      rank:       Number.isFinite(r.rank) ? r.rank : 999,
      score:      Number.isFinite(r.score) ? r.score : 0,
      decision:   ['BUY', 'WAIT', 'AVOID'].includes(r.decision) ? r.decision : 'WAIT',
      sentiment:  r.sentiment  || 'NETRAL',
      unlockRisk: r.unlockRisk || 'UNKNOWN',
      reason:     r.reason     || 'Tidak dinilai AI',
      searched:   b.searched,
    };
  }).sort((a, b) => a.rank - b.rank || b.score - a.score);

  results.forEach((r, i) => { r.rank = i + 1; }); // normalisasi rank 1..N
  log('ai_analyst', `  ✅ Ranking selesai: ${results.map(r => `${r.rank}.${r.symbol}(${r.decision}/${r.score})`).join(' ')}`);

  const output = {
    macro: { risk: parsed.macroRisk || '-', summary: parsed.macroSummary || '', searched: macro.searched },
    results,
  };

  // Simpan untuk dashboard
  saveLastRanking({
    at:       new Date().toISOString(),
    source:   opts.source || 'screening',
    provider: getProvider(),
    model:    getModelName(),
    ...output,
  });

  return output;
}
