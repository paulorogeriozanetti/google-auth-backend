/**
 * PZ Auth+API Backend (v5.0.6 - Production Fix)
 * Versão: 5.0.6
 * Data: 2025-10-27
 * Desc: CORREÇÃO DE DEPLOY (RAILWAY): Força o binding '0.0.0.0' no app.listen()
 * para permitir que os health checks externos se conectem.
 */

// 1) Imports
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { OAuth2Client } = require('google-auth-library');
const marketingAutomator = require('./marketingAutomator');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// 2) Constantes e Configuração do Servidor
const SERVER_VERSION = '5.0.6';
const SERVER_DEPLOY_DATE = '2025-10-27';
const PORT = process.env.PORT || 8080;
const TRACE_ID_HEADER = 'x-request-trace-id';
const USE_SECURE_COOKIES = process.env.NODE_ENV === 'production';

// 3) Configuração de CORS (Segurança)
// Lista de origens permitidas (sem / no final)
const allowedOrigins = [
  'https://pzadvisors.com',
  'https://www.pzadvisors.com',
  'https://auth.pzadvisors.com', // (Exemplo, se o frontend estiver aqui)
  // Adicione subdomínios se necessário
];
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:8080'); // Dev local
  allowedOrigins.push('http://127.0.0.1:8080');
}
const corsOptions = {
  origin: (origin, callback) => {
    // Permite REST tools (sem origin) ou origens na lista
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: Origem não permitida: ${origin}`));
    }
  },
  credentials: true,
};

// 4) Configuração de Clientes Google Auth
// (Permite múltiplos frontends/apps usarem a mesma API)
const GOOGLE_CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID_PZADVISORS, // Ex: pzadvisors.com
  process.env.GOOGLE_CLIENT_ID_LANDER_B,  // Ex: outrolander.com
].filter(Boolean); // Remove IDs não definidos

if (!GOOGLE_CLIENT_IDS.length) {
  console.warn('[AUTH] Aviso: Nenhum GOOGLE_CLIENT_ID_* configurado.');
}
const googleAuthClients = GOOGLE_CLIENT_IDS.map(id => new OAuth2Client(id));

// 5) Configuração de Tracking (Tokens de API)
const TRACK_TOKEN_ENABLED = !!process.env.TRACK_TOKEN;
const TRACK_TOKEN_DEBUG_ENABLED = !!process.env.TRACK_TOKEN_DEBUG;
const TRACK_OPEN = process.env.TRACK_OPEN === 'true'; // Se 'true', permite tracking sem token

// 6) Configuração do Firebase Admin SDK (com fallback robusto)
let admin;
let db;
let FIRESTORE_SOURCE_LOG = 'N/A';

function ensureSA() {
  // Padrão Railway/Fly.io (JSON numa só linha)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      FIRESTORE_SOURCE_LOG = 'env_json';
      return sa;
    } catch (e) {
      console.error('[FS][ERRO] Falha ao parsear FIREBASE_SERVICE_ACCOUNT_JSON:', e?.message);
    }
  }
  // Padrão Vercel (Split)
  if (process.env.GCP_PROJECT_ID && process.env.GCP_SA_EMAIL && process.env.GCP_SA_PRIVATE_KEY) {
     try {
       const sa = {
         project_id: process.env.GCP_PROJECT_ID,
         client_email: process.env.GCP_SA_EMAIL,
         // Corrige formatação da private key (comum em Vercel/Netlify)
         private_key: process.env.GCP_SA_PRIVATE_KEY.replace(/\\n/g, '\n'),
       };
       FIRESTORE_SOURCE_LOG = 'env_split';
       return sa;
     } catch (e) {
       console.error('[FS][ERRO] Falha ao montar SA das Vercel vars:', e?.message);
     }
  }
  // Padrão GCloud Run / Functions (automático)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
     FIRESTORE_SOURCE_LOG = 'gcp_auto';
     return null; // Deixa o SDK descobrir sozinho
  }
  throw new Error('sa_not_configured');
}

function initAdmin() {
  try {
    const serviceAccount = ensureSA(); // Pode ser null (gcp_auto) ou o objeto
    
    initializeApp(serviceAccount ? { credential: cert(serviceAccount) } : {});
    
    admin = true;
    db = getFirestore();
    db.settings({ ignoreUndefinedProperties: true }); // Boa prática
    console.log(`[ADMIN] Firebase SDK OK (Proj: ${process.env.GCP_PROJECT_ID || process.env.PROJECT_ID || 'default'})`);
  } catch (e) {
    admin = false;
    console.error('[ADMIN][FATAL] Falha ao inicializar Firebase Admin SDK:', e?.message);
    if (e.message.includes('sa_not_configured')) {
        console.error('[ADMIN][FATAL] Nenhuma credencial (FIREBASE_SERVICE_ACCOUNT_JSON ou GCP_*) foi encontrada.');
    }
  }
}

// 7) Inicialização dos Adapters (Factory)
// (Isto irá falhar e crashar o boot se os adapters não carregarem, o que é bom)
let ADAPTERS_LOADED = false;
try {
  PlatformAdapterBase.getInstance('clickbank'); // Pré-aquece o adapter
  PlatformAdapterBase.getInstance('digistore24'); // Pré-aquece o adapter
  ADAPTERS_LOADED = true;
  console.log('[BOOT] Módulos Adapter carregados com sucesso.');
} catch (e) {
  console.error('[BOOT][FATAL] Falha ao carregar Adapters:', e.message);
  // O server.js irá crashar aqui se uma chave (ex: CLICKBANK_WEBHOOK_SECRET_KEY) faltar
  throw e;
}
try {
  if (marketingAutomator) console.log('[BOOT] Módulo marketingAutomator carregado com sucesso.');
} catch (e) {}

// 8) Middlewares
const app = express();
app.set('trust proxy', 1); // Confia no proxy (Railway, Fly, GCloud)
app.use(cors(corsOptions)); // Aplica CORS
app.use(cookieParser()); // Habilita parser de cookies

// Middleware de Logging e Trace ID
app.use((req, res, next) => {
  const traceId = req.headers[TRACE_ID_HEADER] || crypto.randomUUID();
  req.traceId = traceId;
  res.setHeader(TRACE_ID_HEADER, traceId);
  
  const start = process.hrtime.bigint();
  
  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const duration = (end - start) / 1_000_000n; // ms
    console.log(`[${req.method}] ${req.path} (${res.statusCode}) - ${duration}ms - [Trace: ${traceId}]`);
  });
  next();
});

// Middleware de Verificação de Token de API (para rotas protegidas)
const verifyApiToken = (req, res, next) => {
  if (TRACK_OPEN) return next(); // API aberta

  const token = req.headers['x-api-token'] || req.query.token;
  
  if (TRACK_TOKEN_ENABLED && token === process.env.TRACK_TOKEN) {
    return next(); // Token principal
  }
  if (TRACK_TOKEN_DEBUG_ENABLED && token === process.env.TRACK_TOKEN_DEBUG) {
    return next(); // Token de debug
  }
  
  console.warn(`[AUTH][401] Token de API inválido ou ausente. [Trace: ${req.traceId}]`);
  return res.status(401).json({ error: 'unauthorized', traceId: req.traceId });
};


// 9) Rotas da API

// --- Rotas Públicas (Health & Version) ---

// (Usado pelo Railway/GCloud para health check)
app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.get('/api/healthz', (req, res) => res.status(200).send('OK'));

app.get('/api/version', (req, res) => {
  res.status(200).json({
    service: 'PZ Auth+API Backend',
    version: SERVER_VERSION,
    deploy_date: SERVER_DEPLOY_DATE,
    status: 'online',
    firestore: admin ? 'connected' : 'disconnected',
    firestore_source: FIRESTORE_SOURCE_LOG,
    adapters_loaded: ADAPTERS_LOADED,
    tracking_open: TRACK_OPEN,
  });
});

// --- Rota Pública (Google Auth) ---

/**
 * Rota: /auth/google
 * Método: POST
 * Body: { credential: "..." }
 * Desc: Recebe o ID Token (JWT) do Google (GSI), verifica,
 * cria/atualiza o user no Firestore e retorna o user_id (sub).
 */
app.post('/auth/google', express.json(), async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'credential_missing', traceId: req.traceId });
  }

  let ticket;
  let verified = false;
  
  // Tenta verificar o token contra TODOS os Client IDs configurados
  for (const client of googleAuthClients) {
    try {
      ticket = await client.verifyIdToken({
          idToken: credential,
          // Não é necessário 'audience' aqui se estamos apenas validando,
          // mas se tivéssemos múltiplos, usaríamos:
          // audience: GOOGLE_CLIENT_IDS, 
      });
      if (ticket) {
        verified = true;
        break; // Sucesso
      }
    } catch (e) {
      // Ignora erro (ex: "Invalid audience") e tenta o próximo client
    }
  }

  if (!verified || !ticket) {
    console.warn(`[AUTH][401] Google Token Inválido (nenhum Client ID correspondeu). [Trace: ${req.traceId}]`);
    return res.status(401).json({ error: 'google_token_invalid', traceId: req.traceId });
  }

  const payload = ticket.getPayload();
  const { sub, email, name, given_name, family_name, picture } = payload;

  if (!sub || !email) {
    console.error(`[AUTH][400] Payload do Google sem 'sub' ou 'email'. [Trace: ${req.traceId}]`);
    return res.status(400).json({ error: 'google_payload_incomplete', traceId: req.traceId });
  }
  
  // Salva no Firestore
  try {
    const userRef = db.collection('users').doc(sub);
    const userData = {
      user_id: sub,
      email: email,
      name: name || '',
      first_name: given_name || '',
      last_name: family_name || '',
      picture: picture || '',
      auth_provider: 'google',
      last_seen_at: new Date(),
    };
    
    // 'set' com 'merge: true' (Upsert)
    await userRef.set(userData, { merge: true });

    // Retorna apenas os dados essenciais
    res.status(200).json({
      status: 'ok',
      user_id: sub,
      email: email,
    });

  } catch (fsError) {
    console.error(`[AUTH][500] Erro ao salvar user no Firestore (User: ${sub}):`, fsError);
    res.status(500).json({ error: 'firestore_error', traceId: req.traceId });
  }
});


// --- Rota Pública (API de Marketing / Send Guide) ---
// (Esta rota é PÚBLICA, pois lida com a captura de leads
// que acabaram de se autenticar)

/**
 * Rota: /api/send-guide
 * Método: POST
 * Body: { user_id: "..." } (O ID do Google 'sub')
 * Desc: Busca o e-mail do user no Firestore (usando o user_id)
 * e o envia para o funil de automação (ConvertKit).
 */
app.post('/api/send-guide', express.json(), async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: 'user_id_missing', traceId: req.traceId });
  }

  try {
    // 1. Buscar dados do user no Firestore
    const userRef = db.collection('users').doc(user_id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.error(`[GUIDE][404] User (User: ${user_id}) não encontrado no Firestore. [Trace: ${req.traceId}]`);
      return res.status(404).json({ error: 'user_not_found', traceId: req.traceId });
    }
    
    const userData = userDoc.data();
    const { email, first_name } = userData;

    if (!email) {
       console.error(`[GUIDE][400] User (User: ${user_id}) existe mas não tem e-mail. [Trace: ${req.traceId}]`);
      return res.status(400).json({ error: 'user_email_missing', traceId: req.traceId });
    }

    // 2. Enviar para o Marketing Automator (ConvertKit)
    // (O automator lida com seus próprios erros internos)
    const subscriberInfo = {
      email: email,
      first_name: first_name || '',
      fields: {
        // Campos customizados (se houver)
        user_id_google: user_id,
        // ... outros dados (anon_id, attribution_history)
        // (Nota: o automator não usa estes campos na v5.1.0)
      }
    };

    const ckResponse = await marketingAutomator.addSubscriberToFunnel(subscriberInfo);

    res.status(200).json({
      status: 'ok',
      message: 'Guide request processed.',
      subscriber: ckResponse, // Retorna resposta do ConvertKit
    });

  } catch (error) {
    console.error(`[GUIDE][500] Falha ao processar guia (User: ${user_id}):`, error?.message || error);
    if (error.response) { // Erro do Axios (ConvertKit)
       return res.status(error.response.status || 502).json({ 
         error: 'marketing_api_error', 
         details: error.response.data,
         traceId: req.traceId 
       });
    }
    res.status(500).json({ error: 'internal_server_error', traceId: req.traceId });
  }
});

// --- Rota Protegida (API de Checkout / Adapter Factory) ---

/**
 * Rota: /api/checkout
 * Método: POST
 * Body: { offerData: { ... }, trackingParams: { ... } }
 * Desc: Recebe dados da oferta e parâmetros de tracking,
 * usa a Factory (AdapterBase) para instanciar o adapter correto
 * e chama buildCheckoutUrl().
 */
app.post('/api/checkout', express.json(), async (req, res) => {
  const { offerData, trackingParams } = req.body;

  if (!offerData || !offerData.affiliate_platform) {
    return res.status(400).json({ error: 'offerData.affiliate_platform_missing', traceId: req.traceId });
  }
  
  const platform = offerData.affiliate_platform;

  try {
    // 1. Usa a Factory para obter o Adapter
    const adapter = PlatformAdapterBase.getInstance(platform);
    
    // 2. Chama o método do Adapter
    const checkoutUrl = await adapter.buildCheckoutUrl(offerData, trackingParams);

    if (checkoutUrl) {
      res.status(200).json({
        status: 'ok',
        checkout_url: checkoutUrl,
        platform: platform,
        adapter_version: adapter.version || 'N/A',
      });
    } else {
       console.warn(`[CHECKOUT][400] Adapter ${platform} retornou URL nula. [Trace: ${req.traceId}]`);
       res.status(400).json({ error: 'checkout_url_generation_failed', platform: platform, traceId: req.traceId });
    }

  } catch (error) {
    console.error(`[CHECKOUT][500] Falha na Factory ou Adapter (${platform}):`, error?.message || error);
    res.status(500).json({ 
      error: 'adapter_error', 
      platform: platform, 
      details: error.message,
      traceId: req.traceId 
    });
  }
});


// --- Rota Protegida (API de Tracking / Eventos) ---

/**
 * Rota: /api/track
 * Método: POST
 * Auth: X-Api-Token
 * Body: { event: "...", payload: { ... } }
 * Desc: Rota genérica para receber eventos de tracking do frontend
 * e salvá-los no Firestore (ex: 'daily_facts').
 */
app.post('/api/track', verifyApiToken, express.json(), async (req, res) => {
  const { event, payload } = req.body;
  if (!event || !payload) {
    return res.status(400).json({ error: 'event_or_payload_missing', traceId: req.traceId });
  }

  // Define a coleção (ex: 'daily_facts', 'page_views', 'clicks')
  const collectionName = 'daily_facts'; 

  try {
    const docData = {
      ...payload,
      event_name: event,
      server_timestamp: new Date(),
      trace_id: req.traceId,
      // (Opcional: Adicionar IP, User-Agent se necessário)
    };
    
    // Adiciona o documento (o Firestore gera o ID)
    const docRef = await db.collection(collectionName).add(docData);

    res.status(201).json({ 
      status: 'created',
      doc_id: docRef.id 
    });

  } catch (fsError) {
    console.error(`[TRACK][500] Erro ao salvar evento '${event}' no Firestore:`, fsError);
    res.status(500).json({ error: 'firestore_error', traceId: req.traceId });
  }
});


// --- Rotas Públicas (Webhooks S2S das Plataformas) ---
// (Estas rotas NÃO podem ter verifyApiToken)

/**
 * Rota: /webhook/digistore24
 * Método: GET (Digistore usa GET S2S)
 * Desc: Recebe o webhook S2S (Server-to-Server) do Digistore24.
 * Usa o Digistore24Adapter para verificar o 'auth_key' e
 * normalizar o payload, depois salva no Firestore.
 */
app.get('/webhook/digistore24', async (req, res) => {
  const query = req.query;
  const headers = req.headers;

  try {
    const adapter = PlatformAdapterBase.getInstance('digistore24');
    
    // O adapter é responsável pela validação (auth_key) e normalização
    const normalizedData = await adapter.verifyWebhook(query, headers);
    
    if (normalizedData) {
      // Sucesso: Salva no Firestore
      const docId = `ds24_${normalizedData.transactionId || normalizedData.orderId || Date.now()}`;
      await db.collection('affiliate_transactions').doc(docId).set(normalizedData, { merge: true });
      
      console.log(`[WEBHOOK][DS24] Webhook S2S ${docId} processado.`);
      res.status(200).send('OK'); // Resposta OK para o Digistore24
    } else {
      // Falha (ex: auth_key inválida)
      console.warn(`[WEBHOOK][DS24] Webhook S2S falhou na verificação do Adapter. [Trace: ${req.traceId}]`);
      res.status(401).send('Unauthorized');
    }

  } catch (error) {
    console.error(`[WEBHOOK][DS24] Erro crítico no Adapter Digistore24:`, error?.message || error);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * Rota: /webhook/clickbank
 * Método: POST (Clickbank usa POST)
 * Desc: Recebe o webhook (INS) do Clickbank.
 * Usa o ClickbankAdapter para verificar o HMAC (assinatura)
 * e decifrar o payload AES-256-CBC, normalizar e salvar.
 */
// (Middleware específico para ler o Buffer raw do body)
app.post('/webhook/clickbank', express.raw({ type: 'application/json' }), async (req, res) => {
  // O Adapter do Clickbank espera o Buffer raw, não o JSON parseado
  const rawBodyBuffer = req.body; 
  const headers = req.headers;

  if (!rawBodyBuffer || rawBodyBuffer.length === 0) {
      console.warn(`[WEBHOOK][CB] Recebido body vazio. [Trace: ${req.traceId}]`);
      return res.status(400).send('Bad Request: Empty payload');
  }

  try {
    const adapter = PlatformAdapterBase.getInstance('clickbank');
    
    // O adapter é responsável pela validação (HMAC, Decrypt) e normalização
    const normalizedData = await adapter.verifyWebhook(rawBodyBuffer, headers);
    
    if (normalizedData) {
      // Sucesso: Salva no Firestore
      const docId = `cb_${normalizedData.transactionId || normalizedData.orderId}`;
      await db.collection('affiliate_transactions').doc(docId).set(normalizedData, { merge: true });
      
      console.log(`[WEBHOOK][CB] Webhook INS ${docId} processado.`);
      res.status(200).send('OK'); // Resposta OK para o Clickbank
    } else {
      // Falha (ex: HMAC inválido)
      console.warn(`[WEBHOOK][CB] Webhook INS falhou na verificação (HMAC/Decrypt). [Trace: ${req.traceId}]`);
      res.status(401).send('Unauthorized');
    }

  } catch (error) {
    console.error(`[WEBHOOK][CB] Erro crítico no Adapter Clickbank:`, error?.message || error);
    res.status(500).send('Internal Server Error');
  }
});


// 10) Start
try {
  // Inicializa o Firebase (síncrono no boot)
  initAdmin(); 
  
  if (!admin && process.env.NODE_ENV === 'production') {
    // Não permite boot em produção sem DB
    throw new Error('Firestore (Admin SDK) falhou ao inicializar. Abortando.');
  }

  // --- ALTERAÇÃO v5.0.6: Força o binding 0.0.0.0 (Host) ---
  // (Necessário para o Railway/Fly.io health check se conectar)
  app.listen(PORT, '0.0.0.0', () => { // Inicia servidor, FORÇA binding 0.0.0.0
    console.log('\n' + '─'.repeat(60));
    // Log atualizado para confirmar a mudança:
    console.log(`✅ Server UP on port ${PORT} (Binding: 0.0.0.0)`);
    console.log(`📦 Version: ${SERVER_VERSION} (${SERVER_DEPLOY_DATE})`);
    console.log('🔧 Config:');
    console.log(`   - CORS Origens : ${allowedOrigins.slice(0, 3).join(', ')}...`);
    console.log(`   - Google Auth  : ${GOOGLE_CLIENT_IDS.length} Client ID(s)`);
    console.log(`   - Track Aberto : ${TRACK_OPEN}`);
    console.log(`   - Track Token  : ${TRACK_TOKEN_ENABLED ? 'Sim' : 'Não'}`);
    console.log(`   - Debug Token  : ${TRACK_TOKEN_DEBUG_ENABLED ? 'Sim' : 'Não'}`);
    console.log(`   - Firestore    : ${admin ? `Admin SDK (Fonte: ${FIRESTORE_SOURCE_LOG}) ✅` : 'Desconectado ❌'}`);
    console.log(`   - Adapters     : ${ADAPTERS_LOADED ? '✅' : '❌'}`);
    console.log(`   - Guia URL Base: ${process.env.GUIDE_REDIRECT_BASE_URL || 'N/A'}`);
    console.log(`   - NODE_ENV     : ${process.env.NODE_ENV || 'undefined'}`);
    console.log('─'.repeat(60));
  });
} catch (e) {
  console.error('[FATAL] Erro ao iniciar servidor:', e?.message || e);
  process.exit(1);
}