/**
 * State Sync — JSONBin.io
 */

import { log } from './logger.js';

const BIN_ID  = process.env.JSONBIN_BIN_ID;
const API_KEY = process.env.JSONBIN_API_KEY;
const BASE    = 'https://api.jsonbin.io/v3/b';

const MAX_CLOSED_RECORDS = 50;

function isConfigured() {
  return !!(BIN_ID && API_KEY);
}

export async function loadFromCloud() {
  if (!isConfigured()) return null;

  try {
    const res  = await fetch(`${BASE}/${BIN_ID}/latest`, {
      headers: { 'X-Master-Key': API_KEY },
    });
    const data = await res.json();
    if (data?.record) {
      log('state', '☁️  State dimuat dari JSONBin');
      return data.record;
    }
  } catch (err) {
    log('state_error', `Gagal load dari JSONBin: ${err.message}`);
  }
  return null;
}

export async function saveToCloud(state) {
  if (!isConfigured()) return;

  try {
    const trimmed = { ...state };
    if (trimmed.closed && trimmed.closed.length > MAX_CLOSED_RECORDS) {
      trimmed.closed = trimmed.closed.slice(-MAX_CLOSED_RECORDS);
    }

    await fetch(`${BASE}/${BIN_ID}`, {
      method:  'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': API_KEY,
      },
      body: JSON.stringify(trimmed),
    });
  } catch (err) {
    log('state_error', `Gagal simpan ke JSONBin: ${err.message}`);
  }
}
