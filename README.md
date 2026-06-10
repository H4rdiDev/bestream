# DiyyMotion Clean Story Backend

Backend Node.js untuk **Clean Story**. WhatsApp connect **cukup sekali di backend** lewat halaman `/prcd`. Setelah session tersimpan, frontend DiyyMotion cuma perlu upload video dan isi nomor tujuan.

## Deploy Railway

Upload folder ini ke GitHub, lalu Railway → New Project → Deploy from GitHub Repo.

Setting default:

```text
Build Command: npm install
Start Command: npm start
```

Environment variables:

```env
CORS_ORIGIN=https://diyymotion.vercel.app
MAX_VIDEO_MB=100
BAILEYS_LOG_LEVEL=silent
PAIR_PHONE=628137961654
```

Opsional kalau mau endpoint dikunci:

```env
CLEAN_STORY_SECRET=isi_secret_random
```

Kalau pakai secret, frontend Vercel juga harus punya:

```env
VITE_CLEAN_STORY_SECRET=isi_secret_random
```

## Pairing sekali

Buka domain Railway backend:

```text
https://domain-railway-kamu.up.railway.app/prcd
```

Masukkan kode pairing di WhatsApp → Perangkat tertaut → Tautkan dengan nomor telepon.

Setelah halaman menampilkan `READY`, session sudah tersimpan. Frontend tidak perlu tombol pairing lagi.

## Endpoint

```text
GET  /                  status JSON
GET  /health            OK
GET  /healt             OK alias typo, karena manusia tetap manusia
GET  /status            cek session, auto wake socket kalau session ada
GET  /prcd              halaman pairing backend
GET  /pair?phone=628xx  pairing code SSE
POST /send-video        field: to, caption, video
```

## Storage cleanup

Video upload disimpan sementara di `/tmp/diyymotion-clean-story`, dikirim ke WhatsApp, lalu otomatis dihapus di blok `finally`. Ada cleanup tambahan tiap 30 menit untuk file lebih tua dari 1 jam.

## Session agar awet

Session default disimpan di folder `auth`. Kalau Railway kamu pakai Volume, set:

```env
AUTH_DIR=/data/auth
```

Kalau tanpa volume, session bisa hilang saat redeploy/rebuild. Itu bukan bug, itu hosting gratis/hemat sedang menagih harga diri.
