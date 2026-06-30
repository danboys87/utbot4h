/**
 * Approval Queue
 */

import { log } from './logger.js';

const _queue = new Map();

let _onApprove  = null;
let _onApprove2 = null;
let _onExpire   = null;

export function setCallbacks({ onApprove, onApprove2, onExpire }) {
  _onApprove  = onApprove;
  _onApprove2 = onApprove2;
  _onExpire   = onExpire;
}

export function addToQueue(candidate, timeoutMin = 30) {
  const symbol    = candidate.symbol;
  const expiresAt = Date.now() + timeoutMin * 60 * 1000;

  if (_queue.has(symbol)) {
    log('approval', `${symbol} sudah ada di queue, skip`);
    return false;
  }

  _queue.set(symbol, {
    candidate,
    expiresAt,
    notified:   true,
    entry1Done: false,
    entry2Done: false,
  });
  log('approval', `${symbol} masuk queue, expired dalam ${timeoutMin} menit`);

  setTimeout(() => {
    if (_queue.has(symbol)) {
      log('approval', `⏰ ${symbol} expired tanpa konfirmasi`);
      _queue.delete(symbol);
      if (_onExpire) _onExpire(symbol);
    }
  }, timeoutMin * 60 * 1000);

  return true;
}

export async function approveCandidate(symbol) {
  const item = _queue.get(symbol);
  if (!item) return { ok: false, reason: `${symbol} tidak ada di queue atau sudah expired` };

  if (item.entry1Done) return { ok: false, reason: `Entry 1 ${symbol} sudah pernah dieksekusi` };

  log('approval', `✅ ${symbol} Entry 1 diapprove`);
  item.entry1Done = true;

  if (_onApprove) await _onApprove(item.candidate);

  if (item.entry2Done) {
    _queue.delete(symbol);
    log('approval', `${symbol} kedua entry selesai → hapus dari queue`);
    return { ok: true, done: true };
  }

  log('approval', `${symbol} Entry 1 done — Entry 2 masih tersedia di queue`);
  return { ok: true, done: false, remaining: 'entry2' };
}

export async function approveEntry2(symbol) {
  const item = _queue.get(symbol);
  if (!item) return { ok: false, reason: `${symbol} tidak ada di queue atau sudah expired` };

  if (item.entry2Done) return { ok: false, reason: `Entry 2 ${symbol} sudah pernah dieksekusi` };

  log('approval', `✅ ${symbol} Entry 2 diapprove`);
  item.entry2Done = true;

  if (_onApprove2) await _onApprove2(item.candidate);

  if (item.entry1Done) {
    _queue.delete(symbol);
    log('approval', `${symbol} kedua entry selesai → hapus dari queue`);
    return { ok: true, done: true };
  }

  log('approval', `${symbol} Entry 2 done — Entry 1 masih tersedia di queue`);
  return { ok: true, done: false, remaining: 'entry1' };
}

export async function approveAll(symbol, onApproveAll) {
  const item = _queue.get(symbol);
  if (!item) return { ok: false, reason: `${symbol} tidak ada di queue atau sudah expired` };

  _queue.delete(symbol);
  log('approval', `✅ ${symbol} Full position diapprove → hapus dari queue`);

  if (onApproveAll) await onApproveAll(item.candidate);

  return { ok: true, done: true };
}

export function skipCandidate(symbol) {
  const item = _queue.get(symbol);
  if (!item) return { ok: false, reason: `${symbol} tidak ada di queue atau sudah expired` };

  _queue.delete(symbol);
  log('approval', `⏭️  ${symbol} diskip`);
  return { ok: true };
}

export function getPendingQueue() {
  const now = Date.now();
  const result = [];
  for (const [symbol, item] of _queue.entries()) {
    const minsLeft = Math.max(0, Math.round((item.expiresAt - now) / 60000));
    result.push({
      symbol,
      candidate:  item.candidate,
      minsLeft,
      entry1Done: item.entry1Done,
      entry2Done: item.entry2Done,
    });
  }
  return result;
}

export function clearQueue() {
  _queue.clear();
}
