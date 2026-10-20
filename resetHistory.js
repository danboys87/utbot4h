/**
 * Reset History — kosongkan riwayat trade & PnL
 *
 * Cara pakai (HENTIKAN BOT DULU):
 *   node resetHistory.js              # hapus history, posisi terbuka tetap
 *   node resetHistory.js --all        # hapus history + semua posisi terbuka
 *   node resetHistory.js --yes        # lewati konfirmasi
 *   node resetHistory.js --keep-logs  # jangan hapus file di folder logs/
 *   node resetHistory.js --no-cloud   # jangan sentuh JSONBin
 *
 * Yang dibersihkan:
 *   1. state.json  -> closed = [], totalPnlUsdt = 0 (backup: state.backup.json)
 *   2. logs/trades-*.jsonl, bot-*.log, last-ranking.json
 *   3. JSONBin (jika JSONBIN_BIN_ID & JSONBIN_API_KEY diisi)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

import fs       from 'fs';
import path     from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args      = process.argv.slice(2);

const ALL       = args.includes('--all');
const YES       = args.includes('--yes');
const KEEP_LOGS = args.includes('--keep-logs');
const NO_CLOUD  = args.includes('--no-cloud');

// Sama persis dengan state.js
const STATE_FILE = process.env.RAILWAY_ENVIRONMENT
  ? '/tmp/state.json'
  : path.join(__dirname, 'state.json');
const LOG_DIR = path.join(__dirname, 'logs');

const BIN_ID  = process.env.JSONBIN_BIN_ID;
const API_KEY = process.env.JSONBIN_API_KEY;
const BIN_URL = 'https://api.jsonbin.io/v3/b';

const EMPTY = { positions: {}, closed: [], totalPnlUsdt: 0 };

function clean(state) {
  return {
    ...state,
    positions:    ALL ? {} : (state?.positions ?? {}),
    closed:       [],
    totalPnlUsdt: 0,
  };
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim().toLowerCase()); }));
}

// ── 1. state.json ────────────────────────────────────────────────────────────
function resetLocal() {
  let state = EMPTY;
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const backup = path.join(path.dirname(STATE_FILE), 'state.backup.json');
      fs.writeFileSync(backup, JSON.stringify(state, null, 2));
      console.log(`  💾 Backup: ${backup}`);
    } catch (e) {
      console.log(`  ⚠ state.json tidak terbaca (${e.message}), dibuat baru`);
    }
  }

  const nClosed = state.closed?.length ?? 0;
  const nPos    = Object.keys(state.positions ?? {}).length;
  const next    = clean(state);

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));

  console.log(`  ✅ state.json: ${nClosed} deal closed dihapus, PnL → 0`);
  console.log(`     Posisi terbuka: ${ALL ? `${nPos} dihapus` : `${nPos} dipertahankan`}`);
}

// ── 2. logs ──────────────────────────────────────────────────────────────────
function resetLogs() {
  if (KEEP_LOGS) { console.log('  ⏭  Folder logs dilewati (--keep-logs)'); return; }
  if (!fs.existsSync(LOG_DIR)) { console.log('  ℹ️  Folder logs tidak ada'); return; }

  const targets = fs.readdirSync(LOG_DIR).filter(f =>
    (f.startsWith('trades-') && f.endsWith('.jsonl')) ||
    (f.startsWith('bot-')    && f.endsWith('.log'))   ||
    f === 'last-ranking.json'
  );
  for (const f of targets) fs.unlinkSync(path.join(LOG_DIR, f));
  console.log(`  ✅ logs: ${targets.length} file dihapus`);
}

// ── 3. JSONBin ───────────────────────────────────────────────────────────────
async function resetCloud() {
  if (NO_CLOUD)             { console.log('  ⏭  JSONBin dilewati (--no-cloud)'); return; }
  if (!BIN_ID || !API_KEY)  { console.log('  ℹ️  JSONBin tidak dikonfigurasi, dilewati'); return; }

  try {
    const res  = await fetch(`${BIN_URL}/${BIN_ID}/latest`, { headers: { 'X-Master-Key': API_KEY } });
    const data = await res.json();
    const cloud = data?.record ?? EMPTY;
    const next  = clean(cloud);

    const put = await fetch(`${BIN_URL}/${BIN_ID}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': API_KEY },
      body:    JSON.stringify(next),
    });
    if (!put.ok) throw new Error(`HTTP ${put.status}: ${(await put.text()).slice(0, 150)}`);

    console.log(`  ✅ JSONBin: ${cloud.closed?.length ?? 0} deal closed dihapus, PnL → 0`);
    console.log(`     Posisi terbuka: ${ALL ? 'dihapus' : `${Object.keys(next.positions).length} dipertahankan`}`);
  } catch (e) {
    console.log(`  ❌ JSONBin gagal: ${e.message}`);
    console.log('     Kosongkan manual, kalau tidak state lama akan dimuat lagi saat bot start.');
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🧹 Reset History Bot');
  console.log('─'.repeat(50));
  console.log(`  Mode     : ${ALL ? '⚠️  RESET TOTAL (termasuk posisi terbuka)' : 'History saja (posisi terbuka dipertahankan)'}`);
  console.log(`  State    : ${STATE_FILE}`);
  console.log(`  Logs     : ${KEEP_LOGS ? 'dilewati' : LOG_DIR}`);
  console.log(`  JSONBin  : ${NO_CLOUD ? 'dilewati' : (BIN_ID && API_KEY ? 'ya' : 'tidak dikonfigurasi')}`);
  console.log('─'.repeat(50));
  console.log('  ⚠ Pastikan bot sudah DIHENTIKAN, kalau tidak state akan tertimpa lagi.\n');

  if (!YES) {
    const a = await ask('Lanjut? (y/N): ');
    if (a !== 'y' && a !== 'yes') { console.log('Dibatalkan.\n'); process.exit(0); }
  }

  console.log('');
  resetLocal();
  resetLogs();
  await resetCloud();

  console.log('\n✅ Selesai. Jalankan ulang bot: npm run dev\n');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
