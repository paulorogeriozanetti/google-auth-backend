/**
 * PZ Auth+API Backend – Versão 2.2.2 – 2025-09-17 – “Revert-Stable”
 *
 * - Reverte para a base de código estável antes da tentativa de integração
 * com o ConvertKit para diagnosticar problemas de build persistentes.
 * - Remove o endpoint /api/send-guide e a importação do marketingAutomator.
 */

const express = require('express');
const cors = require('cors');
let cookieParser = null;
try { cookieParser = require('cookie-parser'); } catch (_) { console.warn('[BOOT] cookie-parser não encontrado; segue sem.'); }

const { OAuth2Client, JWT } = require('google-auth-library');
const admin = require('firebase-admin');

// fetch (fallback para Node < 18)
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();

/* ──────────────────────────────────────────────────────────────
   1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '2.2.2';
const BUILD_DATE = '2025-09-17';
const PORT = process.env.PORT || 8080;

/** Client IDs aceitos (audiences) */
const PRIMARY_CLIENT_ID = '270930304722-pbl5cmp53omohrmfkf9dmicutknf3q95.apps.googleusercontent.com';
const CLIENT_IDS = [
  process.env.GOOGLE_CLIENT_ID,
  ...(process.env.GOOGLE_CLIENT_IDS ? String(process.env.GOOGLE_CLIENT_IDS).split(',') : []),
  PRIMARY_CLIENT_ID
].map(s => (s || '').trim()).filter(Boolean);

/** Origens permitidas */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || [
  'https://pzadvisors.com',
  'https://www.pzadvisors.com',
  'https://auth.pzadvisors.com',
  'https://api.pzadvisors.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8081'
].join(',')).split(',').map(o => o.trim()).filter(Boolean);

const TRACK_OPEN  = (process.env.TRACK_OPEN || 'false').toLowerCase() === 'true';
const TRACK_TOKEN = process.env.TRACK_TOKEN || '';
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || '';

app.set('trust proxy', true);

/* ──────────────────────────────────────────────────────────────
   (As seções 1.1, 1.2, 2, 3, 4, 5, etc., permanecem idênticas à versão anterior)
   ... (todo o código do server.js que já funcionava) ...
   ... (omiti o resto do código por brevidade, mas use a sua versão 2.2.1 completa) ...
   ... (A única diferença é que não haverá a rota /api/send-guide no final) ...
*/
// (Certifique-se de que o seu server.js completo e funcional da versão 2.2.1 está aqui)

// Exemplo de como o final do arquivo deve parecer:
// (O final do seu arquivo, antes da seção de Erros Globais)
app.post('/api/debug/ping-fs', async (req, res) => {
    // ... código do ping-fs ...
});

/* ──────────────────────────────────────────────────────────────
   7) Erros globais
─────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason) => { console.error('[UNHANDLED_REJECTION]', reason); });
process.on('uncaughtException', (err) => { console.error('[UNCAUGHT_EXCEPTION]', err); });

/* ──────────────────────────────────────────────────────────────
   8) Start
─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  // ... código do listen ...
});