/**
 * PZ Auth+API Backend – Version 5.8.0 (Stability Merge) – 2025-10-15
 *
 * - SOLUÇÃO DEFINITIVA: Reverte a inicialização do Firebase Admin SDK para o método estável da versão 'old12',
 * que se provou compatível com o ambiente de produção do Railway.
 * - Combina esta lógica de inicialização robusta com a configuração de CORS completa (lista de allowedHeaders)
 * das versões mais recentes, resolvendo tanto o crash do servidor quanto os erros de CORS.
 * - Esta versão representa o melhor dos dois mundos: estabilidade comprovada e configuração correta.
 */

const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const admin = require('firebase-admin');

// Importa o módulo de automação de marketing
const marketingAutomator = require('./marketingAutomator');

const app = express();

/* ──────────────────────────────────────────────────────────────
    1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '5.8.0 (Stability Merge)';
const BUILD_DATE = '2025-10-15';
const PORT = process.env.PORT || 8080;

const PRIMARY_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '270930304722-pbl5cmp53omohrmfkf9dmicutknf3q95.apps.googleusercontent.com';
const CLIENT_IDS = [PRIMARY_CLIENT_ID];
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://pzadvisors.com,https://www.pzadvisors.com').split(',').map(o => o.trim());

/* ──────────────────────────────────────────────────────────────
    1.2) Firebase Admin SDK Initialization (Stable Method)
─────────────────────────────────────────────────────────────── */
// INÍCIO DA LÓGICA ESTÁVEL (da versão old12)
try {
    const serviceAccount = {
        type: "service_account",
        project_id: process.env.GCP_PROJECT_ID,
        private_key_id: process.env.GCP_SA_PRIVATE_KEY_ID,
        private_key: (process.env.GCP_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        client_email: process.env.GCP_SA_EMAIL,
        client_id: process.env.GCP_SA_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.GCP_SA_CLIENT_X509_CERT_URL,
    };

    if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
        throw new Error('Variáveis de ambiente para o Firebase Service Account estão incompletas.');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id,
    });

    console.log('[BOOT] Firebase Admin SDK inicializado com sucesso para o projeto:', serviceAccount.project_id);

} catch (e) {
    console.error('[BOOT] CRÍTICO: Falha na inicialização do Firebase Admin SDK.', e.message);
    process.exit(1);
}
// FIM DA LÓGICA ESTÁVEL

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ──────────────────────────────────────────────────────────────
    Middlewares (com a configuração de CORS corrigida)
─────────────────────────────────────────────────────────────── */
app.set('trust proxy', true);
app.use(cors({
  origin: (origin, cb) => {
      // Permite requisições sem 'origin' (ex: Postman, server-to-server)
      if (!origin) return cb(null, true);
      // Verifica se a origem está na lista de permissões
      if (allowedOrigins.indexOf(origin) !== -1) {
          return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  // CORREÇÃO: Restaurada a lista completa de cabeçalhos permitidos
  allowedHeaders: [
    'Content-Type','Authorization',
    'X-PZ-Version','x-pz-version',
    'X-Trace-Id','x-trace-id',
    'X-Api-Token','x-api-token',
    'X-Debug-Token','x-debug-token',
    'X-Debug-Verbose','x-debug-verbose'
  ],
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { const rid = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; req.rid = rid; res.setHeader('X-Trace-Id', rid); res.setHeader('X-PZ-Version', `PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`); next(); });
app.use((req, res, next) => { const t0 = Date.now(); res.on('finish', () => { try { console.log(JSON.stringify({ rid: req.rid, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, origin: req.headers.origin || null })); } catch {} }); next(); });

// (Rotas de Health, Debug, etc. podem ser mantidas se existirem)
// ...

/* ──────────────────────────────────────────────────────────────
    Google OAuth & Funnel Endpoints
─────────────────────────────────────────────────────────────── */
const oauthClient = new OAuth2Client(CLIENT_IDS[0]);

app.post('/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error:'missing_credential' });

    const ticket  = await oauthClient.verifyIdToken({ idToken: credential, audience: CLIENT_IDS });
    const payload = ticket.getPayload();
    if (!payload) return res.status(401).json({ error:'invalid_token' });

    const { sub, email, name, picture, email_verified } = payload;
    const user_id = String(sub);

    const userRef = db.collection('users').doc(user_id);
    await userRef.set({
        user_id, sub, email: email || null, name: name || null, picture: picture || null, email_verified: !!email_verified,
        last_seen: FieldValue.serverTimestamp(),
    }, { merge: true });

    return res.status(200).json({ user_id, email, name, picture });
  } catch (err) {
    console.error(JSON.stringify({ route:'/auth/google', rid:req.rid, error: err.message || String(err) }));
    return res.status(401).json({ error: 'auth_failed' });
  }
});

app.post('/api/send-guide', async (req, res) => {
    try {
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ ok: false, error: 'missing_user_id' });

        const userDoc = await db.collection('users').doc(String(user_id)).get();
        if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        
        const userData = userDoc.data();
        const { email, name } = userData;
        if (!email) return res.status(400).json({ ok: false, error: 'user_has_no_email' });
        
        const fullName = (typeof name === 'string' ? name : '').trim();
        const firstName = fullName ? fullName.split(/\s+/)[0] : '';
        
        // Mantém a chamada à função antiga para ser compatível com o marketingAutomator.js v2.0.0
        await marketingAutomator.addSubscriberToFunnel({ email, first_name: firstName });
        
        res.status(200).json({ ok: true, message: 'subscriber_added_to_funnel' });
    } catch (e) {
        console.error(JSON.stringify({ route: '/api/send-guide', rid: req.rid, error: e.message || String(e) }));
        res.status(500).json({ ok: false, error: 'funnel_integration_failed' });
    }
});

/* ──────────────────────────────────────────────────────────────
    Start
─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`✅ Server UP on port ${PORT} | Version: v${VERSION} (${BUILD_DATE})`);
});