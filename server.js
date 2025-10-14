/**
 * PZ Auth+API Backend – Versão 4.2.0 – 2025-09-29
 *
 * - Confirmação e versionamento da lógica de integração com ConvertKit.
 * - Nenhuma alteração funcional em relação à v4.1.0, pois a implementação
 * do funil de captura de leads já está correta e estável.
 * - Preserva toda a base de código da versão 4.1.0.
 */

const express = require('express');
const cors = require('cors');
let cookieParser = null;
try { cookieParser = require('cookie-parser'); } catch (_) { console.warn('[BOOT] cookie-parser não encontrado; segue sem.'); }

const { OAuth2Client, JWT } = require('google-auth-library');
const admin = require('firebase-admin');

// Importa o módulo de automação de marketing
const marketingAutomator = require('./marketingAutomator');

// fetch (fallback para Node < 18)
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();

/* ──────────────────────────────────────────────────────────────
   1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '4.2.0';
const BUILD_DATE = '2025-09-29';
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

let GCP_PROJECT_ID     = SA_JSON?.project_id    || '';
let GCP_SA_EMAIL       = SA_JSON?.client_email  || '';
let GCP_SA_PRIVATE_KEY = SA_JSON?.private_key   || '';

GCP_PROJECT_ID     = process.env.GCP_PROJECT_ID     || GCP_PROJECT_ID || '';
GCP_SA_EMAIL       = process.env.GCP_SA_EMAIL       || GCP_SA_EMAIL   || '';
GCP_SA_PRIVATE_KEY = process.env.GCP_SA_PRIVATE_KEY || GCP_SA_PRIVATE_KEY || '';

if (GCP_SA_PRIVATE_KEY) GCP_SA_PRIVATE_KEY = String(GCP_SA_PRIVATE_KEY).replace(/\\n/g, '\n');

function ensureSA() {
  const miss = { project: !!GCP_PROJECT_ID, email  : !!GCP_SA_EMAIL, key: !!GCP_SA_PRIVATE_KEY && GCP_SA_PRIVATE_KEY.includes('BEGIN PRIVATE KEY') };
  if (!miss.project || !miss.email || !miss.key) {
    const msg = `[FS] Service Account incompleta: ${JSON.stringify(miss)} (source=${SA_SOURCE})`;
    console.error(msg);
    const err = new Error('sa_not_configured');
    err.code = 'sa_not_configured';
    err.meta = { ...miss, source: SA_SOURCE };
    throw err;
  }
}

let _adminInited = false;
function initAdmin() {
  if (_adminInited) return;
  ensureSA();
  admin.initializeApp({
    credential: admin.credential.cert({ projectId: GCP_PROJECT_ID, clientEmail: GCP_SA_EMAIL, privateKey: GCP_SA_PRIVATE_KEY }),
    projectId: GCP_PROJECT_ID
  });
  _adminInited = true;
  console.log('[ADMIN] Firebase Admin inicializado (project:', GCP_PROJECT_ID, ')');
}

function getDB() { initAdmin(); return admin.firestore(); }
const FieldValue = admin.firestore.FieldValue;


/* ──────────────────────────────────────────────────────────────
   2) Middlewares
─────────────────────────────────────────────────────────────── */
if (cookieParser) {
  app.use(cookieParser());
} else {
  app.use((req, res, next) => {
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

app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return next();
  let data = '';
  req.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    if (!req.body || typeof req.body !== 'object') {
      if (data && /^[\s{\[]/.test(data)) {
        try { req.body = JSON.parse(data); } catch { /* ignore */ }
      }
    }
    next();
  });
});

app.use((req, res, next) => {
  const rid = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  req.rid = rid;
  res.setHeader('X-Trace-Id', rid);
  res.setHeader('X-PZ-Version', `PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`);
  res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  next();
});

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

function deriveDayParts(tsISO, tzOffsetMin) {
  let d = tsISO ? new Date(tsISO) : new Date();
  const tz = Number.isFinite(+tzOffsetMin) ? +tzOffsetMin : 0;
  if (tz !== 0) d = new Date(d.getTime() + tz * 60 * 1000);
  return { y: d.getUTCFullYear(), m: zeroPad(d.getUTCMonth() + 1), d: zeroPad(d.getUTCDate()) };
}

function deriveDayLabel(tsISO, tzOffsetMin) {
  const p = deriveDayParts(tsISO, tzOffsetMin);
  return `${p.y}-${p.m}-${p.d}`;
}

function parseClientTimestamp(val) {
  try {
    if (!val) return null;
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return admin.firestore.Timestamp.fromDate(d);
  } catch { return null; }
}

function toPlainJSON(obj) {
  try { return JSON.parse(JSON.stringify(obj || null)); }
  catch { return null; }
}

async function upsertDailyFact({ db, anon_id, user_id, tz_offset, event, page, session_id, payload, tsISO }) {
  const safeAnon = (anon_id && typeof anon_id === 'string') ? anon_id : 'anon_unknown';
  const tz = Number.isFinite(+tz_offset) ? +tz_offset : 0;
  const day = deriveDayLabel(tsISO, tz);
  const docId = `${safeAnon}_${day}`;
  const docRef = db.collection('daily_facts').doc(docId);

  const event_id = `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  const newEvent = toPlainJSON({
    event,
    event_id,
    ts_server: FieldValue.serverTimestamp(),
    ts_client: parseClientTimestamp(tsISO),
    tz_offset: Number.isFinite(tz) ? tz : null,
    page,
    session_id,
    payload: payload
  });

  const updatePayload = {
    updated_at: FieldValue.serverTimestamp(),
    events: FieldValue.arrayUnion(newEvent),
    ['counters.' + event]: FieldValue.increment(1),
    ...(user_id ? { user_id, person_id: user_id } : {})
  };

  try {
    await docRef.update(updatePayload);
  } catch (error) {
    if (error.message && error.message.includes('NOT_FOUND')) {
      const seedPayload = {
        kind: 'user',
        date: day,
        entity_id: safeAnon,
        anon_id: safeAnon,
        person_id: (user_id && typeof user_id === 'string') ? user_id : safeAnon,
        ...(user_id ? { user_id } : {}),
        ...(Number.isFinite(tz) ? { tz_offset: tz } : {}),
        events: [newEvent],
        counters: { [event]: 1 },
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp()
      };
      await docRef.set(seedPayload);
    } else {
      console.error(JSON.stringify({
          tag: 'upsert_daily_fact_failed',
          docId,
          error: error.message || String(error)
      }));
      throw error;
    }
  }

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
    project_id: process.env.GCP_PROJECT_ID || null,
    facts_collection: 'daily_facts',
    facts_doc_pattern: 'anon_id_YYYY-MM-DD'
  });
});

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
      event: 'debug_write',
      page: '/debug',
      session_id: null,
      payload: { note: (req.body && req.body.note) || 'manual' },
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
   5) Google OAuth – One Tap
─────────────────────────────────────────────────────────────── */
const oauthClient = new OAuth2Client(CLIENT_IDS[0] || PRIMARY_CLIENT_ID);

app.options('/auth/google', (_req, res) => res.sendStatus(204));
app.options('/api/auth/google', (_req, res) => res.sendStatus(204));

async function handleAuthGoogle(req, res) {
  try {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    const body = req.body || {};
    const credential = (typeof body.credential === 'string' && body.credential) || (typeof body.id_token === 'string' && body.id_token) || null;
    const context = body.context || {}; 

    console.log(JSON.stringify({ route:'/auth/google', rid:req.rid, content_type:ct, has_credential: !!credential }));

    if (!credential) return res.status(400).json({ error:'missing_credential' });

    if (('g_csrf_token' in body) || (req.cookies && 'g_csrf_token' in req.cookies)) {
      const csrfCookie = req.cookies?.g_csrf_token;
      const csrfBody   = body?.g_csrf_token;
      if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) return res.status(400).json({ error:'csrf_mismatch' });
    }

    res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0' });

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

app.post('/api/track', async (req, res) => {
  try {
    if (!TRACK_OPEN) {
      const tok = req.headers['x-api-token'] || req.headers['X-Api-Token'];
      if (!TRACK_TOKEN || tok !== TRACK_TOKEN) return res.status(403).json({ ok:false, error:'forbidden' });
    }

    const { event, payload } = req.body || {};
    if (!event || typeof event !== 'string') return res.status(400).json({ ok:false, error:'missing_event' });

    const anon_id   = payload?.anon_id || req.body?.anon_id || 'anon_unknown';
    const user_id   = payload?.user_id || null;
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
      payload: (() => {
        const p = { ...payload };
        delete p.ts; delete p.tz_offset; delete p.page; delete p.session_id; delete p.user_id; delete p.anon_id; delete p.context;
        return toPlainJSON(p);
      })(),
      tsISO: tsISO || new Date().toISOString()
    });

    return res.status(200).json({ ok:true, rid:req.rid });
  } catch (e) {
    console.error(JSON.stringify({ route:'/api/track', rid:req.rid, error:e.message || String(e) }));
    return res.status(500).json({ ok:false, error:'track_failed' });
  }
});

/* ──────────────────────────────────────────────────────────────
   ENDPOINT DO FUNIL DE LEAD MAGNET
─────────────────────────────────────────────────────────────── */
app.post('/api/send-guide', async (req, res) => {
    try {
        const { user_id, anon_id, utms } = req.body;
        if (!user_id) return res.status(400).json({ ok: false, error: 'missing_user_id' });

        const db = getDB();
        const userDoc = await db.collection('users').doc(String(user_id)).get();
        if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        
        const userData = userDoc.data();
        const { email, name } = userData;
        if (!email) return res.status(400).json({ ok: false, error: 'user_has_no_email' });

        // Lógica de separação do nome completo
        let firstName = name || '';
        let lastName = '';
        const nameParts = (name || '').trim().split(/\s+/);
        if (nameParts.length > 1) {
            firstName = nameParts[0];
            lastName = nameParts.slice(1).join(' ');
        }

        const params = new URLSearchParams({
            uid: user_id,
            anon_id: anon_id || 'anon_from_email',
            utm_source: utms?.utm_source || 'convertkit',
            utm_medium: 'ebook-cta',
            utm_campaign: utms?.utm_campaign || 'lead-magnet-guide'
        });
        const dynamicUrl = `https://pzadvisors.com/eroxcel-com-latam-text-en-bridge/?${params.toString()}`;

        // Prepara os dados para o ConvertKit com os nomes separados
        const subscriberData = {
            email: email,
            first_name: firstName,
            fields: {
                last_name: lastName,
                dynamic_cta_url: dynamicUrl
            }
        };
        
        await marketingAutomator.addSubscriberToFunnel(subscriberData);
        
        // Loga o evento de sucesso na nossa base (daily_facts)
        await upsertDailyFact({
            db,
            anon_id: anon_id || 'anon_unknown',
            user_id: user_id,
            event: 'convertkit_subscribe_success',
            page: '/free-guide',
            payload: { email, tagId: process.env.CONVERTKIT_TAG_ID },
            tsISO: new Date().toISOString()
        });

        res.status(200).json({ ok: true, message: 'subscriber_added_to_funnel' });

    } catch (e) {
        console.error(JSON.stringify({
            route: '/api/send-guide',
            rid: req.rid,
            error: e.message || String(e)
        }));
        res.status(500).json({ ok: false, error: 'funnel_integration_failed' });
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
  console.log('   SA_EMAIL set               :', !!GCP_SA_EMAIL, `(source=${SA_SOURCE})`);
  console.log('   HAS cookie-parser          :', Boolean(cookieParser));
  console.log('   NODE_ENV                   :', process.env.NODE_ENV || '(not set)');
  console.log('──────────────────────────────────────────────────────────────');
});