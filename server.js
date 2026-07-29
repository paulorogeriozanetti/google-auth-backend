console.log('--- [BOOT CHECK] Loading server.js v6.2.3 (Reprocessador AdsSink + Data Manager) ---'); // [v6.2.3] era v6.2.2
/**
 * PZ Auth+API Backend
 * Versão: 6.2.3  (Reprocessador AdsSink + Data Manager API)
 * Data: 2026-07-28
 * Autor: PZ Advisors
 *
 * ⚠️ VERSÃO: a verdade é a constante SERVER_VERSION (abaixo) + o boot log, NÃO este
 *    cabeçalho. Histórico: 6.0.4 (S2S Parser Fix, 2025-11-13) -> 6.1.0 (ligação micro
 *    AdsSink) -> 6.2.0 (reprocessador + seed create-only) -> 6.2.1 (bump de revisão).
 *    Este bloco esteve preso em "6.0.4" durante o 6.1.0/6.2.0 — corrigido em 6.2.1.
 *
 * Objetivo original (v6.0.4): Corrige o parser de body do ClickBank S2S para v6.0.0.
 * - [CRÍTICO] Substitui app.all() por rotas GET e POST S2S separadas.
 * - [CRÍTICO] Rota POST /postback/clickbank agora aceita express.json() (principal)
 * e express.urlencoded() (fallback) para ler 'notification' e 'iv' [cite: Abaixo o feedback sobre os códigos gerados. Agora gerar nova versão v1.0.4 do PostbackRouter.js...].
 * - Mantém todas as funcionalidades v6.0.0 (DailyFactsService, /api/track, etc.).
 */

// 1) Imports
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { OAuth2Client } = require('google-auth-library');

// Carrega os módulos
const marketingAutomator = require('./marketingAutomator');
const PlatformAdapterBase = require('./PlatformAdapterBase');
// Importa o roteador S2S (mantido da v5.6.0)
const PostbackRouter = require('./PostbackRouter');
// ─── [v6.1.0] AdsSink — upload de conversões offline p/ Google Ads (micro via /api/track). Módulo já em produção, inerte até este require. ───
const AdsSink = require('./AdsSink');

// 2) Constantes e Configuração do Servidor
const SERVER_VERSION = '6.2.3'; // [v6.2.3] era 6.2.2. 6.2.1 = 6.2.0 + seed create-only (correcao de revisao). Reportado em /api/version
const SERVER_DEPLOY_DATE = '2026-07-28'; // [v6.2.x] era 2026-07-26
const PORT = process.env.PORT || 8080;
const TRACE_ID_HEADER = 'x-request-trace-id';
const USE_SECURE_COOKIES = process.env.NODE_ENV === 'production';

// 3) Configuração de CORS (v5.5.4: Restaurado allowlist da v5.5.2)
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
    // (P0-SEC) CORS Restrito
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

// 6) Configuração do Firebase Admin SDK
let db; 
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
     return null;
  }
  console.error('[FS][FATAL] Nenhuma credencial (FIREBASE_SERVICE_ACCOUNT_JSON ou GCP_*) foi encontrada.');
  throw new Error('sa_not_configured');
}

function initAdmin() {
  try {
    const serviceAccount = ensureSA();
    initializeApp(serviceAccount ? { credential: cert(serviceAccount) } : {});
    db = getFirestore();
    db.settings({ ignoreUndefinedProperties: true });
    FIRESTORE_INIT = true;
    console.log(`[ADMIN] Firebase SDK OK (Proj: ${FIRESTORE_PROJECT_ID} )`);
  } catch (e) {
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

// --- INÍCIO DA ALTERAÇÃO v5.5.6: Middleware de Trace ID movido para o TOPO ---
// (Req B) Garante que *todas* as respostas, incluindo erros de CORS, tenham Trace ID.
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
    // Não logar healthz para reduzir ruído
    if (req.path !== '/healthz' && req.path !== '/api/healthz') {
        console.log(logMsg);
    }
  });
  next();
});
// --- FIM DA ALTERAÇÃO v5.5.6 ---

app.use(cors(corsOptions));
app.use(cookieParser());

// --- INÍCIO DA ALTERAÇÃO v5.5.5: Friendly CORS Error (NIT) ---
// (Deve vir *depois* de app.use(cors(corsOptions)))
app.use((err, req, res, next) => {
  if (err && /^CORS: Origem não permitida/.test(err.message)) {
    res.locals.errorLog = `cors_forbidden:${req.headers.origin}`;
    // (v5.5.6) req.traceId agora está disponível
    return res.status(403).json({ ok:false, error:'cors_forbidden', origin:req.headers.origin || null, rid: req.traceId });
  }
  next(err);
});
// --- FIM DA ALTERAÇÃO v5.5.5 ---

// --- INÍCIO DA ALTERAÇÃO v5.5.4: Lógica de Autenticação (P0-SEC) ---
function getApiToken(req) {
  const h = req.get('X-Api-Token') || req.get('x-api-token') || req.get('x-api-key');
  const b = req.body?.auth?.api_token || req.body?.api_token;
  const q = req.query?.api_token || req.query?.token; 
  return h || b || q || null;
}

// (P0-SEC) Carrega tokens *apenas* do .env
const VALID_TOKENS = new Set(
  [
    process.env.TRACK_TOKEN, 
    process.env.TRACK_TOKEN_DEBUG
  ].filter(Boolean)
);
if (VALID_TOKENS.size === 0 && !TRACK_OPEN) {
    console.warn('[AUTH] Nenhum TRACK_TOKEN ou TRACK_TOKEN_DEBUG definido no .env. /api/track pode falhar.');
}

function isValidToken(tok) {
  if (TRACK_OPEN) return true; 
  if (!tok) return false;
  return VALID_TOKENS.has(String(tok));
}
// --- FIM DA ALTERAÇÃO v5.5.4 ---


// =================================================================
// 9) Utils de Daily Facts (Refatorado v6.0.0)
// =================================================================
// --- INÍCIO DA ALTERAÇÃO v6.0.0 ---
// Funções utilitárias movidas para DailyFactsService.js para reutilização
const { upsertDailyFact, toPlainJSON } = require('./DailyFactsService');
// --- FIM DA ALTERAÇÃO v6.0.0 ---


// 10) Rotas da API

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
  // (v5.5.4 BC)
  res.status(200).json({
    service: 'PZ Auth+API Backend', version: SERVER_VERSION, build_date: SERVER_DEPLOY_DATE,
    adapters_loaded: ADAPTERS_LOADED, client_ids: GOOGLE_CLIENT_IDS, origins: allowedOrigins,
    track_open: TRACK_OPEN, 
    track_token_env: TRACK_TOKEN_ENABLED, 
    debug_token_env: TRACK_TOKEN_DEBUG_ENABLED, 
    track_token: TRACK_TOKEN_ENABLED, 
    debug_token: TRACK_TOKEN_DEBUG_ENABLED, 
    fs_auth: FIRESTORE_INIT ? 'AdminSDK' : 'None', 
    fs_init: FIRESTORE_INIT, fs_project: FIRESTORE_PROJECT_ID,
    fs_sa_source: FIRESTORE_SOURCE_LOG, facts_coll: process.env.FIRESTORE_FACTS_COLLECTION || 'daily_facts',
    tx_coll: process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions',
    facts_doc_pattern: process.env.FACTS_DOC_PATTERN || '${anon_id}_${YYYY-MM-DD}',
  });
});

// --- Rota Pública (Google Auth) ---
// (JSON Parser aplicado localmente)
app.post('/auth/google', express.json(), async (req, res) => {
  // (Lógica v5.5.2 mantida)
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
    if (db) {
        const userRef = db.collection('users').doc(sub);
        const userData = {
          user_id: sub, email: email, name: name || '', first_name: given_name || '', last_name: family_name || '',
          picture: picture || '', auth_provider: 'google', last_seen_at: new Date(), created_at: new Date(),
        };
        const doc = await userRef.get();
        if (doc.exists) { await userRef.update({ last_seen_at: new Date() }); }
        else { await userRef.set(userData); }
    } else {
        console.warn(`[AUTH] Firestore (db) não disponível. Gravação 'users' pulada. [Trace: ${req.traceId}]`);
    }
    res.status(200).json({ ok: true, user_id: sub, email: email });
  } catch (fsError) {
    res.locals.errorLog = 'firestore_error_auth';
    console.error(`[AUTH][500] Erro ao salvar user no Firestore (User: ${sub}):`, fsError);
    res.status(500).json({ ok: false, error: 'firestore_error', rid: req.traceId });
  }
});

// --- Rota Pública (API de Marketing / Send Guide) ---
// (JSON Parser aplicado localmente)
app.post('/api/send-guide', express.json(), async (req, res) => {
  // (Lógica v5.5.5 mantida)
  const { user_id } = req.body;
  if (!user_id) {
    res.locals.errorLog = 'user_id_missing';
    return res.status(400).json({ ok: false, error: 'user_id_missing', rid: req.traceId });
  }
  try {
    let email = null;
    let first_name = '';

    if (db) {
        const userRef = db.collection('users').doc(user_id);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
          res.locals.errorLog = 'user_not_found_guide';
          return res.status(404).json({ ok: false, error: 'user_not_found', rid: req.traceId });
        }
        const userData = userDoc.data();
        email = userData.email;
        first_name = userData.first_name;
    } else {
        console.warn(`[GUIDE] Firestore (db) não disponível. Leitura 'users' pulada. [Trace: ${req.traceId}]`);
        email = req.body.email; 
    }

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
// (JSON Parser aplicado localmente)
app.post('/api/checkout', express.json(), async (req, res) => {
  // (Lógica v5.5.2 mantida)
  console.log(`[SERVER CHECKOUT] req.body recebido (Trace: ${req.traceId}):`, JSON.stringify(req.body)); 
  
  const { offerData, trackingParams } = req.body;
  
  console.log(`[SERVER CHECKOUT] offerData extraído (Trace: ${req.traceId}):`, JSON.stringify(offerData)); 

  if (!offerData || !offerData.affiliate_platform) {
    res.locals.errorLog = 'platform_missing_checkout';
    return res.status(400).json({ ok: false, error: 'offerData.affiliate_platform_missing', rid: req.traceId });
  }
  
  const platform = offerData.affiliate_platform;

  try {
    const adapter = PlatformAdapterBase.getInstance(platform);
    
    console.log(`[SERVER CHECKOUT] Passando offerData para o adapter ${platform} (Trace: ${req.traceId}):`, JSON.stringify(offerData)); 
    
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
// (JSON Parser aplicado localmente, com limite)
app.post('/api/track', express.json({ limit: '256kb' }), async (req, res) => {
    
    // (v5.5.3) Pixel Fallback
    try {
        // (P0-DOC) Nota: b64 fallback requer ?api_token=TOKEN na URL
        if (!req.body?.event && req.query?.b64) {
            const decoded = JSON.parse(Buffer.from(String(req.query.b64), 'base64').toString('utf8'));
            req.body = decoded;
            console.log(`[TRACK] Processando fallback b64. [Trace: ${req.traceId}]`);
        }
    } catch (e) {
        console.warn(`[TRACK] Falha ao decodificar b64 fallback: ${e.message}. [Trace: ${req.traceId}]`);
    }

    // (v5.5.4) Autenticação Flexível
    const token = getApiToken(req);
    if (!isValidToken(token)) {
        res.locals.errorLog = 'invalid_api_token';
        return res.status(401).json({ ok: false, error: 'unauthorized', rid: req.traceId });
    }

    // (v5.5.3) Leitura Correta do Evento
    const eventName = (req.body?.event || req.body?.payload?.event || 'page_view_type') + '';
    const payload = req.body?.payload || req.body; 
    
    // (v5.5.5) Mantido para logs/compat
    if (payload.event !== eventName) {
        payload.event = eventName;
    }

    if (!eventName || !payload) { // Validação
        res.locals.errorLog = 'event_payload_missing';
        return res.status(400).json({ ok: false, error: 'event_or_payload_missing', rid: req.traceId });
    }

    try {
        // Utiliza a função importada de DailyFactsService.js (v6.0.0)
        const result = await upsertDailyFact({
            db: db, 
            anon_id: payload?.anon_id || null, 
            user_id: payload?.user_id || null, 
            tz_offset: payload?.tz_offset,
            event: eventName, 
            page: payload?.page || payload?.context?.page,
            session_id: payload?.session_id,
            payload: (() => { 
                const p = { ...payload }; 
                delete p.ts; delete p.tz_offset; delete p.page; delete p.session_id; 
                delete p.user_id; delete p.anon_id; delete p.context;
                delete p.auth; 
                delete p.event_id; 
                return toPlainJSON(p); 
            })(),
            tsISO: payload?.ts || new Date().toISOString()
        });

        if (result.ok) {
            res.status(200).json({ ok: true, rid: req.traceId, doc_id: result.id, op: result.op || 'merged/set' });

            // ═════════════ [v6.1.0] LIGAÇÃO MICRO → AdsSink — INÍCIO (bloco ADITIVO) ═════════════
            // Aprovado em revisão dupla (ARCHITECT + Gemini) 2026-07-26. Fire-and-forget: NUNCA bloqueia /api/track.
            // Só actua com PZ_ADSSINK_ENABLED==='true'. Colecção dedicada ads_micro_outbox (NÃO toca affiliate_transactions).
            // Usa o crypto e o db JÁ existentes neste ficheiro. Não introduz dependências novas.
            const MICRO_EVENTS = new Set(['begin_checkout', 'view_item']);
            if (process.env.PZ_ADSSINK_ENABLED === 'true' && MICRO_EVENTS.has(eventName) && payload?.gclid) {
                const _pt = payload?.got?.page_type || payload?.page_type;
                const _ts = payload?.ts;
                const _rawKey = payload?.event_id
                    ? `eid|${eventName}|${_pt || 'na'}|${payload.event_id}`
                    : (_ts ? `syn|${payload?.anon_id || 'na'}|${eventName}|${_pt || 'na'}|${_ts}` : null);
                if (!_rawKey) {
                    console.warn(`[TRACK][AdsSink] micro sem event_id nem ts — skip. [Trace: ${req.traceId}]`);
                } else {
                    const _txid = crypto.createHash('sha1').update('web|' + _rawKey).digest('hex');
                    const _docId = 'web_' + _txid; // == _docIdFor(canonical) no AdsSink (tx_id é hex puro)
                    const _COLL = 'ads_micro_outbox';
                    const _canonical = {
                        platform: 'web', tx_id: _txid, gclid: payload.gclid,
                        page_type: _pt, event_type: eventName,
                        event_time_iso: _ts || new Date().toISOString(), raw_event_key: _rawKey,
                    };
                    setImmediate(async () => {
                        try {
                            // [v6.2.0] Seed CREATE-ONLY: cria o doc já RECLAMÁVEL — ads_upload_status
                            // 'pending' + ads_wake_at=now — atomicamente, com os campos crús para o
                            // envelope imutável (event_time_iso/event_type congelados no 1º claim).
                            // Se o doc JÁ existe, NÃO toca em nada: preserva todo o estado ads_*
                            // (uploaded/validated/retry/submitted/submitting/polling/ads_envelope).
                            // Sem isto, um crash entre o seed e o sendConversion deixaria o doc órfão
                            // (sem estado nem ads_wake_at) e a query do reprocessador nunca o encontraria.
                            const _ref = db.collection(_COLL).doc(_docId);
                            try {
                                await _ref.create({
                                    platform: 'web', tx_id: _txid, gclid: payload.gclid, page_type: _pt || null,
                                    event_name: eventName, event_type: eventName,
                                    event_time_iso: _ts || new Date().toISOString(),
                                    raw_event_key: _rawKey, source: 'micro_pageview', seed_at: new Date(),
                                    ads_upload_status: 'pending', ads_wake_at: Timestamp.now(),
                                });
                            } catch (_ce) {
                                // code 6 = ALREADY_EXISTS. Doc já existe -> não redefinir estado.
                                const _already = _ce && (_ce.code === 6 || /already exists/i.test(_ce.message || ''));
                                if (!_already) console.warn(`[TRACK][AdsSink] seed create falhou (nao ALREADY_EXISTS): ${_ce?.message || _ce}`);
                            }
                            await AdsSink.sendConversion(_canonical, { event_name: eventName, page_type: _pt, collection: _COLL });
                        } catch (e) {
                            console.error(`[TRACK][AdsSink] micro erro: ${e?.message || e}`);
                        }
                    });
                }
            }
            // ═════════════ [v6.1.0] LIGAÇÃO MICRO → AdsSink — FIM ═════════════
        } else if (result.error === 'DB_NOT_INITIALIZED') {
            res.locals.errorLog = 'firestore_not_initialized';
            res.status(200).json({ ok: true, rid: req.traceId, warning: 'db_not_initialized' });
        } else {
            throw new Error(result.error || 'upsert_failed');
        }
        
    } catch (fsError) {
        res.locals.errorLog = 'firestore_error_track';
        console.error(`[TRACK][500] Erro ao salvar evento '${eventName}' no Firestore:`, fsError);
        res.status(500).json({ ok: false, error: 'firestore_error', rid: req.traceId });
    }
});

// ═════════════ [v6.2.0] REPROCESSADOR AdsSink (fase POLL da Data Manager API) ═════════════
// Conduz os docs em submitted/retry/pending/submitting/polling (via ads_wake_at). A fase
// POLL do modelo submit->poll EXIGE isto: sem um driver periódico, `submitted` fica preso.
// NUNCA lança (AdsSink.reprocessOnce é fail-safe). Autenticado por PZ_ADSSINK_REPROCESS_TOKEN.
async function _runAdsReprocess() {
    const micro = await AdsSink.reprocessOnce({ collection: 'ads_micro_outbox' });
    const purchase = await AdsSink.reprocessOnce({ collection: process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions' });
    return { micro, purchase };
}

app.post('/internal/ads-reprocess', express.json({ limit: '16kb' }), async (req, res) => {
    const expected = process.env.PZ_ADSSINK_REPROCESS_TOKEN;
    if (!expected) return res.status(503).json({ ok: false, error: 'reprocess_token_unset', rid: req.traceId });
    const got = req.get('x-reprocess-token') || req.query.token;
    if (got !== expected) return res.status(401).json({ ok: false, error: 'unauthorized', rid: req.traceId });
    try {
        const out = await _runAdsReprocess();
        res.status(200).json({ ok: true, rid: req.traceId, ...out });
    } catch (e) {
        console.error(`[ads-reprocess] erro: ${e?.message || e}`);
        res.status(500).json({ ok: false, error: 'reprocess_failed', rid: req.traceId });
    }
});
// ═════════════ [v6.2.0] REPROCESSADOR AdsSink — FIM ═════════════

// --- INÍCIO DA ALTERAÇÃO v6.0.3: (S2S Parsers Específicos) ---
// Rota S2S (GET) - Usada pelo Digistore24 (sem body parser)
app.get('/postback/:platform', PostbackRouter.handle);

// Rota S2S (POST) - ClickBank com rota dedicada
// Aplica o parser 'json' (principal) e 'urlencoded' (fallback) para ler 'notification' e 'iv' do body [cite: Analisar abaixo o feedback. Gerar nova versão v6.0.3...].
// e injeta platform='clickbank' para o PostbackRouter.
app.post(
  '/postback/clickbank',
  // 1) Tenta parsear JSON: { "notification": "...", "iv": "..." }
  express.json({ limit: '1mb' }),
  // 2) Se vier como form-encoded, este parser cuida
  express.urlencoded({ extended: false }),
  (req, res) => {
    // Injeta o parâmetro 'platform' manualmente para o Router
    req.params.platform = 'clickbank';
    PostbackRouter.handle(req, res);
  }
);
// --- FIM DA ALTERAÇÃO v6.0.3 ---


// 10) Start
try {
  initAdmin();
  app.listen(PORT, () => {
    HEALTHZ_UPTIME_START = process.hrtime.bigint();
    console.log('\n' + '─'.repeat(60));
    console.log(`✅ Server UP on port ${PORT}`);
    console.log(`📦 Version: ${SERVER_VERSION} (${SERVER_DEPLOY_DATE})`);
    console.log('🔧 Config:');
    console.log(`   - CORS Origens : ${allowedOrigins.slice(0, 3).join(', ')}... (v5.5.4: Restrito)`); 
    console.log(`   - Google Auth  : ${GOOGLE_CLIENT_IDS.length} Client ID(s)`);
    console.log(`   - Track Aberto : ${TRACK_OPEN}`);
    console.log(`   - Track Token  : ${TRACK_TOKEN_ENABLED ? 'Sim (Env)' : 'Não (Env)'} (Validação: ${VALID_TOKENS.size} chaves, s/ fallback)`); 
    console.log(`   - Debug Token  : ${TRACK_TOKEN_DEBUG_ENABLED ? 'Sim (Env)' : 'Não (Env)'}`);
    console.log(`   - Firestore    : ${FIRESTORE_INIT ? `Admin SDK (Fonte: ${FIRESTORE_SOURCE_LOG}) ✅` : 'Desconectado ❌'}`);
    console.log(`   - Adapters     : ${ADAPTERS_LOADED ? '✅' : '❌'}`);
    console.log(`   - Guia URL Base: ${process.env.GUIDE_REDIRECT_BASE_URL || 'N/A'}`);
    console.log(`   - NODE_ENV     : ${process.env.NODE_ENV || 'undefined'}`);

    // [v6.2.0] Scheduler in-process opcional do reprocessador AdsSink. Desligado
    // por defeito (0). Alternativa ao endpoint /internal/ads-reprocess quando não
    // há cron externo. Mínimo 30s. A lease do _claim protege contra corridas.
    const _reprocessMs = parseInt(process.env.PZ_ADSSINK_REPROCESS_INTERVAL_MS || '0', 10);
    if (Number.isFinite(_reprocessMs) && _reprocessMs >= 30000) {
      setInterval(() => { _runAdsReprocess().catch((e) => console.error(`[ads-reprocess][interval] erro: ${e?.message || e}`)); }, _reprocessMs);
      console.log(`   - AdsSink Poll : interval ${_reprocessMs}ms (in-process)`);
    } else {
      console.log(`   - AdsSink Poll : interval OFF (usar /internal/ads-reprocess)`);
    }
    console.log('─'.repeat(60));
  });
} catch (e) {
  console.error('[FATAL] Erro ao iniciar servidor:', e?.message || e);
  process.exit(1);
}
