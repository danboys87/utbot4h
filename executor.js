/**
 * Executor
 * Eksekusi order beli/jual ke Bitget Spot API.
 *
 * v4.3: SL awal posisi = trailing stop UT Bot (candidate.slPrice) bila management.slMode = 'utbot'.
 */
import { placeOrder, getOrder, getAssetBalance, getCurrentPrice } from './bitget.js';
import { config }    from './config.js';
import { log }       from './logger.js';
import { logTrade }  from './logger.js';
import { openPosition, closePosition as closePos, recordPartialSell } from './state.js';

const isDryRun = process.env.DRY_RUN === 'true';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getQtyDecimals(price) {
  if (price >= 10000) return 6;
  if (price >= 100)   return 4;
  if (price >= 1)     return 2;
  return 2;
}

async function calcQuantity(symbol, budget) {
  const price = await getCurrentPrice(symbol);
  if (!price || price <= 0) throw new Error(`Harga tidak valid untuk ${symbol}`);

  const decimals   = getQtyDecimals(price);
  const multiplier = Math.pow(10, decimals);
  const qty        = Math.floor((budget / price) * multiplier) / multiplier;
  return { price, qty };
}

// ── SL dari UT Bot ───────────────────────────────────────────────────────────
function useUtbotSL() {
  return (config.management?.slMode ?? 'utbot') === 'utbot';
}

/**
 * Tentukan SL posisi. Mengembalikan null bila slMode bukan 'utbot' atau slPrice tidak ada
 * (manager lalu memakai fallback stopLossPct).
 * maxSlPct (opsional, 0 = nonaktif): batasi jarak SL maksimal dari entry.
 */
function resolveSL(entryPrice, slPrice) {
  if (!useUtbotSL() || !slPrice || slPrice <= 0 || slPrice >= entryPrice) return null;
  const cap = config.management?.maxSlPct ?? 0;
  if (cap > 0) return Math.max(slPrice, entryPrice * (1 - cap / 100));
  return slPrice;
}

export async function executeBuy(candidate) {
  const { symbol, score, signals, slPrice, tp1Price } = candidate;
  const budget = candidate.budget || config.trading.budgetPerTrade;

  try {
    log('executor', `Mencoba beli ${symbol} | budget=${budget} USDT`);

    const { price: currentPrice, qty } = await calcQuantity(symbol, budget);

    if (qty <= 0) {
      log('executor_error', `Quantity tidak valid untuk ${symbol}`);
      return { success: false, error: 'Quantity <= 0' };
    }

    // Harga sudah turun di bawah SL UT Bot sejak sinyal → setup batal, jangan beli
    if (useUtbotSL() && slPrice && currentPrice <= slPrice) {
      const msg = `Harga ${currentPrice} sudah di bawah SL UT Bot ${slPrice.toFixed(6)} — beli dibatalkan`;
      log('executor_error', `${symbol}: ${msg}`);
      return { success: false, error: msg };
    }

    if (isDryRun) {
      const sl = resolveSL(currentPrice, slPrice);
      log('executor', `[DRY RUN] BUY ${symbol} qty=${qty} @ ${currentPrice} | SL=${sl ? sl.toFixed(6) : 'fallback'}`);
      openPosition({
        symbol,
        entryPrice: currentPrice,
        quantity:   qty,
        orderId:    `dryrun_${Date.now()}`,
        budget,
        score,
        signals,
        slPrice:    sl,
        tp1Price:   tp1Price ?? null,
      });
      logTrade({ side: 'buy', symbol, qty, price: currentPrice, reason: 'dry-run' });
      return { success: true, entryPrice: currentPrice, quantity: qty, orderId: 'dry-run', slPrice: sl };
    }

    const usdtBalance = await getAssetBalance('USDT');
    const available   = parseFloat(usdtBalance?.available || 0);
    const needed      = budget + config.trading.gasReserve;

    if (available < needed) {
      log('executor_error', `Saldo USDT tidak cukup: ${available} < ${needed}`);
      return { success: false, error: 'Saldo tidak cukup' };
    }

    const order = await placeOrder({
      symbol,
      side:      'buy',
      orderType: 'market',
      size:      budget,
      quoteMode: true,
    });

    const orderId = order?.orderId;
    if (!orderId) throw new Error('Tidak ada orderId dari API');

    await sleep(1500);
    const orderDetail = await getOrder(orderId, symbol).catch(() => null);
    const fillPrice   = orderDetail ? parseFloat(orderDetail.priceAvg || orderDetail.fillPrice || currentPrice) : currentPrice;
    const fillQty     = orderDetail ? parseFloat(orderDetail.baseVolume || orderDetail.fillSize || qty) : qty;
    const sl          = resolveSL(fillPrice, slPrice);

    openPosition({
      symbol,
      entryPrice: fillPrice,
      quantity:   fillQty,
      orderId,
      budget,
      score,
      signals,
      slPrice:    sl,
      tp1Price:   tp1Price ?? null,
    });

    logTrade({ side: 'buy', symbol, qty: fillQty, price: fillPrice, reason: 'screening' });
    log('executor', `✅ BUY ${symbol} | qty=${fillQty} @ ${fillPrice} | SL=${sl ? sl.toFixed(6) : 'fallback'} | orderId=${orderId}`);

    return { success: true, entryPrice: fillPrice, quantity: fillQty, orderId, slPrice: sl };

  } catch (err) {
    log('executor_error', `Beli ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export async function executeSell(symbol, { quantity, reason, position }) {
  try {
    log('executor', `Mencoba jual ${symbol} | qty=${quantity} | reason=${reason}`);

    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) throw new Error(`Tidak bisa ambil harga ${symbol}`);

    if (isDryRun) {
      log('executor', `[DRY RUN] SELL ${symbol} qty=${quantity} @ ${currentPrice}`);
      const closed = closePos(symbol, { exitPrice: currentPrice, reason });
      if (closed) {
        logTrade({ side: 'sell', symbol, qty: quantity, price: currentPrice, reason });
      }
      return {
        success: true,
        exitPrice: currentPrice,
        pnlPct:   closed?.pnlPct,
        pnlUsdt:  closed?.pnlUsdt,
      };
    }

    const baseAsset = symbol.replace('USDT', '');
    const tokenBal  = await getAssetBalance(baseAsset);
    const available = parseFloat(tokenBal?.available || 0);

    const rawQty  = Math.min(quantity, available);
    const sellQty = Math.floor(rawQty * 100) / 100;

    if (sellQty <= 0) {
      log('executor_error', `Saldo ${baseAsset} tidak cukup: ${available}`);
      return { success: false, error: 'Saldo token tidak cukup' };
    }

    const order = await placeOrder({
      symbol,
      side:      'sell',
      orderType: 'market',
      size:      sellQty,
    });

    const orderId = order?.orderId;
    await sleep(1500);
    const orderDetail = await getOrder(orderId, symbol).catch(() => null);
    const fillPrice   = orderDetail ? parseFloat(orderDetail.priceAvg || orderDetail.fillPrice || currentPrice) : currentPrice;

    const closed = closePos(symbol, { exitPrice: fillPrice, reason });
    logTrade({ side: 'sell', symbol, qty: sellQty, price: fillPrice, reason });

    log('executor', `✅ SELL ${symbol} | qty=${sellQty} @ ${fillPrice} | reason=${reason}`);

    return {
      success:   true,
      exitPrice: fillPrice,
      pnlPct:    closed?.pnlPct,
      pnlUsdt:   closed?.pnlUsdt,
    };

  } catch (err) {
    log('executor_error', `Jual ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export async function executePartialSell(symbol, { sellPct, reason, position }) {
  try {
    const sellQty = Math.floor(position.quantity * (sellPct / 100) * 10000) / 10000;
    if (sellQty <= 0) return { success: false, error: 'Partial qty terlalu kecil' };

    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) throw new Error('Harga tidak valid');

    log('executor', `Partial sell ${symbol}: ${sellPct}% (${sellQty}) @ ${currentPrice} | reason=${reason}`);

    if (isDryRun) {
      recordPartialSell(symbol, { sellQty, price: currentPrice, reason });
      logTrade({ side: 'sell', symbol, qty: sellQty, price: currentPrice, reason: `partial-${reason}` });
      return { success: true, exitPrice: currentPrice, qty: sellQty };
    }

    const baseAsset = symbol.replace('USDT', '');
    const tokenBal  = await getAssetBalance(baseAsset);
    const available = parseFloat(tokenBal?.available || 0);

    const rawActual = Math.min(sellQty, available);
    const actualQty = Math.floor(rawActual * 100) / 100;

    if (actualQty <= 0) return { success: false, error: 'Saldo tidak cukup untuk partial' };

    const order = await placeOrder({
      symbol,
      side:      'sell',
      orderType: 'market',
      size:      actualQty,
    });

    await sleep(1500);
    const orderDetail = await getOrder(order?.orderId, symbol).catch(() => null);
    const fillPrice   = orderDetail ? parseFloat(orderDetail.priceAvg || currentPrice) : currentPrice;

    recordPartialSell(symbol, { sellQty: actualQty, price: fillPrice, reason });
    logTrade({ side: 'sell', symbol, qty: actualQty, price: fillPrice, reason: `partial-${reason}` });

    return { success: true, exitPrice: fillPrice, qty: actualQty };

  } catch (err) {
    log('executor_error', `Partial sell ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}
