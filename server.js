/**
 * PZ Auth+API Backend – Version 5.5.2 (Robustness Hotfix) – 2025-10-14
 *
 * - CORREÇÃO CRÍTICA: Adiciona uma verificação de segurança para lidar com utilizadores sem nome.
 * - O erro 'Cannot read properties of undefined (reading 'split')' ocorria quando um utilizador
 * autenticado não tinha um campo 'name' no seu registo do Firebase.
 * - Este hotfix garante que a variável 'name' seja tratada como uma string vazia nesse caso, evitando o crash.
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
const VERSION = '5.5.2 (Robustness Hotfix)';
const BUILD_DATE = '2025-10-14';
const PORT = process.env.PORT || 8080;

// (O resto da configuração de vars permanece o mesmo)
const PRIMARY_CLIENT_ID = '270930304722-pbl5cmp53omohrmfkf9dmicutknf3q95.apps.googleusercontent.com';
const CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID,
  ...(process.env.GOOGLE_CLIENT_IDS ? String(process.env.GOOGLE_CLIENT_IDS).split(',') : []),
  PRIMARY_CLIENT_ID
].map(s => (s || '').trim()).filter(Boolean);

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

// (As seções de CORS, Service Account e Middlewares permanecem as mesmas)
// ... (código omitido para brevidade, mantenha o seu código original aqui)
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

if (cookieParser) { app.use(cookieParser()); }
app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next(); if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return next(); let data = ''; req.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); }); req.on('end', () => { if (!req.body || typeof req.body !== 'object') { if (data && /^[\s{\[]/.test(data)) { try { req.body = JSON.parse(data); } catch { /* ignore */ } } } next(); }); });
app.use((req, res, next) => { const rid = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; req.rid = rid; res.setHeader('X-Trace-Id', rid); res.setHeader('X-PZ-Version', `PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`); res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'); next(); });
app.use((req, res, next) => { const t0 = Date.now(); res.on('finish', () => { try { console.log(JSON.stringify({ rid: req.rid, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, origin: req.headers.origin || null })); } catch {} }); next(); });

// (A rota /auth/google e outras rotas auxiliares permanecem as mesmas)
// ... (código omitido para brevidade, mantenha o seu código original aqui)
app.post('/auth/google', async (req, res) => {
    // ...
});

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
        const { email, name } = userData; // 'name' pode ser undefined aqui
        if (!email) return res.status(400).json({ ok: false, error: 'user_has_no_email' });

        // --- INÍCIO DA CORREÇÃO ---
        // Garante que 'fullName' seja sempre uma string, mesmo que 'name' seja nulo ou indefinido.
        const fullName = (typeof name === 'string' ? name : '').trim();
        const firstName = fullName ? fullName.split(/\s+/)[0] : '';
        // --- FIM DA CORREÇÃO ---
        
        const subscriberData = {
            email: email,
            first_name: firstName,
        };
        
        // Mantém a chamada à função antiga para ser compatível com o marketingAutomator.js v2.0.0
        await marketingAutomator.addSubscriberToFunnel(subscriberData);
        
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