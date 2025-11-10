/**
 * PZ Advisors – Auth+API Backend (Express)
 * Nome/Versão: server.js v5.0.9 (Rollback Firestore Write Logic)
 * Data: 2025-11-10
 *
 * Objetivo desta versão:
 * 1) Restaurar a lógica de gravação no Firestore exatamente no espírito das versões estáveis
 *    v5.0.5 / v5.0.7: NUNCA silenciar gravações; se Firestore não estiver inicializado,
 *    lançar erro (DB_NOT_INITIALIZED) e retornar 503 nas rotas que gravam/lêem.
 * 2) NÃO perder nenhuma funcionalidade existente.
 * 3) Manter logs de diagnóstico introduzidos nas versões mais recentes.
 *
 * Principais mudanças vs 5.0.8:
 * - Reintroduz padrão getDB(): tenta inicializar Admin SDK sob demanda e lança erro
 *   'DB_NOT_INITIALIZED' quando indisponível (como v5.0.5/5.0.7).
 * - Remove qualquer "skip" silencioso de gravações; as rotas passam a tratar o erro e
 *   respondem 503 quando Firestore não está pronto.
 * - Mantém todas as rotas e integrações (OAuth, Checkout, Webhooks, ConvertKit etc.).
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// 0) Imports básicos
// ─────────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const admin = require('firebase-admin');

// Adapters
const PlatformAdapterBase = require('./adapters/PlatformAdapterBase');
const marketingAutomator = require('./marketing/convertkitAutomator');

// ─────────────────────────────────────────────────────────────
// 0.1) Metadados de build
// ─────────────────────────────────────────────────────────────
const SERVER_VERSION = process.env.PZ_SERVER_VERSION || '5.0.9';
const SERVER_DEPLOY_DATE = process.env.PZ_SERVER_DEPLOY_DATE || '2025-11-10';
const PORT = Number(process.env.PORT || 8080);

// ─────────────────────────────────────────────────────────────
// 1) App e CORS
// ─────────────────────────────────────────────────────────────
const app = express();
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const { hostname, protocol } = new URL(origin.trim());
    if (protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1')) return true;
    if (protocol === 'https:' && (hostname === 'pzadvisors.com' || hostname === 'www.pzadvisors.com' || hostname.endsWith('.pzadvisors.com'))) return true;
    return allowedOrigins.includes(origin.trim());
  } catch {
    return false;
  }
}

app.use(cors({
  origin(origin, cb) {
    const ok = isAllowedOrigin(origin);
    if (!ok && origin) try { console.warn(JSON.stringify({ tag: 'cors_denied', origin })); } catch {}
    cb(null, ok);
  },
  methods: ['GET','POST','OPTIONS','HEAD'],
  allowedHeaders: [
    'Content-Type','Authorization','X-PZ-Version','x-pz-version','X-Trace-Id','x-trace-id',
    'X-Api-Token','x-api-token','X-Debug-Token','x-debug-token','X-Debug-Verbose','x-debug-verbose'
  ],
  optionsSuccessStatus: 204
}));

// Trace + headers padrão
app.use((req, res, next) => {
  const rid = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  req.traceId = rid;
  res.setHeader('X-Trace-Id', rid);
  res.setHeader('X-PZ-Version', `PZ Auth+API Backend v${SERVER_VERSION} (${SERVER_DEPLOY_DATE})`);
  res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  next();
});

// Access log resumido (evita webhook body pesado)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      if (req.path.startsWith('/webhook/')) return;
      console.log(JSON.stringify({ rid: req.traceId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, origin: req.headers.origin || null }));
    } catch {}
  });
  next();
});

// ─────────────────────────────────────────────────────────────
// 2) Firebase Admin SDK – rollback de lógica (v5.0.5/5.0.7)
// ─────────────────────────────────────────────────────────────
let SA_SOURCE = 'nenhuma';
let SA_JSON = null;
const SA_RAW_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (SA_RAW_JSON) {
  try { SA_JSON = JSON.parse(SA_RAW_JSON); SA_SOURCE = 'env_json'; console.log('[BOOT] SA carregado de JSON.'); }
  catch (e) { console.error('[BOOT][ERRO] SA JSON inválido:', e?.message || e); }
}
let GCP_PROJECT_ID = '', GCP_SA_EMAIL = '', GCP_SA_PRIVATE_KEY = '';
if (!SA_JSON) {
  GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || '';
  GCP_SA_EMAIL = process.env.GCP_SA_EMAIL || '';
  GCP_SA_PRIVATE_KEY = process.env.GCP_SA_PRIVATE_KEY || '';
  if (GCP_PROJECT_ID && GCP_SA_EMAIL && GCP_SA_PRIVATE_KEY) {
    SA_SOURCE = 'env_split';
    if (GCP_SA_PRIVATE_KEY) GCP_SA_PRIVATE_KEY = String(GCP_SA_PRIVATE_KEY).replace(/\\n/g, '\n');
    console.log('[BOOT] SA carregado de split env.');
  } else {
    console.warn('[BOOT][AVISO] Nenhuma SA encontrada.');
  }
} else {
  GCP_PROJECT_ID = SA_JSON.project_id || '';
  GCP_SA_EMAIL = SA_JSON.client_email || '';
  GCP_SA_PRIVATE_KEY = SA_JSON.private_key || '';
}

function ensureSA() {
  const hasKey = !!GCP_SA_PRIVATE_KEY && GCP_SA_PRIVATE_KEY.includes('BEGIN PRIVATE KEY');
  const miss = { project: !!GCP_PROJECT_ID, email: !!GCP_SA_EMAIL, key: hasKey };
  if (!miss.project || !miss.email || !miss.key) {
    const msg = `[FS][ERRO] SA incompleta: ${JSON.stringify(miss)} (Fonte: ${SA_SOURCE})`;
    console.error(msg);
    const err = new Error('sa_not_configured');
    err.code = 'sa_not_configured';
    err.meta = { miss, source: SA_SOURCE };
    throw err;
  }
  return { projectId: GCP_PROJECT_ID, clientEmail: GCP_SA_EMAIL, privateKey: GCP_SA_PRIVATE_KEY };
}

let _adminInited = false;
let _db = null;
function initAdmin() {
  if (_adminInited) return;
  try {
    const credentials = ensureSA();
    admin.initializeApp({ credential: admin.credential.cert(credentials), projectId: credentials.projectId });
    _adminInited = true;
    _db = admin.firestore();
    console.log('[ADMIN] Firebase SDK OK (Proj:', credentials.projectId, ')');
  } catch (error) {
    // Comportamento de v5.0.5/5.0.7: NÃO mascara indisponibilidade; deixa _adminInited=false
    console.error('[ADMIN][ERRO] Init Firebase:', error?.message || error);
  }
}

function getDB() {
  if (!_adminInited) {
    initAdmin();
    if (!_adminInited) {
      const err = new Error('DB não inicializado.');
      err.code = 'DB_NOT_INITIALIZED';
      throw err;
    }
  }
  return _db;
}

const FieldValue = admin.firestore.FieldValue;

// ─────────────────────────────────────────────────────────────
// 2.1) Webhooks (ANTES dos parsers globais pesados)
// ─────────────────────────────────────────────────────────────
app.get('/webhook/digistore24', async (req, res) => {
  const logPrefix = `[WEBHOOK /dg24](rid:${req.traceId})`;
  try {
    console.log(`${logPrefix} Recebido.`);
    const adapter = PlatformAdapterBase.getInstance('digistore24');
    const normalizedData = await adapter.verifyWebhook(req.query, req.headers, req.traceId);
    if (!normalizedData) {
      console.warn(`${logPrefix} Verificação falhou.`);
      return res.status(400).send('Webhook verification failed.');
    }
    // Persistência – NUNCA silenciar: usa getDB()/503 em caso de indisponibilidade
    try {
      const db = getDB();
      const docId = `ds24_${normalizedData.transactionId || normalizedData.orderId}`;
      await db.collection(process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions')
        .doc(docId).set(normalizedData, { merge: true });
    } catch (e) {
      if (e.code === 'DB_NOT_INITIALIZED') return res.status(503).send('Firestore unavailable.');
      throw e;
    }
    console.log(`${logPrefix} OK. TxID:${normalizedData.transactionId}`);
    return res.status(200).send('OK');
  } catch (error) {
    console.error(`${logPrefix} Erro:`, error.message || error);
    return res.status(500).send('Internal Server Error.');
  }
});

app.post('/webhook/clickbank', express.raw({ type: '*/*' }), async (req, res) => {
  const logPrefix = `[WEBHOOK /cb](rid:${req.traceId})`;
  try {
    console.log(`${logPrefix} Recebido...`);
    if (!req.body || !(req.body instanceof Buffer) || req.body.length === 0) {
      console.warn(`${logPrefix} Erro: req.body Buffer inválido.`);
      return res.status(400).send('Invalid request body.');
    }
    const adapter = PlatformAdapterBase.getInstance('clickbank');
    const normalizedData = await adapter.verifyWebhook(req.body, req.headers, req.traceId);
    if (!normalizedData) {
      console.warn(`${logPrefix} Verificação falhou.`);
      return res.status(400).send('Webhook verification failed.');
    }
    try {
      const db = getDB();
      const docId = `cb_${normalizedData.transactionId || normalizedData.orderId}`;
      await db.collection(process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions')
        .doc(docId).set(normalizedData, { merge: true });
    } catch (e) {
      if (e.code === 'DB_NOT_INITIALIZED') return res.status(503).send('Firestore unavailable.');
      throw e;
    }
    console.log(`${logPrefix} OK. TxID:${normalizedData.transactionId}`);
    return res.status(200).send('OK');
  } catch (error) {
    console.error(`${logPrefix} Erro:`, error.message || error);
    return res.status(500).send('Internal Server Error.');
  }
});

// ─────────────────────────────────────────────────────────────
// 2.2) Parsers globais (após webhooks)
// ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb', type: ['application/json','application/*+json'] }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || (req.body && typeof req.body === 'object')) return next();
  let data = '';
  req.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    if (!req.body || typeof req.body !== 'object') {
      if (data && /^[\s{\[]/.test(data)) try { req.body = JSON.parse(data); } catch {}
    }
    next();
  });
});

// ─────────────────────────────────────────────────────────────
// 3) Utils de Daily Facts (v5.0.5)
// ─────────────────────────────────────────────────────────────
function zeroPad(n, w = 2) { return String(n).padStart(w, '0'); }
function deriveDayParts(tsISO, tzOffsetMin) { let d=tsISO?new Date(tsISO):new Date(); const tz=Number.isFinite(+tzOffsetMin)?+tzOffsetMin:0; if(tz!==0) d=new Date(d.getTime()+tz*60*1000); return { y:d.getUTCFullYear(), m:zeroPad(d.getUTCMonth()+1), d:zeroPad(d.getUTCDate()) }; }
function deriveDayLabel(tsISO, tzOffsetMin) { const p=deriveDayParts(tsISO,tzOffsetMin); return `${p.y}-${p.m}-${p.d}`; }
function parseClientTimestamp(val) { try{ if(!val) return null; const d=new Date(val); if(isNaN(d.getTime())) return null; return admin.firestore.Timestamp.fromDate(d); } catch { return null; } }
function toPlainJSON(obj) { try { return JSON.parse(JSON.stringify(obj || null)); } catch { return null; } }

async function upsertDailyFact({ db = null, anon_id, user_id, tz_offset, event, page, session_id, payload, tsISO }) {
  if (!db) try { db = getDB(); } catch (dbError) { console.error(`[upsertDailyFact][ERRO] DB:`, dbError.message || dbError); throw dbError; }
  const safeAnon = (anon_id && typeof anon_id === 'string') ? anon_id : 'anon_unknown';
  const tz = Number.isFinite(+tz_offset) ? +tz_offset : 0;
  const day = deriveDayLabel(tsISO, tz);
  const docId = `${safeAnon}_${day}`;
  const docRef = db.collection('daily_facts').doc(docId);
  const event_id = `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  const newEvent = toPlainJSON({ event, event_id, ts_server: FieldValue.serverTimestamp(), ts_client: parseClientTimestamp(tsISO), tz_offset: Number.isFinite(tz) ? tz : null, page, session_id, payload });
  const updatePayload = {
    updated_at: FieldValue.serverTimestamp(),
    events: FieldValue.arrayUnion(newEvent),
    [`counters.${event}`]: FieldValue.increment(1),
    ...(user_id ? { user_id, person_id: user_id } : {})
  };
  try {
    await docRef.update(updatePayload);
  } catch (error) {
    const notFound = error?.code === 5 || error?.code === 'not-found' || /NOT_FOUND/i.test(error?.message || '');
    if (notFound) {
      const seedPayload = {
        kind: 'user', date: day, entity_id: safeAnon, anon_id: safeAnon,
        person_id: (user_id && typeof user_id === 'string') ? user_id : safeAnon,
        ...(user_id ? { user_id } : {}),
        ...(Number.isFinite(tz) ? { tz_offset: tz } : {}),
        events: [newEvent], counters: { [event]: 1 },
        created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp()
      };
      await docRef.set(seedPayload);
    } else {
      console.error(JSON.stringify({ tag: 'upsert_daily_fact_failed', docId, error: error.message || String(error), code: error.code }));
      throw error;
    }
  }
  return { ok: true, id: docId };
}

async function logAffiliateTransaction(normalizedData) {
  if (!normalizedData?.platform || !normalizedData?.transactionId) {
    console.warn('[logAffiliateTransaction] Skip: Dados inválidos.');
    return;
  }
  let db;
  try { db = getDB(); } catch (dbError) { console.error(`[logAffiliateTransaction][ERRO] DB:`, dbError.message || dbError); return; }
  try {
    const platform = normalizedData.platform;
    const txId = normalizedData.transactionId;
    const safeTxId = String(txId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const docId = `${platform}_${safeTxId}`;
    const docRef = db.collection('affiliate_transactions').doc(docId);
    const docSnap = await docRef.get();
    const updateData = { ...normalizedData, _log_last_updated_at: FieldValue.serverTimestamp(), _log_doc_id: docId };
    if (!docSnap.exists) {
      await docRef.set({ ...updateData, _log_first_seen_at: FieldValue.serverTimestamp() });
      console.log(`[logAffiliateTransaction] Logado (Novo): ${docId}`);
    } else {
      await docRef.update(updateData);
      console.log(`[logAffiliateTransaction] Logado (Update): ${docId}`);
    }
  } catch (error) {
    console.error(JSON.stringify({ tag: 'log_affiliate_transaction_failed', error: error.message || String(error), platform: normalizedData.platform, txId: normalizedData.transactionId }));
  }
}

// ─────────────────────────────────────────────────────────────
// 4) Rotas básicas / health / versão
// ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.status(200).send('🚀 PZ Auth+API Backend ativo.'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() }));
app.head('/healthz', (_req, res) => res.sendStatus(200));
app.get('/api/healthz', (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() }));
app.head('/api/healthz', (_req, res) => res.sendStatus(200));

app.get('/api/version', (_req, res) => {
  res.status(200).json({
    service: 'PZ Auth+API Backend',
    version: SERVER_VERSION,
    build_date: SERVER_DEPLOY_DATE,
    adapters_loaded: typeof PlatformAdapterBase?.getInstance === 'function',
    origins: allowedOrigins,
    fs_auth: 'AdminSDK',
    fs_init: _adminInited,
    fs_project: GCP_PROJECT_ID || '(N/A)',
    fs_sa_source: SA_SOURCE,
    facts_coll: 'daily_facts',
    tx_coll: 'affiliate_transactions'
  });
});

// ─────────────────────────────────────────────────────────────
// 5) OAuth Google One Tap (mantendo comportamento)
// ─────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_IDS = (process.env.GOOGLE_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_IDS[0] || 'YOUR_DEFAULT_CLIENT_ID');

app.options('/auth/google', (_req, res) => res.sendStatus(204));
app.options('/api/auth/google', (_req, res) => res.sendStatus(204));

async function handleAuthGoogle(req, res) {
  try {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    const body = req.body || {};
    const credential = (typeof body.credential === 'string' && body.credential) || (typeof body.id_token === 'string' && body.id_token) || null;
    const context = body.context || {};

    console.log(JSON.stringify({ route: '/auth/google', rid: req.traceId, ct, has_cred: !!credential }));
    if (!credential) return res.status(400).json({ error: 'missing_credential' });

    const csrfCookie = req.cookies?.g_csrf_token, csrfBody = body?.g_csrf_token;
    if (csrfCookie && csrfBody && csrfCookie !== csrfBody) {
      console.warn(`[AUTH] CSRF Mismatch: Cookie:"${csrfCookie}" vs Body:"${csrfBody}"`);
      return res.status(400).json({ error: 'csrf_mismatch' });
    }

    res.set({ 'Cache-Control': 'no-store,no-cache,must-revalidate,private', Pragma: 'no-cache', Expires: '0' });

    const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_IDS });
    const payload = ticket.getPayload();
    if (!payload) return res.status(401).json({ error: 'invalid_token' });

    const { sub, email, name, picture, email_verified } = payload;
    const user_id = String(sub);

    // Persistência de usuário + evento (padrão v5.0.5/5.0.7)
    try {
      const db = getDB();
      const docRef = db.collection('users').doc(user_id);
      await docRef.set({ user_id, sub, email: email || null, name: name || null, picture: picture || null, email_verified: !!email_verified }, { merge: true });
      await docRef.set({ last_seen: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) {
      console.error(JSON.stringify({ route: '/auth/google', rid: req.traceId, warn: 'users_upsert_fail', error: e.message || String(e) }));
      if (e.code === 'DB_NOT_INITIALIZED') return res.status(503).json({ error: e.code });
    }

    try {
      const db = getDB();
      const anon_id = context.anon_id || body.anon_id || 'anon_unknown';
      await upsertDailyFact({ db, anon_id, user_id, tz_offset: context.tz_offset, event: 'auth_google_success', page: context.page || '/onetap', session_id: context.session_id, payload: { email: email || null, name: name || null, pic: picture || null, verified: !!email_verified }, tsISO: new Date().toISOString() });
    } catch (e) {
      console.error(JSON.stringify({ route: '/auth/google', rid: req.traceId, warn: 'daily_facts_log_fail', error: e.message || String(e) }));
      if (e.code === 'DB_NOT_INITIALIZED') return res.status(503).json({ error: e.code });
    }

    return res.status(200).json({ user_id, email: email || null, name: name || null, picture: picture || null });
  } catch (err) {
    const msg = err?.message || String(err || '');
    let code = 'auth_failed';
    if (/audience/.test(msg)) code = 'audience_mismatch';
    if (/expired/i.test(msg)) code = 'token_expired';
    if (/invalid/i.test(msg)) code = 'invalid_token';
    console.error(JSON.stringify({ route: '/auth/google', rid: req.traceId, error: msg, code }));
    return res.status(401).json({ error: code });
  }
}

app.post('/auth/google', handleAuthGoogle);
app.post('/api/auth/google', handleAuthGoogle);

// ─────────────────────────────────────────────────────────────
// 6) Auxiliares
// ─────────────────────────────────────────────────────────────
app.post('/api/echo', (req, res) => {
  res.set({ 'Cache-Control': 'no-store,no-cache,must-revalidate,private', Pragma: 'no-cache', Expires: '0' });
  return res.status(200).json({ ok: true, rid: req.traceId, echo: req.body || null, ts: new Date().toISOString() });
});

app.post('/api/track', async (req, res) => {
  try {
    const TRACK_OPEN = String(process.env.TRACK_OPEN || '1') === '1';
    const TRACK_TOKEN = process.env.TRACK_TOKEN || '';
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

    const db = getDB();
    await upsertDailyFact({
      db,
      anon_id,
      user_id,
      tz_offset,
      event,
      page,
      session_id: sessionId,
      payload: (() => { const p = { ...payload }; delete p.ts; delete p.tz_offset; delete p.page; delete p.session_id; delete p.user_id; delete p.anon_id; delete p.context; return toPlainJSON(p); })(),
      tsISO: tsISO || new Date().toISOString()
    });

    return res.status(200).json({ ok: true, rid: req.traceId });
  } catch (e) {
    console.error(JSON.stringify({ route: '/api/track', rid: req.traceId, error: e.message || String(e) }));
    if (e.code === 'DB_NOT_INITIALIZED') return res.status(503).json({ ok: false, error: e.code });
    return res.status(500).json({ ok: false, error: 'track_failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// 7) API de Marketing / Send Guide (mantendo comportamento)
// ─────────────────────────────────────────────────────────────
app.post('/api/send-guide', express.json(), async (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ ok: false, error: 'user_id_missing', rid: req.traceId });
  try {
    const db = getDB();
    const userRef = db.collection('users').doc(user_id);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'user_not_found', rid: req.traceId });
    const userData = userDoc.data();
    const { email, first_name } = userData;
    if (!email) return res.status(400).json({ ok: false, error: 'user_email_missing', rid: req.traceId });

    const subscriberInfo = {
      email: email,
      first_name: first_name || '',
      fields: {
        user_id_google: user_id,
        anon_id: req.body.anon_id || null,
        attribution_history_json: JSON.stringify(req.body.attribution_history || []),
        product_choice: req.body.product_choice || null,
      }
    };

    const ckResponse = await marketingAutomator.addSubscriberToFunnel(subscriberInfo);
    res.status(200).json({ ok: true, message: 'subscriber_added_to_funnel', subscriber: ckResponse });
  } catch (e) {
    if (e.code === 'DB_NOT_INITIALIZED') return res.status(503).json({ ok: false, error: e.code });
    console.error(`[GUIDE][500]`, e?.message || e);
    if (e.response) return res.status(e.response.status || 502).json({ ok: false, error: 'marketing_api_error', details: e.response.data, rid: req.traceId });
    res.status(500).json({ ok: false, error: 'internal_server_error', rid: req.traceId });
  }
});

// ─────────────────────────────────────────────────────────────
// 8) Adapters – Checkout
// ─────────────────────────────────────────────────────────────
app.post('/api/checkout', express.json(), async (req, res) => {
  console.log(`[SERVER CHECKOUT] req.body recebido (Trace: ${req.traceId}):`, JSON.stringify(req.body));
  const { offerData, trackingParams } = req.body || {};
  console.log(`[SERVER CHECKOUT] offerData extraído (Trace: ${req.traceId}):`, JSON.stringify(offerData));
  if (!offerData || !offerData.affiliate_platform) {
    return res.status(400).json({ ok: false, error: 'missing_offerData' });
  }
  if (!trackingParams) return res.status(400).json({ ok: false, error: 'missing_trackingParams' });
  let platform = 'unknown';
  try {
    platform = offerData.affiliate_platform;
    const adapter = PlatformAdapterBase.getInstance(platform);
    const finalCheckoutUrl = await adapter.buildCheckoutUrl(offerData, trackingParams);
    if (!finalCheckoutUrl || typeof finalCheckoutUrl !== 'string') {
      console.error(`[API /checkout] Adapter.buildCheckoutUrl() inválido:`, finalCheckoutUrl);
      throw new Error(`Adapter ${platform} falhou.`);
    }
    return res.status(200).json({ ok: true, finalCheckoutUrl });
  } catch (error) {
    console.error(`[API /checkout] Falha ${platform}:`, error.message || error);
    return res.status(500).json({ ok: false, error: 'checkout_url_generation_failed', platform });
  }
});

// ─────────────────────────────────────────────────────────────
// 9) Erros globais
// ─────────────────────────────────────────────────────────────
process.on('unhandledRejection', reason => { console.error('[UNHANDLED_REJECTION] Reason:', reason); });
process.on('uncaughtException', (err, origin) => { console.error('[UNCAUGHT_EXCEPTION] Error:', err, 'Origin:', origin); });

// ─────────────────────────────────────────────────────────────
// 10) Start – tenta inicializar no boot. Em testes, exporta app.
// ─────────────────────────────────────────────────────────────
initAdmin();

if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
  console.log('[BOOT] Ambiente teste. Exportando "app".');
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`✅ Server UP on port ${PORT}`);
    console.log(`📦 Version: v${SERVER_VERSION} (${SERVER_DEPLOY_DATE})`);
    console.log('🔧 Config:');
    console.log(`   - CORS Origens : ${allowedOrigins.slice(0,3).join(', ')}...`);
    console.log(`   - Google Auth  : ${GOOGLE_CLIENT_IDS.length} Client ID(s)`);
    console.log(`   - Firestore    : Admin SDK (Fonte: ${SA_SOURCE}) ${_adminInited ? '✅' : '❌'}`);
    console.log(`   - Adapters     : ${typeof PlatformAdapterBase?.getInstance === 'function' ? '✅' : '❌'}`);
    console.log(`   - NODE_ENV     : ${process.env.NODE_ENV || '(N/A)'}`);
    console.log('──────────────────────────────────────────────────────────────');
  });
}