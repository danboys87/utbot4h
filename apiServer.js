/**
 * API Server — Dashboard REST Endpoints (UTBot 4H)
 * Dijalankan bersamaan dengan bot (port terpisah, default 3000)
 */

import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';
import { log }           from './logger.js';
import { getCurrentPrice } from './bitget.js';
import {
  getStats, getAllPositions, getOpenSymbols,
  hasPosition, getClosedPositions,
} from './state.js';
import { config, saveConfig } from './config.js';
import { getEffectiveSL } from './manager.js';
import { analyzeOnDemand, getAIStatus, isAIEnabled, rankCandidates, getLastRanking } from './aiAnalyst.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = parseInt(process.env.DASHBOARD_PORT || '3000');
const API_SECRET = process.env.DASHBOARD_SECRET || '';

let _callbacks = {};
export function setApiCallbacks(cb) { _callbacks = cb; }

// State ranking manual (dijalankan di background, dashboard polling)
let _rankRunning = false;
let _rankError   = null;

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,X-Secret',
  });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 400) {
  json(res, { ok: false, error: msg }, status);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!API_SECRET) return true;
  return req.headers['x-secret'] === API_SECRET;
}

function tailLog(lines = 100) {
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const logFile = path.join(__dirname, 'logs', `bot-${today}.log`);
    if (!fs.existsSync(logFile)) return [];
    const content = fs.readFileSync(logFile, 'utf8');
    return content.trim().split('\n').slice(-lines);
  } catch { return []; }
}

function getClosedTrades() {
  try {
    const dir = path.join(__dirname, 'logs');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.startsWith('trades-') && f.endsWith('.jsonl')).sort().reverse();
    const trades = [];
    for (const f of files.slice(0, 7)) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
      for (const l of lines) {
        try { trades.push(JSON.parse(l)); } catch {}
      }
    }
    return trades.sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 200);
  } catch { return []; }
}

// Jalankan ranking untuk kandidat di pending queue (background)
async function runRankOnPending() {
  _rankRunning = true;
  _rankError   = null;
  try {
    const pending = _callbacks.getPendingQueue?.() ?? [];
    const cands   = pending.map(p => p.candidate).filter(Boolean);
    if (!cands.length) { _rankError = 'Tidak ada kandidat di pending queue'; return; }

    const aiCfg  = config.ai ?? {};
    const batch  = cands.slice(0, aiCfg.maxCandidates ?? 10);
    const ranked = await rankCandidates(batch, { delayMs: aiCfg.researchDelayMs ?? 4000, source: 'manual (pending queue)' });
    if (!ranked) { _rankError = 'Ranking AI gagal (cek Bot Logs)'; return; }

    // Tempel hasil ke kandidat (objek yang sama dengan di queue)
    const bySym = new Map(batch.map(c => [c.symbol, c]));
    for (const r of ranked.results) {
      const c = bySym.get(r.symbol);
      if (!c) continue;
      c.aiRank = r.rank;
      c.aiAnalysis = {
        verdict:    r.decision === 'BUY' ? 'BUY_NOW' : r.decision === 'WAIT' ? 'WAIT' : 'SKIP',
        confidence: r.score,
        summary:    `#${r.rank} ${r.reason} (sentimen ${r.sentiment}, unlock ${r.unlockRisk})`,
      };
    }
  } catch (e) {
    _rankError = e.message;
    log('ai_analyst_error', `runRankOnPending: ${e.message}`);
  } finally {
    _rankRunning = false;
  }
}

async function handle(req, res) {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const route  = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Secret' });
    res.end(); return;
  }

  if (method === 'POST' && !checkAuth(req)) {
    err(res, 'Unauthorized', 401); return;
  }

  // ── GET /api/status ────────────────────────────────────────────────────────
  if (route === '/api/status' && method === 'GET') {
    const stats     = getStats();
    const positions = getAllPositions();
    const pending   = _callbacks.getPendingQueue?.() ?? [];

    const enriched = {};
    for (const [sym, pos] of Object.entries(positions)) {
      const price = await getCurrentPrice(sym).catch(() => null);
      const pnlPct  = price ? ((price - pos.entryPrice) / pos.entryPrice * 100) : null;
      const pnlUsdt = price ? ((price - pos.entryPrice) * pos.quantity) : null;
      const hasBEP  = pos.partialSells?.some(ps => ps.reason === 'tp1_partial');
      enriched[sym] = { ...pos, currentPrice: price, pnlPct, pnlUsdt, hasBEP, effectiveSL: getEffectiveSL(pos, config.management) };
    }

    json(res, {
      ok: true,
      stats,
      positions: enriched,
      pending: pending.map(p => ({
        symbol:      p.symbol,
        minsLeft:    p.minsLeft,
        triggered:   p.candidate.triggered,
        strategy:    p.candidate.strategy,
        lastPrice:   p.candidate.lastPrice,
        change24h:   p.candidate.change24h,
        vol24h:      p.candidate.vol24h,
        slPrice:     p.candidate.slPrice,
        zones:       p.candidate.zones,
        signals:     p.candidate.signals,
        aiRank:      p.candidate.aiRank,
        aiVerdict:   p.candidate.aiAnalysis?.verdict,
        aiConfidence:p.candidate.aiAnalysis?.confidence,
        aiSummary:   p.candidate.aiAnalysis?.summary,
        aiAnalysis:  p.candidate.aiAnalysis,
      })),
      config: {
        budgetPerTrade:    config.trading.budgetPerTrade,
        maxOpenPositions:  config.trading.maxOpenPositions,
        takeProfitPct:     config.management.takeProfitPct,
        stopLossPct:       config.management.stopLossPct,
        trailPct:          config.management.trailingStop.trailPct,
        trailActivatePct:  config.management.trailingStop.activateAtProfitPct,
        isDryRun:          process.env.DRY_RUN === 'true',
        autoExecute:       config.trading.autoExecute === true,
        utbotKeyValue:     config.screening?.utbot?.keyValue,
        utbotAtrPeriod:    config.screening?.utbot?.atrPeriod,
        utbotIntervalMin:  config.screening?.utbot?.checkIntervalMin,
        aiEnabled:         isAIEnabled(),
        aiFilterEnabled:   config.ai?.filterEnabled === true,
        aiStatus:          (() => { try { return getAIStatus(); } catch { return null; } })(),
      },
      serverTime: new Date().toISOString(),
    });
    return;
  }

  // ── GET /api/ranking — hasil ranking AI terakhir ───────────────────────────
  if (route === '/api/ranking' && method === 'GET') {
    json(res, {
      ok:      true,
      running: _rankRunning,
      error:   _rankError,
      ranking: getLastRanking(),
    });
    return;
  }

  // ── POST /api/rank — jalankan ranking untuk pending queue (background) ─────
  if (route === '/api/rank' && method === 'POST') {
    if (!isAIEnabled()) { err(res, 'AI tidak aktif. Set API key provider di .env lalu restart bot.'); return; }
    if (_rankRunning)   { json(res, { ok: true, running: true, message: 'Ranking sedang berjalan' }); return; }
    const pending = _callbacks.getPendingQueue?.() ?? [];
    if (!pending.length) { err(res, 'Pending queue kosong. Ranking otomatis berjalan saat screening menemukan sinyal BUY.'); return; }
    runRankOnPending();
    json(res, { ok: true, running: true, message: `Ranking ${Math.min(pending.length, config.ai?.maxCandidates ?? 10)} kandidat dimulai` });
    return;
  }

  // ── GET /api/history ───────────────────────────────────────────────────────
  if (route === '/api/history' && method === 'GET') {
    json(res, { ok: true, trades: getClosedTrades() });
    return;
  }

  // ── GET /api/pnl — laporan PnL harian ──────────────────────────────────────
  if (route === '/api/pnl' && method === 'GET') {
    const days   = Math.max(1, parseInt(url.searchParams.get('days') || '30'));
    const since  = Date.now() - days * 86400000;
    const feePct = config.trading?.feePct ?? 0.1;   // estimasi fee per sisi (%)
    const trades = getClosedPositions()
      .filter(t => t.closedAt && new Date(t.closedAt).getTime() >= since)
      .map(t => {
        const buyVal  = t.entryPrice * t.quantity;
        const sellVal = t.exitPrice  * t.quantity;
        const fee     = (buyVal + sellVal) * feePct / 100;
        const net     = (t.pnlUsdt ?? (sellVal - buyVal)) - fee;
        return {
          symbol:     t.symbol,
          entryPrice: t.entryPrice,
          exitPrice:  t.exitPrice,
          quantity:   t.quantity,
          pnlPct:     buyVal > 0 ? (net / buyVal) * 100 : 0,
          pnlUsdt:    net,
          fee,
          reason:     t.reason,
          manual:     String(t.reason || '').startsWith('manual'),
          openedAt:   t.openedAt,
          closedAt:   t.closedAt,
        };
      })
      .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
    json(res, { ok: true, days, feePct, trades });
    return;
  }

  // ── GET /api/logs ──────────────────────────────────────────────────────────
  if (route === '/api/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('n') || '150');
    json(res, { ok: true, logs: tailLog(n) });
    return;
  }

  // ── GET /api/price/:symbol ─────────────────────────────────────────────────
  if (route.startsWith('/api/price/') && method === 'GET') {
    const symbol = route.split('/').pop().toUpperCase();
    const price  = await getCurrentPrice(symbol).catch(() => null);
    json(res, { ok: true, symbol, price });
    return;
  }

  // ── GET /api/config ────────────────────────────────────────────────────────
  if (route === '/api/config' && method === 'GET') {
    json(res, { ok: true, config });
    return;
  }

  // ── POST /api/config ───────────────────────────────────────────────────────
  if (route === '/api/config' && method === 'POST') {
    const body = await readBody(req);
    try {
      saveConfig(body);
      json(res, { ok: true, message: 'Config tersimpan', config });
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/approve ──────────────────────────────────────────────────────
  if (route === '/api/approve' && method === 'POST') {
    const { symbol, type = 'entry1' } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try {
      let result;
      if (type === 'entry2')   result = await _callbacks.approveEntry2?.(symbol);
      else if (type === 'all') result = await _callbacks.approveAll?.(symbol);
      else                     result = await _callbacks.approveCandidate?.(symbol);
      json(res, result ?? { ok: false, error: 'Callback tidak tersedia' });
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/skip ─────────────────────────────────────────────────────────
  if (route === '/api/skip' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    const result = _callbacks.skipCandidate?.(symbol) ?? { ok: false };
    json(res, result);
    return;
  }

  // ── POST /api/buy ──────────────────────────────────────────────────────────
  if (route === '/api/buy' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    if (!_callbacks.executeBuyManual) { err(res, 'Buy callback tidak tersedia'); return; }
    try {
      const result = await _callbacks.executeBuyManual(symbol);
      json(res, result);
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/sell ─────────────────────────────────────────────────────────
  if (route === '/api/sell' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    if (!_callbacks.executeSellManual) { err(res, 'Sell callback tidak tersedia'); return; }
    try {
      const result = await _callbacks.executeSellManual(symbol);
      json(res, result);
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/screen ───────────────────────────────────────────────────────
  if (route === '/api/screen' && method === 'POST') {
    json(res, { ok: true, message: `UTBot 4H screening dimulai di background` });
    _callbacks.doUTBotScreener?.().catch(() => {});
    return;
  }

  // ── POST /api/analyze ──────────────────────────────────────────────────────
  if (route === '/api/analyze' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    if (!isAIEnabled()) { err(res, `AI tidak aktif. Set OPENROUTER_API_KEY, GEMINI_API_KEY, atau ANTHROPIC_API_KEY di .env sesuai AI_PROVIDER, lalu restart bot.`); return; }
    try {
      const analysis = await analyzeOnDemand(symbol.toUpperCase());
      json(res, { ok: true, symbol, analysis });
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/manage ───────────────────────────────────────────────────────
  if (route === '/api/manage' && method === 'POST') {
    json(res, { ok: true, message: 'Management cycle dimulai' });
    _callbacks.doManagement?.().catch(() => {});
    return;
  }

  // ── POST /webhook/tradingview ──────────────────────────────────────────────
  if (route === '/webhook/tradingview' && method === 'POST') {
    const webhookSecret = process.env.WEBHOOK_SECRET || '';
    if (webhookSecret) {
      const headerSecret = req.headers['x-webhook-secret'];
      const querySecret  = new URL(req.url, `http://localhost`).searchParams.get('secret');
      if (headerSecret !== webhookSecret && querySecret !== webhookSecret) {
        err(res, 'Unauthorized', 401);
        log('webhook', `⛔ Webhook ditolak — secret tidak valid`);
        return;
      }
    }

    const body = await readBody(req);
    const { ticker, action, price, time, strategy } = body;

    if (!ticker || !action) {
      err(res, 'ticker dan action wajib ada');
      return;
    }

    const symbol    = ticker.toUpperCase().includes('USDT') ? ticker.toUpperCase() : `${ticker.toUpperCase()}USDT`;
    const actionUp  = action.toUpperCase();

    log('webhook', `📡 TradingView signal: ${actionUp} ${symbol} @ ${price} | strategy=${strategy || '-'}`);

    if (actionUp === 'BUY') {
      const openPos = getOpenSymbols();
      const maxPos  = config.trading.maxOpenPositions;

      if (openPos.includes(symbol)) {
        const msg = `⚠️ Sudah ada posisi ${symbol}, skip BUY signal`;
        log('webhook', msg);
        json(res, { ok: false, reason: msg });
        _callbacks.notifyWebhook?.({ symbol, action: 'BUY', price, strategy, skipped: true, reason: 'already_open' });
        return;
      }

      if (openPos.length >= maxPos) {
        const msg = `⚠️ Slot penuh (${openPos.length}/${maxPos}), skip BUY ${symbol}`;
        log('webhook', msg);
        json(res, { ok: false, reason: msg });
        _callbacks.notifyWebhook?.({ symbol, action: 'BUY', price, strategy, skipped: true, reason: 'slot_full' });
        return;
      }

      json(res, { ok: true, message: `BUY ${symbol} dieksekusi` });
      _callbacks.executeWebhookBuy?.({ symbol, price, strategy }).catch(e => {
        log('webhook_error', `BUY ${symbol} gagal: ${e.message}`);
      });
      return;
    }

    if (actionUp === 'SELL') {
      const positions = getAllPositions();
      if (!positions[symbol]) {
        const msg = `⚠️ Tidak ada posisi ${symbol}, skip SELL signal`;
        log('webhook', msg);
        json(res, { ok: false, reason: msg });
        _callbacks.notifyWebhook?.({ symbol, action: 'SELL', price, strategy, skipped: true, reason: 'no_position' });
        return;
      }

      json(res, { ok: true, message: `SELL ${symbol} dieksekusi` });
      _callbacks.executeWebhookSell?.({ symbol, price, strategy }).catch(e => {
        log('webhook_error', `SELL ${symbol} gagal: ${e.message}`);
      });
      return;
    }

    err(res, `action tidak dikenal: ${action}. Gunakan BUY atau SELL`);
    return;
  }

  json(res, { ok: false, error: 'Route tidak ditemukan' }, 404);
}

export function startApiServer(callbacks) {
  setApiCallbacks(callbacks);
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); }
    catch (e) { err(res, e.message, 500); }
  });
  server.listen(PORT, () => {
    log('api_server', `✅ Dashboard API berjalan di http://localhost:${PORT}`);
    log('api_server', `   Buka dashboard.html di browser dan set API URL ke http://localhost:${PORT}`);
  });
  return server;
}
