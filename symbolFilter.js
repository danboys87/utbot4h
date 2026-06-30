/**
 * Symbol Filter — Crypto Spot Only
 */

import { log } from './logger.js';

const SYMBOLS_URL    = 'https://api.bitget.com/api/v2/spot/public/symbols';
const CACHE_TTL_MS   = 6 * 60 * 60 * 1000;

let _cryptoSymbols   = new Set();
let _lastFetch       = 0;
let _fetchPromise    = null;

async function fetchAndCache() {
  try {
    const res  = await fetch(SYMBOLS_URL);
    const data = await res.json();

    if (data.code !== '00000' || !Array.isArray(data.data)) {
      throw new Error(`API error: ${data.msg}`);
    }

    const cryptoSet = new Set();
    let totalRwa    = 0;

    for (const s of data.data) {
      if (s.areaSymbol === 'no') {
        cryptoSet.add(s.symbol);
      } else {
        totalRwa++;
      }
    }

    _cryptoSymbols = cryptoSet;
    _lastFetch     = Date.now();

    log('symbol_filter', `✅ Symbol cache updated: ${cryptoSet.size} crypto spot, ${totalRwa} non-crypto (tokenized/RWA) difilter`);
    return true;

  } catch (err) {
    log('symbol_filter', `⚠ Gagal fetch symbols: ${err.message} — pakai cache lama (${_cryptoSymbols.size} entries)`);
    return false;
  }
}

async function ensureCache() {
  const stale = Date.now() - _lastFetch > CACHE_TTL_MS;

  if (_cryptoSymbols.size > 0 && !stale) return;

  if (_fetchPromise) {
    await _fetchPromise;
    return;
  }

  _fetchPromise = fetchAndCache().finally(() => { _fetchPromise = null; });
  await _fetchPromise;
}

export function isCryptoSpot(symbol) {
  if (_cryptoSymbols.size === 0) return true;
  return _cryptoSymbols.has(symbol);
}

export async function initSymbolFilter() {
  log('symbol_filter', 'Memuat daftar symbol crypto spot dari Bitget...');
  await fetchAndCache();
}

export async function filterCryptoOnly(tickers) {
  await ensureCache();

  if (_cryptoSymbols.size === 0) {
    log('symbol_filter', '⚠ Cache kosong, tidak bisa filter — semua ticker dikembalikan');
    return tickers;
  }

  const before  = tickers.length;
  const filtered = tickers.filter(t => _cryptoSymbols.has(t.symbol));
  const removed  = before - filtered.length;

  if (removed > 0) {
    log('symbol_filter', `Filter: ${before} → ${filtered.length} ticker (${removed} non-crypto dibuang)`);
  }

  return filtered;
}
