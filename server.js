/**
 * PZ Auth+API Backend – Versão 1.8.1 – 2025-09-06 – “DailyFacts-Upsert”
 *
 * Alterações vs 1.7.0 (AdminSDK-DirectWrite):
 *  - 🔁 Substitui gravação em "auth_events" por **upsert** em "daily_facts" (fato único diário).
 *  - 🗂️ ID do documento: YYYYMMDD + '_' + anon_id (considerando tz_offset, se enviado).
 *  - ➕ Append de eventos em array `events` + incremento em `counters.{event}` + `updated_at`.
 *  - 🕒 Mantém `ts_server` (serverTimestamp) e aceita `ts_client` (ISO) do payload.
 *  - ♻️ Continua aceitando `/auth/google` e `/api/track`, CORS no topo e endpoints de debug/health.
 */

const express = require('express');
const cors = require('cors');
let cookieParser = null;
try { cookieParser = require('cookie-parser'); } catch (_) { console.warn('[BOOT] cookie-parser não encontrado; segue sem.'); }

const { OAuth2Client, JWT } = require('google-auth-library');
const admin = require('firebase-admin');

// fetch (fallback para Node < 18)
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();

/* ──────────────────────────────────────────────────────────────
   1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '1.8.1';
const BUILD_DATE = '2025-09-06';
const PORT = process.env.PORT || 8080;

/** Client IDs aceitos (audiences) */
const PRIMARY_CLIENT_ID = '270930304722-pbl5cmp53omohrmfkf9dmicutknf3q95.apps.googleusercontent.com';
const CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID,
  ...(process.env.GOOGLE_CLIENT_IDS ? String(process.env.GOOGLE_CLIENT_IDS).split(',') : []),
  PRIMARY_CLIENT_ID
].map(s => (s || '').trim()).filter(Boolean);

/** Origens permitidas */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || [
  'https://pzadvisors.com',
  'https://www.pzadvisors.com',
  'https://auth.pzadvisors.com',
  'https://api.pzadvisors.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8081'
].join(',')).split(',').map(o => o.trim()).filter(Boolean);

const TRACK_OPEN  = (process.env.TRACK_OPEN || 'false').toLowerCase() === 'true';
const TRACK_TOKEN = process.env.TRACK_TOKEN || '';
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || '';

app.set('trust proxy', true);

/* ──────────────────────────────────────────────────────────────
   1.1) CORS (no topo)
─────────────────────────────────────────────────────────────── */
function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server
  try {
    const { hostname, protocol } = new URL(origin.trim());
    const host = String(hostname || '').toLowerCase();
    const isLocal = protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1');
    if (isLocal) return true;
    if (host === 'pzadvisors.com' || host === 'www.pzadvisors.com' || host.endsWith('.pzadvisors.com')) return true;
    return allowedOrigins.includes(origin.trim());
  } catch { return false; }
}

app.use(cors({
  origin(origin, cb) {
    const ok = isAllowedOrigin(origin);
    if (!ok && origin) { try { console.warn(JSON.stringify({ tag: 'cors_denied', origin })); } catch {} }
    return cb(null, ok);
  },
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type','Authorization',
    'X-PZ-Version','x-pz-version',
    'X-Trace-Id','x-trace-id',
    'X-Api-Token','x-api-token',
    'X-Debug-Token','x-debug-token',
    'X-Debug-Verbose','x-debug-verbose'
  ],
  optionsSuccessStatus: 204
}));

/* ──────────────────────────────────────────────────────────────
   1.2) Service Account / Firebase Admin SDK
─────────────────────────────────────────────────────────────── */
let SA_SOURCE = 'split_env';
let SA_JSON = null;

const SA_RAW = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (SA_RAW) {
  try { SA_JSON = JSON.parse(SA_RAW); SA_SOURCE = 'env_json'; }
  catch (e) { console.error('[FS] FIREBASE_SERVICE_ACCOUNT_JSON inválido:', e?.message || e); }
}

// Base via JSON (se houver)
let GCP_PROJECT_ID     = SA_JSON?.project_id    || '';
let GCP_SA_EMAIL       = SA_JSON?.client_email  || '';
let GCP_SA_PRIVATE_KEY = SA_JSON?.private_key   || '';

// Compatibilidade: variáveis GCP_* têm prioridade final
GCP_PROJECT_ID     = process.env.GCP_PROJECT_ID     || GCP_PROJECT_ID || '';
GCP_SA_EMAIL       = process.env.GCP_SA_EMAIL       || GCP_SA_EMAIL   || '';
GCP_SA_PRIVATE_KEY = process.env.GCP_SA_PRIVATE_KEY || GCP_SA_PRIVATE_KEY || '';

// Normaliza "\n" na private key
if (GCP_SA_PRIVATE_KEY) GCP_SA_PRIVATE_KEY = String(GCP_SA_PRIVATE_KEY).replace(/\\n/g, '\n');

function ensureSA() {
  const miss = {
    project: !!GCP_PROJECT_ID,
    email  : !!GCP_SA_EMAIL,
    key    : !!GCP_SA_PRIVATE_KEY && GCP_SA_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')
  };
  if (!miss.project || !miss.email || !miss.key) {
    const msg = `[FS] Service Account incompleta: ${JSON.stringify(miss)} (source=${SA_SOURCE})`;
    console.error(msg);
    const err = new Error('sa_not_configured');
    err.code = 'sa_not_configured';
    err.meta = { ...miss, source: SA_SOURCE };
    throw err;
  }
}

/** Inicializa Firebase Admin SDK apenas uma vez */
let _adminInited = false;
function initAdmin() {
  if (_adminInited) return;
  ensureSA();
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: GCP_PROJECT_ID,
      clientEmail: GCP_SA_EMAIL,
      privateKey: GCP_SA_PRIVATE_KEY
    }),
    projectId: GCP_PROJECT_ID
  });
  _adminInited = true;
  console.log('[ADMIN] Firebase Admin inicializado (project:', GCP_PROJECT_ID, ')');
}

function getDB() { initAdmin(); return admin.firestore(); }
const FieldValue = admin.firestore.FieldValue;

/** Para diagnóstico de token SA (mesmo usando Admin SDK) */
const FS_SCOPE = 'https://www.googleapis.com/auth/datastore';
async function getSATokenDiag() {
  ensureSA();
  const client = new JWT({ email: GCP_SA_EMAIL, key: GCP_SA_PRIVATE_KEY, scopes: [FS_SCOPE] });
  const { token, expiry_date } = await client.authorize();
  return { token, expiry_date: expiry_date || null };
}

/* ──────────────────────────────────────────────────────────────
   2) Middlewares
─────────────────────────────────────────────────────────────── */
if (cookieParser) {
  app.use(cookieParser());
} else {
  // Fallback: parser simples de cookies (g_csrf_token)
  app.use((req, _res, next) => {
    const raw = req.headers.cookie || '';
    req.cookies = {};
    raw.split(';').forEach(p => {
      const [k, ...v] = p.split('=');
      if (!k) return;
      req.cookies[k.trim()] = decodeURIComponent((v.join('=') || '').trim());
    });
    next();
  });
}

// Body parsers
app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));

// Fallback para corpo raw→JSON
app.use((req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return next();
  let data = '';
  req.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); }); // 2MB
  req.on('end', () => {
    if (!req.body || typeof req.body !== 'object') {
      if (data && /^[\s{\[]/.test(data)) {
        try { req.body = JSON.parse(data); } catch { /* ignore */ }
      }
    }
    next();
  });
});

// Headers padrão + trace id
app.use((req, res, next) => {
  const rid = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  req.rid = rid;
  res.setHeader('X-Trace-Id', rid);
  res.setHeader('X-PZ-Version', `PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`);
  res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  next();
});

// Logger
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      console.log(JSON.stringify({
        rid: req.rid, method: req.method, path: req.path,
        status: res.statusCode, ms: Date.now() - t0, origin: req.headers.origin || null
      }));
    } catch {}
  });
  next();
});

/* ──────────────────────────────────────────────────────────────
   3) Utilitários Daily Facts
─────────────────────────────────────────────────────────────── */
function zeroPad(n, w = 2) { n = String(n); return n.length >= w ? n : '0'.repeat(w - n.length) + n; }

function deriveDayYYYYMMDD(tsISO, tzOffsetMin) {
  // tzOffsetMin: minutos em relação ao UTC (ex.: -180 para UTC-3). Se ausente, assume 0 (UTC).
  let d = tsISO ? new Date(tsISO) : new Date();
  if (Number.isFinite(tzOffsetMin)) {
    // converte data UTC para "tempo local" aplicando o offset (minutos)
    d = new Date(d.getTime() + tzOffsetMin * 60 * 1000);
  }
  const y = d.getUTCFullYear();
  const m = zeroPad(d.getUTCMonth() + 1);
  const day = zeroPad(d.getUTCDate());
  return `${y}${m}${day}`; // YYYYMMDD
}

function parseClientTimestamp(val) {
  try {
    if (!val) return null;
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return admin.firestore.Timestamp.fromDate(d);
  } catch { return null; }
}

async function upsertDailyFact({ db, anon_id, user_id, tz_offset, event, page, session_id, payload, tsISO }) {
  const safeAnon = (anon_id && typeof anon_id === 'string') ? anon_id : 'anon_unknown';
  const day = deriveDayYYYYMMDD(tsISO, Number.isFinite(+tz_offset) ? +tz_offset : 0);
  const docId = `${day}_${safeAnon}`; // YYYYMMDD_anon
  const docRef = db.collection('daily_facts').doc(docId);

  const event_id = `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  const ev = {
    event,
    event_id,
    ts_server: FieldValue.serverTimestamp(), // sempre
    ...(parseClientTimestamp(tsISO) ? { ts_client: parseClientTimestamp(tsISO) } : {}),
    ...(Number.isFinite(+tz_offset) ? { tz_offset: +tz_offset } : {}),
    ...(page ? { page } : {}),
    ...(session_id ? { session_id } : {}),
    ...(payload ? { payload } : {})
  };

  const seed = {
    kind: 'user',
    date: `${docId.slice(0,4)}-${docId.slice(4,6)}-${docId.slice(6,8)}`, // ex.: 2025-09-06
    entity_id: safeAnon,
    anon_id: safeAnon,
    person_id: (user_id && typeof user_id === 'string') ? user_id : safeAnon,
    ...(user_id ? { user_id } : {}),
    ...(Number.isFinite(+tz_offset) ? { tz_offset: +tz_offset } : {}),
    events: [],
    counters: {},
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp()
  };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      tx.set(docRef, seed, { merge: false });
    } else {
      // pode atualizar cabeçalho (ex.: upgrade de user_id)
      const headerUpdate = {
        updated_at: FieldValue.serverTimestamp(),
        ...(user_id ? { user_id, person_id: user_id } : {})
      };
      tx.set(docRef, headerUpdate, { merge: true });
    }

    // append evento + increment de contador
    const incField = `counters.${event}`;
    tx.set(docRef, {
      events: FieldValue.arrayUnion(ev),
      [incField]: FieldValue.increment(1),
      updated_at: FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return { ok: true, id: docId };
}

/* ──────────────────────────────────────────────────────────────
   4) Rotas básicas / Health / Versão
─────────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => res.status(200).send('🚀 PZ Auth+API Backend ativo. Use /healthz, /api/version, /api/track, /auth/google.'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime(), ts:new Date().toISOString() }));
app.head('/healthz', (_req, res) => res.sendStatus(200));
app.get('/api/healthz', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime(), ts:new Date().toISOString() }));
app.head('/api/healthz', (_req, res) => res.sendStatus(200));

app.get('/api/version', (_req, res) => {
  res.status(200).json({
    service: 'PZ Auth+API Backend',
    version: VERSION,
    build_date: BUILD_DATE,
    client_ids_configured: CLIENT_IDS,
    cors_allowed_origins: allowedOrigins,
    wildcard_pzadvisors: '*.pzadvisors.com',
    track_open: TRACK_OPEN,
    has_track_token: Boolean(TRACK_TOKEN),
    debug_ping_enabled: Boolean(DEBUG_TOKEN),
    firestore_auth_mode: 'AdminSDK',
    has_cookie_parser: Boolean(cookieParser),
    project_id: process.env.GCP_PROJECT_ID || null
  });
});

// CORS diag
app.get('/api/cors-check', (req, res) => {
  const origin = req.headers.origin || null;
  return res.status(200).json({ ok:true, rid:req.rid, origin, allowed: isAllowedOrigin(origin), ua: req.headers['user-agent'] || null, ts: new Date().toISOString() });
});

/* ──────────────────────────────────────────────────────────────
   4.1) Debug – Credenciais SA / Firestore (protegido)
─────────────────────────────────────────────────────────────── */
function assertDebugAccess(req, res) {
  const tok = req.headers['x-debug-token'] || req.headers['X-Debug-Token'];
  if (!DEBUG_TOKEN || tok !== DEBUG_TOKEN) { res.status(403).json({ ok:false, error:'forbidden' }); return false; }
  return true;
}

app.get('/api/debug/env-has-sa', (_req, res) => {
  const hasProj  = !!(process.env.GCP_PROJECT_ID);
  const hasEmail = !!(process.env.GCP_SA_EMAIL);
  const hasKey   = !!(process.env.GCP_SA_PRIVATE_KEY) && String(process.env.GCP_SA_PRIVATE_KEY).includes('BEGIN PRIVATE KEY');
  res.status(200).json({ hasProj, hasEmail, hasKey, sa_source: SA_SOURCE });
});

// Diagnóstico do token do SA
app.get('/api/debug/fs-token', async (req, res) => {
  if (!assertDebugAccess(req, res)) return;
  try {
    const { expiry_date } = await getSATokenDiag();
    const expires_in_s = expiry_date ? Math.max(0, Math.floor((expiry_date - Date.now())/1000)) : null;
    res.status(200).json({ ok: true, scope: FS_SCOPE, expiry_date, expires_in_s });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || String(e) });
  }
});

// Tentativa de escrita com retorno detalhado – agora em daily_facts
app.post('/api/debug/fs-write', async (req, res) => {
  if (!assertDebugAccess(req, res)) return;
  try {
    const db = getDB();
    const anon_id = (req.body && req.body.anon_id) || 'anon_debug';
    const out = await upsertDailyFact({
      db,
      anon_id,
      user_id: req.body && req.body.user_id,
      tz_offset: req.body && req.body.tz_offset,
      event: 'debug_write',
      page: '/debug',
      session_id: null,
      payload: { note: (req.body && req.body.note) || 'manual' },
      tsISO: (req.body && req.body.ts) || new Date().toISOString()
    });
    res.status(200).json({ ok:true, rid:req.rid, doc: out.id });
  } catch (e) {
    res.status(500).json({ ok:false, rid:req.rid, error: e.message || String(e) });
  }
});

/* ──────────────────────────────────────────────────────────────
   5) Google OAuth – One Tap
─────────────────────────────────────────────────────────────── */
const oauthClient = new OAuth2Client(CLIENT_IDS[0] || PRIMARY_CLIENT_ID);

app.options('/auth/google', (_req, res) => res.sendStatus(204));
app.options('/api/auth/google', (_req, res) => res.sendStatus(204));

function decodeJwtPayload(idToken) {
  try {
    const base64 = idToken.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}

async function handleAuthGoogle(req, res) {
  try {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    const body = req.body || {};
    const credential = (typeof body.credential === 'string' && body.credential) || (typeof body.id_token === 'string' && body.id_token) || null;
    const context = body.context || {}; // pode carregar anon_id, page, etc.

    console.log(JSON.stringify({ route:'/auth/google', rid:req.rid, content_type:ct, has_credential: !!credential }));

    if (!credential) return res.status(400).json({ error:'missing_credential' });

    // CSRF (se usar login_uri)
    if (('g_csrf_token' in body) || (req.cookies && 'g_csrf_token' in req.cookies)) {
      const csrfCookie = req.cookies?.g_csrf_token;
      const csrfBody   = body?.g_csrf_token;
      if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) return res.status(400).json({ error:'csrf_mismatch' });
    }

    res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0' });

    // Verificação (assinatura + audiences)
    const ticket  = await oauthClient.verifyIdToken({ idToken: credential, audience: CLIENT_IDS });
    const payload = ticket.getPayload();
    if (!payload) return res.status(401).json({ error:'invalid_token' });

    const { sub, email, name, picture, email_verified } = payload;
    const user_id = String(sub);

    // Upsert em users
    try {
      const db = getDB();
      const docRef = db.collection('users').doc(user_id);
      await docRef.set({ user_id, sub, email: email || null, name: name || null, picture: picture || null, email_verified: !!email_verified }, { merge: true });
      await docRef.set({ last_seen: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, warn:'users_upsert_failed', error:e.message || String(e) }));
    }

    // Log em daily_facts (auth_google_success) se tivermos anon_id no contexto
    try {
      const db = getDB();
      const anon_id = context.anon_id || (body.anon_id) || 'anon_unknown';
      await upsertDailyFact({
        db,
        anon_id,
        user_id,
        tz_offset: (typeof context.tz_offset !== 'undefined') ? context.tz_offset : 0,
        event: 'auth_google_success',
        page: context.page || '/onetap',
        session_id: context.session_id || null,
        payload: { email: email || null, name: name || null, picture: picture || null, email_verified: !!email_verified },
        tsISO: new Date().toISOString()
      });
    } catch (e) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, warn:'daily_facts_log_failed', error:e.message || String(e) }));
    }

    return res.status(200).json({ user_id, email: email || null, name: name || null, picture: picture || null });
  } catch (err) {
    const msg = err?.message || String(err || '');
    let code = 'auth_failed';
    if (/Wrong recipient|audience/.test(msg)) code = 'audience_mismatch';
    if (/expired/i.test(msg))               code = 'token_expired';
    if (/invalid/i.test(msg))               code = 'invalid_token';
    console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, error: msg, code }));
    return res.status(401).json({ error: code });
  }
}

app.post('/auth/google', handleAuthGoogle);
app.post('/api/auth/google', handleAuthGoogle);

/* ──────────────────────────────────────────────────────────────
   6) Endpoints auxiliares
─────────────────────────────────────────────────────────────── */
app.post('/api/echo', (req, res) => {
  res.set({ 'Cache-Control':'no-store, no-cache, must-revalidate, private', Pragma:'no-cache', Expires:'0' });
  return res.status(200).json({ ok:true, rid:req.rid, echo:req.body || null, ts:new Date().toISOString() });
});

// Novo: grava em daily_facts com doc YYYYMMDD_anon_id
app.post('/api/track', async (req, res) => {
  try {
    if (!TRACK_OPEN) {
      const tok = req.headers['x-api-token'] || req.headers['X-Api-Token'];
      if (!TRACK_TOKEN || tok !== TRACK_TOKEN) return res.status(403).json({ ok:false, error:'forbidden' });
    }

    const { event, payload } = req.body || {};
    if (!event || typeof event !== 'string') return res.status(400).json({ ok:false, error:'missing_event' });

    const anon_id   = payload?.anon_id || req.body?.anon_id || 'anon_unknown';
    const user_id   = payload?.user_id || null; // será "upgraded" quando houver
    const tz_offset = (typeof payload?.tz_offset !== 'undefined') ? payload.tz_offset : 0;
    const tsISO     = payload?.ts || null;
    const page      = payload?.page || payload?.context?.page || null;
    const sessionId = payload?.session_id || null;

    const db = getDB();
    await upsertDailyFact({
      db,
      anon_id,
      user_id,
      tz_offset,
      event,
      page,
      session_id: sessionId,
      // remove campos redundantes do payload
      payload: (() => {
        const p = { ...payload };
        delete p.ts; delete p.tz_offset; delete p.page; delete p.session_id; delete p.user_id; delete p.anon_id; delete p.context;
        return Object.keys(p).length ? p : null;
      })(),
      tsISO: tsISO || new Date().toISOString()
    });

    return res.status(200).json({ ok:true, rid:req.rid });
  } catch (e) {
    console.error(JSON.stringify({ route:'/api/track', rid:req.rid, error:e.message || String(e) }));
    return res.status(500).json({ ok:false, error:'track_failed' });
  }
});

// Ping FS com verbose
app.post('/api/debug/ping-fs', async (req, res) => {
  const verbose = (String(req.query.verbose || req.headers['x-debug-verbose'] || '') === '1');
  try {
    const tok = req.headers['x-debug-token'] || req.headers['X-Debug-Token'];
    if (!DEBUG_TOKEN || tok !== DEBUG_TOKEN) return res.status(403).json({ ok:false, error:'forbidden' });

    const db = getDB();
    const out = await upsertDailyFact({
      db,
      anon_id: (req.body && req.body.anon_id) || 'anon_debug',
      user_id: req.body && req.body.user_id,
      tz_offset: req.body && req.body.tz_offset,
      event: 'debug_ping_fs',
      page: '/debug',
      session_id: null,
      payload: null,
      tsISO: new Date().toISOString()
    });

    return res.status(200).json({ ok:true, rid:req.rid, doc: out.id });
  } catch (e) {
    const payload = { route:'/api/debug/ping-fs', rid:req.rid, error:e.message || String(e) };
    console.error(JSON.stringify(payload));
    if (e.code === 'sa_not_configured') return res.status(503).json({ ok:false, error:'sa_not_configured', meta:e.meta });
    return res.status(500).json(verbose ? { ok:false, ...payload } : { ok:false, error:'ping_failed' });
  }
});

/* ──────────────────────────────────────────────────────────────
   7) Erros globais
─────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason) => { console.error('[UNHANDLED_REJECTION]', reason); });
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT_EXCEPTION]', err); });

/* ──────────────────────────────────────────────────────────────
   8) Start
─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`✅ Server UP on port ${PORT}`);
  console.log(`📦 Version: v${VERSION} (${BUILD_DATE})`);
  console.log('🔧 Vars:');
  console.log('   CLIENT_IDS                 :', CLIENT_IDS);
  console.log('   ALLOWED_ORIGINS            :', allowedOrigins);
  console.log('   wildcard_pzadvisors        : *.pzadvisors.com');
  console.log('   TRACK_OPEN                 :', TRACK_OPEN);
  console.log('   TRACK_TOKEN set            :', Boolean(TRACK_TOKEN));
  console.log('   DEBUG_TOKEN set            :', Boolean(DEBUG_TOKEN));
  console.log('   FIRESTORE auth mode        : AdminSDK');
  console.log('   PROJECT_ID                 :', process.env.GCP_PROJECT_ID || '(env)');
  console.log('   HAS cookie-parser          :', Boolean(cookieParser));
  console.log('   NODE_ENV                   :', process.env.NODE_ENV || '(not set)');
  console.log('──────────────────────────────────────────────────────────────');
});