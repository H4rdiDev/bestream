# DiyyMotion Clean Story Backend v22

Backend Baileys untuk Clean Story. Versi ini otomatis connect ke nomor `PAIR_PHONE` saat server start. Pairing code dicetak di Railway Logs, bukan di frontend.

## Deploy Railway

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

## Environment Variables

```env
CORS_ORIGIN=https://diyymotion.vercel.app
MAX_VIDEO_MB=100
BAILEYS_LOG_LEVEL=silent
PAIR_PHONE=628137961654
AUTO_PAIR_ON_START=true
LOG_PAIRING_CODE=true
```

Opsional jika pakai Railway Volume agar session awet:

```env
AUTH_DIR=/data/auth
UPLOAD_DIR=/tmp/diyymotion-clean-story
```

## Cara pairing

1. Deploy / restart service Railway.
2. Buka Railway → Service → Logs.
3. Cari blok `DIYYMOTION WHATSAPP PAIRING CODE`.
4. Masukkan kode di WhatsApp → Perangkat tertaut → Tautkan dengan nomor telepon.
5. Setelah session tersimpan, frontend cukup upload video dan kirim.

## Endpoint

- `GET /health` → OK
- `GET /status` → status JSON
- `GET /prcd` → trigger pairing + instruksi log
- `POST /send-video` → multipart form-data: `to`, `caption`, `video`

File video temp otomatis dihapus setelah terkirim atau gagal.
