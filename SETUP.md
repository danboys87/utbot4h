# 🚀 Setup di GitHub Codespaces

## 1. Persiapan Repository

```bash
mkdir bitget-bot && cd bitget-bot
git init
git add .
git commit -m "initial bot setup"
```

Atau langsung push ke GitHub repo baru, lalu buka dengan Codespaces.

---

## 2. Struktur File

Pastikan semua file ini ada di root project:

```
bitget-bot/
├── .devcontainer/
│   └── devcontainer.json     ← untuk Codespaces auto-setup
├── .env                      ← rename dari _env (JANGAN commit!)
├── .gitignore                ← rename dari _gitignore
├── index.js
├── aiAnalyst.js
├── apiServer.js
├── approvalQueue.js
├── bitget.js
├── config.js
├── dashboard.html
├── executor.js
├── indicators.js
├── logger.js
├── manager.js
├── package.json
├── screenerUTBot.js
├── state.js
├── state.json
├── stateSync.js
├── symbolFilter.js
├── telegram.js
├── telegramCommands.js
├── addPosition.js
└── user-config.json
```

---

## 3. Setup .env

Rename `_env` → `.env` lalu isi:

```env
# Bitget API (dari Bitget → API Management)
BITGET_API_KEY=your_key
BITGET_SECRET_KEY=your_secret
BITGET_PASSPHRASE=your_passphrase

# Mode: true = simulasi, false = live
DRY_RUN=true

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# AI Analyst (pilih salah satu)
AI_PROVIDER=gemini
GEMINI_API_KEY=AIza...         # gratis di aistudio.google.com/apikey
GEMINI_MODEL=gemini-2.0-flash

# Dashboard
DASHBOARD_PORT=3000
```

> ⚠️ PENTING: tambahkan `.env` ke `.gitignore` agar API key tidak ter-commit!

---

## 4. Install & Run di Codespaces

```bash
# Install dependencies
npm install

# Test koneksi API Bitget
node testapi.js

# Jalankan bot (DRY RUN mode)
npm run dev

# Atau live trading
npm start
```

---

## 5. Akses Dashboard

Di Codespaces, setelah bot jalan:

1. Klik tab **PORTS** di bagian bawah VS Code
2. Port `3000` akan muncul → klik **Open in Browser**
3. Buka `dashboard.html` di browser lokal
4. Set API URL ke URL Codespaces port 3000:
   ```
   https://YOUR-CODESPACE-NAME-3000.app.github.dev
   ```

> ⚠️ Pastikan visibility port 3000 di-set ke **Public** (klik kanan di tab Ports)
> agar dashboard.html bisa mengaksesnya dari browser lokal.

---

## 6. Codespaces Secrets (Recommended)

Daripada simpan API key di `.env` file, gunakan **Codespaces Secrets**:

1. GitHub → Settings → Codespaces → Secrets → New secret
2. Tambahkan semua key:
   - `BITGET_API_KEY`
   - `BITGET_SECRET_KEY`
   - `BITGET_PASSPHRASE`
   - `GEMINI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. Secrets otomatis tersedia sebagai env variable saat Codespace dibuka
4. `.env` hanya perlu berisi setting non-secret:
   ```env
   DRY_RUN=true
   AI_PROVIDER=gemini
   GEMINI_MODEL=gemini-2.0-flash
   DASHBOARD_PORT=3000
   ```

---

## 7. Keep Bot Running (Codespaces timeout)

Codespaces auto-stop setelah idle 30 menit. Untuk bot yang harus jalan terus:

**Opsi A — Railway (recommended untuk production):**
```bash
railway login
railway init
railway up
```
Set semua env variable di Railway dashboard.

**Opsi B — Perpanjang timeout Codespaces:**
GitHub Settings → Codespaces → Default idle timeout → set ke 4 jam (max)

**Opsi C — Jalankan dengan nohup:**
```bash
nohup npm start > bot.log 2>&1 &
echo "Bot PID: $!"
```

---

## 8. Tambah Position Manual (setelah restart)

Jika bot restart dan posisi hilang dari state:

```bash
node addPosition.js BTCUSDT 65000 0.001
node addPosition.js ETHUSDT 3200 0.1
```

---

## 9. Tentang Screener

Bot ini **hanya** menggunakan satu screener: **UT Bot Alert pada timeframe 4 jam (4H)**.

- Mendeteksi sinyal **BUY** (close cross di atas ATR trailing stop) → masuk approval queue / auto execute
- Mendeteksi sinyal **SELL** (close cross di bawah ATR trailing stop) → notifikasi saja, eksekusi exit dikelola oleh `manager.js` (TP/SL/Trailing)
- Parameter bisa diatur di `user-config.json` → `screening.utbot` (keyValue, atrPeriod, checkIntervalMin, minVolume24h)

---

## 10. Troubleshooting

| Error | Solusi |
|-------|--------|
| `ECONNREFUSED` di dashboard | Pastikan bot sudah jalan dan port 3000 Public |
| `Bitget API error 401` | Cek API key & passphrase di .env |
| `GEMINI_API_KEY tidak ada` | Set GEMINI_API_KEY di .env atau Codespaces Secrets |
| `Cannot find module` | Jalankan `npm install` dulu |
| State hilang setelah restart | Set JSONBIN_BIN_ID untuk cloud state persistence |

---

## 11. Perintah Berguna

```bash
# Jalankan screening UTBot 4H manual
npm run screen

# Jalankan management manual
npm run manage

# Test API Bitget
node testapi.js

# Tambah posisi manual
npm run addpos BTCUSDT 65000 0.001

# Lihat log real-time
tail -f logs/bot-$(date +%Y-%m-%d).log
```
