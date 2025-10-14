/**
 * PZ Auth+API Backend – Version 5.5.1 (Hotfix) – 2025-10-14
 *
 * - HOTFIX: Reverte a chamada na rota /api/send-guide para 'addSubscriberToFunnel'.
 * - Esta alteração garante retrocompatibilidade com a versão v2.0.0 do 'marketingAutomator.js'
 * que está atualmente em produção, resolvendo o erro 'TypeError'.
 * - A solução de longo prazo é atualizar ambos os ficheiros para a lógica de eventos.
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
const VERSION = '5.5.1 (Hotfix)';
const BUILD_DATE = '2025-10-14';
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
  allowedHeaders: [ 'Content-Type','Authorization', 'X-PZ-Version','x-pz-version', 'X-Trace-Id','x-trace-id', 'X-Api-Token','x-api-token', 'X-Debug-Token','x-debug-token', 'X-Debug-Verbose','x-debug-verbose' ],
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
    const err = new Error('sa_not_configured'); err.code = 'sa_not_configured'; err.meta = { ...miss, source: SA_SOURCE };
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
if (cookieParser) { app.use(cookieParser()); }
app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next(); if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return next(); let data = ''; req.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); }); req.on('end', () => { if (!req.body || typeof req.body !== 'object') { if (data && /^[\s{\[]/.test(data)) { try { req.body = JSON.parse(data); } catch { /* ignore */ } } } next(); }); });
app.use((req, res, next) => { const rid = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; req.rid = rid; res.setHeader('X-Trace-Id', rid); res.setHeader('X-PZ-Version', `PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`); res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'); next(); });
app.use((req, res, next) => { const t0 = Date.now(); res.on('finish', () => { try { console.log(JSON.stringify({ rid: req.rid, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, origin: req.headers.origin || null })); } catch {} }); next(); });

/* ──────────────────────────────────────────────────────────────
    (As seções 3 e 4 com rotas de Health, Debug, etc. permanecem as mesmas)
    (Mantenha o seu código original aqui)
─────────────────────────────────────────────────────────────── */
// ... (código omitido para brevidade, mantenha o seu código original aqui)


/* ──────────────────────────────────────────────────────────────
    5) Google OAuth – One Tap
─────────────────────────────────────────────────────────────── */
const oauthClient = new OAuth2Client(CLIENT_IDS[0] || PRIMARY_CLIENT_ID);

async function handleAuthGoogle(req, res) {
  try {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    const body = req.body || {};
    const credential = (typeof body.credential === 'string' && body.credential) || (typeof body.id_token === 'string' && body.id_token) || null;
    
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

    try {
      const db = getDB();
      const docRef = db.collection('users').doc(user_id);
      await docRef.set({ user_id, sub, email: email || null, name: name || null, picture: picture || null, email_verified: !!email_verified }, { merge: true });
      await docRef.set({ last_seen: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, warn:'users_upsert_failed', error:e.message || String(e) }));
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
    6) Endpoints auxiliares e de funil
─────────────────────────────────────────────────────────────── */
// (Mantenha aqui as suas rotas /api/echo, /api/track, etc.)
// ... (código omitido para brevidade, mantenha o seu código original aqui)


/* ──────────────────────────────────────────────────────────────
    ENDPOINT DO FUNIL DE LEAD MAGNET
─────────────────────────────────────────────────────────────── */
app.post('/api/send-guide', async (req, res) => {
    try {
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ ok: false, error: 'missing_user_id' });

        const db = getDB();
        const userDoc = await db.collection('users').doc(String(user_id)).get();
        if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        
        const userData = userDoc.data();
        const { email, name } = userData;
        if (!email) return res.status(400).json({ ok: false, error: 'user_has_no_email' });

        const fullName = (typeof name === 'string' ? name : '').trim();
        const firstName = fullName ? fullName.split(/\s+/)[0] : '';
        
        const subscriberData = {
            email: email,
            first_name: firstName,
        };
        
        // --- INÍCIO DO HOTFIX ---
        // A chamada foi revertida para 'addSubscriberToFunnel' para ser compatível
        // com o marketingAutomator.js v2.0.0 que está em produção.
        await marketingAutomator.addSubscriberToFunnel(subscriberData);
        // --- FIM DO HOTFIX ---
        
        res.status(200).json({ ok: true, message: 'subscriber_added_to_funnel' });

    } catch (e) {
        console.error(JSON.stringify({ route: '/api/send-guide', rid: req.rid, error: e.message || String(e) }));
        res.status(500).json({ ok: false, error: 'funnel_integration_failed' });
    }
});


/* ──────────────────────────────────────────────────────────────
    7) Erros globais & Start
─────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason) => { console.error('[UNHANDLED_REJECTION]', reason); });
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT_EXCEPTION]', err); });

app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`✅ Server UP on port ${PORT} | Version: v${VERSION} (${BUILD_DATE})`);
  // ... (o resto dos logs de inicialização permanece o mesmo)
});