/**
 * Manager — TP/SL Management
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
import { executeSell, executePartialSell } from './executor.js';
import { notifySell }       from './telegram.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getEffectiveSL(position, mgmt) {
  if (position.trailingActive) {
    return position.entryPrice * (1 + 0.01);   // breakeven + buffer 1% di ATAS entry
  }
  if (position.slPrice && position.slPrice > 0) {
    return position.slPrice;
  }
  const slPct = Math.abs(mgmt.stopLossPct ?? 4);
  return position.entryPrice * (1 - slPct / 100);
}

function getTP1Price(position, effectiveSL) {
  if (position.tp1Price && position.tp1Price > 0) {
    return position.tp1Price;
  }
  const riskPerUnit = position.entryPrice - effectiveSL;
  const minRR = config.management?.minRiskReward ?? 2;
  return position.entryPrice + riskPerUnit * minRR;
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

  const effectiveSL = getEffectiveSL(position, mgmt);

  if (currentPrice <= effectiveSL) {
    const slLabel = position.trailingActive ? 'Break Even' : 'Stop Loss';
    log('manager', `🛑 ${slLabel} hit: ${symbol} | price=${currentPrice} SL=${effectiveSL.toFixed(6)}`);

    const result = await executeSell(symbol, {
      quantity: position.quantity,
      reason:   position.trailingActive ? 'break_even_sl' : 'stop_loss',
      position,
    });

    if (result.success) {
      await notifySell({
        symbol,
        entryPrice: position.entryPrice,
        exitPrice:  result.exitPrice,
        pnlPct:     result.pnlPct,
        pnlUsdt:    result.pnlUsdt,
        reason:     position.trailingActive ? 'break_even_sl' : 'stop_loss',
      });
    }
    return;
  }

  const tp1Price = getTP1Price(position, effectiveSL);

  if (currentPrice >= tp1Price) {
    log('manager', `🎯 TP1 hit: ${symbol} | price=${currentPrice} TP1=${tp1Price.toFixed(6)} | Close 100%`);

    const result = await executeSell(symbol, {
      quantity: position.quantity,
      reason:   'take_profit',
      position,
    });

    if (result.success) {
      await notifySell({
        symbol,
        entryPrice: position.entryPrice,
        exitPrice:  result.exitPrice,
        pnlPct:     result.pnlPct,
        pnlUsdt:    result.pnlUsdt,
        reason:     'take_profit',
      });
      log('manager', `✅ TP1 done: ${symbol} closed 100% | PnL=${result.pnlPct?.toFixed(2)}%`);
    }
    return;
  }

  const activateAtPct = mgmt.trailingStop?.activateAtProfitPct ?? 4;
  if (!position.trailingActive && pnlPct >= activateAtPct) {
    log('manager', `🔻 Trailing aktif: ${symbol} | PnL=${pnlPct.toFixed(2)}% >= ${activateAtPct}% | SL geser ke BEP`);
    activateTrailing(symbol);
  }

  if (position.trailingActive) {
    const ts = mgmt.trailingStop;

    updatePeakPrice(symbol, currentPrice);

    const allPos = getAllPositions();
    const pos    = allPos[symbol];
    if (!pos) return;

    const trailPct     = ts?.trailPct ?? 2;
    const dropFromPeak = ((pos.peakPrice - currentPrice) / pos.peakPrice) * 100;

    if (dropFromPeak >= trailPct) {
      log('manager',
        `🔻 Trailing Stop: ${symbol} | drop ${dropFromPeak.toFixed(2)}% dari peak ${pos.peakPrice} ` +
        `(callback ${trailPct}%)`
      );

      const result = await executeSell(symbol, {
        quantity: pos.quantity,
        reason:   'trailing_stop',
        position: pos,
      });

      if (result.success) {
        await notifySell({
          symbol,
          entryPrice: pos.entryPrice,
          exitPrice:  result.exitPrice,
          pnlPct:     result.pnlPct,
          pnlUsdt:    result.pnlUsdt,
          reason:     'trailing_stop',
        });
      }
      return;
    }

    log('manager',
      `  Trailing aktif: peak=${pos.peakPrice} | drop=${dropFromPeak.toFixed(2)}% ` +
      `| trigger at ${trailPct}%`
    );
  }

  const maxHold = mgmt.maxHoldHours ?? 72;
  if (holdHours >= maxHold) {
    log('manager', `⏰ Max hold: ${symbol} sudah ${holdHours.toFixed(1)} jam`);

    const result = await executeSell(symbol, {
      quantity: position.quantity,
      reason:   'max_hold_time',
      position,
    });

    if (result.success) {
      await notifySell({
        symbol,
        entryPrice: position.entryPrice,
        exitPrice:  result.exitPrice,
        pnlPct:     result.pnlPct,
        pnlUsdt:    result.pnlUsdt,
        reason:     'max_hold_time',
      });
    }
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
