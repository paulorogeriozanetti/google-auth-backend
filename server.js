/**
 * PZ Auth+API Backend (v5.3.0 - Minimal Firestore Fix on top of 5.0.8)
 * Versão: 5.3.0 cg
 * Data: 2025-11-10
 * Autor: PZ Advisors
 *
 * Objetivo: manter 100% das funcionalidades da v5.0.8 e aplicar APENAS o ajuste
 * mínimo que restaurou as gravações no Firestore (como visto na v5.2.0),
 * sem tocar em promoção de user_id (GOT) e nem no fluxo de checkout ClickBank.
 *
 * Mudança única vs 5.0.8:
 * - Troca da inicialização do Firestore para usar `firebase-admin` direto
 *   (admin.initializeApp + admin.firestore()), preservando o restante do código.
 * - Mantém exatamente as mesmas rotas, logs e comportamentos da v5.0.8.
 */

// 1) Imports
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const admin = require('firebase-admin'); // <-- Alteração: usar admin direto
const { OAuth2Client } = require('google-auth-library');

// Carrega os módulos
const marketingAutomator = require('./marketingAutomator');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// 2) Constantes e Configuração do Servidor
const SERVER_VERSION = '5.3.0'; // Atualizado
const SERVER_DEPLOY_DATE = '2025-11-10';
const PORT = process.env.PORT || 8080;
const TRACE_ID_HEADER = 'x-request-trace-id';
const USE_SECURE_COOKIES = process.env.NODE_ENV === 'production';

// 3) Configuração de CORS
const allowedOrigins = [
  'https://pzadvisors.com',
  'https://www.pzadvisors.com',
  'https://auth.pzadvisors.com',
  'https://api.pzadvisors.com',
];
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:8080');
  allowedOrigins.push('http://127.0.0.1:8080');
  allowedOrigins.push('http://localhost:3000');
}
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: Origem não permitida: ${origin}`));
    }
  },
  credentials: true,
};

// 4) Configuração de Clientes Google Auth
const GOOGLE_CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID_PZADVISORS,
  process.env.GOOGLE_CLIENT_ID_LANDER_B,
].filter(Boolean);

if (!GOOGLE_CLIENT_IDS.length) {
  console.warn('[AUTH] Aviso: Nenhum GOOGLE_CLIENT_ID_* configurado.');
}
const googleAuthClients = GOOGLE_CLIENT_IDS.map(id => new OAuth2Client(id));

// 5) Configuração de Tracking
const TRACK_TOKEN_ENABLED = !!process.env.TRACK_TOKEN;
const TRACK_TOKEN_DEBUG_ENABLED = !!process.env.TRACK_TOKEN_DEBUG;
const TRACK_OPEN = process.env.TRACK_OPEN === 'true';

// 6) Configuração do Firebase Admin SDK (ajuste mínimo compatível)
let FIRESTORE_ADMIN_READY = false; // <-- flag substitui o boolean "admin" da 5.0.8
let db; // instancia do firestore
let FIRESTORE_SOURCE_LOG = 'N/A';
let FIRESTORE_PROJECT_ID = 'N/A';
let FIRESTORE_INIT = false;

function ensureSA() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      FIRESTORE_SOURCE_LOG = 'env_json';
      FIRESTORE_PROJECT_ID = sa.project_id;
      return sa;
    } catch (e) { console.error('[FS][ERRO] Falha ao parsear FIREBASE_SERVICE_ACCOUNT_JSON:', e?.message); }
  }
  if (process.env.GCP_PROJECT_ID && process.env.GCP_SA_EMAIL && process.env.GCP_SA_PRIVATE_KEY) {
     try {
       const sa = {
         project_id: process.env.GCP_PROJECT_ID,
         client_email: process.env.GCP_SA_EMAIL,
         private_key: process.env.GCP_SA_PRIVATE_KEY.replace(/\\n/g, '\n'),
       };
       FIRESTORE_SOURCE_LOG = 'env_split';
       FIRESTORE_PROJECT_ID = sa.project_id;
       return sa;
     } catch (e) { console.error('[FS][ERRO] Falha ao montar SA das Vercel vars:', e?.message); }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
     FIRESTORE_SOURCE_LOG = 'gcp_auto';
     FIRESTORE_PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.PROJECT_ID || 'gcp_auto_project';
     return null; // deixa o SDK localizar credenciais
  }
  console.error('[FS][FATAL] Nenhuma credencial (FIREBASE_SERVICE_ACCOUNT_JSON ou GCP_*) foi encontrada.');
  throw new Error('sa_not_configured');
}

function initAdmin() {
  try {
    const serviceAccount = ensureSA();
    if (serviceAccount) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
      admin.initializeApp({});
    }
    FIRESTORE_ADMIN_READY = true;
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    FIRESTORE_INIT = true;
    console.log(`[ADMIN] Firebase SDK OK (Proj: ${FIRESTORE_PROJECT_ID} )`);
  } catch (e) {
    FIRESTORE_ADMIN_READY = false;
    FIRESTORE_INIT = false;
    console.error('[ADMIN][FATAL] Falha ao inicializar Firebase Admin SDK:', e?.message);
    if (e.message === 'sa_not_configured') {
       if(process.env.SA_OPTIONAL !== 'true') { throw e; }
       console.warn('[ADMIN] SA_OPTIONAL=true. Servidor iniciando sem Firestore.');
    } else { throw e; }
  }
}

// 7) Inicialização dos Adapters
let ADAPTERS_LOADED = false;
try {
  if (PlatformAdapterBase) {
      ADAPTERS_LOADED = true;
      console.log('[BOOT] Módulo PlatformAdapterBase (Factory) carregado.');
  }
} catch (e) {
  console.error('[BOOT][FATAL] Falha ao carregar PlatformAdapterBase:', e.message);
  throw e;
}
try {
  if (marketingAutomator) console.log('[BOOT] Módulo marketingAutomator carregado com sucesso.');
} catch (e) {}

// 8) Middlewares
const app = express();
app.set('trust proxy', 1);
app.use(cors(corsOptions));
app.use(cookieParser());

// Middleware de Logging e Trace ID
app.use((req, res, next) => {
  const traceId = req.headers[TRACE_ID_HEADER] || crypto.randomUUID();
  req.traceId = traceId;
  res.setHeader(TRACE_ID_HEADER, traceId);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const duration = (end - start) / 1_000_000n;
    let logMsg = `[${req.method}] ${req.path} (${res.statusCode}) - ${duration}ms - [Trace: ${traceId}]`;
    if (res.locals.errorLog) { logMsg += ` - [ERROR: ${res.locals.errorLog}]`; }
    console.log(logMsg);
  });
  next();
});

// Middleware de Verificação de Token de API
const verifyApiToken = (req, res, next) => {
  if (TRACK_OPEN) return next();
  const token = req.headers['x-api-token'] || req.query.token;
  if (TRACK_TOKEN_ENABLED && token === process.env.TRACK_TOKEN) { return next(); }
  if (TRACK_TOKEN_DEBUG_ENABLED && token === process.env.TRACK_TOKEN_DEBUG) { return next(); }
  res.locals.errorLog = 'invalid_api_token';
  return res.status(401).json({ ok: false, error: 'unauthorized', rid: req.traceId });
};

// 9) Rotas da API

// --- Rotas Públicas (Health & Version) ---
const HEALTHZ_TS = new Date().toISOString();
let HEALTHZ_UPTIME_START = process.hrtime.bigint();
app.get('/healthz', (req, res) => {
    const uptimeNano = process.hrtime.bigint() - HEALTHZ_UPTIME_START;
    const uptimeSec = Number(uptimeNano) / 1_000_000_000;
    res.status(200).json({ ok: true, uptime: uptimeSec, ts: new Date().toISOString() });
});
app.get('/api/healthz', (req, res) => {
    const uptimeNano = process.hrtime.bigint() - HEALTHZ_UPTIME_START;
    const uptimeSec = Number(uptimeNano) / 1_000_000_000;
    res.status(200).json({ ok: true, uptime: uptimeSec, ts: new Date().toISOString() });
});
app.get('/api/version', (req, res) => {
  res.status(200).json({
    service: 'PZ Auth+API Backend', version: SERVER_VERSION, build_date: SERVER_DEPLOY_DATE,
    adapters_loaded: ADAPTERS_LOADED, client_ids: GOOGLE_CLIENT_IDS, origins: allowedOrigins,
    track_open: TRACK_OPEN, track_token: TRACK_TOKEN_ENABLED, debug_token: TRACK_TOKEN_DEBUG_ENABLED,
    fs_auth: FIRESTORE_ADMIN_READY ? 'AdminSDK' : 'None', fs_init: FIRESTORE_INIT, fs_project: FIRESTORE_PROJECT_ID,
    fs_sa_source: FIRESTORE_SOURCE_LOG, facts_coll: process.env.FIRESTORE_FACTS_COLLECTION || 'daily_facts',
    tx_coll: process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions',
    facts_doc_pattern: process.env.FACTS_DOC_PATTERN || '${anon_id}_${YYYY-MM-DD}',
  });
});

// --- Rota Pública (Google Auth) ---
app.post('/auth/google', express.json(), async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    res.locals.errorLog = 'credential_missing';
    return res.status(400).json({ ok: false, error: 'credential_missing', rid: req.traceId });
  }
  let ticket; let verified = false;
  for (const client of googleAuthClients) {
    try {
      ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_IDS });
      if (ticket) { verified = true; break; }
    } catch (e) { console.warn(`[AUTH] Falha na verificação GSI (Cliente: ${client.clientId_?.slice(0,10)}...): ${e.message}`); }
  }
  if (!verified || !ticket) {
    res.locals.errorLog = 'google_token_invalid';
    return res.status(401).json({ ok: false, error: 'google_token_invalid', rid: req.traceId });
  }
  const payload = ticket.getPayload();
  const { sub, email, name, given_name, family_name, picture } = payload;
  if (!sub || !email) {
    res.locals.errorLog = 'google_payload_incomplete';
    return res.status(400).json({ ok: false, error: 'google_payload_incomplete', rid: req.traceId });
  }
  try {
    const userRef = db.collection('users').doc(sub);
    const userData = {
      user_id: sub, email: email, name: name || '', first_name: given_name || '', last_name: family_name || '',
      picture: picture || '', auth_provider: 'google', last_seen_at: new Date(), created_at: new Date(),
    };
    const doc = await userRef.get();
    if (doc.exists) { await userRef.update({ last_seen_at: new Date() }); }
    else { await userRef.set(userData); }
    res.status(200).json({ ok: true, user_id: sub, email: email });
  } catch (fsError) {
    res.locals.errorLog = 'firestore_error_auth';
    console.error(`[AUTH][500] Erro ao salvar user no Firestore (User: ${sub}):`, fsError);
    res.status(500).json({ ok: false, error: 'firestore_error', rid: req.traceId });
  }
});

// --- Rota Pública (API de Marketing / Send Guide) ---
app.post('/api/send-guide', express.json(), async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) {
    res.locals.errorLog = 'user_id_missing';
    return res.status(400).json({ ok: false, error: 'user_id_missing', rid: req.traceId });
  }
  try {
    const userRef = db.collection('users').doc(user_id);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      res.locals.errorLog = 'user_not_found_guide';
      return res.status(404).json({ ok: false, error: 'user_not_found', rid: req.traceId });
    }
    const userData = userDoc.data();
    const { email, first_name } = userData;
    if (!email) {
       res.locals.errorLog = 'user_email_missing_guide';
      return res.status(400).json({ ok: false, error: 'user_email_missing', rid: req.traceId });
    }
    const subscriberInfo = {
      email: email, first_name: first_name || '',
      fields: {
        user_id_google: user_id, anon_id: req.body.anon_id || null,
        attribution_history_json: JSON.stringify(req.body.attribution_history || []),
        product_choice: req.body.product_choice || null,
      }
    };
    const ckResponse = await marketingAutomator.addSubscriberToFunnel(subscriberInfo);
    res.status(200).json({ ok: true, message: 'Guide request processed.', subscriber: ckResponse });
  } catch (error) {
    res.locals.errorLog = `marketing_api_error:${error.message}`;
    console.error(`[GUIDE][500] Falha ao processar guia (User: ${user_id}):`, error?.message || error);
    if (error.response) {
       return res.status(error.response.status || 502).json({
         ok: false, error: 'marketing_api_error', details: error.response.data, rid: req.traceId
       });
    }
    res.status(500).json({ ok: false, error: 'internal_server_error', rid: req.traceId });
  }
});

// --- Rota Protegida (API de Checkout / Adapter Factory) ---
app.post('/api/checkout', express.json(), async (req, res) => {
  // Logs de Diagnóstico v5.0.8 mantidos
  console.log(`[SERVER CHECKOUT] req.body recebido (Trace: ${req.traceId}):`, JSON.stringify(req.body)); // Log 1
  
  const { offerData, trackingParams } = req.body;
  
  console.log(`[SERVER CHECKOUT] offerData extraído (Trace: ${req.traceId}):`, JSON.stringify(offerData)); // Log 2

  if (!offerData || !offerData.affiliate_platform) {
    res.locals.errorLog = 'platform_missing_checkout';
    return res.status(400).json({ ok: false, error: 'offerData.affiliate_platform_missing', rid: req.traceId });
  }
  
  const platform = offerData.affiliate_platform;

  try {
    const adapter = PlatformAdapterBase.getInstance(platform);
    
    console.log(`[SERVER CHECKOUT] Passando offerData para o adapter ${platform} (Trace: ${req.traceId}):`, JSON.stringify(offerData)); // Log 3
    
    const finalCheckoutUrl = await adapter.buildCheckoutUrl(offerData, trackingParams);

    if (finalCheckoutUrl) {
      res.status(200).json({ ok: true, finalCheckoutUrl: finalCheckoutUrl });
    } else {
       res.locals.errorLog = `adapter_returned_null:${platform}`;
       console.warn(`[CHECKOUT][400] Adapter ${platform} retornou URL nula. [Trace: ${req.traceId}]`);
       res.status(400).json({ ok: false, error: 'checkout_url_generation_failed', platform: platform, rid: req.traceId });
    }
  } catch (error) {
    res.locals.errorLog = `adapter_factory_error:${platform}:${error.message}`;
    console.error(`[CHECKOUT][500] Falha na Factory ou Adapter (${platform}):`, error?.message || error);
    res.status(500).json({
      ok: false, error: 'adapter_error', platform: platform, details: error.message, rid: req.traceId
    });
  }
});

// --- Rota Protegida (API de Tracking / Eventos) ---
app.post('/api/track', verifyApiToken, express.json(), async (req, res) => {
  const { event, payload } = req.body;
  if (!event || !payload) {
    res.locals.errorLog = 'event_payload_missing';
    return res.status(400).json({ ok: false, error: 'event_or_payload_missing', rid: req.traceId });
  }
  const collectionName = process.env.FIRESTORE_FACTS_COLLECTION || 'daily_facts';
  try {
    const docData = {
      ...payload, event_name: event, server_timestamp: new Date(), trace_id: req.traceId,
      ip: req.ip || null, ua: req.headers['user-agent'] || null,
    };
    const docIdPattern = process.env.FACTS_DOC_PATTERN || '';
    let docRef;
    if (docIdPattern && payload.anon_id) {
        const date = new Date(); const yyyy = date.getUTCFullYear();
        const mm = String(date.getUTCMonth() + 1).padStart(2, '0'); const dd = String(date.getUTCDate()).padStart(2, '0');
        const docId = docIdPattern.replace('${anon_id}', payload.anon_id).replace('${YYYY-MM-DD}', `${yyyy}-${mm}-${dd}`);
        docRef = db.collection(collectionName).doc(docId);
        await docRef.set(docData, { merge: true });
        res.status(200).json({ ok: true, rid: req.traceId, doc_id: docId, op: 'merged' });
    } else {
        docRef = await db.collection(collectionName).add(docData);
        res.status(201).json({ ok: true, rid: req.traceId, doc_id: docRef.id, op: 'created' });
    }
  } catch (fsError) {
    res.locals.errorLog = 'firestore_error_track';
    console.error(`[TRACK][500] Erro ao salvar evento '${event}' no Firestore:`, fsError);
    res.status(500).json({ ok: false, error: 'firestore_error', rid: req.traceId });
  }
});

// --- Rotas Públicas (Webhooks S2S das Plataformas) ---
app.get('/webhook/digistore24', async (req, res) => {
  const query = req.query; const headers = req.headers;
  try {
    const adapter = PlatformAdapterBase.getInstance('digistore24');
    const normalizedData = await adapter.verifyWebhook(query, headers, req.traceId);
    if (normalizedData) {
      const docId = `ds24_${normalizedData.transactionId || normalizedData.orderId || crypto.randomUUID()}`;
      await db.collection(process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions')
        .doc(docId).set(normalizedData, { merge: true });
      console.log(`[WEBHOOK][DS24] Webhook S2S ${docId} processado. [Trace: ${req.traceId}]`);
      res.status(200).send('OK');
    } else {
      res.locals.errorLog = 'webhook_ds24_unauthorized';
      console.warn(`[WEBHOOK][DS24] Webhook S2S falhou na verificação do Adapter. [Trace: ${req.traceId}]`);
      res.status(401).send('Unauthorized');
    }
  } catch (error) {
    res.locals.errorLog = `webhook_ds24_error:${error.message}`;
    console.error(`[WEBHOOK][DS24] Erro crítico no Adapter Digistore24:`, error?.message || error);
    res.status(500).send('Internal Server Error');
  }
});
app.post('/webhook/clickbank', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBodyBuffer = req.body; const headers = req.headers;
  if (!rawBodyBuffer || rawBodyBuffer.length === 0) {
      res.locals.errorLog = 'webhook_cb_empty_body';
      console.warn(`[WEBHOOK][CB] Recebido body vazio. [Trace: ${req.traceId}]`);
      return res.status(400).send('Bad Request: Empty payload');
  }
  try {
    const adapter = PlatformAdapterBase.getInstance('clickbank');
    const normalizedData = await adapter.verifyWebhook(rawBodyBuffer, headers, req.traceId);
    if (normalizedData) {
      const docId = `cb_${normalizedData.transactionId || normalizedData.orderId}`;
      await db.collection(process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions')
        .doc(docId).set(normalizedData, { merge: true });
      console.log(`[WEBHOOK][CB] Webhook INS ${docId} processado. [Trace: ${req.traceId}]`);
      res.status(200).send('OK');
    } else {
      res.locals.errorLog = 'webhook_cb_unauthorized';
      console.warn(`[WEBHOOK][CB] Webhook INS falhou na verificação (HMAC/Decrypt). [Trace: ${req.traceId}]`);
      res.status(401).send('Unauthorized');
    }
  } catch (error) {
    res.locals.errorLog = `webhook_cb_error:${error.message}`;
    console.error(`[WEBHOOK][CB] Erro crítico no Adapter Clickbank:`, error?.message || error);
    res.status(500).send('Internal Server Error');
  }
});

// 10) Start
try {
  initAdmin();
  app.listen(PORT, () => {
    HEALTHZ_UPTIME_START = process.hrtime.bigint();
    console.log('\n' + '─'.repeat(60));
    console.log(`✅ Server UP on port ${PORT}`);
    console.log(`📦 Version: ${SERVER_VERSION} (${SERVER_DEPLOY_DATE})`);
    console.log('🔧 Config:');
    console.log(`   - CORS Origens : ${allowedOrigins.slice(0, 3).join(', ')}...`);
    console.log(`   - Google Auth  : ${GOOGLE_CLIENT_IDS.length} Client ID(s)`);
    console.log(`   - Track Aberto : ${TRACK_OPEN}`);
    console.log(`   - Track Token  : ${TRACK_TOKEN_ENABLED ? 'Sim' : 'Não'}`);
    console.log(`   - Debug Token  : ${TRACK_TOKEN_DEBUG_ENABLED ? 'Sim' : 'Não'}`);
    console.log(`   - Firestore    : ${FIRESTORE_INIT ? `Admin SDK (Fonte: ${FIRESTORE_SOURCE_LOG}) ✅` : 'Desconectado ❌'}`);
    console.log(`   - Adapters     : ${ADAPTERS_LOADED ? '✅' : '❌'}`);
    console.log(`   - Guia URL Base: ${process.env.GUIDE_REDIRECT_BASE_URL || 'N/A'}`);
    console.log(`   - NODE_ENV     : ${process.env.NODE_ENV || 'undefined'}`);
    console.log('─'.repeat(60));
  });
} catch (e) {
  console.error('[FATAL] Erro ao iniciar servidor:', e?.message || e);
  process.exit(1);
}