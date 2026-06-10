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
const DEFAULT_PAIR_PHONE = cleanPhone(process.env.PAIR_PHONE || '628137961654');
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });

mkdirSync(AUTH_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((x) => x.trim()) }));
app.use(express.json({ limit: '1mb' }));

function cleanPhone(phone = '') {
  return String(phone).replace(/\D/g, '');
}

function jsonEscape(value = '') {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[ch]));
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

async function safeReadAuthFiles() {
  try {
    if (!existsSync(AUTH_DIR)) return [];
    return await fs.readdir(AUTH_DIR);
  } catch {
    return [];
  }
}

async function hasStoredSession() {
  const files = await safeReadAuthFiles();
  return files.some((name) => name.includes('creds') || name.endsWith('.json'));
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
    if (!String(file.mimetype || '').startsWith('video/')) return cb(new Error('File harus video. Jangan kirim format ngawur.'));
    cb(null, true);
  },
});

let sock = null;
let connected = false;
let starting = null;
let lastConnectionMessage = 'Belum connect. Buka /prcd di backend untuk pairing sekali.';
let lastPairCode = '';
let lastPairAt = 0;

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
    keepAliveIntervalMs: 25_000,
    logger,
  });

  wa.ev.on('creds.update', saveCreds);
  wa.ev.on('connection.update', (update = {}) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'connecting') {
      lastConnectionMessage = 'WhatsApp socket connecting.';
    }
    if (connection === 'open') {
      connected = true;
      lastPairCode = '';
      lastConnectionMessage = 'WhatsApp connected. Session aktif di backend.';
    }
    if (connection === 'close') {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      sock = null;
      if (statusCode === DisconnectReason.loggedOut) {
        lastConnectionMessage = 'Session logout. Buka /prcd dan pairing ulang.';
      } else {
        lastConnectionMessage = 'Socket tertutup. Backend akan reconnect saat status/send dipanggil.';
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
      reject(new Error('Timeout menunggu WhatsApp connect. Kalau belum pairing, buka /prcd di backend dulu.'));
    }, timeoutMs);

    const handler = (update = {}) => {
      if (update.connection === 'open') {
        clearTimeout(timer);
        wa.ev.off('connection.update', handler);
        resolve();
      }
      if (update.connection === 'close') {
        const statusCode = update?.lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          clearTimeout(timer);
          wa.ev.off('connection.update', handler);
          reject(new Error('Session logout. Buka /prcd di backend dan pairing ulang.'));
        }
      }
    };
    wa.ev.on('connection.update', handler);
  });
}

async function getStatus({ wake = false } = {}) {
  const session = await hasStoredSession();
  if (wake && session && !connected) {
    ensureSocket().catch(() => {});
  }
  return {
    ok: true,
    service: 'DiyyMotion Clean Story Backend',
    connected,
    hasSession: session,
    ready: connected || session,
    message: connected ? 'READY. Frontend cukup upload video.' : session ? 'Session ada. Socket akan bangun saat kirim video.' : lastConnectionMessage,
    maxVideoMb: MAX_VIDEO_MB,
    pairPhone: DEFAULT_PAIR_PHONE,
    uptime: process.uptime(),
  };
}

app.get('/', async (_req, res) => {
  res.json(await getStatus({ wake: true }));
});

app.get('/health', (_req, res) => {
  res.type('text/plain').send('OK');
});

app.get('/healt', (_req, res) => {
  res.type('text/plain').send('OK');
});

app.get('/status', requireSecret, async (_req, res) => {
  res.json(await getStatus({ wake: true }));
});

app.get('/prcd', (_req, res) => {
  const secretQuery = CLEAN_STORY_SECRET ? `&secret=${encodeURIComponent(CLEAN_STORY_SECRET)}` : '';
  res.type('html').send(`<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DiyyMotion Pairing</title>
<style>
:root{color-scheme:dark;--bg:#202226;--card:#343A40;--green:#2F5D50;--mint:#8FB9AB;--ivory:#EFF7F4}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,rgba(143,185,171,.25),transparent 34%),linear-gradient(135deg,var(--bg),#0f1114);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;color:var(--ivory);padding:18px}.card{width:min(520px,100%);border:1px solid rgba(239,247,244,.16);border-radius:34px;padding:28px;background:linear-gradient(145deg,rgba(239,247,244,.13),rgba(47,93,80,.18));box-shadow:0 34px 100px rgba(0,0,0,.42);backdrop-filter:blur(18px)}.k{color:var(--mint);font-size:13px;text-transform:uppercase;letter-spacing:.22em;font-weight:900}.code{font-size:clamp(42px,14vw,68px);letter-spacing:.08em;font-weight:950;margin:18px 0;color:#fff}.status{line-height:1.6;color:rgba(239,247,244,.75)}button{border:0;border-radius:999px;padding:15px 20px;font-weight:900;background:linear-gradient(135deg,var(--mint),var(--green));color:#101412;margin-top:18px;width:100%;font-size:16px}.small{font-size:13px;color:rgba(239,247,244,.55);margin-top:18px}
</style></head><body><main class="card"><div class="k">DiyyMotion backend pairing</div><h1>WhatsApp Pairing</h1><p class="status">Nomor: <b>${jsonEscape(DEFAULT_PAIR_PHONE)}</b>. Connect cukup sekali. Setelah READY, frontend cuma upload video.</p><div id="code" class="code">...</div><p id="status" class="status">Mengecek session...</p><button id="retry">Refresh / Pair ulang</button><p class="small">Buka WhatsApp → Perangkat tertaut → Tautkan dengan nomor telepon.</p></main>
<script>
const codeEl=document.getElementById('code');const statusEl=document.getElementById('status');const phone='${jsonEscape(DEFAULT_PAIR_PHONE)}';
async function check(){try{const r=await fetch('/status${CLEAN_STORY_SECRET ? `?secret=${encodeURIComponent(CLEAN_STORY_SECRET)}` : ''}');const j=await r.json();if(j.connected||j.hasSession){codeEl.textContent='READY';statusEl.textContent=j.message||'Session siap.';return true;}return false}catch(e){statusEl.textContent=e.message;return false}}
function pair(){codeEl.textContent='...';statusEl.textContent='Meminta pairing code...';const es=new EventSource('/pair?phone='+encodeURIComponent(phone)+'${secretQuery}');es.addEventListener('code',ev=>{const j=JSON.parse(ev.data||'{}');codeEl.textContent=j.code||'-';statusEl.textContent='Masukkan kode ini di WhatsApp.'});es.addEventListener('status',ev=>{const j=JSON.parse(ev.data||'{}');if(j.message)statusEl.textContent=j.message});es.addEventListener('connected',ev=>{codeEl.textContent='READY';statusEl.textContent='Connected. Session disimpan di backend.';es.close()});es.addEventListener('error',()=>{statusEl.textContent='Pairing berhenti/timeout. Klik refresh kalau belum READY.';es.close()})}
document.getElementById('retry').onclick=async()=>{if(!(await check())) pair()};(async()=>{if(!(await check())) pair()})();
</script></body></html>`);
});

app.get('/pair', requireSecret, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const phone = cleanPhone(req.query.phone || DEFAULT_PAIR_PHONE);
  if (!phone || phone.length < 8) {
    sseWrite(res, 'status', { type: 'bad', message: 'Nomor pairing tidak valid.' });
    res.end();
    return;
  }

  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    const session = await hasStoredSession();
    if (connected || session) {
      if (session && !connected) ensureSocket().catch(() => {});
      if (!closed) sseWrite(res, 'connected', { message: 'Session sudah ada. Frontend cukup upload video.' });
      res.end();
      return;
    }

    sseWrite(res, 'status', { message: 'Menyiapkan socket WhatsApp...' });
    const wa = await ensureSocket();
    await new Promise((r) => setTimeout(r, 1200));
    sseWrite(res, 'status', { message: 'Meminta pairing code...' });
    const code = await wa.requestPairingCode(phone);
    lastPairCode = String(code || '').match(/.{1,4}/g)?.join('-') || String(code || '');
    lastPairAt = Date.now();
    if (!closed) sseWrite(res, 'code', { code: lastPairCode });

    const timer = setTimeout(() => {
      if (!closed) sseWrite(res, 'status', { type: 'bad', message: 'Pairing timeout. Klik refresh kalau belum connect.' });
      res.end();
    }, 75_000);

    const handler = (update = {}) => {
      if (closed) return;
      if (update.connection === 'open') {
        clearTimeout(timer);
        sseWrite(res, 'connected', { message: 'WhatsApp connected. Session disimpan di backend.' });
        wa.ev.off('connection.update', handler);
        res.end();
      }
      if (update.connection === 'close') {
        const statusCode = update?.lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          clearTimeout(timer);
          sseWrite(res, 'status', { type: 'bad', message: 'Session logout. Pairing ulang.' });
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

    if (!to || to.length < 8) throw new Error('Nomor tujuan tidak valid. Pakai format 628xxx.');
    if (!req.file) throw new Error('Video tidak ditemukan.');
    if (!(await hasStoredSession())) throw new Error('Backend belum pairing. Buka Railway backend /prcd sekali dulu.');

    const wa = await ensureSocket();
    await waitForOpen(wa, 60_000);

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
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, error: `Video maksimal ${MAX_VIDEO_MB}MB.` });
  return res.status(400).json({ ok: false, error: err.message || 'Request gagal.' });
});

setInterval(() => cleanupOldUploads().catch(() => {}), 30 * 60 * 1000).unref?.();

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`DiyyMotion Clean Story backend running on :${PORT}`);
  if (await hasStoredSession()) {
    ensureSocket().catch((err) => console.error('Auto socket start failed:', err?.message || err));
  }
});
