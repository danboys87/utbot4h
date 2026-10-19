/**
 * Manager — SL / Trailing Management
 *
 * Aturan (v4.3):
 *  1. SL awal   : slPrice dari UT Bot (trailing stop - buffer). Bila tidak ada → fallback stopLossPct.
 *  2. Profit ≥ activateAtProfitPct (10%) → trailing aktif: SL naik ke entry +1%,
 *     lalu exit bila harga turun trailPct (2%) dari peak.
 *  3. TP tetap HANYA bila management.useFixedTP = true (default false, supaya trailing bisa jalan).
 *  4. Exit karena sinyal SELL UT Bot ditangani di index.js (exitOnUTBotSell).
 *  5. Max hold.
 */

import { getCurrentPrice }  from './bitget.js';
import { config }           from './config.js';
import { log }              from './logger.js';
import {
  getAllPositions,
  getOpenSymbols,
  updatePeakPrice,
  activateTrailing,
} from './state.js';
import { executeSell }      from './executor.js';
import { notifySell }       from './telegram.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function getEffectiveSL(position, mgmt) {
  if (position.trailingActive) {
    return position.entryPrice * (1 + 0.01);   // breakeven + buffer 1% di ATAS entry
  }
  // SL dari UT Bot (hanya valid bila di bawah entry)
  if (position.slPrice && position.slPrice > 0 && position.slPrice < position.entryPrice) {
    return position.slPrice;
  }
  const slPct = Math.abs(mgmt.stopLossPct ?? 4);
  return position.entryPrice * (1 - slPct / 100);
}

function getFixedTPPrice(position, mgmt) {
  if (mgmt.useFixedTP !== true) return null;
  if (position.tp1Price && position.tp1Price > 0) return position.tp1Price;
  return position.entryPrice * (1 + (mgmt.takeProfitPct ?? 10) / 100);
}

async function closeWith(symbol, position, reason) {
  const result = await executeSell(symbol, { quantity: position.quantity, reason, position });
  if (result.success) {
    await notifySell({
      symbol,
      entryPrice: position.entryPrice,
      exitPrice:  result.exitPrice,
      pnlPct:     result.pnlPct,
      pnlUsdt:    result.pnlUsdt,
      reason,
    });
  }
  return result;
}

async function evaluatePosition(symbol, position) {
  const mgmt = config.management;

  const currentPrice = await getCurrentPrice(symbol);
  if (!currentPrice) {
    log('manager_warn', `Tidak bisa ambil harga ${symbol}, skip`);
    return;
  }

  const pnlPct    = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / 3_600_000;

  log('manager',
    `${symbol} | price=${currentPrice} entry=${position.entryPrice} ` +
    `PnL=${pnlPct.toFixed(2)}% | hold=${holdHours.toFixed(1)}h | ` +
    `trailing=${position.trailingActive ? 'ON' : 'off'}`
  );

  // ── 1. Stop Loss (UT Bot) / Break Even (setelah trailing aktif) ───────────
  const effectiveSL = getEffectiveSL(position, mgmt);

  if (currentPrice <= effectiveSL) {
    const slLabel = position.trailingActive ? 'Break Even' : 'Stop Loss';
    log('manager', `🛑 ${slLabel} hit: ${symbol} | price=${currentPrice} SL=${effectiveSL.toFixed(6)}`);
    await closeWith(symbol, position, position.trailingActive ? 'break_even_sl' : 'stop_loss');
    return;
  }

  // ── 2. Take Profit tetap (opsional, default OFF) ──────────────────────────
  const tpPrice = getFixedTPPrice(position, mgmt);
  if (tpPrice && currentPrice >= tpPrice) {
    log('manager', `🎯 TP hit: ${symbol} | price=${currentPrice} TP=${tpPrice.toFixed(6)} | Close 100%`);
    await closeWith(symbol, position, 'take_profit');
    return;
  }

  // ── 3. Aktifkan trailing saat profit ≥ threshold ──────────────────────────
  const activateAtPct = mgmt.trailingStop?.activateAtProfitPct ?? 10;
  if (mgmt.trailingStop?.enabled !== false && !position.trailingActive && pnlPct >= activateAtPct) {
    log('manager', `🔻 Trailing aktif: ${symbol} | PnL=${pnlPct.toFixed(2)}% >= ${activateAtPct}% | SL geser ke entry +1%`);
    activateTrailing(symbol);
  }

  // ── 4. Trailing stop dari peak ────────────────────────────────────────────
  const fresh = getAllPositions()[symbol];
  if (fresh?.trailingActive) {
    updatePeakPrice(symbol, currentPrice);

    const pos = getAllPositions()[symbol];
    if (!pos) return;

    const trailPct     = mgmt.trailingStop?.trailPct ?? 2;
    const dropFromPeak = ((pos.peakPrice - currentPrice) / pos.peakPrice) * 100;

    if (dropFromPeak >= trailPct) {
      log('manager',
        `🔻 Trailing Stop: ${symbol} | drop ${dropFromPeak.toFixed(2)}% dari peak ${pos.peakPrice} ` +
        `(callback ${trailPct}%)`
      );
      await closeWith(symbol, pos, 'trailing_stop');
      return;
    }

    log('manager',
      `  Trailing aktif: peak=${pos.peakPrice} | drop=${dropFromPeak.toFixed(2)}% ` +
      `| trigger at ${trailPct}%`
    );
  }

  // ── 5. Max hold ───────────────────────────────────────────────────────────
  const maxHold = mgmt.maxHoldHours ?? 72;
  if (maxHold > 0 && holdHours >= maxHold) {
    log('manager', `⏰ Max hold: ${symbol} sudah ${holdHours.toFixed(1)} jam`);
    await closeWith(symbol, getAllPositions()[symbol] ?? position, 'max_hold_time');
  }
}

export async function runManagementCycle() {
  const symbols = getOpenSymbols();

  if (symbols.length === 0) {
    log('manager', 'Tidak ada posisi terbuka');
    return;
  }

  log('manager', `Mengevaluasi ${symbols.length} posisi...`);
  const positions = getAllPositions();

  for (const symbol of symbols) {
    const position = positions[symbol];
    if (!position) continue;

    try {
      await evaluatePosition(symbol, position);
    } catch (err) {
      log('manager_error', `Error evaluasi ${symbol}: ${err.message}`);
    }

    await sleep(300);
  }

  log('manager', 'Siklus management selesai');
}
