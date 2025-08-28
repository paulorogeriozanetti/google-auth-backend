/**
 * PZ Auth Backend – Versão 1.3.0 – 2025-08-21
 *
 * Endpoints:
 * - Healthcheck:   GET /healthz  (200 quando OK)
 * - Root test:     GET /
 * - Auth:          POST /auth/google  { credential: "<ID_TOKEN>" }
 *
 * Melhorias nesta versão:
 *  - 🔎 Logging estruturado + correlation id (X-Trace-Id) por request
 *  - 🔐 CORS: inclui header "X-Trace-Id" além de "X-PZ-Version"
 *  - 🗃️ Upsert do utilizador no Firestore (users/{user_id}) após verificação
 *  - 🧪 Health mais verboso (uptime + timestamp ISO)
 *  - 🧱 Preflight OPTIONS /auth/google (204) mantido
 *  - 🧊 Resposta /auth com no-store (evita cache intermediário)
 *  - ✅ Nenhuma funcionalidade removida
 */

const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const { Firestore } = require('@google-cloud/firestore');

const app = express();

/* ──────────────────────────────────────────────────────────────
   1) Config / Vars
─────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 8080;
const CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '775119501851-1qsm8b7sf50k0jar8i75qsffh0hfi0pl.apps.googleusercontent.com';

// Múltiplas origens via env (ALLOWED_ORIGINS) ou default:
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  [
    'https://pzadvisors.com',
    'https://www.pzadvisors.com',
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

// Cloud proxies (Railway/Cloud Run) — confia no proxy p/ IP/cookies seguros
app.set('trust proxy', true);

// Firestore (usa credenciais padrão do ambiente GCP)
const db = new Firestore();
const usersCol = db.collection('users');

/* ──────────────────────────────────────────────────────────────
   2) Middlewares
─────────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '1mb' }));

app.use(
  cors({
    origin(origin, cb) {
      // Healthcheck e Postman podem não enviar "origin"
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
      'X-Trace-Id',  'x-trace-id'
    ],
    optionsSuccessStatus: 204
  })
);

// Logger estruturado + correlation id (X-Trace-Id)
app.use((req, res, next) => {
  const rid =
    req.headers['x-trace-id'] ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.rid = rid;
  res.setHeader('X-Trace-Id', rid);
  const t0 = Date.now();
  res.on('finish', () => {
    try {
      console.log(JSON.stringify({
        route: req.path,
        rid,
        method: req.method,
        status: res.statusCode,
        ms: Date.now() - t0,
        origin: req.headers.origin || null
      }));
    } catch (_) {
      // fallback
      console.log(`[REQ] ${req.method} ${req.url} | rid=${rid} | status=${res.statusCode}`);
    }
  });
  next();
});

/* ──────────────────────────────────────────────────────────────
   3) Rotas básicas / Health
─────────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => {
  res
    .status(200)
    .send('🚀 API de autenticação Google rodando com sucesso! (PZ Auth Backend)');
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
});

/* ──────────────────────────────────────────────────────────────
   4) Google OAuth – One Tap (ID token verificação)
─────────────────────────────────────────────────────────────── */
const client = new OAuth2Client(CLIENT_ID);

// Preflight mais rápido para o endpoint de auth
app.options('/auth/google', (_req, res) => res.sendStatus(204));

app.post('/auth/google', async (req, res) => {
  try {
    const { credential } = req.body || {};
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

    // 2) Mapear sub -> user_id interno (aqui usamos o próprio sub)
    const user_id = String(sub);

    // 3) Persistir/atualizar usuário no Firestore
    try {
      await usersCol.doc(user_id).set({
        user_id,
        sub,
        email: email || null,
        name: name || null,
        picture: picture || null,
        email_verified: !!email_verified,
        last_seen: new Date()
      }, { merge: true });
    } catch (e) {
      // Persistência não deve derrubar o auth; loga e segue
      console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, ok:true, warn:'firestore_upsert_failed', error: e.message || String(e) }));
    }

    // 4) Log estruturado OK
    console.log(JSON.stringify({
      route: '/auth/google',
      rid: req.rid,
      ok: true,
      user_id,
      sub,
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
});

/* ──────────────────────────────────────────────────────────────
   5) Tratamento de erros globais
─────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err);
});

/* ──────────────────────────────────────────────────────────────
   6) Start
─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────');
  console.log(`✅ Server UP on port ${PORT}`);
  console.log('🔧 Vars:');
  console.log('   GOOGLE_CLIENT_ID:', CLIENT_ID);
  console.log('   ALLOWED_ORIGINS :', allowedOrigins);
  console.log('   NODE_ENV        :', process.env.NODE_ENV || '(not set)');
  console.log('──────────────────────────────────────────────');
});