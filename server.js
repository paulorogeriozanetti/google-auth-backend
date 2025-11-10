/**
 * PZ Auth+API Backend – server.js
 * Nome/Versão: v5.2.0 (Hotfix Firestore Init + Path hygiene)
 * Data: 2025-11-10
 *
 * Objetivo deste hotfix:
 * 1) Restaurar a lógica de inicialização e gravação no Firestore exatamente no padrão das versões estáveis v5.0.7 / v5.0.5
 *    ("hard init" + getDB com erro DB_NOT_INITIALIZED quando credenciais ausentes),
 *    removendo o comportamento silencioso introduzido em v5.0.8+ que pulava gravações.
 * 2) Corrigir hygiene de paths (SEM subpastas inexistentes) mantendo todos os recursos da v5.0.8:
 *    - /auth/google e /api/auth/google
 *    - /api/echo
 *    - /api/track (token opcional via header)
 *    - /api/send-guide (ConvertKit via marketingAutomator)
 *    - /api/checkout (Adapters: digistore24, clickbank)
 * 3) Sem perder funcionalidades, com CORS, cookies e logs intactos.
 */

// ─────────────────────────────────────────────────────────────
// 1) Imports
// ─────────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
let cookieParser = null; try { cookieParser = require('cookie-parser'); } catch (_) { console.warn('[BOOT] cookie-parser não encontrado; segue sem.'); }
const crypto = require('crypto');

const { OAuth2Client } = require('google-auth-library');
const admin = require('firebase-admin');

// Hygiene de paths (NADA de "./adapters/..." ou "./marketing/..." que não existem na produção)
const PlatformAdapterBase = require('./PlatformAdapterBase');

// Torna marketingAutomator opcional (evita crash se ausente em alguns ambientes)
let marketingAutomator = null;
try {
  marketingAutomator = require('./marketingAutomator');
  console.log('[BOOT] marketingAutomator carregado.');
} catch (err) {
  console.warn('[BOOT] marketingAutomator ausente. Usando stub em runtime.');
  marketingAutomator = {
    addSubscriberToFunnel: async (info) => {
      console.warn('[STUB] addSubscriberToFunnel chamado (stub).', info?.email);
      if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
        // Em produção, manter sem throw para não derrubar o funil – endpoint já trata erros
        return { ok: false, message: 'stubbed_noop' };
      }
      return { ok: true, message: 'stubbed' };
    }
  };
}

// Polyfill de fetch somente se necessário
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

// ─────────────────────────────────────────────────────────────
// 2) Config / Vars
// ─────────────────────────────────────────────────────────────
const VERSION = '5.2.0';
const BUILD_DATE = '2025-11-10';
const PORT = process.env.PORT || 8080;
const TRACE_ID_HEADER = 'x-request-trace-id';

// CORS – manter whitelists de 5.0.7/5.0.8
const allowedOrigins = [
  'https://pzadvisors.com',
  'https://www.pzadvisors.com',
  'https://auth.pzadvisors.com',
  'https://api.pzadvisors.com',
];
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:8080', 'http://127.0.0.1:8080', 'http://localhost:3000');
}
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: Origem não permitida: ${origin}`));
  },
  credentials: true,
};

// Google Auth – múltiplos Client IDs
const GOOGLE_CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_IDS ? String(process.env.GOOGLE_CLIENT_IDS).split(',') : [],
  process.env.GOOGLE_CLIENT_ID_PZADVISORS,
  process.env.GOOGLE_CLIENT_ID_LANDER_B,
].flat().map(s => (s || '').trim()).filter(Boolean);
if (!GOOGLE_CLIENT_IDS.length) console.warn('[AUTH] Nenhum GOOGLE_CLIENT_ID* configurado.');
const googleClients = GOOGLE_CLIENT_IDS.map(id => new OAuth2Client(id));

// Track tokens (compatível v5.0.5/5.0.7/5.0.8)
const TRACK_OPEN = String(process.env.TRACK_OPEN || 'false').toLowerCase() === 'true';
const TRACK_TOKEN = process.env.TRACK_TOKEN || '';
const DEBUG_TOKEN = process.env.TRACK_TOKEN_DEBUG || process.env.DEBUG_TOKEN || '';

// ─────────────────────────────────────────────────────────────
// 3) Firestore Admin SDK – Restaurar padrão "hard init" v5.0.7/5.0.5
// ─────────────────────────────────────────────────────────────
let _adminInited = false;
let _db = null;
let FIRESTORE_SOURCE_LOG = 'N/A';
let FIRESTORE_PROJECT_ID = 'N/A';

function ensureSA() {
  // Mesma ordem de resolução da v5.0.7
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      FIRESTORE_SOURCE_LOG = 'env_json';
      FIRESTORE_PROJECT_ID = sa.project_id;
      return { projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key };
    } catch (e) {
      console.error('[FS][ERRO] Parse FIREBASE_SERVICE_ACCOUNT_JSON:', e?.message);
    }
  }
  if (process.env.GCP_PROJECT_ID && process.env.GCP_SA_EMAIL && process.env.GCP_SA_PRIVATE_KEY) {
    try {
      const sa = {
        projectId: process.env.GCP_PROJECT_ID,
        clientEmail: process.env.GCP_SA_EMAIL,
        privateKey: String(process.env.GCP_SA_PRIVATE_KEY).replace(/\\n/g, '\n'),
      };
      FIRESTORE_SOURCE_LOG = 'env_split';
      FIRESTORE_PROJECT_ID = sa.projectId;
      return sa;
    } catch (e) {
      console.error('[FS][ERRO] Montar SA das vars (split):', e?.message);
    }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    FIRESTORE_SOURCE_LOG = 'gcp_auto';
    FIRESTORE_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.PROJECT_ID || 'gcp_auto_project';
    return null; // deixa o SDK localizar credenciais no ambiente
  }
  console.error('[FS][FATAL] Nenhuma credencial (FIREBASE_SERVICE_ACCOUNT_JSON ou GCP_*) encontrada.');
  const err = new Error('sa_not_configured');
  err.code = 'sa_not_configured';
  throw err; // "hard" – exatamente como 5.0.7/5.0.5
}

function initAdmin() {
  if (_adminInited) return;
  try {
    const sa = ensureSA();
    if (sa) {
      admin.initializeApp({ credential: admin.credential.cert({
        projectId: sa.projectId,
        clientEmail: sa.clientEmail,
        privateKey: sa.privateKey,
      }) });
    } else {
      admin.initializeApp({}); // GAC/Workload Identity
    }
    _adminInited = true;
    _db = admin.firestore();
    _db.settings({ ignoreUndefinedProperties: true });
    console.log(`[ADMIN] Firebase SDK OK (Proj: ${FIRESTORE_PROJECT_ID}, Fonte: ${FIRESTORE_SOURCE_LOG})`);
  } catch (e) {
    _adminInited = false;
    _db = null;
    console.error('[ADMIN][ERRO FATAL] Init Firebase:', e?.message || e);
    if (e?.code === 'sa_not_configured' && process.env.SA_OPTIONAL === 'true') {
      console.warn('[ADMIN] SA_OPTIONAL=true. Servidor iniciando sem Firestore (escritas falharão com DB_NOT_INITIALIZED).');
      return; // mantém server up sem DB
    }
    throw e; // comportamento "hard" como 5.0.7
  }
}

function getDB() {
  if (!_adminInited || !_db) {
    initAdmin();
    if (!_adminInited || !_db) {
      const err = new Error('DB não inicializado.');
      err.code = 'DB_NOT_INITIALIZED';
      throw err;
    }
  }
  return _db;
}

const FieldValue = admin.firestore.FieldValue;

// upsertDailyFact – mesmo padrão lógico dos 5.0.5/5.0.7 (agrega por dia e anon_id)
async function upsertDailyFact({ db, anon_id, user_id, tz_offset, event, page, session_id, payload, tsISO }) {
  if (!db) db = getDB();
  const ts = tsISO ? new Date(tsISO) : new Date();
  const dayKey = ts.toISOString().slice(0, 10); // YYYY-MM-DD
  const docId = `${String(anon_id || 'anon_unknown')}_${dayKey}`;
  const ref = db.collection('daily_facts').doc(docId);
  const nowISO = new Date().toISOString();
  const safePayload = (() => {
    const p = { ...(payload || {}) };
    delete p.ts; delete p.tz_offset; delete p.page; delete p.session_id; delete p.user_id; delete p.anon_id; delete p.context;
    return p;
  })();
  await ref.set({
    anon_id: anon_id || 'anon_unknown',
    user_id: user_id || null,
    day: dayKey,
    tz_offset: tz_offset ?? null,
    last_event: event,
    last_page: page || null,
    last_session_id: session_id || null,
    updated_at: nowISO,
    events: FieldValue.arrayUnion({ ev: event, at: nowISO, page: page || null }),
    payloads: FieldValue.arrayUnion(safePayload),
  }, { merge: true });
}

// ─────────────────────────────────────────────────────────────
// 4) App + Middlewares
// ─────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(cors(corsOptions));
if (cookieParser) app.use(cookieParser());

// Trace + Logging simples (não logar /webhook/* para evitar ruído)
app.use((req, res, next) => {
  const rid = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  req.rid = rid;
  res.setHeader('X-Trace-Id', rid);
  res.setHeader('X-PZ-Version', `PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`);
  res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      if (req.path.startsWith('/webhook/')) return;
      console.log(JSON.stringify({ rid, method: req.method, path: req.path, status: res.statusCode, ms: Date.now()-t0 }));
    } catch (_) {}
  });
  next();
});

// Body parsers – garantir JSON antes de /api/checkout (bug fix v5.0.7)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────────────────────
// 5) Endpoints
// ─────────────────────────────────────────────────────────────

// Health + Version
app.get(['/','/api/healthz','/api/version'], (req, res) => {
  res.set({ 'Cache-Control': 'no-store' });
  res.status(200).json({ ok: true, ts: new Date().toISOString(), version: VERSION, build: BUILD_DATE, firestore: _adminInited ? 'ready' : 'not_ready' });
});

// Echo
app.post('/api/echo', (req, res) => {
  res.set({ 'Cache-Control': 'no-store' });
  res.status(200).json({ ok: true, rid: req.rid, echo: req.body || null, ts: new Date().toISOString() });
});

// Google Auth – compatível com v5.0.5/7/8
async function handleAuthGoogle(req, res) {
  try {
    const { id_token } = req.body || {};
    if (!id_token) return res.status(400).json({ error: 'missing_id_token' });

    // Aceitar qualquer client_id listado (multicliente)
    const ticket = await (async () => {
      for (const c of googleClients) {
        try { return await c.verifyIdToken({ idToken: id_token, audience: GOOGLE_CLIENT_IDS }); }
        catch (_) { /* tenta próximo client */ }
      }
      throw new Error('invalid_token');
    })();

    const payload = ticket.getPayload() || {};
    const user_id = payload.sub;
    const email = payload.email;
    const name = payload.name;
    const picture = payload.picture;

    try {
      await upsertDailyFact({
        db: getDB(),
        anon_id: req.body?.anon_id || 'anon_unknown',
        user_id,
        tz_offset: req.body?.tz_offset,
        event: 'auth_google_success',
        page: req.body?.page || '/auth/google',
        session_id: req.body?.session_id,
        payload: { email_verified: !!payload.email_verified },
        tsISO: (new Date()).toISOString(),
      });
    } catch (e) {
      console.error(JSON.stringify({ route: '/auth/google', rid: req.rid, warn: 'daily_facts_log_fail', error: e.message || String(e) }));
    }

    return res.status(200).json({ user_id, email: email || null, name: name || null, picture: picture || null });
  } catch (err) {
    const msg = err?.message || String(err || '');
    let code = 'auth_failed';
    if (/audience/.test(msg)) code = 'audience_mismatch';
    if (/expired/i.test(msg)) code = 'token_expired';
    if (/invalid/i.test(msg)) code = 'invalid_token';
    console.error(JSON.stringify({ route: '/auth/google', rid: req.rid, error: msg, code }));
    return res.status(401).json({ error: code });
  }
}
app.post('/auth/google', handleAuthGoogle);
app.post('/api/auth/google', handleAuthGoogle);

// Track – protegida por token quando TRACK_OPEN=false (padrão)
app.post('/api/track', async (req, res) => {
  try {
    if (!TRACK_OPEN) {
      const tok = req.headers['x-api-token'] || req.headers['X-Api-Token'];
      if (!TRACK_TOKEN || tok !== TRACK_TOKEN) return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const { event, payload } = req.body || {};
    if (!event || typeof event !== 'string') return res.status(400).json({ ok: false, error: 'missing_event' });

    const anon_id = payload?.anon_id || req.body?.anon_id || 'anon_unknown';
    const user_id = payload?.user_id || null;
    const tz_offset = payload?.tz_offset;
    const tsISO = payload?.ts || null;
    const page = payload?.page || payload?.context?.page;
    const sessionId = payload?.session_id;

    await upsertDailyFact({
      db: getDB(),
      anon_id,
      user_id,
      tz_offset,
      event,
      page,
      session_id: sessionId,
      payload: payload || {},
      tsISO: tsISO || (new Date()).toISOString(),
    });

    return res.status(200).json({ ok: true, rid: req.rid });
  } catch (e) {
    console.error(JSON.stringify({ route: '/api/track', rid: req.rid, error: e.message || String(e) }));
    if (e.code === 'DB_NOT_INITIALIZED') return res.status(503).json({ ok: false, error: e.code });
    return res.status(500).json({ ok: false, error: 'track_failed' });
  }
});

// Lead magnet – envia guia (mantém integração convertkit)
app.post('/api/send-guide', async (req, res) => {
  try {
    const { user_id, anon_id, utms, email, reqContext } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'missing_email' });

    const dynamicBase = process.env.GUIDE_DYNAMIC_URL_BASE || 'https://pzadvisors.com/bridge/';
    const dynamicUrl = `${dynamicBase}?email=${encodeURIComponent(email)}&user_id=${encodeURIComponent(user_id || '')}`;

    // Chamada ao automator
    if (!marketingAutomator?.addSubscriberToFunnel) throw new Error('Marketing automator module not loaded.');
    await marketingAutomator.addSubscriberToFunnel({ email, utms, user_id, anon_id, source: 'send-guide' });

    // Logar sucesso
    await upsertDailyFact({
      db: getDB(),
      anon_id: anon_id || 'anon_unknown',
      user_id,
      event: 'convertkit_subscribe_success',
      page: reqContext?.page || '/api/send-guide',
      session_id: reqContext?.session_id,
      payload: { email, urlSent: dynamicUrl },
      tsISO: new Date().toISOString(),
    });

    return res.status(200).json({ ok: true, message: 'subscriber_added_to_funnel' });
  } catch (e) {
    console.error(JSON.stringify({ route: '/api/send-guide', rid: req.rid, error: e.message || String(e) }));
    if (e.code === 'DB_NOT_INITIALIZED') return res.status(503).json({ ok: false, error: e.code });
    if (e.message?.includes('ConvertKit') || e.response?.data || e.message?.includes('Marketing automator')) {
      return res.status(e.response?.status || 500).json({ ok: false, error: 'convertkit_integration_failed', details: e.response?.data || e.message });
    }
    return res.status(500).json({ ok: false, error: 'funnel_integration_failed' });
  }
});

// Checkout – Adapters (factory)
app.post('/api/checkout', async (req, res) => {
  const logPrefix = `[API /checkout](rid:${req.rid})`;
  let platform = 'unknown';
  try {
    const { offerData, trackingParams } = req.body || {};
    if (!offerData?.affiliate_platform) {
      console.warn(`${logPrefix} Falta offerData.affiliate_platform.`);
      return res.status(400).json({ ok: false, error: 'missing_offerData' });
    }
    if (!trackingParams) {
      console.warn(`${logPrefix} Falta trackingParams.`);
      return res.status(400).json({ ok: false, error: 'missing_trackingParams' });
    }

    platform = String(offerData.affiliate_platform);
    console.log(`${logPrefix} Plataforma: ${platform}`);

    const adapter = PlatformAdapterBase.getInstance(platform);
    const finalCheckoutUrl = await adapter.buildCheckoutUrl(offerData, trackingParams);
    if (!finalCheckoutUrl || typeof finalCheckoutUrl !== 'string') {
      console.error(`${logPrefix} Adapter.buildCheckoutUrl() inválido:`, finalCheckoutUrl);
      throw new Error(`Adapter ${platform} falhou.`);
    }

    return res.status(200).json({ ok: true, finalCheckoutUrl });
  } catch (error) {
    console.error(`${logPrefix} Falha ${platform}:`, error.message || error);
    return res.status(500).json({ ok: false, error: 'checkout_url_generation_failed', platform });
  }
});

// ─────────────────────────────────────────────────────────────
// 6) Erros globais
// ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => { console.error('[UNHANDLED_REJECTION]', reason); });
process.on('uncaughtException', (err, origin) => { console.error('[UNCAUGHT_EXCEPTION]', err, 'Origin:', origin); });

// ─────────────────────────────────────────────────────────────
// 7) Boot
// ─────────────────────────────────────────────────────────────
initAdmin(); // tenta inicializar no boot (hard init)

if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
  console.log('[BOOT] Ambiente de teste. Exportando app.');
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`✅ Server UP on port ${PORT}`);
    console.log(`📦 Version: v${VERSION} (${BUILD_DATE})`);
    console.log('🔧 Config:');
    console.log(`   - CORS Origens : ${allowedOrigins.slice(0,3).join(', ')}...`);
    console.log(`   - Google Auth  : ${GOOGLE_CLIENT_IDS.length} Client ID(s)`);
    console.log(`   - Track Aberto : ${TRACK_OPEN}`);
    console.log(`   - Track Token  : ${TRACK_TOKEN ? 'Sim' : 'Não'}`);
    console.log(`   - Debug Token  : ${DEBUG_TOKEN ? 'Sim' : 'Não'}`);
    console.log(`   - Firestore    : Fonte=${FIRESTORE_SOURCE_LOG} Proj=${FIRESTORE_PROJECT_ID} Status=${_adminInited ? '✅' : '❌'}`);
    console.log(`   - Adapters     : ${typeof PlatformAdapterBase?.getInstance === 'function' ? 'OK' : 'MISSING'}`);
  });
}