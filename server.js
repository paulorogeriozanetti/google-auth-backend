/**
 * PZ Auth Backend – Versão 1.2 – 2025-08-12
 *
 * - Healthcheck:   GET /healthz  (retorna 200 quando está de pé)
 * - Root test:     GET /
 * - Auth:          POST /auth/google  { credential: "<ID_TOKEN>" }
 *
 * Melhorias nesta versão:
 *  - trust proxy habilitado (Railway/CDN)
 *  - OPTIONS /auth/google para preflight CORS (204)
 *  - Cabeçalhos no-store no endpoint de auth (evita cache intermediário)
 *  - Checagem leve do emissor (iss) do token Google (log informativo)
 *  - Nenhuma funcionalidade removida ou alterada
 */

const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');

const app = express();

// ────────────────────────────────────────────────────────────────
// 1) Config / Vars
// ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '775119501851-1qsm8b7sf50k0jar8i75qsffh0hfi0pl.apps.googleusercontent.com';

// Permite definir múltiplas origens via env (ALLOWED_ORIGINS), ou usa padrão:
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  [
    'https://pzadvisors.com',
    'https://api.pzadvisors.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8081', // para testes locais
  ].join(',')
)
  .split(',')
  .map((o) => o.trim());

// Em ambientes com proxy (Railway/Cloud), confia no proxy para IP/cookies seguros
app.set('trust proxy', true);

// ────────────────────────────────────────────────────────────────
// 2) Middlewares
// ────────────────────────────────────────────────────────────────
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
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  })
);

// Logger simples de requisições
app.use((req, _res, next) => {
  console.log(
    `[REQ] ${req.method} ${req.url} | origin=${req.headers.origin || '-'} | ip=${
      req.ip
    }`
  );
  next();
});

// ────────────────────────────────────────────────────────────────
// 3) Rotas básicas / Health
// ────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res
    .status(200)
    .send('🚀 API de autenticação Google rodando com sucesso! (PZ Auth Backend)');
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

// ────────────────────────────────────────────────────────────────
// 4) Google OAuth – One Tap (ID token verificação)
// ────────────────────────────────────────────────────────────────
const client = new OAuth2Client(CLIENT_ID);

// Preflight mais rápido para o endpoint de auth
app.options('/auth/google', (_req, res) => res.sendStatus(204));

app.post('/auth/google', async (req, res) => {
  try {
    const { credential } = req.body || {};

    if (!credential || typeof credential !== 'string') {
      console.error('[AUTH] credential ausente ou inválida');
      return res.status(400).json({ error: 'Missing credential' });
    }

    // Evita cache intermediário da resposta
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0',
    });

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      console.error('[AUTH] Payload vazio após verifyIdToken');
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Checagem leve do emissor (apenas log informativo)
    if (payload.iss && !/accounts\.google\.com$/.test(payload.iss)) {
      console.warn('[AUTH] Token com emissor inesperado:', payload.iss);
      // NÃO falhamos aqui para evitar falsos positivos — apenas log
    }

    const { sub, email, name, picture } = payload;

    console.log('[AUTH] Token OK | sub:', sub, '| email:', email);

    return res.status(200).json({
      user_id: sub,
      email,
      name,
      picture,
      // opcional: setar cookie HttpOnly aqui em produção
    });
  } catch (err) {
    console.error('[AUTH] Erro na verificação do token:', err?.message || err);
    return res.status(401).json({ error: 'Token inválido' });
  }
});

// ────────────────────────────────────────────────────────────────
// 5) Tratamento de erros globais
// ────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION]', err);
});

// ────────────────────────────────────────────────────────────────
// 6) Start
// ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────');
  console.log(`✅ Server UP on port ${PORT}`);
  console.log('🔧 Vars:');
  console.log('   GOOGLE_CLIENT_ID:', CLIENT_ID);
  console.log('   ALLOWED_ORIGINS :', allowedOrigins);
  console.log('   NODE_ENV       :', process.env.NODE_ENV || '(not set)');
  console.log('──────────────────────────────────────────────');
});