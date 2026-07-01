/**
 * Bitget Spot Trading Bot v4.0 — UTBot 4H Only
 * Entry point utama
 *
 * Screener aktif:
 *  - UT Bot Alert 4H: deteksi sinyal BUY dan SELL
 *    BUY  → masuk approval queue atau auto execute
 *    SELL → notifikasi saja (eksekusi via manager)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv  = require('dotenv');
dotenv.config();

import cron     from 'node-cron';
import readline from 'readline';
import { log }                from './logger.js';
import { config }             from './config.js';
import { testConnection, getCurrentPrice, getAllTickers } from './bitget.js';
import { runUTBotScreener }             from './screenerUTBot.js';
import { runManagementCycle }           from './manager.js';
import { executeBuy }                   from './executor.js';
import { getStats, getOpenSymbols, getAllPositions, initState } from './state.js';
import { initSymbolFilter } from './symbolFilter.js';
import {
  notifyStartup, notifyBuy,
  notifyScreening, notifyApprovalRequest,
  notifyStats, notifyError, notifyUTBot, notifyUTBotSell,
  isEnabled,
} from './telegram.js';
import { startTelegramPolling, stopTelegramPolling } from './telegramCommands.js';
import { startApiServer } from './apiServer.js';
import {
  addToQueue, setCallbacks, getPendingQueue,
  approveCandidate, skipCandidate,
} from './approvalQueue.js';

const isDryRun = process.env.DRY_RUN === 'true';
const args     = process.argv.slice(2);

let _utbotBusy  = false;
let _manageBusy = false;
let _cronTasks  = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function intervalToCron(minutes, offsetMin = 0) {
  if (minutes <= 0) minutes = 240;

  // Offset cuma masuk akal kalau interval >= 60 menit (align ke jam candle close)
  if (minutes < 60) return `*/${minutes} * * * *`;

  if (minutes === 60) return `${offsetMin} * * * *`;

  const hours = Math.floor(minutes / 60);
  return `${offsetMin} */${hours} * * *`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT ENTRY HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function executeBuyEntry1(candidate) {
  const maxPos = config.trading.maxOpenPositions;
  const open   = getOpenSymbols().length;
  if (open >= maxPos) {
    await notifyError(`⚠️ Slot penuh (${open}/${maxPos}). <b>${candidate.symbol}</b> tidak bisa dibeli.\n\nTunggu posisi lain closing.`);
    return;
  }
  const pct1    = (config.trading.splitEntry?.portion1Pct ?? 55) / 100;
  const budget1 = config.trading.budgetPerTrade * pct1;
  const result  = await executeBuy({ ...candidate, budget: budget1, entryPortion: 1 });
  if (result.success) {
    await notifyBuy({ symbol: candidate.symbol, price: result.entryPrice, quantity: result.quantity, budget: budget1, score: candidate.score, signals: candidate.signals, slPrice: candidate.slPrice, entryPortion: 1, zones: candidate.zones, strategy: candidate.strategy });
  } else {
    await notifyError(`Buy Entry1 ${candidate.symbol} gagal: ${result.error}`);
  }
}

async function executeBuyEntry2(candidate) {
  const pct2    = (config.trading.splitEntry?.portion2Pct ?? 45) / 100;
  const budget2 = config.trading.budgetPerTrade * pct2;
  const result  = await executeBuy({ ...candidate, budget: budget2, entryPortion: 2 });
  if (result.success) {
    await notifyBuy({ symbol: candidate.symbol, price: result.entryPrice, quantity: result.quantity, budget: budget2, score: candidate.score, signals: candidate.signals, slPrice: candidate.slPrice, entryPortion: 2, zones: candidate.zones, strategy: candidate.strategy });
  } else {
    await notifyError(`Buy Entry2 ${candidate.symbol} gagal: ${result.error}`);
  }
}

async function executeBuyAll(candidate) {
  const maxPos = config.trading.maxOpenPositions;
  const open   = getOpenSymbols().length;
  if (open >= maxPos) { await notifyError(`Slot penuh (${open}/${maxPos}). ${candidate.symbol} dilewati.`); return; }
  const result = await executeBuy({ ...candidate, entryPortion: 'all' });
  if (result.success) {
    await notifyBuy({ symbol: candidate.symbol, price: result.entryPrice, quantity: result.quantity, budget: config.trading.budgetPerTrade, score: candidate.score, signals: candidate.signals, slPrice: candidate.slPrice, entryPortion: 'all', zones: candidate.zones, strategy: candidate.strategy });
  } else {
    await notifyError(`Buy ALL ${candidate.symbol} gagal: ${result.error}`);
  }
}

setCallbacks({
  onApprove: executeBuyEntry1,
  onExpire:  (symbol) => log('approval', `⏰ ${symbol} expired tanpa konfirmasi`),
});

export { executeBuyEntry2, executeBuyAll };

// ─────────────────────────────────────────────────────────────────────────────
// SEND APPROVAL REQUESTS — support auto execute mode
// ─────────────────────────────────────────────────────────────────────────────
async function sendApprovalRequests(candidates) {
  const isAuto     = config.trading.autoExecute === true;
  const timeoutMin = config.trading.approvalTimeoutMin ?? 60;

  if (isAuto) {
    log('approval', `🤖 AUTO EXECUTE mode aktif — ${candidates.length} kandidat akan langsung dibeli`);
    for (const candidate of candidates) {
      log('approval', `🤖 Auto execute: ${candidate.symbol}`);
      await executeBuyAll(candidate);
      await sleep(500);
    }
  } else {
    for (const candidate of candidates) {
      const added = addToQueue(candidate, timeoutMin);
      if (added) await notifyApprovalRequest({ candidate, timeoutMin });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTBOT SCREENER — BUY + SELL
// ─────────────────────────────────────────────────────────────────────────────
export async function doUTBotScreener() {
  if (_utbotBusy) { log('cron', 'UTBot masih berjalan, skip'); return []; }
  _utbotBusy = true;
  try {
    log('screener', '📡 Menjalankan UT Bot Alert Screener (4H)...');
    const tickers = await getAllTickers();
    const signals = await runUTBotScreener(tickers);

    const buySignals  = signals.filter(s => s.signal === 'BUY');
    const sellSignals = signals.filter(s => s.signal === 'SELL');

    // ── Proses SELL signal (hanya notifikasi utk yang punya posisi terbuka) ─
if (sellSignals.length > 0) {
  const sellWithPosition = sellSignals.filter(s => s.hasPosition);
  const sellNoPosition   = sellSignals.filter(s => !s.hasPosition);

  if (sellNoPosition.length > 0) {
    log('utbot', `  Skip ${sellNoPosition.length} SELL (tidak ada posisi): ${sellNoPosition.map(s => s.symbol).join(', ')}`);
  }

  if (sellWithPosition.length > 0) {
    log('utbot', `  ${sellWithPosition.length} SELL signal (posisi terbuka) → kirim notifikasi`);
    await notifyUTBotSell(sellWithPosition);
  }
}
    // ── Proses BUY signal ─────────────────────────────────────────────────
    if (buySignals.length > 0) {
      const eligible = buySignals.filter(s => !s.hasPosition);
      const skipped  = buySignals.filter(s => s.hasPosition);

      if (skipped.length > 0) {
        log('utbot', `  Skip ${skipped.length} BUY (sudah punya posisi): ${skipped.map(s => s.symbol).join(', ')}`);
      }

      if (eligible.length > 0) {
        const openCount = getOpenSymbols().length;
        const maxPos    = config.trading.maxOpenPositions;
        const slotLeft  = maxPos - openCount;

        if (slotLeft <= 0) {
          log('utbot', `  Slot penuh (${openCount}/${maxPos}), BUY tidak diproses`);
          await notifyError(`📡 UT Bot: ${eligible.length} BUY signal tapi slot posisi penuh (${openCount}/${maxPos})`);
        } else {
          const toProcess = eligible.slice(0, slotLeft);
          const isAuto    = config.trading.autoExecute === true;
          log('utbot', `  ${toProcess.length} BUY signal → ${isAuto ? '🤖 auto execute' : 'approval queue'}`);
          if (!isAuto) await notifyUTBot(buySignals);
          await sendApprovalRequests(toProcess);
        }
      }
    }

    if (signals.length === 0) {
      log('utbot', '  Tidak ada sinyal UTBot saat ini');
    }

    await notifyScreening({
      found:    signals.length,
      total:    0,
      symbols:  signals.map(s => `${s.symbol}(${s.signal})`),
      strategy: 'UT Bot 4H',
      buyCount:  buySignals.length,
      sellCount: sellSignals.length,
    });

    return signals;
  } catch (err) {
    log('cron_error', `UTBot error: ${err.message}`);
    await notifyError(`UTBot error: ${err.message}`);
    return [];
  } finally {
    _utbotBusy = false;
  }
}

export async function doScreening() {
  return await doUTBotScreener();
}

// ─────────────────────────────────────────────────────────────────────────────
// MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
export async function doManagement() {
  if (_manageBusy) { log('cron', 'Management masih berjalan, skip'); return; }
  _manageBusy = true;
  try {
    await runManagementCycle();
  } catch (err) {
    log('cron_error', `Management error: ${err.message}`);
    await notifyError(`Management error: ${err.message}`);
  } finally {
    _manageBusy = false;
  }
}

export { approveCandidate, skipCandidate, getPendingQueue };

// ─────────────────────────────────────────────────────────────────────────────
// CRON
// ─────────────────────────────────────────────────────────────────────────────
function startCron() {
  stopCron();

  const manageMin = config.schedule?.managementIntervalMin    ?? 10;
  const utbotMin  = config.screening?.utbot?.checkIntervalMin ?? 240;

  const UTBOT_OFFSET_MIN = 5; // jalankan 5 menit setelah candle 4H close, biar data settle dulu

  const cronManage = intervalToCron(manageMin);
  const cronUtbot  = intervalToCron(utbotMin, UTBOT_OFFSET_MIN);

  log('cron', `Cron aktif:`);
  log('cron', `  UTBot 4H  : ${cronUtbot} → setiap ${utbotMin} menit`);
  log('cron', `  Management: ${cronManage} → setiap ${manageMin} menit`);

  const manageTask = cron.schedule(cronManage, doManagement);
  const utbotTask  = cron.schedule(cronUtbot, () => {
    log('cron', `  UTBot 4H  : ${cronUtbot} → setiap ${utbotMin} menit (offset +${UTBOT_OFFSET_MIN}m setelah candle close)`);
    doUTBotScreener();
  });

  _cronTasks = [manageTask, utbotTask];
}

function stopCron() {
  _cronTasks.forEach(t => t.stop());
  _cronTasks = [];
  stopTelegramPolling();
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS DISPLAY
// ─────────────────────────────────────────────────────────────────────────────
async function showStatus() {
  const stats     = getStats();
  const positions = getAllPositions();
  const pending   = getPendingQueue();
  const isAuto    = config.trading.autoExecute === true;

  console.log('\n══════════════════════════════════════');
  console.log('  📊 STATUS BOT v4.0 — UTBot 4H');
  console.log('══════════════════════════════════════');
  console.log(`  Mode     : ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE'}`);
  console.log(`  Entry    : ${isAuto ? '🤖 AUTO EXECUTE' : '✋ MANUAL APPROVE'}`);
  console.log(`  Open Pos : ${stats.openPositions}/${config.trading.maxOpenPositions}`);
  console.log(`  Closed   : ${stats.closedCount}`);
  console.log(`  Total PnL: ${stats.totalPnlUsdt >= 0 ? '+' : ''}${stats.totalPnlUsdt?.toFixed(2)} USDT`);

  if (pending.length > 0) {
    console.log(`\n  ⏳ Menunggu Approval (${pending.length}):`);
    for (const p of pending) {
      console.log(`    [UTBot 4H] ${p.symbol} — sisa ${p.minsLeft} menit`);
    }
  }

  if (stats.openPositions > 0) {
    console.log('\n  Posisi Terbuka:');
    for (const [symbol, pos] of Object.entries(positions)) {
      const currentPrice = await getCurrentPrice(symbol).catch(() => null);
      if (currentPrice) {
        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const sign   = pnlPct >= 0 ? '+' : '';
        const trail  = pos.trailingActive ? '|TRAIL' : '';
        console.log(`    ${symbol.padEnd(12)} entry=${pos.entryPrice} now=${currentPrice} PnL=${sign}${pnlPct.toFixed(2)}% [active${trail}]`);
      } else {
        console.log(`    ${symbol.padEnd(12)} entry=${pos.entryPrice}`);
      }
    }
  }
  console.log('══════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL
// ─────────────────────────────────────────────────────────────────────────────
function startREPL() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n[bitget-bot v4.0] > ' });
  console.log('\n📖 Perintah: status | utbot | screen | manage | stats | automode | stop | help\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const parts = line.trim().toLowerCase().split(/\s+/);
    const cmd   = parts[0];
    const arg   = parts[1];
    if (!cmd) { rl.prompt(); return; }
    switch (cmd) {
      case 'status':   await showStatus(); break;
      case 'utbot':
      case 'screen':   await doUTBotScreener(); break;
      case 'manage':   await doManagement(); break;
      case 'stats':    await notifyStats(getStats()); console.log('📊 Stats dikirim ke Telegram'); break;
      case 'automode': {
        const { saveConfig } = await import('./config.js');
        if (arg === 'on') {
          saveConfig({ trading: { autoExecute: true } });
          console.log('🤖 Auto Execute: ON — sinyal akan langsung dibeli');
        } else if (arg === 'off') {
          saveConfig({ trading: { autoExecute: false } });
          console.log('✋ Auto Execute: OFF — sinyal masuk approval queue');
        } else {
          console.log(`Auto Execute sekarang: ${config.trading.autoExecute ? '🤖 ON' : '✋ OFF'}`);
          console.log('Gunakan: automode on | automode off');
        }
        break;
      }
      case 'stop': console.log('🛑 Menghentikan bot...'); stopCron(); process.exit(0); break;
      case 'help':
        console.log([
          '',
          '  status        — posisi terbuka & PnL',
          '  utbot / screen— UTBot 4H screening (BUY + SELL)',
          '  manage        — cek TP/SL semua posisi',
          '  stats         — kirim ringkasan ke Telegram',
          '  automode on   — aktifkan auto execute (langsung beli)',
          '  automode off  — kembali ke manual approve',
          '  stop          — hentikan bot',
          '',
        ].join('\n')); break;
      default: console.log(`❓ Perintah tidak dikenal: "${cmd}". Ketik "help".`);
    }
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Bitget Spot Bot v4.0 — UT Bot Alert 4H         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Mode : ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}`);
  console.log(`  Entry: ${config.trading.autoExecute ? '🤖 AUTO EXECUTE' : '✋ MANUAL APPROVE'}`);
  console.log('');

  if (!isDryRun) {
    log('startup', 'Mengecek koneksi Bitget API...');
    const conn = await testConnection();
    if (!conn.ok) { log('startup_error', `Koneksi API gagal: ${conn.error}`); process.exit(1); }
    log('startup', `✅ Koneksi OK | ${conn.assets} aset ditemukan`);
  } else {
    log('startup', '🧪 DRY RUN mode - API connection skipped');
  }

  const cfg       = config;
  const pct1      = cfg.trading.splitEntry?.portion1Pct ?? 55;
  const pct2      = cfg.trading.splitEntry?.portion2Pct ?? 45;
  const manageMin = cfg.schedule?.managementIntervalMin ?? 10;
  const utbotMin  = cfg.screening?.utbot?.checkIntervalMin ?? 240;

  log('startup', `Config:`);
  log('startup', `  Budget/trade : ${cfg.trading.budgetPerTrade} USDT`);
  log('startup', `  Entry mode   : ${cfg.trading.autoExecute ? '🤖 AUTO EXECUTE (100%)' : `✋ MANUAL (E1 ${pct1}% / E2 ${pct2}%)`}`);
  log('startup', `  Max posisi   : ${cfg.trading.maxOpenPositions}`);
  log('startup', `  UTBot key    : ${cfg.screening?.utbot?.keyValue ?? 2}`);
  log('startup', `  UTBot ATR    : ${cfg.screening?.utbot?.atrPeriod ?? 10}`);
  log('startup', `Jadwal:`);
  log('startup', `  UTBot 4H   : setiap ${utbotMin} menit`);
  log('startup', `  Management : setiap ${manageMin} menit`);

  await notifyStartup(isDryRun);

  if (args.includes('--manage-only'))  { await doManagement();   process.exit(0); }
  if (args.includes('--utbot-only'))   { await doUTBotScreener(); process.exit(0); }
  if (args.includes('--screen-only'))  { await doUTBotScreener(); process.exit(0); }

  await initState();
  await initSymbolFilter();

  log('startup', 'Menjalankan management cycle pertama...');
  await doManagement();

  startCron();

  const approveEntry2Fn = (symbol) => {
    const q    = getPendingQueue();
    const item = q.find(p => p.symbol === symbol);
    if (!item) return { ok: false, reason: `${symbol} tidak ada di queue` };
    return executeBuyEntry2(item.candidate).then(() => ({ ok: true }));
  };

  const approveAllFn = (symbol) => {
    const q    = getPendingQueue();
    const item = q.find(p => p.symbol === symbol);
    if (!item) return { ok: false, reason: `${symbol} tidak ada di queue` };
    return executeBuyAll(item.candidate).then(() => ({ ok: true }));
  };

  startTelegramPolling({
    doScreening:      doUTBotScreener,
    doUTBotScreener,
    doManagement,
    approveCandidate,
    approveEntry2:    approveEntry2Fn,
    approveAll:       approveAllFn,
    skipCandidate,
    getPendingQueue,
    getAllPositions,
    getCurrentPrice,
    stopBot: () => { stopCron(); process.exit(0); },
  });

  startApiServer({
    doUTBotScreener,
    doScreening:   doUTBotScreener,
    doManagement,
    approveCandidate,
    approveEntry2:  approveEntry2Fn,
    approveAll:     approveAllFn,
    skipCandidate,
    getPendingQueue,
    getAllPositions,
    getCurrentPrice,
    executeBuyManual: async (symbol, opts = {}) => {
      const { executeBuy } = await import('./executor.js');
      const { split, slPrice, tp1Price, budget } = opts;
      const baseBudget  = budget || config.trading.budgetPerTrade;
      const p1 = (config.trading.splitEntry?.portion1Pct ?? 55) / 100;
      const p2 = (config.trading.splitEntry?.portion2Pct ?? 45) / 100;
      const finalBudget = split === 'entry1' ? baseBudget * p1 : split === 'entry2' ? baseBudget * p2 : baseBudget;
      return executeBuy({ symbol, score: 0, signals: {}, strategy: 'manual', budget: finalBudget, entryPortion: split === 'entry1' ? 1 : split === 'entry2' ? 2 : 'all', slPrice: slPrice || null, tp1Price: tp1Price || null });
    },
    executeSellManual: async (symbol, opts = {}) => {
      const { executeSell, executePartialSell } = await import('./executor.js');
      const pos = getAllPositions()[symbol];
      if (!pos) return { ok: false, error: 'Posisi tidak ditemukan' };
      const sellPct = opts.sellPct ?? 100;
      if (sellPct < 100) return executePartialSell(symbol, { sellPct, reason: 'manual_partial', position: pos });
      return executeSell(symbol, { quantity: pos.quantity, reason: 'manual_sell', position: pos });
    },
  });

  if (process.stdin.isTTY) {
    startREPL();
  } else {
    log('startup', 'Non-TTY mode - berjalan sebagai daemon');
  }
}

main().catch(err => { log('fatal', err.message); process.exit(1); });
