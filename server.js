/**
 * PZ Auth+API Backend – Versão 1.6.3 – 2025-08-29 – “Railway-FS-PathFix+Hardening”
 *
 * Diff funcional vs 1.6.2:
 *  - 🔧 Firestore REST: caminho unificado (sem "documents/" nos helpers; só no fullName do commit).
 *  - 🧱 Guard rails SA mantidos (erro claro quando GCP_* faltarem).
 *  - 🌐 CORS no topo (mesma política).
 *  - 🧪 Fallback de JSON quando Content-Type vem errado.
 *  - ⚡ fetch nativo (Node 18+) com fallback para node-fetch@3 (ESM).
 */

const express = require('express');
const cors = require('cors');
let cookieParser = null;
try { cookieParser = require('cookie-parser'); }
catch (_) { console.warn('[BOOT] cookie-parser não encontrado; usando parser leve de header (fallback).'); }

const { OAuth2Client, JWT } = require('google-auth-library');

// fetch robusto (nativo primeiro; fallback ESM)
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();

/* ──────────────────────────────────────────────────────────────
   1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '1.6.3';
const BUILD_DATE = '2025-08-29';
const PORT = process.env.PORT || 8080;

/** Client IDs aceitos (audiences) */
const PRIMARY_CLIENT_ID = '270930304722-pbl5cmp53omohrmfkf9dmicutknf3q95.apps.googleusercontent.com';
const CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID,
  ...(process.env.GOOGLE_CLIENT_IDS ? String(process.env.GOOGLE_CLIENT_IDS).split(',') : []),
  PRIMARY_CLIENT_ID
].map(s => (s || '').trim()).filter(Boolean);

/** Origens permitidas */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  [
    'https://pzadvisors.com',
    'https://www.pzadvisors.com',
    'https://auth.pzadvisors.com',
    'https://api.pzadvisors.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8081'
  ].join(',')
).split(',').map(o => o.trim()).filter(Boolean);

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
    'X-Debug-Token','x-debug-token'
  ],
  optionsSuccessStatus: 204
}));

/* ──────────────────────────────────────────────────────────────
   1.2) Firestore REST (Service Account)
─────────────────────────────────────────────────────────────── */
const GCP_PROJECT_ID     = process.env.GCP_PROJECT_ID || '';
const GCP_SA_EMAIL       = process.env.GCP_SA_EMAIL || '';
const GCP_SA_PRIVATE_KEY = (process.env.GCP_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const FS_BASE  = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT_ID}/databases/(default)`;
const FS_SCOPE = 'https://www.googleapis.com/auth/datastore';

// Normaliza caminhos: remove barras extras e prefixo "documents/"
function normalizePath(p) {
  return String(p || '').replace(/^\/+|\/+$/g, '').replace(/^documents\//, '');
}

// Gera o "full document name" para APIs que exigem (ex.: transforms)
function makeDocFullName(collectionPath, id) {
  const col = normalizePath(collectionPath);
  return `${FS_BASE}/documents/${col}/${encodeURIComponent(String(id))}`;
}

function ensureSA() {
  if (!GCP_PROJECT_ID || !GCP_SA_EMAIL || !GCP_SA_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')) {
    const miss = {
      project: !!GCP_PROJECT_ID, email: !!GCP_SA_EMAIL, key: !!GCP_SA_PRIVATE_KEY
    };
    const msg = `[FS] Service Account config incompleta: ${JSON.stringify(miss)}`;
    console.error(msg);
    throw Object.assign(new Error('sa_not_configured'), { code: 'sa_not_configured', meta: miss });
  }
}

// Gera access token via Service Account
async function getSAToken() {
  ensureSA();
  const client = new JWT({ email: GCP_SA_EMAIL, key: GCP_SA_PRIVATE_KEY, scopes: [FS_SCOPE] });
  const { token } = await client.authorize();
  return token;
}

// Converte JS → Firestore Value
function fsVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date)      return { timestampValue: v.toISOString() };
  if (typeof v === 'object') {
    const fields = {}; for (const k of Object.keys(v)) fields[k] = fsVal(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

// Create (auto-id): POST /documents/{collection}
async function fsCreate(collectionPath, data) {
  const token = await getSAToken();
  const col = normalizePath(collectionPath);
  const url = `${FS_BASE}/documents/${col}`;
  const body = { fields: {} };
  for (const k of Object.keys(data)) body.fields[k] = fsVal(data[k]);
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`fsCreate ${col} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Upsert (merge): PATCH /documents/{docPath}?allowMissing=true&updateMask.fieldPaths=...
async function fsUpsert(docPath, data) {
  const token = await getSAToken();
  const doc = normalizePath(docPath);
  const url = new URL(`${FS_BASE}/documents/${doc}`);
  url.searchParams.set('allowMissing', 'true');
  const fields = Object.keys(data);
  fields.forEach(f => url.searchParams.append('updateMask.fieldPaths', f));
  const body = { fields: {} };
  for (const k of fields) body.fields[k] = fsVal(data[k]);
  const r = await fetch(url.toString(), { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`fsUpsert ${doc} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Commit com transform REQUEST_TIME: POST /documents:commit
async function fsCommitTransforms(docFullName, fieldPaths = []) {
  if (!fieldPaths.length) return;
  const token = await getSAToken();
  const url = `${FS_BASE}/documents:commit`;
  const writes = [{
    transform: {
      document: docFullName,
      fieldTransforms: fieldPaths.map(fp => ({ fieldPath: fp, setToServerValue: 'REQUEST_TIME' }))
    }
  }];
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ writes }) });
  if (!r.ok) throw new Error(`fsCommitTransforms failed: ${r.status} ${await r.text()}`);
  return r.json();
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

// Body parsers (robustos)
app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));

// Fallback: se body veio como string/sem Content-Type, tenta JSON
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
   3) Rotas básicas / Health / Versão
─────────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => res.status(200).send('🚀 PZ Auth+API Backend ativo. Use /healthz, /api/version ou /auth/google.'));
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
    firestore_auth_mode: 'REST+ServiceAccount',
    has_cookie_parser: Boolean(cookieParser),
    project_id: GCP_PROJECT_ID,
    sa_email: !!GCP_SA_EMAIL
  });
});

// CORS diag
app.get('/api/cors-check', (req, res) => {
  const origin = req.headers.origin || null;
  return res.status(200).json({
    ok:true, rid:req.rid, origin,
    allowed: isAllowedOrigin(origin),
    ua: req.headers['user-agent'] || null,
    ts: new Date().toISOString()
  });
});

/* ──────────────────────────────────────────────────────────────
   3.1) Debug – Credenciais SA
─────────────────────────────────────────────────────────────── */
app.get('/api/debug/env-has-sa', (_req, res) => {
  const hasProj  = !!GCP_PROJECT_ID;
  const hasEmail = !!GCP_SA_EMAIL;
  const hasKey   = !!GCP_SA_PRIVATE_KEY && GCP_SA_PRIVATE_KEY.includes('BEGIN PRIVATE KEY');
  res.status(200).json({ hasProj, hasEmail, hasKey });
});

/* ──────────────────────────────────────────────────────────────
   4) Google OAuth – One Tap
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
    const credential = (typeof body.credential === 'string' && body.credential) ||
                       (typeof body.id_token === 'string' && body.id_token) || null;
    const context = body.context;

    console.log(JSON.stringify({ route:'/auth/google', rid:req.rid, content_type:ct, body_keys:Object.keys(body||{}) }));

    if (!credential) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:false, error:'missing_credential' }));
      return res.status(400).json({ error:'missing_credential' });
    }

    // CSRF (se usar login_uri)
    if (('g_csrf_token' in body) || (req.cookies && 'g_csrf_token' in req.cookies)) {
      const csrfCookie = req.cookies?.g_csrf_token;
      const csrfBody   = body?.g_csrf_token;
      if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) {
        console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:false, error:'csrf_mismatch' }));
        return res.status(400).json({ error:'csrf_mismatch' });
      }
    }

    res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0' });

    // Log leve do token (aud/iss/exp)
    const decoded = decodeJwtPayload(credential) || {};
    if (decoded && decoded.aud) {
      console.log(JSON.stringify({
        route: '/auth/google', rid: req.rid,
        token_aud: decoded.aud, token_iss: decoded.iss || null, token_exp: decoded.exp || null
      }));
    }

    // Verificação (assinatura + audiences)
    const ticket  = await oauthClient.verifyIdToken({ idToken: credential, audience: CLIENT_IDS });
    const payload = ticket.getPayload();
    if (!payload) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:false, error:'invalid_token_empty_payload' }));
      return res.status(401).json({ error:'invalid_token' });
    }

    if (payload.iss && !/accounts\.google\.com$/.test(String(payload.iss))) {
      console.warn(JSON.stringify({ route:'/auth/google', rid:req.rid, warn:'unexpected_issuer', iss: payload.iss }));
    }

    const { sub, email, name, picture, email_verified } = payload;
    const user_id = String(sub);

    // Upsert user (REST) – merge + REQUEST_TIME em last_seen/updated_at
    try {
      await fsUpsert(`users/${encodeURIComponent(user_id)}`, {
        user_id, sub, email: email || null, name: name || null, picture: picture || null,
        email_verified: !!email_verified
      });
      const docName = makeDocFullName('users', user_id);
      await fsCommitTransforms(docName, ['last_seen', 'updated_at']);
    } catch (e) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:true, warn:'firestore_upsert_failed', error:e.message || String(e) }));
    }

    // Event (não bloqueante)
    try {
      await fsCreate('auth_events', {
        type: 'auth_google',
        rid: req.rid,
        trace_id: req.headers['x-trace-id'] || null,
        user_id,
        email: email || null,
        context: context || null,
        ua: req.headers['user-agent'] || null,
        origin: req.headers.origin || null,
        ts: new Date()
      });
    } catch (e) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, warn:'auth_event_log_failed', error:e.message || String(e) }));
    }

    console.log(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:true, user_id, email: email || null }));
    return res.status(200).json({ user_id, email: email || null, name: name || null, picture: picture || null });
  } catch (err) {
    const msg = err?.message || String(err || '');
    let code = 'auth_failed';
    if (/Wrong recipient|audience/.test(msg)) code = 'audience_mismatch';
    if (/expired/i.test(msg))               code = 'token_expired';
    if (/invalid/i.test(msg))               code = 'invalid_token';

    console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:false, error: msg, code }));
    return res.status(401).json({ error: code });
  }
}

app.post('/auth/google', handleAuthGoogle);
app.post('/api/auth/google', handleAuthGoogle);

/* ──────────────────────────────────────────────────────────────
   5) Endpoints auxiliares
─────────────────────────────────────────────────────────────── */
app.post('/api/echo', (req, res) => {
  res.set({ 'Cache-Control':'no-store, no-cache, must-revalidate, private', Pragma:'no-cache', Expires:'0' });
  return res.status(200).json({ ok:true, rid:req.rid, echo:req.body || null, ts:new Date().toISOString() });
});

app.post('/api/track', async (req, res) => {
  try {
    if (!TRACK_OPEN) {
      const tok = req.headers['x-api-token'] || req.headers['X-Api-Token'];
      if (!TRACK_TOKEN || tok !== TRACK_TOKEN) return res.status(403).json({ ok:false, error:'forbidden' });
    }
    const { event, payload } = req.body || {};
    if (!event || typeof event !== 'string') return res.status(400).json({ ok:false, error:'missing_event' });

    await fsCreate('auth_events', {
      type: event,
      rid: req.rid,
      payload: payload || null,
      origin: req.headers.origin || null,
      ua: req.headers['user-agent'] || null,
      ts: new Date()
    });

    return res.status(200).json({ ok:true, rid:req.rid });
  } catch (e) {
    console.error(JSON.stringify({ route:'/api/track', rid:req.rid, error:e.message || String(e) }));
    return res.status(500).json({ ok:false, error:'track_failed' });
  }
});

app.post('/api/debug/ping-fs', async (req, res) => {
  try {
    const tok = req.headers['x-debug-token'] || req.headers['X-Debug-Token'];
    if (!DEBUG_TOKEN || tok !== DEBUG_TOKEN) return res.status(403).json({ ok:false, error:'forbidden' });

    const r = await fsCreate('auth_events', {
      type: 'debug_ping_fs',
      rid: req.rid,
      origin: req.headers.origin || null,
      ts: new Date()
    });

    const id = (r.name || '').split('/').pop() || null;
    return res.status(200).json({ ok:true, rid:req.rid, doc: id });
  } catch (e) {
    console.error(JSON.stringify({ route:'/api/debug/ping-fs', rid:req.rid, error:e.message || String(e) }));
    if (e.code === 'sa_not_configured') return res.status(503).json({ ok:false, error:'sa_not_configured', meta:e.meta });
    return res.status(500).json({ ok:false, error:'ping_failed' });
  }
});

/* ──────────────────────────────────────────────────────────────
   6) Erros globais
─────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason) => { console.error('[UNHANDLED_REJECTION]', reason); });
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT_EXCEPTION]', err); });

/* ──────────────────────────────────────────────────────────────
   7) Start
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
  console.log('   FIRESTORE auth mode        : REST+ServiceAccount');
  console.log('   PROJECT_ID                 :', GCP_PROJECT_ID);
  console.log('   SA_EMAIL set               :', !!GCP_SA_EMAIL);
  console.log('   HAS cookie-parser          :', Boolean(cookieParser));
  console.log('   NODE_ENV                   :', process.env.NODE_ENV || '(not set)');
  console.log('──────────────────────────────────────────────────────────────');
});