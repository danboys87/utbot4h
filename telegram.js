/**
 * Telegram Notifications — v4.0 UTBot 4H
 */
import { log } from './logger.js';
import { getAIStatus } from './aiAnalyst.js';
import { config } from './config.js';

const getToken  = () => process.env.TELEGRAM_BOT_TOKEN;
const getChatId = () => process.env.TELEGRAM_CHAT_ID;
const getBase   = () => { const t = getToken(); return t ? `https://api.telegram.org/bot${t}` : null; };

export function isEnabled() { return !!(getToken() && getChatId()); }

async function send(text) {
  if (!isEnabled()) return;
  try {
    await fetch(`${getBase()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: getChatId(), text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    log('telegram_error', `Gagal kirim: ${err.message}`);
  }
}

async function sendLong(text) {
  const LIMIT = 4000;
  if (text.length <= LIMIT) { await send(text); return; }
  const lines = text.split('\n');
  let chunk   = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > LIMIT) {
      await send(chunk);
      chunk = line;
      await new Promise(r => setTimeout(r, 300));
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) await send(chunk);
}

function sanitize(text) {
  if (!text) return '—';
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/‑/g, '-').replace(/–/g, '-').replace(/—/g, '-')
    .replace(/'/g, "'").replace(/"/g, '"').replace(/"/g, '"')
    .trim();
}

function buildConfBar(pct) {
  const f = Math.round((pct / 100) * 10);
  return '█'.repeat(f) + '░'.repeat(10 - f);
}

// ── BUY Notification ─────────────────────────────────────────────────────────
export async function notifyBuy({ symbol, price, quantity, budget, score, signals, slPrice, entryPortion, zones, strategy }) {
  const portionLabel =
      entryPortion === 1    ? '📌 Entry 1/2 — 55% posisi'
    : entryPortion === 2    ? '📌 Entry 2/2 — 45% posisi'
    : entryPortion === 'all'? '📌 Full Entry — 100% posisi'
    : '';

  const slPct     = slPrice ? ((slPrice - price) / price * 100) : null;
  const slDisplay = slPrice
    ? `${slPrice.toFixed(6)} (${slPct > 0 ? '⚠️ SL di atas entry!' : slPct.toFixed(2) + '%'})`
    : '-';

  const signalLines = Object.entries(signals || {})
    .filter(([, v]) => v?.bullish)
    .map(([, v]) => `• ${v.label}`)
    .join('\n');

  const trailPct = config.management?.trailingStop?.trailPct ?? 2;
  const tpPct    = config.management?.takeProfitPct ?? 8;

  const lines = [
    `🟢 <b>BUY Executed</b> — 📡 UT Bot Alert 4H`,
    portionLabel,
    ``,
    `Pair  : <b>${symbol}</b>`,
    `Entry : ${price}`,
    `SL    : ${slDisplay}`,
    `TP    : +${tpPct}% → Close 100% posisi`,
    `Trail : ${trailPct}% callback (aktif jika profit ≥ ${config.management?.trailingStop?.activateAtProfitPct ?? 4}%)`,
    signalLines ? `\n${signalLines}` : '',
    ``,
    `📦 Qty: ${quantity} | Budget: ${budget} USDT`,
  ].filter(l => l !== '').join('\n');

  await send(lines);
}

// ── Approval Request ──────────────────────────────────────────────────────────
export async function notifyApprovalRequest({ candidate, timeoutMin }) {
  const c         = candidate;
  const signalLines = Object.entries(c.signals || {})
    .filter(([, v]) => v?.bullish)
    .map(([, v]) => `  • ${v.label}`)
    .join('\n');

  const slLine = c.slPrice ? `SL Ref   : ${c.slPrice.toFixed(6)}` : '';

  const lines = [
    `🔔 <b>Kandidat BUY Ditemukan!</b> — 📡 UT Bot Alert 4H`,
    ``,
    `Pair     : <b>${c.symbol}</b>`,
    `Harga    : ${c.lastPrice}`,
    `Vol 24h  : $${(c.vol24h / 1e6).toFixed(1)}M`,
    ``,
    signalLines ? `<b>✅ Sinyal:</b>\n${signalLines}` : '',
    slLine,
    ``,
    `<b>Perintah:</b>`,
    `/approve ${c.symbol}    → Entry 1 (55%)`,
    `/approve2 ${c.symbol}   → Entry 2 (45%)`,
    `/approveall ${c.symbol} → Full position`,
    `/analyze ${c.symbol}    → AI Analyst`,
    `/skip ${c.symbol}       → Lewati`,
    ``,
    `⏰ Expired dalam ${timeoutMin} menit`,
  ].filter(l => l !== null && l !== undefined).join('\n');

  await sendLong(lines);
}

// ── UTBot BUY Notification (ringkasan) ───────────────────────────────────────
export async function notifyUTBot(signals) {
  if (!signals?.length) return;
  const buySignals = signals.filter(s => s.signal === 'BUY');
  if (!buySignals.length) return;

  const fmt = (s) => {
    const pos = s.hasPosition ? ' <b>[POSISI OPEN]</b>' : '';
    const vol  = s.vol24h ? ` | Vol $${(s.vol24h/1e6).toFixed(1)}M` : '';
    return [
      `🟢 <b>${s.symbol}</b>${pos}${vol}`,
      `   Price : ${s.close}`,
      `   Trail : ${s.trailingStop?.toFixed(6)}`,
      `   ATR   : ${s.atr?.toFixed(6)}`,
    ].join('\n');
  };

  const lines = [
    `📡 <b>UT Bot 4H — BUY Signal</b>`,
    `Key: ${config?.screening?.utbot?.keyValue ?? 2} | ATR: ${config?.screening?.utbot?.atrPeriod ?? 10}`,
    ``,
    ...buySignals.map(fmt),
    ``,
    `<i>/analyze SYMBOL untuk AI second opinion sebelum approve</i>`,
  ];
  await sendLong(lines.join('\n'));
}

// ── UTBot SELL Notification ───────────────────────────────────────────────────
export async function notifyUTBotSell(signals) {
  if (!signals?.length) return;
  const sellSignals = signals.filter(s => s.signal === 'SELL');
  if (!sellSignals.length) return;

  const fmt = (s) => {
    const hasPos = s.hasPosition;
    const posTag = hasPos ? ' ⚠️ <b>[POSISI OPEN — pertimbangkan exit!]</b>' : '';
    const vol    = s.vol24h ? ` | Vol $${(s.vol24h/1e6).toFixed(1)}M` : '';
    return [
      `🔴 <b>${s.symbol}</b>${posTag}${vol}`,
      `   Price : ${s.close}`,
      `   Trail : ${s.trailingStop?.toFixed(6)}`,
      `   ATR   : ${s.atr?.toFixed(6)}`,
      hasPos ? `   <i>→ Manager akan handle exit via SL/TP</i>` : '',
    ].filter(Boolean).join('\n');
  };

  const lines = [
    `📡 <b>UT Bot 4H — SELL Signal</b>`,
    `Key: ${config?.screening?.utbot?.keyValue ?? 2} | ATR: ${config?.screening?.utbot?.atrPeriod ?? 10}`,
    ``,
    ...sellSignals.map(fmt),
    ``,
    `<i>ℹ️ SELL signal hanya notifikasi. Exit posisi dikelola oleh manager (TP/SL/Trailing).</i>`,
    `<i>Untuk exit manual: /sell SYMBOL</i>`,
  ];
  await sendLong(lines.join('\n'));
}

// ── AI Analysis Report ────────────────────────────────────────────────────────
export function formatAIAnalysis(symbol, analysis) {
  if (!analysis) return `⚠️ AI analisa untuk <b>${symbol}</b> tidak tersedia.`;

  const vEmoji = { BUY_NOW: '🟢', WAIT: '🟡', SKIP: '🔴' }[analysis.verdict] ?? '⚪';
  const bar    = buildConfBar(analysis.confidence);
  const sEmoji = { BULLISH: '🟢', NEUTRAL: '🟡', BEARISH: '🔴' }[analysis.sentiment?.overall] ?? '⚪';
  const tEmoji = (t) => ({ BULLISH: '🟢', NEUTRAL: '🟡', BEARISH: '🔴' }[t] ?? '⚪');

  const lines = [
    `🤖 <b>AI Analyst Report</b> — ${symbol}`,
    ``,
    `${vEmoji} <b>VERDICT: ${analysis.verdict}</b>`,
    `📊 Confidence: ${bar} ${analysis.confidence}%`,
    ``,
    `📝 <b>Summary</b>`,
    sanitize(analysis.summary),
    ``,
    `🚀 <b>Validasi Momentum</b>`,
    `• Volume    : ${sanitize(analysis.momentum?.volumeRatio)}`,
    `• RSI Status: ${sanitize(analysis.momentum?.rsiStatus)}`,
    `• Karakter  : ${sanitize(analysis.momentum?.pumpOrBreakout)}`,
    ``,
    `📡 <b>UT Bot Signal</b>`,
    `• SL (Trail): ${sanitize(analysis.utbotSignal?.slLevel)}  (risk ${sanitize(analysis.utbotSignal?.riskPct)})`,
    `• Entry     : ${sanitize(analysis.utbotSignal?.entryIdeal)}`,
    `• TP1       : ${sanitize(analysis.utbotSignal?.tp1Level)}`,
    `• R:R       : ${sanitize(analysis.utbotSignal?.rrRatio)}`,
    ``,
    `📈 <b>Trend Alignment</b> ${analysis.trendAlignment?.aligned ? '✅ Searah' : '⚠️ Tidak searah'}`,
    `• 1D: ${tEmoji(analysis.trendAlignment?.daily)} ${analysis.trendAlignment?.daily ?? '-'}`,
    `• 4H: ${tEmoji(analysis.trendAlignment?.h4)} ${analysis.trendAlignment?.h4 ?? '-'}`,
    `• 1H: ${tEmoji(analysis.trendAlignment?.h1)} ${analysis.trendAlignment?.h1 ?? '-'}`,
    `• ${sanitize(analysis.trendAlignment?.note)}`,
    ``,
    `${sEmoji} <b>Sentiment: ${analysis.sentiment?.overall ?? '-'}</b>`,
    `• Katalis+ : ${sanitize(analysis.sentiment?.catalysts)}`,
    `• Risiko   : ${sanitize(analysis.sentiment?.risks)}`,
    ``,
    `🎯 <b>Key Levels</b>`,
    `• Harga    : ${sanitize(analysis.keyLevels?.currentPrice)}`,
    `• Resist 1 : ${sanitize(analysis.keyLevels?.resistance1)}`,
    `• Support 1: ${sanitize(analysis.keyLevels?.support1)}`,
    `• Kritis   : ${sanitize(analysis.keyLevels?.criticalLevel)}`,
    ``,
    `💡 <b>Rekomendasi</b>`,
    sanitize(analysis.recommendation),
  ];

  if (analysis.verdict === 'BUY_NOW') {
    lines.push(``, `<b>→ Aksi:</b>`, `/approve ${symbol}`, `/approve2 ${symbol}`, `/approveall ${symbol}`);
  } else if (analysis.verdict === 'WAIT') {
    lines.push(``, `<i>Jalankan /analyze ${symbol} lagi saat kondisi berubah.</i>`);
  }

  return lines.join('\n');
}

export async function notifyAIAnalysis(symbol, analysis) {
  const msg = formatAIAnalysis(symbol, analysis);
  await sendLong(msg);
}

// ── SELL Notification ─────────────────────────────────────────────────────────
export async function notifySell({ symbol, entryPrice, exitPrice, pnlPct, pnlUsdt, reason }) {
  const emoji = pnlPct >= 0 ? '🟢' : '🔴';
  const sign  = pnlPct >= 0 ? '+' : '';
  const labels = {
    take_profit:   '🎯 Take Profit — Close 100%',
    stop_loss:     '🛑 Stop Loss',
    break_even_sl: '🔁 Break Even SL',
    trailing_stop: '🔻 Trailing Stop',
    max_hold_time: '⏰ Max Hold Time',
    manual_sell:   '🖐 Manual Sell',
  };
  const extra = reason === 'break_even_sl' ? `\n✅ Modal dilindungi`
    : reason === 'trailing_stop'           ? `\n📈 Profit diamankan via trailing`
    : '';
  await send(
    `${emoji} <b>SELL</b> ${symbol}\n` +
    `📌 ${labels[reason] || reason}\n` +
    `📈 Entry: ${entryPrice} → Exit: ${exitPrice}\n` +
    `💵 PnL: ${sign}${pnlPct?.toFixed(2)}% (${sign}${pnlUsdt?.toFixed(2)} USDT)` +
    extra
  );
}

// ── Screening Summary ─────────────────────────────────────────────────────────
export async function notifyScreening({ found, symbols, strategy, buyCount = 0, sellCount = 0 }) {
  if (found === 0) {
    await send(`🔍 <b>${strategy} Selesai</b>\n⚠️ Tidak ada sinyal.`);
    return;
  }
  const detail = buyCount > 0 || sellCount > 0
    ? `\n🟢 BUY: ${buyCount} | 🔴 SELL: ${sellCount}`
    : '';
  await send(`🔍 <b>${strategy} Selesai</b>\n✅ ${found} sinyal${detail}\nKoin: ${symbols.slice(0,10).join(', ')}`);
}

export async function notifyError(message) { await send(`⚠️ <b>Error</b>\n${message}`); }

function getAIInfo() {
  try {
    const s = getAIStatus();
    if (!s.enabled) return '⚠ tidak aktif (set API key di .env)';
    return `✅ ${s.provider} / ${s.model}`;
  } catch { return '—'; }
}

export async function notifyStartup(dryRun) {
  const cfg    = config;
  const utbMin = cfg.screening?.utbot?.checkIntervalMin ?? 240;
  await send(
    `🚀 <b>Bot v4.0 — UT Bot Alert 4H</b>\n` +
    `Mode: ${dryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}\n` +
    `📡 Screener : UTBot 4H (key=${cfg.screening?.utbot?.keyValue ?? 2} atr=${cfg.screening?.utbot?.atrPeriod ?? 10})\n` +
    `⏰ Interval : setiap ${utbMin} menit\n` +
    `🤖 AI Analyst : ${getAIInfo()} (manual via /analyze)\n` +
    `Time: ${new Date().toLocaleString('id-ID')}`
  );
}

export async function notifyStats({ openPositions, closedCount, totalPnlUsdt }) {
  const sign = totalPnlUsdt >= 0 ? '+' : '';
  await send(`📊 <b>Status Bot</b>\n📂 Posisi terbuka: ${openPositions}\n✅ Total closed: ${closedCount}\n💰 Total PnL: ${sign}${totalPnlUsdt?.toFixed(2)} USDT`);
}

// Legacy compat
export async function notifyApprovalEntry2({ candidate, timeoutMin }) {
  const z = candidate.zones?.[0];
  if (!z) return;
  await send(
    `📦 <b>Approval Entry 2</b>\n\nPair: <b>${candidate.symbol}</b>\n\n` +
    `/approve2 ${candidate.symbol} — Entry 2 (45%)\n/skip ${candidate.symbol} — Lewati\n\n⏰ ${timeoutMin} menit`
  );
}
