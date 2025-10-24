/**
 * PZ Auth+API Backend – Versão 5.0.3 – 2025-10-25
 *
 * - IMPROVEMENT (Duplo Check 3): Usa o objeto URL para construir a dynamicUrl no /api/send-guide (mais robusto).
 * - IMPROVEMENT (Duplo Check 3): Alinha o limite do express.urlencoded com o express.json (consistência).
 * - Mantém todas as correções e funcionalidades da v5.0.2 (ordem webhooks, error.code, first_seen, etc.).
 * - Implementação final da arquitetura de Adapters (v1.1.4) pronta para deploy.
 * - Preserva toda a funcionalidade de Auth (v4.2.0), LeadGen e Tracking.
 */

const express = require('express');
const cors = require('cors');
let cookieParser = null;
try { cookieParser = require('cookie-parser'); } catch (_) { console.warn('[BOOT] cookie-parser não encontrado; segue sem.'); }

const { OAuth2Client } = require('google-auth-library');
const admin = require('firebase-admin');

// Importa módulos
const marketingAutomator = require('./marketingAutomator');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// fetch (fallback)
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();

/* ──────────────────────────────────────────────────────────────
   1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '5.0.3'; // ATUALIZADO
const BUILD_DATE = '2025-10-25'; // ATUALIZADO
const PORT = process.env.PORT || 8080;

/** Client IDs aceitos (audiences) */
const PRIMARY_CLIENT_ID = '270930304722-pbl5cmp53omohrmfkf9dmicutknf3q95.apps.googleusercontent.com';
const CLIENT_IDS = [ /* ... (código idêntico v5.0.2) ... */ process.env.GOOGLE_CLIENT_ID,...process.env.GOOGLE_CLIENT_IDS?String(process.env.GOOGLE_CLIENT_IDS).split(","):[],PRIMARY_CLIENT_ID].map(s=>(s||"").trim()).filter(Boolean);

/** Origens permitidas */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || [ /* ... (código idêntico v5.0.2) ... */ "https://pzadvisors.com","https://www.pzadvisors.com","https://auth.pzadvisors.com","https://api.pzadvisors.com","http://localhost:3000","http://127.0.0.1:3000","http://127.0.0.1:8080","http://127.0.0.1:8081"].join(",")).split(",").map(o=>o.trim()).filter(Boolean);

const TRACK_OPEN  = (process.env.TRACK_OPEN || 'false').toLowerCase() === 'true';
const TRACK_TOKEN = process.env.TRACK_TOKEN || '';
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || '';
const GUIDE_DYNAMIC_URL_BASE = process.env.GUIDE_DYNAMIC_URL_BASE || 'https://pzadvisors.com/bridge/';


app.set('trust proxy', true);

/* ──────────────────────────────────────────────────────────────
   1.1) CORS (no topo)
─────────────────────────────────────────────────────────────── */
function isAllowedOrigin(origin) { /* ... (código idêntico v5.0.2) ... */ if(!origin)return!0;try{const{hostname,protocol}=new URL(origin.trim()),host=String(hostname||"").toLowerCase(),isLocal=protocol==="http:"&&(host==="localhost"||host==="127.0.0.1");if(isLocal)return!0;if(host==="pzadvisors.com"||host==="www.pzadvisors.com"||host.endsWith(".pzadvisors.com"))return!0;return allowedOrigins.includes(origin.trim())}catch{return!1} }
app.use(cors({ /* ... (código idêntico v5.0.2) ... */ origin(origin,cb){const ok=isAllowedOrigin(origin);if(!ok&&origin)try{console.warn(JSON.stringify({tag:"cors_denied",origin}))}catch{}return cb(null,ok)},methods:["GET","POST","OPTIONS","HEAD"],allowedHeaders:["Content-Type","Authorization","X-PZ-Version","x-pz-version","X-Trace-Id","x-trace-id","X-Api-Token","x-api-token","X-Debug-Token","x-debug-token","X-Debug-Verbose","x-debug-verbose"],optionsSuccessStatus:204}));


/* ──────────────────────────────────────────────────────────────
   1.2) Service Account / Firebase Admin SDK
─────────────────────────────────────────────────────────────── */
// ... (código idêntico à v5.0.2) ...
let SA_SOURCE = 'split_env'; let SA_JSON = null; const SA_RAW = process.env.FIREBASE_SERVICE_ACCOUNT_JSON; if (SA_RAW) { try { SA_JSON = JSON.parse(SA_RAW); SA_SOURCE = 'env_json'; } catch (e) { console.error('[FS] FIREBASE_SERVICE_ACCOUNT_JSON inválido:', e?.message || e); } } let GCP_PROJECT_ID = SA_JSON?.project_id || process.env.GCP_PROJECT_ID || ''; let GCP_SA_EMAIL = SA_JSON?.client_email || process.env.GCP_SA_EMAIL || ''; let GCP_SA_PRIVATE_KEY = SA_JSON?.private_key || process.env.GCP_SA_PRIVATE_KEY || ''; if (GCP_SA_PRIVATE_KEY) GCP_SA_PRIVATE_KEY = String(GCP_SA_PRIVATE_KEY).replace(/\\n/g, '\n'); function ensureSA() { /* ... (código idêntico) ... */ const miss={project:!!GCP_PROJECT_ID,email:!!GCP_SA_EMAIL,key:!!GCP_SA_PRIVATE_KEY&&GCP_SA_PRIVATE_KEY.includes("BEGIN PRIVATE KEY")};if(!miss.project||!miss.email||!miss.key){const msg=`[FS] Service Account incompleta: ${JSON.stringify(miss)} (source=${SA_SOURCE})`;console.error(msg);const err=new Error("sa_not_configured");err.code="sa_not_configured";err.meta={...miss,source:SA_SOURCE};throw err} } let _adminInited = false; function initAdmin() { if (_adminInited) return; ensureSA(); admin.initializeApp({ credential: admin.credential.cert({ projectId: GCP_PROJECT_ID, clientEmail: GCP_SA_EMAIL, privateKey: GCP_SA_PRIVATE_KEY }), projectId: GCP_PROJECT_ID }); _adminInited = true; console.log('[ADMIN] Firebase Admin inicializado (project:', GCP_PROJECT_ID, ')'); } function getDB() { initAdmin(); return admin.firestore(); } const FieldValue = admin.firestore.FieldValue;


/* ──────────────────────────────────────────────────────────────
   2) Middlewares (PARTE 1 - ANTES DOS PARSERS GLOBAIS)
─────────────────────────────────────────────────────────────── */

// Cookie Parser (ou fallback com try/catch)
if (cookieParser) {
  app.use(cookieParser());
} else {
  // Fallback
  app.use((req, res, next) => { /* ... (código idêntico v5.0.2 com try/catch) ... */ const raw=req.headers.cookie||"";req.cookies={};raw.split(";").forEach(p=>{const[k,...v]=p.split("=");if(!k)return;const keyTrimmed=k.trim(),valueJoined=(v.join("=")||"").trim();try{req.cookies[keyTrimmed]=decodeURIComponent(valueJoined)}catch(e){console.warn(`[Cookie Parser Fallback] Failed to decode cookie "${keyTrimmed}":`,e.message);req.cookies[keyTrimmed]=valueJoined}});next()});
}

// Middleware de Logging e Headers (Trace ID, Versão, etc.)
app.use((req, res, next) => { /* ... (código idêntico v5.0.2) ... */ const rid=req.headers["x-trace-id"]||`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;req.rid=rid;res.setHeader("X-Trace-Id",rid);res.setHeader("X-PZ-Version",`PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`);res.setHeader("Vary","Origin, Access-Control-Request-Method, Access-Control-Request-Headers");next() });

// Middleware de Log de Duração (APÓS A RESPOSTA)
app.use((req, res, next) => { /* ... (código idêntico v5.0.2, skip /webhook/) ... */ const t0=Date.now();res.on("finish",()=>{try{if(req.path.startsWith("/webhook/"))return;console.log(JSON.stringify({rid:req.rid,method:req.method,path:req.path,status:res.statusCode,ms:Date.now()-t0,origin:req.headers.origin||null}))}catch{}});next() });

/* ──────────────────────────────────────────────────────────────
   2.1) Rotas de Webhook (ANTES dos parsers globais) - OK na v5.0.2
─────────────────────────────────────────────────────────────── */

app.get('/webhook/digistore24', async (req, res) => { /* ... (código idêntico v5.0.2) ... */ const logPrefix=`[WEBHOOK /webhook/digistore24] (rid: ${req.rid})`;try{console.log(`${logPrefix} Webhook Digistore24 recebido (query params)...`);const adapter=PlatformAdapterBase.getInstance("digistore24"),normalizedData=await adapter.verifyWebhook(req.query,req.headers);if(!normalizedData){console.warn(`${logPrefix} Verificação do webhook falhou.`);return res.status(400).send("Webhook verification failed.")}console.log(`${logPrefix} Webhook verificado. Processando transação ID: ${normalizedData.transactionId}`);await logAffiliateTransaction(normalizedData);return res.status(200).send("OK")}catch(error){console.error(`${logPrefix} Erro crítico:`,error.message||error);return res.status(500).send("Internal Server Error.")} });
app.post('/webhook/clickbank', express.raw({ type: '*/*' }), async (req, res) => { /* ... (código idêntico v5.0.2) ... */ const logPrefix=`[WEBHOOK /webhook/clickbank] (rid: ${req.rid})`;try{console.log(`${logPrefix} Webhook Clickbank recebido (raw body)...`);if(!req.body||!(req.body instanceof Buffer)||req.body.length===0){console.warn(`${logPrefix} Erro: express.raw() não populou req.body como Buffer.`);return res.status(400).send("Invalid request body.")}const adapter=PlatformAdapterBase.getInstance("clickbank"),normalizedData=await adapter.verifyWebhook(req.body,req.headers);if(!normalizedData){console.warn(`${logPrefix} Verificação do webhook falhou.`);return res.status(400).send("Webhook verification failed.")}console.log(`${logPrefix} Webhook verificado. Processando transação ID: ${normalizedData.transactionId}`);await logAffiliateTransaction(normalizedData);return res.status(200).send("OK")}catch(error){console.error(`${logPrefix} Erro crítico:`,error.message||error);return res.status(500).send("Internal Server Error.")} });

/* ──────────────────────────────────────────────────────────────
   2.2) Middlewares (PARTE 2 - PARSERS GLOBAIS - Com FIX v5.0.3)
─────────────────────────────────────────────────────────────── */

// Parsers Globais (JSON, URL Encoded)
app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
// IMPROVEMENT v5.0.3: Alinha limite do urlencoded
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Middleware de fallback para JSON (preservado)
app.use((req, res, next) => { /* ... (código idêntico v5.0.2) ... */ if(req.method==="GET"||req.method==="HEAD"||req.method==="OPTIONS")return next();if(req.body&&typeof req.body==="object")return next();let data="";req.on("data",c=>{data+=c;if(data.length>2*1024*1024)req.destroy()});req.on("end",()=>{if(!req.body||typeof req.body!=="object"){if(data&&/^[\s{\[]/.test(data))try{req.body=JSON.parse(data)}catch{}}next()}) });

/* ──────────────────────────────────────────────────────────────
   3) Utilitários Daily Facts & Transactions (OK na v5.0.2)
─────────────────────────────────────────────────────────────── */
function zeroPad(n, w = 2) { /* ... */ return String(n).padStart(w,"0") }
function deriveDayParts(tsISO, tzOffsetMin) { /* ... (código idêntico v5.0.2) ... */ let d=tsISO?new Date(tsISO):new Date;const tz=Number.isFinite(+tzOffsetMin)?+tzOffsetMin:0;if(tz!==0)d=new Date(d.getTime()+tz*60*1000);return{y:d.getUTCFullYear(),m:zeroPad(d.getUTCMonth()+1),d:zeroPad(d.getUTCDate())} }
function deriveDayLabel(tsISO, tzOffsetMin) { /* ... (código idêntico v5.0.2) ... */ const p=deriveDayParts(tsISO,tzOffsetMin);return`${p.y}-${p.m}-${p.d}` }
function parseClientTimestamp(val) { /* ... (código idêntico v5.0.2) ... */ try{if(!val)return null;const d=new Date(val);if(isNaN(d.getTime()))return null;return admin.firestore.Timestamp.fromDate(d)}catch{return null} }
function toPlainJSON(obj) { /* ... (código idêntico v5.0.2) ... */ try{return JSON.parse(JSON.stringify(obj||null))}catch{return null} }

// Função para logar eventos genéricos (OK na v5.0.2)
async function upsertDailyFact({ db, anon_id, user_id, tz_offset, event, page, session_id, payload, tsISO }) { /* ... (código idêntico v5.0.2) ... */ const safeAnon=anon_id&&typeof anon_id==="string"?anon_id:"anon_unknown",tz=Number.isFinite(+tz_offset)?+tz_offset:0,day=deriveDayLabel(tsISO,tz),docId=`${safeAnon}_${day}`,docRef=db.collection("daily_facts").doc(docId);const event_id=`${Date.now()}-${Math.random().toString(36).slice(2,10)}`,newEvent=toPlainJSON({event,event_id,ts_server:FieldValue.serverTimestamp(),ts_client:parseClientTimestamp(tsISO),tz_offset:Number.isFinite(tz)?tz:null,page,session_id,payload}),updatePayload={updated_at:FieldValue.serverTimestamp(),events:FieldValue.arrayUnion(newEvent),["counters."+event]:FieldValue.increment(1),...(user_id?{user_id,person_id:user_id}:{})};try{await docRef.update(updatePayload)}catch(error){const notFound=error?.code===5||error?.code==="not-found"||/NOT_FOUND/i.test(error?.message||"");if(notFound){const seedPayload={kind:"user",date:day,entity_id:safeAnon,anon_id:safeAnon,person_id:user_id&&typeof user_id==="string"?user_id:safeAnon,...user_id?{user_id}:{},...Number.isFinite(tz)?{tz_offset:tz}:{},events:[newEvent],counters:{[event]:1},created_at:FieldValue.serverTimestamp(),updated_at:FieldValue.serverTimestamp()};await docRef.set(seedPayload)}else{console.error(JSON.stringify({tag:"upsert_daily_fact_failed",docId,error:error.message||String(error),code:error.code}));throw error}}return{ok:!0,id:docId} }

// Helper para logar transações (OK na v5.0.2)
async function logAffiliateTransaction(normalizedData) { /* ... (código idêntico v5.0.2 com get-then-set) ... */ if(!normalizedData||!normalizedData.platform||!normalizedData.transactionId){console.warn("[logAffiliateTransaction] Dados normalizados inválidos, skip log.");return}try{const db=getDB(),platform=normalizedData.platform,txId=normalizedData.transactionId,safeTxId=String(txId).replace(/[^a-zA-Z0-9_-]/g,"_"),docId=`${platform}_${safeTxId}`,docRef=db.collection("affiliate_transactions").doc(docId);const docSnap=await docRef.get(),updateData={...normalizedData,_log_last_updated_at:FieldValue.serverTimestamp(),_log_doc_id:docId};if(!docSnap.exists){await docRef.set({...updateData,_log_first_seen_at:FieldValue.serverTimestamp()});console.log(`[logAffiliateTransaction] Nova transação logada: ${docId}`)}else{await docRef.update(updateData);console.log(`[logAffiliateTransaction] Transação existente atualizada: ${docId}`)}}catch(error){console.error(JSON.stringify({tag:"log_affiliate_transaction_failed",error:error.message||String(error),platform:normalizedData.platform,transactionId:normalizedData.transactionId}))} }


/* ──────────────────────────────────────────────────────────────
   4) Rotas básicas / Health / Versão (OK na v5.0.1)
─────────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => res.status(200).send('🚀 PZ Auth+API Backend ativo. Use /healthz, /api/version, /api/track, /auth/google.'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime(), ts:new Date().toISOString() })); app.head('/healthz', (_req, res) => res.sendStatus(200));
app.get('/api/healthz', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime(), ts:new Date().toISOString() })); app.head('/api/healthz', (_req, res) => res.sendStatus(200));
app.get('/api/version', (_req, res) => { /* ... (código idêntico v5.0.2) ... */ res.status(200).json({service:"PZ Auth+API Backend",version:VERSION,build_date:BUILD_DATE,adapter_factory_loaded:typeof PlatformAdapterBase?.getInstance==="function",client_ids_configured:CLIENT_IDS,cors_allowed_origins:allowedOrigins,wildcard_pzadvisors:"*.pzadvisors.com",track_open:TRACK_OPEN,has_track_token:!!TRACK_TOKEN,debug_ping_enabled:!!DEBUG_TOKEN,firestore_auth_mode:"AdminSDK",has_cookie_parser:!!cookieParser,project_id:process.env.GCP_PROJECT_ID||null,facts_collection:"daily_facts",transactions_collection:"affiliate_transactions",facts_doc_pattern:"${anon_id}_${YYYY-MM-DD}"}) });
app.get('/api/cors-check', (req, res) => { /* ... (código idêntico v5.0.2) ... */ const origin=req.headers.origin||null;return res.status(200).json({ok:!0,rid:req.rid,origin,allowed:isAllowedOrigin(origin),ua:req.headers["user-agent"]||null,ts:(new Date).toISOString()}) });

/* ──────────────────────────────────────────────────────────────
   4.1) Debug – Credenciais SA / Firestore (OK na v5.0.1)
─────────────────────────────────────────────────────────────── */
function assertDebugAccess(req, res) { /* ... (código idêntico v5.0.2) ... */ const tok=req.headers["x-debug-token"]||req.headers["X-Debug-Token"];if(!DEBUG_TOKEN||tok!==DEBUG_TOKEN){res.status(403).json({ok:!1,error:"forbidden"});return!1}return!0 }
app.get('/api/debug/env-has-sa', (_req, res) => { /* ... (código idêntico v5.0.2) ... */ const hasProj=!!process.env.GCP_PROJECT_ID,hasEmail=!!process.env.GCP_SA_EMAIL,hasKey=!!process.env.GCP_SA_PRIVATE_KEY&&String(process.env.GCP_SA_PRIVATE_KEY).includes("BEGIN PRIVATE KEY");res.status(200).json({hasProj,hasEmail,hasKey,sa_source:SA_SOURCE}) });
// Stub controlado (OK na v5.0.1)
app.get('/api/debug/fs-token', (req, res) => { /* ... (código idêntico v5.0.2) ... */ if(!assertDebugAccess(req,res))return;console.warn("[API /api/debug/fs-token] Rota chamada, mas helpers de diagnóstico ('getSATokenDiag', 'FS_SCOPE') não estão implementados nesta versão.");return res.status(200).json({ok:!0,note:"Diagnostic helpers (getSATokenDiag) not available in this version.",scope:"firestore.default",expiry_date:null,expires_in_s:null}) });
app.post('/api/debug/ping-fs', async (req, res) => { /* ... (código idêntico v5.0.2) ... */ const verbose=(String(req.query.verbose||req.headers["x-debug-verbose"]||"")==="1");try{const tok=req.headers["x-debug-token"]||req.headers["X-Debug-Token"];if(!DEBUG_TOKEN||tok!==DEBUG_TOKEN)return res.status(403).json({ok:!1,error:"forbidden"});const db=getDB(),out=await upsertDailyFact({db,anon_id:req.body&&req.body.anon_id||"anon_debug",user_id:req.body&&req.body.user_id,tz_offset:req.body&&req.body.tz_offset,event:"debug_write",page:"/debug",session_id:null,payload:{note:req.body&&req.body.note||"manual"},tsISO:(new Date).toISOString()});return res.status(200).json({ok:!0,rid:req.rid,doc:out.id})}catch(e){const payload={route:"/api/debug/ping-fs",rid:req.rid,error:e.message||String(e)};console.error(JSON.stringify(payload));if(e.code==="sa_not_configured")return res.status(503).json({ok:!1,error:"sa_not_configured",meta:e.meta});return res.status(500).json(verbose?{ok:!1,...payload}:{ok:!1,error:"ping_failed"})} });

/* ──────────────────────────────────────────────────────────────
   5) Google OAuth – One Tap (OK na v5.0.1)
─────────────────────────────────────────────────────────────── */
const oauthClient = new OAuth2Client(CLIENT_IDS[0] || PRIMARY_CLIENT_ID);
app.options('/auth/google', (_req, res) => res.sendStatus(204)); app.options('/api/auth/google', (_req, res) => res.sendStatus(204));
async function handleAuthGoogle(req, res) { /* ... (código idêntico v5.0.2 com CSRF tolerante) ... */ try{const ct=(req.headers["content-type"]||"").toLowerCase(),body=req.body||{},credential=typeof body.credential==="string"&&body.credential||typeof body.id_token==="string"&&body.id_token||null,context=body.context||{};console.log(JSON.stringify({route:"/auth/google",rid:req.rid,content_type:ct,has_credential:!!credential}));if(!credential)return res.status(400).json({error:"missing_credential"});const csrfCookie=req.cookies?.g_csrf_token,csrfBody=body?.g_csrf_token,hasCookie=!!csrfCookie,hasBody=!!csrfBody;if(hasCookie&&hasBody&&csrfCookie!==csrfBody){console.warn(`[AUTH /auth/google] CSRF Mismatch. Cookie: "${csrfCookie}" vs Body: "${csrfBody}"`);return res.status(400).json({error:"csrf_mismatch"})}res.set({"Cache-Control":"no-store, no-cache, must-revalidate, private",Pragma:"no-cache",Expires:"0"});const ticket=await oauthClient.verifyIdToken({idToken:credential,audience:CLIENT_IDS}),payload=ticket.getPayload();if(!payload)return res.status(401).json({error:"invalid_token"});const{sub,email,name,picture,email_verified}=payload,user_id=String(sub);try{const db=getDB(),docRef=db.collection("users").doc(user_id);await docRef.set({user_id,sub,email:email||null,name:name||null,picture:picture||null,email_verified:!!email_verified},{merge:!0});await docRef.set({last_seen:FieldValue.serverTimestamp(),updated_at:FieldValue.serverTimestamp()},{merge:!0})}catch(e){console.error(JSON.stringify({route:"/auth/google",rid:req.rid,warn:"users_upsert_failed",error:e.message||String(e)}))}try{const db=getDB(),anon_id=context.anon_id||body.anon_id||"anon_unknown";await upsertDailyFact({db,anon_id,user_id,tz_offset:typeof context.tz_offset!=="undefined"?context.tz_offset:0,event:"auth_google_success",page:context.page||"/onetap",session_id:context.session_id||null,payload:{email:email||null,name:name||null,picture:picture||null,email_verified:!!email_verified},tsISO:(new Date).toISOString()})}catch(e){console.error(JSON.stringify({route:"/auth/google",rid:req.rid,warn:"daily_facts_log_failed",error:e.message||String(e)}))}return res.status(200).json({user_id,email:email||null,name:name||null,picture:picture||null})}catch(err){const msg=err?.message||String(err||"");let code="auth_failed";if(/Wrong recipient|audience/.test(msg))code="audience_mismatch";if(/expired/i.test(msg))code="token_expired";if(/invalid/i.test(msg))code="invalid_token";console.error(JSON.stringify({route:"/auth/google",rid:req.rid,error:msg,code}));return res.status(401).json({error:code})} }
app.post('/auth/google', handleAuthGoogle); app.post('/api/auth/google', handleAuthGoogle);

/* ──────────────────────────────────────────────────────────────
   6) Endpoints auxiliares (Preservado)
─────────────────────────────────────────────────────────────── */
app.post('/api/echo', (req, res) => { /* ... (código idêntico v5.0.2) ... */ res.set({"Cache-Control":"no-store, no-cache, must-revalidate, private",Pragma:"no-cache",Expires:"0"});return res.status(200).json({ok:!0,rid:req.rid,echo:req.body||null,ts:(new Date).toISOString()}) });
app.post('/api/track', async (req, res) => { /* ... (código idêntico v5.0.2) ... */ try{if(!TRACK_OPEN){const tok=req.headers["x-api-token"]||req.headers["X-Api-Token"];if(!TRACK_TOKEN||tok!==TRACK_TOKEN)return res.status(403).json({ok:!1,error:"forbidden"})}const{event,payload}=req.body||{};if(!event||typeof event!=="string")return res.status(400).json({ok:!1,error:"missing_event"});const anon_id=payload?.anon_id||req.body?.anon_id||"anon_unknown",user_id=payload?.user_id||null,tz_offset=typeof payload?.tz_offset!=="undefined"?payload.tz_offset:0,tsISO=payload?.ts||null,page=payload?.page||payload?.context?.page||null,sessionId=payload?.session_id||null;const db=getDB();await upsertDailyFact({db,anon_id,user_id,tz_offset,event,page,session_id:sessionId,payload:(()=>{const p={...payload};delete p.ts;delete p.tz_offset;delete p.page;delete p.session_id;delete p.user_id;delete p.anon_id;delete p.context;return toPlainJSON(p)})(),tsISO:tsISO||(new Date).toISOString()});return res.status(200).json({ok:!0,rid:req.rid})}catch(e){console.error(JSON.stringify({route:"/api/track",rid:req.rid,error:e.message||String(e)}));return res.status(500).json({ok:!1,error:"track_failed"})} });

/* ──────────────────────────────────────────────────────────────
   7) ENDPOINT DO FUNIL DE LEAD MAGNET (Preservado com FIX v5.0.3)
─────────────────────────────────────────────────────────────── */
app.post('/api/send-guide', async (req, res) => {
    try {
        const { user_id, anon_id, utms, context: reqContext } = req.body;
        if (!user_id) return res.status(400).json({ ok: false, error: 'missing_user_id' });

        const db = getDB();
        const userDoc = await db.collection('users').doc(String(user_id)).get();
        if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        
        const userData = userDoc.data();
        const { email, name } = userData;
        if (!email) return res.status(400).json({ ok: false, error: 'user_has_no_email' });

        // Lógica de separação nome (idêntica)
        let firstName=name||'';let lastName='';const nameParts=(name||'').trim().split(/\s+/);if(nameParts.length>1){firstName=nameParts[0];lastName=nameParts.slice(1).join(' ')}

        // IMPROVEMENT v5.0.3: Usa o objeto URL para construir a URL dinâmica
        let dynamicUrl = GUIDE_DYNAMIC_URL_BASE; // Fallback
        try {
            const baseUrl = new URL(GUIDE_DYNAMIC_URL_BASE);
            const params = new URLSearchParams({
                uid: user_id,
                anon_id: anon_id || 'anon_from_guide_api', 
                utm_source: utms?.utm_source || 'convertkit',
                utm_medium: utms?.utm_medium || 'ebook-cta',
                utm_campaign: utms?.utm_campaign || 'lead-magnet-guide'
            });
            // Adiciona os parâmetros à URL base de forma segura
            for (const [k, v] of params) { baseUrl.searchParams.set(k, v); }
            dynamicUrl = baseUrl.toString();
        } catch (urlError) {
             console.error(`[API /api/send-guide] Falha ao construir URL dinâmica com base '${GUIDE_DYNAMIC_URL_BASE}':`, urlError.message);
             // Continua com a URL base sem parâmetros como fallback
        }
        // FIM IMPROVEMENT v5.0.3

        const subscriberData = { email: email, first_name: firstName, fields: { last_name: lastName, dynamic_cta_url: dynamicUrl } };
        await marketingAutomator.addSubscriberToFunnel(subscriberData);
        
        // Loga evento no Firestore
        await upsertDailyFact({
            db,
            anon_id: anon_id || 'anon_unknown',
            user_id: user_id,
            event: 'convertkit_subscribe_success',
            page: reqContext?.page || '/api/send-guide',
            session_id: reqContext?.session_id || null,
            payload: { email, tagId: process.env.CONVERTKIT_TAG_ID, dynamicUrlSent: dynamicUrl },
            tsISO: new Date().toISOString()
        });

        res.status(200).json({ ok: true, message: 'subscriber_added_to_funnel' });

    } catch (e) {
        console.error(JSON.stringify({ route: '/api/send-guide', rid: req.rid, error: e.message || String(e) }));
        res.status(500).json({ ok: false, error: 'funnel_integration_failed' }); 
    }
});

/* ──────────────────────────────────────────────────────────────
   8) Funil de Afiliados (Adapters v1.1.4) - OK na v5.0.2
─────────────────────────────────────────────────────────────── */

/**
 * Endpoint: Gerar URL de Checkout Dinâmico
 * (Permanece após os parsers globais)
 */
app.post('/api/checkout', async (req, res) => { /* ... (código idêntico v5.0.2) ... */ const logPrefix=`[API /api/checkout] (rid: ${req.rid})`;let platform="unknown";try{const{offerData,trackingParams}=req.body;if(!offerData||typeof offerData!=="object"||!offerData.affiliate_platform){console.warn(`${logPrefix} Payload inválido: 'offerData' obrigatório.`);return res.status(400).json({ok:!1,error:"missing_offerData"})}if(!trackingParams||typeof trackingParams!=="object"){console.warn(`${logPrefix} Payload inválido: 'trackingParams' obrigatório.`);return res.status(400).json({ok:!1,error:"missing_trackingParams"})}platform=offerData.affiliate_platform;console.log(`${logPrefix} Recebida requisição para plataforma: ${platform}`);const adapter=PlatformAdapterBase.getInstance(platform),finalCheckoutUrl=await adapter.buildCheckoutUrl(offerData,trackingParams);if(!finalCheckoutUrl||typeof finalCheckoutUrl!=="string"){console.error(`${logPrefix} Adapter.buildCheckoutUrl() inválido:`,finalCheckoutUrl);throw new Error("Adapter failed.")}console.log(`${logPrefix} URL gerada com sucesso para ${platform}.`);return res.status(200).json({ok:!0,finalCheckoutUrl})}catch(error){console.error(`${logPrefix} Falha para ${platform}:`,error.message||error);return res.status(500).json({ok:!1,error:"checkout_url_generation_failed",platform})} });


/* ──────────────────────────────────────────────────────────────
   9) Erros globais
─────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason, promise) => { console.error('[UNHANDLED_REJECTION] Reason:', reason, 'Promise:', promise); });
process.on('uncaughtException', (err, origin) => { console.error('[UNCAUGHT_EXCEPTION] Error:', err, 'Origin:', origin); });

/* ──────────────────────────────────────────────────────────────
   10) Start
─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`✅ Server UP on port ${PORT}`);
  console.log(`📦 Version: v${VERSION} (${BUILD_DATE})`);
  console.log('🔧 Configurações Ativas:');
  console.log(`   - CORS Origens Permitidas  : ${allowedOrigins.length>3?allowedOrigins.slice(0,3).join(", ")+"...":allowedOrigins.join(", ")}`);
  console.log(`   - Autenticação Google      : ${CLIENT_IDS.length} Client ID(s)`);
  console.log(`   - Tracking Aberto (/track) : ${TRACK_OPEN}`);
  console.log(`   - Token de Tracking        : ${TRACK_TOKEN?"Configurado":"Não Configurado"}`);
  console.log(`   - Token de Debug           : ${DEBUG_TOKEN?"Configurado":"Não Configurado"}`);
  console.log(`   - Firestore Auth           : Admin SDK (SA Source: ${SA_SOURCE})`);
  console.log(`   - Adapters Carregados      : ${typeof PlatformAdapterBase?.getInstance==="function"}`);
  console.log(`   - URL Base Guia Dinâmico   : ${GUIDE_DYNAMIC_URL_BASE}`); 
  console.log(`   - NODE_ENV                 : ${process.env.NODE_ENV||"(Não definido)"}`);
  console.log('──────────────────────────────────────────────────────────────');
});