/**
 * PZ Auth+API Backend – Version 5.6.0 (Eager Initialization) – 2025-10-15
 *
 * - CORREÇÃO CRÍTICA: Reverte a inicialização do Firebase Admin SDK para o modelo "Eager Initialization".
 * - O SDK do Firebase agora é inicializado uma única vez, no arranque do servidor, em vez de "on-the-fly" durante uma requisição.
 * - Esta abordagem é mais robusta e evita o crash 'Process exited with code 1' (net::ERR_CONNECTION_RESET)
 * que ocorria durante a inicialização "lazy" na rota /auth/google.
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
const VERSION = '5.6.0 (Eager Initialization)';
const BUILD_DATE = '2025-10-15';
const PORT = process.env.PORT || 8080;

// (Configuração de Client IDs, Allowed Origins, etc., permanece a mesma)
const PRIMARY_CLIENT_ID = '270930304722-pbl5cmp53omohrmfkf9dmicutknf3q95.apps.googleusercontent.com';
const CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID,
  ...(process.env.GOOGLE_CLIENT_IDS ? String(process.env.GOOGLE_CLIENT_IDS).split(',') : []),
  PRIMARY_CLIENT_ID
].map(s => (s || '').trim()).filter(Boolean);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://pzadvisors.com,https://www.pzadvisors.com').split(',').map(o => o.trim()).filter(Boolean);

/* ──────────────────────────────────────────────────────────────
    1.2) Service Account & Eager Firebase Admin SDK Initialization
─────────────────────────────────────────────────────────────── */
try {
    const SA_RAW = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!SA_RAW) throw new Error('Variável de ambiente FIREBASE_SERVICE_ACCOUNT_JSON não encontrada.');

    const serviceAccount = JSON.parse(SA_RAW);
    
    // Validação mínima das credenciais
    if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON está incompleto.');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id,
    });
    
    console.log('[BOOT] Firebase Admin SDK inicializado com sucesso para o projeto:', serviceAccount.project_id);

} catch (e) {
    console.error('[BOOT] CRÍTICO: Falha na inicialização do Firebase Admin SDK. O servidor não pode continuar.', e.message);
    process.exit(1); // Encerra o processo se a inicialização do Firebase falhar.
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ──────────────────────────────────────────────────────────────
    (CORS e outros Middlewares - Lógica inalterada)
─────────────────────────────────────────────────────────────── */
app.set('trust proxy', true);
app.use(cors({
  origin: (origin, cb) => {
    const isAllowed = !origin || allowedOrigins.some(o => origin.endsWith(o.replace(/^https?:\/\//, '')));
    cb(null, isAllowed);
  },
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: [ 'Content-Type','Authorization', 'X-PZ-Version', 'X-Trace-Id' ],
  optionsSuccessStatus: 204
}));
app.use(express.json({ limit: '1mb' }));
// (Resto dos middlewares permanece o mesmo)
app.use((req, res, next) => { const rid = req.headers['x-trace-id'] || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; req.rid = rid; res.setHeader('X-Trace-Id', rid); res.setHeader('X-PZ-Version', `PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`); next(); });
app.use((req, res, next) => { const t0 = Date.now(); res.on('finish', () => { try { console.log(JSON.stringify({ rid: req.rid, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, origin: req.headers.origin || null })); } catch {} }); next(); });


/* ──────────────────────────────────────────────────────────────
    5) Google OAuth – One Tap
─────────────────────────────────────────────────────────────── */
const oauthClient = new OAuth2Client(CLIENT_IDS[0] || PRIMARY_CLIENT_ID);

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

/* ──────────────────────────────────────────────────────────────
    ENDPOINT DO FUNIL DE LEAD MAGNET
─────────────────────────────────────────────────────────────── */
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
        
        await marketingAutomator.addSubscriberToFunnel({ email, first_name: firstName });
        
        res.status(200).json({ ok: true, message: 'subscriber_added_to_funnel' });
    } catch (e) {
        console.error(JSON.stringify({ route: '/api/send-guide', rid: req.rid, error: e.message || String(e) }));
        res.status(500).json({ ok: false, error: 'funnel_integration_failed' });
    }
});


/* ──────────────────────────────────────────────────────────────
    7) Erros globais & Start
─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`✅ Server UP on port ${PORT} | Version: v${VERSION} (${BUILD_DATE})`);
});