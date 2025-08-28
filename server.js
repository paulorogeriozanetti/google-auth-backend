/**
 * PZ Auth+API Backend – Versão 1.4.1 – 2025-08-28
 *
 * Endpoints:
 * - Healthcheck:        GET  /healthz            (alias: GET /api/healthz)
 * - Root test:          GET  /
 * - Versão/Status:      GET  /api/version
 * - Auth (Google OTP):  POST /auth/google        { credential, context? }
 *                        ALIAS: POST /api/auth/google
 * - Echo (debug leve):  POST /api/echo           { ... }  -> devolve payload (sem persistir)
 * - Track (opcional):   POST /api/track          { event, payload? }  -> grava em auth_events (se habilitado)
 *
 * Novidades v1.4.1:
 *  - 🔐 Firestore com credenciais explícitas via ENV:
 *      FIREBASE_SERVICE_ACCOUNT_JSON (JSON)  OU  FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 (base64)
 *    (corrige "\n" da private_key automaticamente; fallback para ADC quando não setado)
 *  - ✅ Demais funcionalidades preservadas (CORS, logs, aliases, track, echo…)
 */

const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const app = express();

/* ──────────────────────────────────────────────────────────────
   1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '1.4.1';
const BUILD_DATE = '2025-08-28';

const PORT = process.env.PORT || 8080;

const CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '775119501851-1qsm8b7sf50k0jar8i75qsffh0hfi0pl.apps.googleusercontent.com';

// Múltiplas origens via env (ALLOWED_ORIGINS) ou default:
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  [
    'https://pzadvisors.com',
    'https://www.pzadvisors.com',
    'https://auth.pzadvisors.com',
    'https://api.pzadvisors.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8081' // testes locais
  ].join(',')
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Habilita /api/track sem token só se explicitamente permitido
const TRACK_OPEN = (process.env.TRACK_OPEN || 'false').toLowerCase() === 'true';
// Caso não esteja aberto, exige X-Api-Token == TRACK_TOKEN para /api/track
const TRACK_TOKEN = process.env.TRACK_TOKEN || '';

// Cloud proxies (Railway/Cloud Run) — confia no proxy p/ IP/cookies seguros
app.set('trust proxy', true);

/* ──────────────────────────────────────────────────────────────
   1.1) Firestore – credenciais via ENV (ou ADC fallback)
─────────────────────────────────────────────────────────────── */
function loadServiceAccountFromEnv() {
  try {
    // Preferência: JSON puro
    let raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';

    // Alternativa: base64
    if (!raw && process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64) {
      raw = Buffer.from(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64,
        'base64'
      ).toString('utf8');
    }

    if (!raw) return null;

    const json = JSON.parse(raw);
    if (json.private_key && typeof json.private_key === 'string') {
      // Corrige quebras de linha escapadas
      json.private_key = json.private_key.replace(/\\n/g, '\n');
    }
    return json;
  } catch (e) {
    console.error('[SA_PARSE_ERROR]', e?.message || String(e));
    return null;
  }
}

const sa = loadServiceAccountFromEnv();

const db = sa && sa.client_email && sa.private_key
  ? new Firestore({
      projectId: sa.project_id,
      credentials: {
        client_email: sa.client_email,
        private_key: sa.private_key
      }
    })
  : new Firestore(); // fallback ADC (ex.: Cloud Run com Workload Identity)

const usersCol  = db.collection('users');
const eventsCol = db.collection('auth_events');

/* ──────────────────────────────────────────────────────────────
   2) Middlewares
─────────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '1mb' }));

app.use(
  cors({
    origin(origin, cb) {
      // Healthcheck e ferramentas CLI podem não enviar "origin"
      if (!origin) return cb(null, true);
      const ok = allowedOrigins.includes(origin);
      if (ok) return cb(null, true);
      cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-PZ-Version', 'x-pz-version',
      'X-Trace-Id',  'x-trace-id',
      'X-Api-Token', 'x-api-token'
    ],
    optionsSuccessStatus: 204
  })
);

// X-Trace-Id + versão em todas as respostas
app.use((req, res, next) => {
  const rid =
    req.headers['x-trace-id'] ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.rid = rid;
  res.setHeader('X-Trace-Id', rid);
  res.setHeader('X-PZ-Version', `PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`);
  next();
});

// Logger estruturado
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      console.log(
        JSON.stringify({
          rid: req.rid,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - t0,
          origin: req.headers.origin || null,
        })
      );
    } catch (_) {
      // fallback
      console.log(`[REQ] ${req.method} ${req.url} | rid=${req.rid} | status=${res.statusCode}`);
    }
  });
  next();
});

/* ──────────────────────────────────────────────────────────────
   3) Rotas básicas / Health / Versão
─────────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => {
  res
    .status(200)
    .send('🚀 PZ Auth+API Backend ativo. Use /healthz, /api/version ou /auth/google.');
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
});
app.get('/api/healthz', (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
});

app.get('/api/version', (_req, res) => {
  res.status(200).json({
    service: 'PZ Auth+API Backend',
    version: VERSION,
    build_date: BUILD_DATE,
    client_id_configured: Boolean(process.env.GOOGLE_CLIENT_ID) || 'default',
    cors_allowed_origins: allowedOrigins,
    track_open: TRACK_OPEN,
    has_track_token: Boolean(TRACK_TOKEN),
    firestore_auth_mode: sa ? 'service-account-env' : 'adc'
  });
});

/* ──────────────────────────────────────────────────────────────
   4) Google OAuth – One Tap (ID token verificação)
─────────────────────────────────────────────────────────────── */
const client = new OAuth2Client(CLIENT_ID);

// Preflight rápido para o endpoint de auth
app.options('/auth/google', (_req, res) => res.sendStatus(204));
app.options('/api/auth/google', (_req, res) => res.sendStatus(204));

// Handler compartilhado
async function handleAuthGoogle(req, res) {
  try {
    const { credential, context } = req.body || {};
    if (!credential || typeof credential !== 'string') {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:false, error:'missing_credential' }));
      return res.status(400).json({ error: 'Missing credential' });
    }

    // Evita cache intermediário da resposta
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0'
    });

    // 1) Verificar ID Token
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: CLIENT_ID
    });
    const payload = ticket.getPayload();
    if (!payload) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:false, error:'empty_payload' }));
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Checagem leve do emissor (log informativo — não bloqueia)
    if (payload.iss && !/accounts\.google\.com$/.test(String(payload.iss))) {
      console.warn(JSON.stringify({ route:'/auth/google', rid:req.rid, warn:'unexpected_issuer', iss: payload.iss }));
    }

    const { sub, email, name, picture, email_verified } = payload;
    const user_id = String(sub);

    // 2) Persistir/atualizar usuário no Firestore
    try {
      await usersCol.doc(user_id).set(
        {
          user_id,
          sub,
          email: email || null,
          name: name || null,
          picture: picture || null,
          email_verified: !!email_verified,
          last_seen: FieldValue.serverTimestamp(),
          updated_at: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    } catch (e) {
      // Persistência do usuário não deve derrubar o auth; loga e segue
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:true, warn:'firestore_upsert_failed', error: e.message || String(e) }));
    }

    // 3) Logar evento de autenticação (não bloqueante)
    try {
      const traceId = req.headers['x-trace-id'] || null;
      await eventsCol.add({
        type: 'auth_google',
        rid: req.rid,
        trace_id: traceId,
        user_id,
        email: email || null,
        context: context || null,
        ua: req.headers['user-agent'] || null,
        origin: req.headers.origin || null,
        ts: FieldValue.serverTimestamp()
      });
    } catch (e) {
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, warn:'auth_event_log_failed', error: e.message || String(e) }));
    }

    // 4) Log estruturado OK
    console.log(JSON.stringify({
      route: '/auth/google',
      rid: req.rid,
      ok: true,
      user_id,
      email: email || null
    }));

    // 5) Resposta para o frontend
    return res.status(200).json({
      user_id,
      email: email || null,
      name: name || null,
      picture: picture || null
      // (Opcional: definir cookie HttpOnly/SameSite aqui)
    });
  } catch (err) {
    console.error(JSON.stringify({
      route: '/auth/google',
      rid: req.rid,
      ok: false,
      error: err?.message || String(err)
    }));
    return res.status(401).json({ error: 'auth_failed' });
  }
}

app.post('/auth/google', handleAuthGoogle);
app.post('/api/auth/google', handleAuthGoogle);

/* ──────────────────────────────────────────────────────────────
   5) Endpoints auxiliares de API
─────────────────────────────────────────────────────────────── */

// Debug leve — NÃO persiste (útil p/ teste rápido de CORS)
app.post('/api/echo', (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0'
  });
  return res.status(200).json({
    ok: true,
    rid: req.rid,
    echo: req.body || null,
    ts: new Date().toISOString()
  });
});

// Track opcional — grava eventos no Firestore (auth_events)
// - Se TRACK_OPEN=true, qualquer origem permitida pode gravar
// - Caso contrário, exige X-Api-Token == TRACK_TOKEN
app.post('/api/track', async (req, res) => {
  try {
    if (!TRACK_OPEN) {
      const tok = req.headers['x-api-token'] || req.headers['X-Api-Token'];
      if (!TRACK_TOKEN || tok !== TRACK_TOKEN) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
    }
    const { event, payload } = req.body || {};
    if (!event || typeof event !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing_event' });
    }
    await eventsCol.add({
      type: event,
      rid: req.rid,
      payload: payload || null,
      origin: req.headers.origin || null,
      ua: req.headers['user-agent'] || null,
      ts: FieldValue.serverTimestamp()
    });
    return res.status(200).json({ ok: true, rid: req.rid });
  } catch (e) {
    console.error(JSON.stringify({ route:'/api/track', rid:req.rid, error: e.message || String(e) }));
    return res.status(500).json({ ok: false, error: 'track_failed' });
  }
});

/* ──────────────────────────────────────────────────────────────
   6) Tratamento de erros globais
─────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err);
});

/* ──────────────────────────────────────────────────────────────
   7) Start
─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────');
  console.log(`✅ Server UP on port ${PORT}`);
  console.log(`📦 Version: v${VERSION} (${BUILD_DATE})`);
  console.log('🔧 Vars:');
  console.log('   GOOGLE_CLIENT_ID           :', CLIENT_ID);
  console.log('   ALLOWED_ORIGINS            :', allowedOrigins);
  console.log('   TRACK_OPEN                 :', TRACK_OPEN);
  console.log('   TRACK_TOKEN set            :', Boolean(TRACK_TOKEN));
  console.log('   FIRESTORE auth mode        :', sa ? 'service-account-env' : 'adc');
  console.log('   NODE_ENV                   :', process.env.NODE_ENV || '(not set)');
  console.log('──────────────────────────────────────────────');
});