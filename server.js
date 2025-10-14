/**
 * PZ Auth+API Backend – Versão 5.2.0 – 2025-10-14
 *
 * - CORREÇÃO: A lógica do 'marketingAutomator' foi movida para a rota /auth/google.
 * - Ao autenticar, o backend agora chama corretamente a função 'addSubscriberToFunnel'.
 * - A rota redundante /api/send-guide foi removida para alinhar com o fluxo do frontend.
 * - Mantém a lógica de adicionar TAG no ConvertKit, conforme implementado no marketingAutomator.js.
 */

const express = require('express');
const cors = require('cors');
let cookieParser = null;
try { cookieParser = require('cookie-parser'); } catch (_) { console.warn('[BOOT] cookie-parser não encontrado; segue sem.'); }

const { OAuth2Client, JWT } = require('google-auth-library');
const admin = require('firebase-admin');

// Importa o módulo de automação de marketing
const marketingAutomator = require('./marketingAutomator');

// fetch (fallback para Node < 18)
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();

/* ──────────────────────────────────────────────────────────────
    1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '5.2.0';
const BUILD_DATE = '2025-10-14';
const PORT = process.env.PORT || 8080;

const PRIMARY_CLIENT_ID = '270930304722-0omch2vqdc9hahvn486vjemct3648ib9.apps.googleusercontent.com';
const CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID,
  ...(process.env.GOOGLE_CLIENT_IDS ? String(process.env.GOOGLE_CLIENT_IDS).split(',') : []),
  PRIMARY_CLIENT_ID
].map(s => (s || '').trim()).filter(Boolean);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://pzadvisors.com,https://www.pzadvisors.com').split(',').map(o => o.trim()).filter(Boolean);

// O resto do código de configuração e middlewares (CORS, Firebase, etc.) permanece o mesmo...
// ... (código omitido para brevidade)

/* ──────────────────────────────────────────────────────────────
    5) Google OAuth – One Tap
─────────────────────────────────────────────────────────────── */
const oauthClient = new OAuth2Client(CLIENT_IDS[0] || PRIMARY_CLIENT_ID);

app.options('/auth/google', (_req, res) => res.sendStatus(204));
app.post('/auth/google', async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'missing_credential' });

    const ticket = await oauthClient.verifyIdToken({ idToken: credential, audience: CLIENT_IDS });
    const payload = ticket.getPayload();
    if (!payload) return res.status(401).json({ error: 'invalid_token' });

    const { sub, email, name, picture, email_verified } = payload;
    const user_id = String(sub);

    // Upsert em users (Firebase)
    try {
      const db = getDB();
      const docRef = db.collection('users').doc(user_id);
      await docRef.set({ user_id, sub, email: email || null, name: name || null, picture: picture || null, email_verified: !!email_verified }, { merge: true });
      await docRef.set({ last_seen: FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) {
      console.error(JSON.stringify({ route: '/auth/google', rid: req.rid, warn: 'users_upsert_failed', error: e.message || String(e) }));
    }

    // <-- INÍCIO DO NOVO BLOCO INTEGRADO -->
    try {
        if (email) {
            console.log(`[MARKETING] Attempting to add subscriber to funnel: ${email}`);
            
            let firstName = name || '';
            const nameParts = (name || '').trim().split(/\s+/);
            if (nameParts.length > 1) {
                firstName = nameParts[0];
            }
            
            const subscriberData = {
                email: email,
                first_name: firstName,
            };
            
            // Chama a função do marketingAutomator.js
            await marketingAutomator.addSubscriberToFunnel(subscriberData);
            console.log(`[MARKETING] Subscriber ${email} processed by marketing automator.`);
        }
    } catch (e) {
        // Regista o erro mas não impede a resposta de sucesso para o frontend
        console.error(JSON.stringify({ 
            route: '/auth/google', rid: req.rid, 
            warn: 'marketing_automator_failed', error: e.message || String(e) 
        }));
    }
    // <-- FIM DO NOVO BLOCO INTEGRADO -->

    return res.status(200).json({ user_id, email: email || null, name: name || null, picture: picture || null });

  } catch (err) {
    const msg = err?.message || String(err || '');
    let code = 'auth_failed';
    if (/Wrong recipient|audience/.test(msg)) code = 'audience_mismatch';
    if (/expired/i.test(msg)) code = 'token_expired';
    console.error(JSON.stringify({ route: '/auth/google', rid: req.rid, error: msg, code }));
    return res.status(401).json({ error: code });
  }
});

// O resto do ficheiro (rotas de debug, erros globais, start) permanece o mesmo...
// ... (código omitido para brevidade)