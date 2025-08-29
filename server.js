/**
 * PZ Auth+API Backend – Versão 1.6.0 – 2025-08-29 – “Railway-FS-REST”
 *
 * Endpoints:
 * - Healthcheck:        GET/HEAD  /healthz          (alias: GET/HEAD /api/healthz)
 * - Root test:          GET       /
 * - Versão/Status:      GET       /api/version
 * - Auth (Google OTP):  POST      /auth/google      { credential, context? }
 *                        ALIAS:   POST /api/auth/google
 * - Echo (debug leve):  POST      /api/echo
 * - Track (opcional):   POST      /api/track
 * - CORS check (diag):  GET       /api/cors-check
 * - FS ping (diag):     POST      /api/debug/ping-fs  (Requer X-Debug-Token == DEBUG_TOKEN)
 * - SA env check (diag):GET       /api/debug/env-has-sa
 *
 * Novidades v1.6.0:
 *  - 🔄 Firestore via REST + Service Account (sem @google-cloud/firestore / Admin SDK).
 *  - 🧰 Upsert de usuário e criação de eventos preservados (coleções: users, auth_events).
 *  - ⏱️ Timestamps de eventos no backend (ISO) e, quando possível, transform de REQUEST_TIME.
 *  - ⚙️ Mantidas todas as rotas e CORS do 1.5.3.
 */

const express = require('express');
const cors = require('cors');
let cookieParser = null;
try { cookieParser = require('cookie-parser'); }
catch (_) { console.warn('[BOOT] cookie-parser não encontrado; usando parser leve de header (fallback).'); }

const { OAuth2Client } = require('google-auth-library'); // para verificar ID token (front → backend)
const { JWT } = require('google-auth-library');           // para gerar access token da Service Account (backend → Firestore)
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();

/* ──────────────────────────────────────────────────────────────
   1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '1.6.0';
const BUILD_DATE = '2025-08-29';
const PORT = process.env.PORT || 8080;

/**
 * Client IDs aceitos (audiences)
 */
const PRIMARY_CLIENT_ID = '270930304722-pbl5cmp53omohrmfkf9dmicutknf3q95.apps.googleusercontent.com';
const CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID,
  ...(process.env.GOOGLE_CLIENT_IDS ? String(process.env.GOOGLE_CLIENT_IDS).split(',') : []),
  PRIMARY_CLIENT_ID
].map(s => (s || '').trim()).filter(Boolean);

// Origens permitidas
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
   1.1) Firestore REST (Service Account)
─────────────────────────────────────────────────────────────── */
const GCP_PROJECT_ID   = process.env.GCP_PROJECT_ID || '';
const GCP_SA_EMAIL     = process.env.GCP_SA_EMAIL || '';
const GCP_SA_PRIVATE_KEY = (process.env.GCP_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT_ID}/databases/(default)`;
const FS_SCOPE = 'https://www.googleapis.com/auth/datastore';

// Gera access token via Service Account
async function getSAToken() {
  const client = new JWT({
    email: GCP_SA_EMAIL,
    key: GCP_SA_PRIVATE_KEY,
    scopes: [FS_SCOPE],
  });
  const { token } = await client.authorize();
  return token;
}

// Conversor simples JS → Firestore Value
function fsVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'object') {
    // mapValue
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = fsVal(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

// Cria documento (auto-id) → POST /documents/{collection}
async function fsCreate(collection, data) {
  const token = await getSAToken();
  const url = `${FS_BASE}/documents/${collection}`;
  const body = { fields: {} };
  for (const k of Object.keys(data)) body.fields[k] = fsVal(data[k]);
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`fsCreate ${collection} failed: ${r.status} ${await r.text()}`);
  return r.json(); // contém name do doc
}

// Upsert (merge) → PATCH /documents/{docPath}?allowMissing=true&updateMask.fieldPaths=...
async function fsUpsert(docPath, data) {
  const token = await getSAToken();
  const url = new URL(`${FS_BASE}/documents/${docPath}`);
  url.searchParams.set('allowMissing', 'true');
  const mask = Object.keys(data);
  mask.forEach(f => url.searchParams.append('updateMask.fieldPaths', f));
  const body = { fields: {} };
  for (const k of mask) body.fields[k] = fsVal(data[k]);

  const r = await fetch(url.toString(), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`fsUpsert ${docPath} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Commit com transform (REQUEST_TIME) → POST /documents:commit
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
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes })
  });
  if (!r.ok) throw new Error(`fsCommitTransforms failed: ${r.status} ${await r.text()}`);
  return r.json();
}

/* ──────────────────────────────────────────────────────────────
   2) Middlewares
─────────────────────────────────────────────────────────────── */
if (cookieParser) {
  app.use(cookieParser());
} else {
  // Fallback: parser simples de cookies (apenas para g_csrf_token)
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

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const { hostname, protocol } = new URL(origin.trim());
    const host = String(hostname || '').toLowerCase();
    const isLocal = protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1');
    if (isLocal) return true;
    if (host === 'pzadvisors.com' || host === 'www.pzadvisors.com' || host.endsWith('.pzadvisors.com')) {
      return true;
    }
    return allowedOrigins.includes(origin.trim());
  } catch { return false; }
}

app.use(
  cors({
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
  })
);

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
        status: res.statusCode, ms: Date.now()-t0, origin: req.headers.origin || null
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
  const hasProj = !!GCP_PROJECT_ID;
  const hasEmail = !!GCP_SA_EMAIL;
  const hasKey = !!GCP_SA_PRIVATE_KEY && GCP_SA_PRIVATE_KEY.includes('BEGIN PRIVATE KEY');
  res.status(200).json({ hasProj, hasEmail, hasKey });
});

/* ──────────────────────────────────────────────────────────────
   4) Google OAuth – One Tap
─────────────────────────────────────────────────────────────── */
const oauthClient = new OAuth2Client(CLIENT_IDS[0] || PRIMARY_CLIENT_ID);

app.options('/auth/google', (_req, res) => res.sendStatus(204));
app.options('/api/auth/google', (_req, res) => res.sendStatus(204));

// Decode auxiliar (apenas log)
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

    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0'
    });

    // Log leve do token (aud/iss/exp)
    const decoded = decodeJwtPayload(credential) || {};
    if (decoded && decoded.aud) {
      console.log(JSON.stringify({
        route: '/auth/google', rid: req.rid,
        token_aud: decoded.aud, token_iss: decoded.iss || null, token_exp: decoded.exp || null
      }));
    }

    // Verificação (assinatura + audience)
    const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience: CLIENT_IDS });
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
      // 1) upsert campos principais
      await fsUpsert(`documents/users/${encodeURIComponent(user_id)}`, {
        user_id, sub, email: email || null, name: name || null, picture: picture || null,
        email_verified: !!email_verified
      });

      // 2) aplica transform REQUEST_TIME em last_seen/updated_at
      const docName = `${FS_BASE}/documents/users/${encodeURIComponent(user_id)}`;
      await fsCommitTransforms(docName, ['last_seen', 'updated_at']);
    } catch (e) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:true, warn:'firestore_upsert_failed', error:e.message || String(e) }));
    }

    // Event (não bloqueante) – cria doc em auth_events
    try {
      await fsCreate('documents/auth_events', {
        type: 'auth_google',
        rid: req.rid,
        trace_id: req.headers['x-trace-id'] || null,
        user_id,
        email: email || null,
        context: context || null,
        ua: req.headers['user-agent'] || null,
        origin: req.headers.origin || null,
        ts: new Date() // backend time
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
    if (/expired/i.test(msg)) code = 'token_expired';
    if (/invalid/i.test(msg)) code = 'invalid_token';

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

    await fsCreate('documents/auth_events', {
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

    const r = await fsCreate('documents/auth_events', {
      type: 'debug_ping_fs',
      rid: req.rid,
      origin: req.headers.origin || null,
      ts: new Date()
    });

    // r.name = full path do documento criado
    const id = (r.name || '').split('/').pop() || null;
    return res.status(200).json({ ok:true, rid:req.rid, doc: id });
  } catch (e) {
    console.error(JSON.stringify({ route:'/api/debug/ping-fs', rid:req.rid, error:e.message || String(e) }));
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