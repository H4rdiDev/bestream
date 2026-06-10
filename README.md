# DiyyMotion Clean Story Backend

Backend Node.js untuk fitur **Clean Story**. Pakai `@whiskeysockets/baileys`, pairing code, kirim video sebagai WhatsApp video preview, lalu hapus file upload sementara setelah proses selesai.

## Deploy ke Render

1. Upload folder ini ke GitHub repo baru.
2. Render → **New Web Service**.
3. Pilih repo backend ini.
4. Gunakan setting:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
```

5. Tambahkan environment variables:

```env
CORS_ORIGIN=https://domain-vercel-kamu.vercel.app
MAX_VIDEO_MB=100
BAILEYS_LOG_LEVEL=silent
```

Kalau mau endpoint tidak dipakai orang random, tambahkan:

```env
CLEAN_STORY_SECRET=isi_secret_random
```

Lalu di frontend DiyyMotion/Vercel tambahkan juga:

```env
VITE_CLEAN_STORY_SECRET=isi_secret_random
```

## Endpoint

```text
GET  /                  status service
GET  /health            health check
GET  /status            cek session
GET  /pair?phone=628xx  pairing code via SSE
POST /send-video        kirim video, field: to, caption, video
```

## Session WhatsApp

Session Baileys disimpan di folder `auth` secara default. Di Render free, filesystem bisa hilang saat redeploy/restart tertentu, jadi pairing ulang bisa dibutuhkan. Kalau hosting kamu mendukung persistent disk, set:

```env
AUTH_DIR=/data/auth
```

## Cleanup Storage

Video upload disimpan sementara di `/tmp/diyymotion-clean-story`, dikirim ke WhatsApp, lalu otomatis dihapus di blok `finally`. Ada cleanup tambahan tiap 30 menit untuk file yang lebih tua dari 1 jam.

## Local Test

```bash
npm install
npm start
```

Server jalan di:

```text
http://localhost:3000
```
