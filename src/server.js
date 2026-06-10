import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const AUTH_DIR = process.env.AUTH_DIR || path.join(rootDir, 'auth');
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/diyymotion-clean-story';
const MAX_VIDEO_MB = Number(process.env.MAX_VIDEO_MB || 100);
const PORT = Number(process.env.PORT || 3000);
const CLEAN_STORY_SECRET = process.env.CLEAN_STORY_SECRET || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });

mkdirSync(AUTH_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((x) => x.trim()) }));
app.use(express.json({ limit: '1mb' }));

function cleanPhone(phone = '') {
  return String(phone).replace(/\D/g, '');
}

function isAuthorized(req) {
  if (!CLEAN_STORY_SECRET) return true;
  const headerSecret = req.headers['x-clean-secret'];
  const querySecret = req.query.secret;
  return headerSecret === CLEAN_STORY_SECRET || querySecret === CLEAN_STORY_SECRET;
}

function requireSecret(req, res, next) {
  if (isAuthorized(req)) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized Clean Story request.' });
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try { await fs.unlink(filePath); } catch {}
}

async function cleanupOldUploads(maxAgeMs = 60 * 60 * 1000) {
  try {
    const files = await fs.readdir(UPLOAD_DIR);
    const now = Date.now();
    await Promise.all(files.map(async (file) => {
      const filePath = path.join(UPLOAD_DIR, file);
      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) await safeUnlink(filePath);
      } catch {}
    }));
  } catch {}
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename(_req, file, cb) {
    const original = (file.originalname || 'video.mp4').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-90);
    cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}-${original}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!String(file.mimetype || '').startsWith('video/')) return cb(new Error('File harus video. Jangan kirim batu bata digital.'));
    cb(null, true);
  },
});

let sock = null;
let connected = false;
let starting = null;
let lastConnectionMessage = 'Belum connect.';

async function createSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch {
    version = undefined;
  }

  const wa = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 45_000,
    defaultQueryTimeoutMs: 60_000,
    logger,
  });

  wa.ev.on('creds.update', saveCreds);
  wa.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update || {};
    if (connection === 'open') {
      connected = true;
      lastConnectionMessage = 'WhatsApp connected. Session aktif.';
    }
    if (connection === 'connecting') {
      lastConnectionMessage = 'WhatsApp socket connecting.';
    }
    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        lastConnectionMessage = 'Session logout. Pairing ulang dibutuhkan.';
        sock = null;
      } else {
        lastConnectionMessage = 'Socket tertutup. Akan dibuka lagi saat dibutuhkan.';
        sock = null;
      }
    }
  });

  sock = wa;
  return wa;
}

async function ensureSocket() {
  if (sock) return sock;
  if (!starting) starting = createSocket().finally(() => { starting = null; });
  return starting;
}

function waitForOpen(wa, timeoutMs = 45_000) {
  if (connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wa.ev.off('connection.update', handler);
      reject(new Error('Timeout menunggu WhatsApp connect. Pairing ulang atau restart service kalau perlu.'));
    }, timeoutMs);
    const handler = (update) => {
      if (update?.connection === 'open') {
        clearTimeout(timer);
        wa.ev.off('connection.update', handler);
        resolve();
      }
      if (update?.connection === 'close') {
        const statusCode = update?.lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          clearTimeout(timer);
          wa.ev.off('connection.update', handler);
          reject(new Error('Session logout. Pairing ulang dulu.'));
        }
      }
    };
    wa.ev.on('connection.update', handler);
  });
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'DiyyMotion Clean Story Railway',
    connected,
    message: lastConnectionMessage,
    maxVideoMb: MAX_VIDEO_MB,
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, connected, uptime: process.uptime() });
});

app.get('/status', requireSecret, async (_req, res) => {
  try {
    const hasSession = existsSync(AUTH_DIR) && (await fs.readdir(AUTH_DIR)).length > 0;
    res.json({ ok: true, connected, hasSession, message: connected ? 'Session connected.' : lastConnectionMessage });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Gagal cek status.' });
  }
});

app.get('/pair', requireSecret, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const phone = cleanPhone(req.query.phone);
  if (!phone || phone.length < 8) {
    sseWrite(res, 'status', { type: 'bad', message: 'Nomor pengirim tidak valid.' });
    res.end();
    return;
  }

  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    sseWrite(res, 'status', { message: 'Menyiapkan socket WhatsApp...' });
    const wa = await ensureSocket();

    if (wa.authState?.creds?.registered || connected) {
      try { await waitForOpen(wa, 20_000); } catch {}
      if (!closed) sseWrite(res, 'connected', { message: 'Session sudah connected. Tidak perlu pairing ulang.' });
      res.end();
      return;
    }

    await new Promise((r) => setTimeout(r, 1200));
    sseWrite(res, 'status', { message: 'Meminta pairing code...' });
    const code = await wa.requestPairingCode(phone);
    if (!closed) sseWrite(res, 'code', { code: String(code || '').match(/.{1,4}/g)?.join('-') || code });

    const timer = setTimeout(() => {
      if (!closed) sseWrite(res, 'status', { type: 'bad', message: 'Pairing timeout. Minta code ulang kalau belum connect.' });
      res.end();
    }, 70_000);

    const handler = (update) => {
      if (closed) return;
      if (update?.connection === 'open') {
        clearTimeout(timer);
        sseWrite(res, 'connected', { message: 'WhatsApp connected. Session disimpan di Railway.' });
        wa.ev.off('connection.update', handler);
        res.end();
      }
      if (update?.connection === 'close') {
        const statusCode = update?.lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          clearTimeout(timer);
          sseWrite(res, 'status', { type: 'bad', message: 'Session logout. Coba pairing ulang.' });
          wa.ev.off('connection.update', handler);
          res.end();
        }
      }
    };
    wa.ev.on('connection.update', handler);
  } catch (err) {
    if (!closed) sseWrite(res, 'status', { type: 'bad', message: err.message || 'Gagal membuat pairing code.' });
    res.end();
  }
});

app.post('/send-video', requireSecret, upload.single('video'), async (req, res) => {
  await cleanupOldUploads();
  const tempPath = req.file?.path;
  try {
    const to = cleanPhone(req.body.to);
    const caption = String(req.body.caption || 'Clean Story by DiyyMotion').slice(0, 1024);

    if (!to || to.length < 8) throw new Error('Nomor tujuan tidak valid.');
    if (!req.file) throw new Error('Video tidak ditemukan.');

    const wa = await ensureSocket();
    await waitForOpen(wa, 45_000);

    const jid = `${to}@s.whatsapp.net`;
    const sent = await wa.sendMessage(jid, {
      video: { url: tempPath },
      mimetype: req.file.mimetype || 'video/mp4',
      caption,
    });

    res.json({ ok: true, message: 'Video terkirim. File temp sudah dibersihkan.', id: sent?.key?.id || null });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Gagal mengirim video.' });
  } finally {
    await safeUnlink(tempPath);
  }
});

app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ ok: false, error: `Video maksimal ${MAX_VIDEO_MB}MB.` });
  }
  return res.status(400).json({ ok: false, error: err.message || 'Request gagal.' });
});

setInterval(() => cleanupOldUploads().catch(() => {}), 30 * 60 * 1000).unref?.();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DiyyMotion Clean Story server running on :${PORT}`);
});
