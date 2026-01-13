/**
 * PZ Auth+API Backend – Versão 5.0.5 – 2025-10-26
 *
 * - FIX (Testes): Exporta 'app' condicionalmente para uso com supertest (não chama app.listen() em teste).
 * - FIX (Testes): Protege require('./marketingAutomator') com try/catch e fornece stub para ambiente de teste.
 * - FIX (Duplo Check 5): Corrige typo no polyfill do fetch (...args em vez de .args).
 * - Mantém toda a lógica funcional e melhorias da v5.0.3 (Adapters, correções duplo check, etc.).
 */

const express = require('express');
const cors = require('cors');
let cookieParser = null;
try { cookieParser = require('cookie-parser'); } catch (_) { console.warn('[BOOT] cookie-parser não encontrado; segue sem.'); }

const { OAuth2Client } = require('google-auth-library');
const admin = require('firebase-admin');

// --- INÍCIO PATCH 1 (Duplo Check 4) ---
// Torna marketingAutomator opcional (evita crash nos testes se o ficheiro não existir)
let marketingAutomator = null;
try {
  marketingAutomator = require('./marketingAutomator');
  console.log('[BOOT] Módulo marketingAutomator carregado com sucesso.');
} catch (err) {
  // Apenas avisa se não estiver em ambiente de teste
  if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
    console.error('[BOOT][ERRO] marketingAutomator não encontrado. A rota /api/send-guide falhará:', err.message);
  } else {
    console.warn('[BOOT] marketingAutomator não encontrado; usando stub no ambiente de teste.');
  }
  // Fornece um stub para evitar erros em 'require' ou chamadas posteriores
  marketingAutomator = {
    addSubscriberToFunnel: async (subscriberInfo) => {
        console.warn('[STUB] marketingAutomator.addSubscriberToFunnel chamado com:', subscriberInfo ? subscriberInfo.email : 'dados ausentes');
        // Retorna um erro simulado se não estiver em teste, ou sucesso se estiver
        if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
            throw new Error("Marketing automator module not loaded correctly.");
        }
        return { ok: true, message: 'stubbed_subscriber_added' };
     }
  };
}
// --- FIM PATCH 1 ---

const PlatformAdapterBase = require('./PlatformAdapterBase');

// fetch (fallback) - CORRIGIDO (PATCH E)
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args))); // <-- Corrigido .args para ...args

const app = express();

/* ──────────────────────────────────────────────────────────────
   1) Config / Vars
─────────────────────────────────────────────────────────────── */
const VERSION = '5.0.5'; // ATUALIZADO
const BUILD_DATE = '2025-10-26'; // ATUALIZADO
const PORT = process.env.PORT || 8080;
const CLIENT_IDS = [ process.env.GOOGLE_CLIENT_ID,...process.env.GOOGLE_CLIENT_IDS?String(process.env.GOOGLE_CLIENT_IDS).split(","):[],'270930304722-pbl5cmp53omohrmfkf9dmicutknf3q95.apps.googleusercontent.com'].map(s=>(s||"").trim()).filter(Boolean);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o=>o.trim()).filter(Boolean); if(allowedOrigins.length===0){allowedOrigins.push('https://pzadvisors.com','https://www.pzadvisors.com','https://auth.pzadvisors.com','https://api.pzadvisors.com','http://localhost:3000','http://127.0.0.1:3000','http://127.0.0.1:8080','http://127.0.0.1:8081')}
const TRACK_OPEN = (process.env.TRACK_OPEN||'false').toLowerCase()==='true'; const TRACK_TOKEN = process.env.TRACK_TOKEN||''; const DEBUG_TOKEN = process.env.DEBUG_TOKEN||''; const GUIDE_DYNAMIC_URL_BASE = process.env.GUIDE_DYNAMIC_URL_BASE||'https://pzadvisors.com/bridge/';

app.set('trust proxy', true);

/* ──────────────────────────────────────────────────────────────
   1.1) CORS (no topo) - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
function isAllowedOrigin(origin) { if(!origin)return!0;try{const{hostname:host,protocol}=new URL(origin.trim()),hostname=String(host||"").toLowerCase();if(protocol==="http:"&&(hostname==="localhost"||hostname==="127.0.0.1"))return!0;if(protocol==="https:"&&(hostname==="pzadvisors.com"||hostname==="www.pzadvisors.com"||hostname.endsWith(".pzadvisors.com")))return!0;return allowedOrigins.includes(origin.trim())}catch{return!1} }
app.use(cors({ origin(origin,cb){const ok=isAllowedOrigin(origin);if(!ok&&origin)try{console.warn(JSON.stringify({tag:"cors_denied",origin}))}catch{}cb(null,ok)},methods:["GET","POST","OPTIONS","HEAD"],allowedHeaders:["Content-Type","Authorization","X-PZ-Version","x-pz-version","X-Trace-Id","x-trace-id","X-Api-Token","x-api-token","X-Debug-Token","x-debug-token","X-Debug-Verbose","x-debug-verbose"],optionsSuccessStatus:204}));

/* ──────────────────────────────────────────────────────────────
   1.2) Service Account / Firebase Admin SDK - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
let SA_SOURCE = 'nenhuma'; let SA_JSON = null; const SA_RAW_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON; if (SA_RAW_JSON) { try { SA_JSON = JSON.parse(SA_RAW_JSON); SA_SOURCE = 'env_json'; console.log('[BOOT] SA carregado de JSON.'); } catch (e) { console.error('[BOOT][ERRO] SA JSON inválido:', e?.message || e); } } let GCP_PROJECT_ID = '', GCP_SA_EMAIL = '', GCP_SA_PRIVATE_KEY = ''; if (!SA_JSON) { GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || ''; GCP_SA_EMAIL = process.env.GCP_SA_EMAIL || ''; GCP_SA_PRIVATE_KEY = process.env.GCP_SA_PRIVATE_KEY || ''; if (GCP_PROJECT_ID && GCP_SA_EMAIL && GCP_SA_PRIVATE_KEY) { SA_SOURCE = 'env_split'; if (GCP_SA_PRIVATE_KEY) GCP_SA_PRIVATE_KEY = String(GCP_SA_PRIVATE_KEY).replace(/\\n/g, '\n'); console.log('[BOOT] SA carregado de split env.'); } else { console.warn('[BOOT][AVISO] Nenhuma SA encontrada.'); } } else { GCP_PROJECT_ID = SA_JSON.project_id || ''; GCP_SA_EMAIL = SA_JSON.client_email || ''; GCP_SA_PRIVATE_KEY = SA_JSON.private_key || ''; } function ensureSA() { const hasKey = !!GCP_SA_PRIVATE_KEY && GCP_SA_PRIVATE_KEY.includes('BEGIN PRIVATE KEY'); const miss = { project: !!GCP_PROJECT_ID, email: !!GCP_SA_EMAIL, key: hasKey }; if (!miss.project || !miss.email || !miss.key) { const msg = `[FS][ERRO] SA incompleta: ${JSON.stringify(miss)} (Fonte: ${SA_SOURCE})`; console.error(msg); const err = new Error('sa_not_configured'); err.code = 'sa_not_configured'; err.meta = { ...miss, source: SA_SOURCE }; throw err; } return { projectId: GCP_PROJECT_ID, clientEmail: GCP_SA_EMAIL, privateKey: GCP_SA_PRIVATE_KEY }; } let _adminInited = false; let _db = null; function initAdmin() { if (_adminInited) return; try { const credentials = ensureSA(); admin.initializeApp({ credential: admin.credential.cert(credentials), projectId: credentials.projectId }); _adminInited = true; _db = admin.firestore(); console.log('[ADMIN] Firebase SDK OK (Proj:', credentials.projectId, ')'); } catch (error) { console.error('[ADMIN][ERRO FATAL] Init Firebase:', error.message || error); } } function getDB() { if (!_adminInited) { initAdmin(); if (!_adminInited) { const err = new Error('DB não inicializado.'); err.code = 'DB_NOT_INITIALIZED'; throw err; } } return _db; } const FieldValue = admin.firestore.FieldValue;


/* ──────────────────────────────────────────────────────────────
   2) Middlewares (PARTE 1) - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
if (cookieParser) { app.use(cookieParser()); } else { app.use((req, res, next) => { const raw=req.headers.cookie||"";req.cookies={};raw.split(";").forEach(p=>{const[k,...v]=p.split("=");if(!k)return;const keyTrimmed=k.trim(),valueJoined=(v.join("=")||"").trim();try{req.cookies[keyTrimmed]=decodeURIComponent(valueJoined)}catch(e){console.warn(`[Cookie Fallback] Decode falhou "${keyTrimmed}":`,e.message);req.cookies[keyTrimmed]=valueJoined}});next()}); }
app.use((req, res, next) => { const rid=req.headers["x-trace-id"]||`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;req.rid=rid;res.setHeader("X-Trace-Id",rid);res.setHeader("X-PZ-Version",`PZ Auth+API Backend v${VERSION} (${BUILD_DATE})`);res.setHeader("Vary","Origin, Access-Control-Request-Method, Access-Control-Request-Headers");next() });
app.use((req, res, next) => { const t0=Date.now();res.on("finish",()=>{try{if(req.path.startsWith("/webhook/"))return;console.log(JSON.stringify({rid:req.rid,method:req.method,path:req.path,status:res.statusCode,ms:Date.now()-t0,origin:req.headers.origin||null}))}catch{}});next() });

/* ──────────────────────────────────────────────────────────────
   2.1) Rotas de Webhook (ANTES dos parsers globais) - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
app.get('/webhook/digistore24', async (req, res) => { const logPrefix=`[WEBHOOK /dg24](rid:${req.rid})`;try{console.log(`${logPrefix} Recebido...`);const adapter=PlatformAdapterBase.getInstance("digistore24"),normalizedData=await adapter.verifyWebhook(req.query,req.headers);if(!normalizedData){console.warn(`${logPrefix} Verificação falhou.`);return res.status(400).send("Webhook verification failed.")}console.log(`${logPrefix} OK. TxID:${normalizedData.transactionId}`);await logAffiliateTransaction(normalizedData);return res.status(200).send("OK")}catch(error){console.error(`${logPrefix} Erro:`,error.message||error);return res.status(500).send("Internal Server Error.")} });
app.post('/webhook/clickbank', express.raw({ type: '*/*' }), async (req, res) => { const logPrefix=`[WEBHOOK /cb](rid:${req.rid})`;try{console.log(`${logPrefix} Recebido...`);if(!req.body||!(req.body instanceof Buffer)||req.body.length===0){console.warn(`${logPrefix} Erro: req.body Buffer inválido.`);return res.status(400).send("Invalid request body.")}const adapter=PlatformAdapterBase.getInstance("clickbank"),normalizedData=await adapter.verifyWebhook(req.body,req.headers);if(!normalizedData){console.warn(`${logPrefix} Verificação falhou.`);return res.status(400).send("Webhook verification failed.")}console.log(`${logPrefix} OK. TxID:${normalizedData.transactionId}`);await logAffiliateTransaction(normalizedData);return res.status(200).send("OK")}catch(error){console.error(`${logPrefix} Erro:`,error.message||error);return res.status(500).send("Internal Server Error.")} });

/* ──────────────────────────────────────────────────────────────
   2.2) Middlewares (PARTE 2 - PARSERS GLOBAIS) - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use((req, res, next) => { if(req.method==="GET"||req.method==="HEAD"||req.method==="OPTIONS"||(req.body&&typeof req.body==="object"))return next();let data="";req.on("data",c=>{data+=c;if(data.length>2097152)req.destroy()});req.on("end",()=>{if(!req.body||typeof req.body!=="object"){if(data&&/^[\s{\[]/.test(data))try{req.body=JSON.parse(data)}catch{}}next()}) });

/* ──────────────────────────────────────────────────────────────
   3) Utilitários Daily Facts & Transactions - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
function zeroPad(n, w = 2) { return String(n).padStart(w,"0") }
function deriveDayParts(tsISO, tzOffsetMin) { let d=tsISO?new Date(tsISO):new Date;const tz=Number.isFinite(+tzOffsetMin)?+tzOffsetMin:0;if(tz!==0)d=new Date(d.getTime()+tz*60*1000);return{y:d.getUTCFullYear(),m:zeroPad(d.getUTCMonth()+1),d:zeroPad(d.getUTCDate())} }
function deriveDayLabel(tsISO, tzOffsetMin) { const p=deriveDayParts(tsISO,tzOffsetMin);return`${p.y}-${p.m}-${p.d}` }
function parseClientTimestamp(val) { try{if(!val)return null;const d=new Date(val);if(isNaN(d.getTime()))return null;return admin.firestore.Timestamp.fromDate(d)}catch{return null} }
function toPlainJSON(obj) { try{return JSON.parse(JSON.stringify(obj||null))}catch{return null} }
async function upsertDailyFact({ db = null, anon_id, user_id, tz_offset, event, page, session_id, payload, tsISO }) { if(!db)try{db=getDB()}catch(dbError){console.error(`[upsertDailyFact][ERRO] DB:`,dbError.message||dbError);throw dbError} const safeAnon=anon_id&&typeof anon_id==="string"?anon_id:"anon_unknown",tz=Number.isFinite(+tz_offset)?+tz_offset:0,day=deriveDayLabel(tsISO,tz),docId=`${safeAnon}_${day}`,docRef=db.collection("daily_facts").doc(docId);const event_id=`${Date.now()}-${Math.random().toString(36).slice(2,10)}`,newEvent=toPlainJSON({event,event_id,ts_server:FieldValue.serverTimestamp(),ts_client:parseClientTimestamp(tsISO),tz_offset:Number.isFinite(tz)?tz:null,page,session_id,payload}),updatePayload={updated_at:FieldValue.serverTimestamp(),events:FieldValue.arrayUnion(newEvent),["counters."+event]:FieldValue.increment(1),...(user_id?{user_id,person_id:user_id}:{})};try{await docRef.update(updatePayload)}catch(error){const notFound=error?.code===5||error?.code==="not-found"||/NOT_FOUND/i.test(error?.message||"");if(notFound){const seedPayload={kind:"user",date:day,entity_id:safeAnon,anon_id:safeAnon,person_id:user_id&&typeof user_id==="string"?user_id:safeAnon,...user_id?{user_id}:{},...Number.isFinite(tz)?{tz_offset:tz}:{},events:[newEvent],counters:{[event]:1},created_at:FieldValue.serverTimestamp(),updated_at:FieldValue.serverTimestamp()};await docRef.set(seedPayload)}else{console.error(JSON.stringify({tag:"upsert_daily_fact_failed",docId,error:error.message||String(error),code:error.code}));throw error}}return{ok:!0,id:docId} }
async function logAffiliateTransaction(normalizedData) { if(!normalizedData?.platform||!normalizedData?.transactionId){console.warn("[logAffiliateTransaction] Skip: Dados inválidos.");return} let db;try{db=getDB()}catch(dbError){console.error(`[logAffiliateTransaction][ERRO] DB:`,dbError.message||dbError);return} try{const platform=normalizedData.platform,txId=normalizedData.transactionId,safeTxId=String(txId).replace(/[^a-zA-Z0-9_-]/g,"_"),docId=`${platform}_${safeTxId}`,docRef=db.collection("affiliate_transactions").doc(docId);const docSnap=await docRef.get(),updateData={...normalizedData,_log_last_updated_at:FieldValue.serverTimestamp(),_log_doc_id:docId};if(!docSnap.exists){await docRef.set({...updateData,_log_first_seen_at:FieldValue.serverTimestamp()});console.log(`[logAffiliateTransaction] Logado (Novo): ${docId}`)}else{await docRef.update(updateData);console.log(`[logAffiliateTransaction] Logado (Update): ${docId}`)}}catch(error){console.error(JSON.stringify({tag:"log_affiliate_transaction_failed",error:error.message||String(error),platform,txId}))} }

/* ──────────────────────────────────────────────────────────────
   4) Rotas básicas / Health / Versão - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => res.status(200).send('🚀 PZ Auth+API Backend ativo.'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime(), ts:new Date().toISOString() })); app.head('/healthz', (_req, res) => res.sendStatus(200));
app.get('/api/healthz', (_req, res) => res.status(200).json({ ok:true, uptime:process.uptime(), ts:new Date().toISOString() })); app.head('/api/healthz', (_req, res) => res.sendStatus(200));
app.get('/api/version', (_req, res) => { res.status(200).json({service:"PZ Auth+API Backend",version:VERSION,build_date:BUILD_DATE,adapters_loaded:typeof PlatformAdapterBase?.getInstance==="function",client_ids:CLIENT_IDS,origins:allowedOrigins,track_open:TRACK_OPEN,track_token:!!TRACK_TOKEN,debug_token:!!DEBUG_TOKEN,fs_auth:"AdminSDK",fs_init:_adminInited,fs_project:GCP_PROJECT_ID||"(N/A)",fs_sa_source:SA_SOURCE,facts_coll:"daily_facts",tx_coll:"affiliate_transactions",facts_doc_pattern:"${anon_id}_${YYYY-MM-DD}"}) });
app.get('/api/cors-check', (req, res) => { const origin=req.headers.origin||null;return res.status(200).json({ok:!0,rid:req.rid,origin,allowed:isAllowedOrigin(origin),ua:req.headers["user-agent"]||null,ts:(new Date).toISOString()}) });

/* ──────────────────────────────────────────────────────────────
   4.1) Debug – Credenciais SA / Firestore - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
function assertDebugAccess(req, res) { const tok=req.headers["x-debug-token"]||req.headers["X-Debug-Token"];if(!DEBUG_TOKEN||tok!==DEBUG_TOKEN){res.status(403).json({ok:!1,error:"forbidden"});return!1}return!0 }
app.get('/api/debug/env-has-sa', (_req, res) => { const hasProj=!!GCP_PROJECT_ID,hasEmail=!!GCP_SA_EMAIL,hasKey=!!GCP_SA_PRIVATE_KEY&&String(GCP_SA_PRIVATE_KEY).includes("BEGIN PRIVATE KEY");res.status(200).json({hasProj,hasEmail,hasKey,sa_source:SA_SOURCE}) });
app.get('/api/debug/fs-token', (req, res) => { if(!assertDebugAccess(req,res))return;console.warn("[API /debug/fs-token] Rota chamada, diag helpers não implementados.");return res.status(200).json({ok:!0,note:"Diag helpers not available.",scope:"firestore.default",expiry_date:null,expires_in_s:null}) });
app.post('/api/debug/ping-fs', async (req, res) => { const verbose=(String(req.query.verbose||req.headers["x-debug-verbose"]||"")==="1");try{if(!assertDebugAccess(req,res))return res.status(403).json({ok:!1,error:"forbidden"});const db=getDB();const out=await upsertDailyFact({db,anon_id:req.body?.anon_id||"anon_debug",user_id:req.body?.user_id,tz_offset:req.body?.tz_offset,event:"debug_write",page:"/debug",session_id:null,payload:{note:req.body?.note||"manual"},tsISO:(new Date).toISOString()});return res.status(200).json({ok:!0,rid:req.rid,doc:out.id})}catch(e){const payload={route:"/api/debug/ping-fs",rid:req.rid,error:e.message||String(e)};console.error(JSON.stringify(payload));if(e.code==="sa_not_configured"||e.code==='DB_NOT_INITIALIZED')return res.status(503).json({ok:!1,error:e.code||'db_init_failed',meta:e.meta});return res.status(500).json(verbose?{ok:!1,...payload}:{ok:!1,error:"ping_failed"})} });

/* ──────────────────────────────────────────────────────────────
   5) Google OAuth – One Tap - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
const oauthClient = new OAuth2Client(CLIENT_IDS[0] || 'YOUR_DEFAULT_CLIENT_ID');
app.options('/auth/google', (_req, res) => res.sendStatus(204)); app.options('/api/auth/google', (_req, res) => res.sendStatus(204));
async function handleAuthGoogle(req, res) { try{const ct=(req.headers["content-type"]||"").toLowerCase(),body=req.body||{},credential=typeof body.credential==="string"&&body.credential||typeof body.id_token==="string"&&body.id_token||null,context=body.context||{};console.log(JSON.stringify({route:"/auth/google",rid:req.rid,ct,has_cred:!!credential}));if(!credential)return res.status(400).json({error:"missing_credential"});const csrfCookie=req.cookies?.g_csrf_token,csrfBody=body?.g_csrf_token;if(csrfCookie&&csrfBody&&csrfCookie!==csrfBody){console.warn(`[AUTH] CSRF Mismatch: Cookie:"${csrfCookie}" vs Body:"${csrfBody}"`);return res.status(400).json({error:"csrf_mismatch"})}res.set({"Cache-Control":"no-store,no-cache,must-revalidate,private",Pragma:"no-cache",Expires:"0"});const ticket=await oauthClient.verifyIdToken({idToken:credential,audience:CLIENT_IDS}),payload=ticket.getPayload();if(!payload)return res.status(401).json({error:"invalid_token"});const{sub,email,name,picture,email_verified}=payload,user_id=String(sub);try{const db=getDB();const docRef=db.collection("users").doc(user_id);await docRef.set({user_id,sub,email:email||null,name:name||null,picture:picture||null,email_verified:!!email_verified},{merge:!0});await docRef.set({last_seen:FieldValue.serverTimestamp(),updated_at:FieldValue.serverTimestamp()},{merge:!0})}catch(e){console.error(JSON.stringify({route:"/auth/google",rid:req.rid,warn:"users_upsert_fail",error:e.message||String(e)}))}try{const db=getDB();const anon_id=context.anon_id||body.anon_id||"anon_unknown";await upsertDailyFact({db,anon_id,user_id,tz_offset:context.tz_offset,event:"auth_google_success",page:context.page||"/onetap",session_id:context.session_id,payload:{email:email||null,name:name||null,pic:picture||null,verified:!!email_verified},tsISO:(new Date).toISOString()})}catch(e){console.error(JSON.stringify({route:"/auth/google",rid:req.rid,warn:"daily_facts_log_fail",error:e.message||String(e)}))}return res.status(200).json({user_id,email:email||null,name:name||null,picture:picture||null})}catch(err){const msg=err?.message||String(err||"");let code="auth_failed";if(/audience/.test(msg))code="audience_mismatch";if(/expired/i.test(msg))code="token_expired";if(/invalid/i.test(msg))code="invalid_token";console.error(JSON.stringify({route:"/auth/google",rid:req.rid,error:msg,code}));return res.status(401).json({error:code})} }
app.post('/auth/google', handleAuthGoogle); app.post('/api/auth/google', handleAuthGoogle);

/* ──────────────────────────────────────────────────────────────
   6) Endpoints auxiliares - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
app.post('/api/echo', (req, res) => { res.set({"Cache-Control":"no-store,no-cache,must-revalidate,private",Pragma:"no-cache",Expires:"0"});return res.status(200).json({ok:!0,rid:req.rid,echo:req.body||null,ts:(new Date).toISOString()}) });
app.post('/api/track', async (req, res) => { try{if(!TRACK_OPEN){const tok=req.headers["x-api-token"]||req.headers["X-Api-Token"];if(!TRACK_TOKEN||tok!==TRACK_TOKEN)return res.status(403).json({ok:!1,error:"forbidden"})}const{event,payload}=req.body||{};if(!event||typeof event!=="string")return res.status(400).json({ok:!1,error:"missing_event"});const anon_id=payload?.anon_id||req.body?.anon_id||"anon_unknown",user_id=payload?.user_id||null,tz_offset=payload?.tz_offset,tsISO=payload?.ts||null,page=payload?.page||payload?.context?.page,sessionId=payload?.session_id;const db=getDB();await upsertDailyFact({db,anon_id,user_id,tz_offset,event,page,session_id:sessionId,payload:(()=>{const p={...payload};delete p.ts;delete p.tz_offset;delete p.page;delete p.session_id;delete p.user_id;delete p.anon_id;delete p.context;return toPlainJSON(p)})(),tsISO:tsISO||(new Date).toISOString()});return res.status(200).json({ok:!0,rid:req.rid})}catch(e){console.error(JSON.stringify({route:"/api/track",rid:req.rid,error:e.message||String(e)}));if(e.code==='DB_NOT_INITIALIZED')return res.status(503).json({ok:!1,error:e.code});return res.status(500).json({ok:!1,error:"track_failed"})} });

/* ──────────────────────────────────────────────────────────────
   7) ENDPOINT DO FUNIL DE LEAD MAGNET - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
app.post('/api/send-guide', async (req, res) => {
    try {
        const { user_id, anon_id, utms, context: reqContext } = req.body;
        if (!user_id) return res.status(400).json({ ok: false, error: 'missing_user_id' });
        const db = getDB();
        const userDoc = await db.collection('users').doc(String(user_id)).get();
        if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        const userData = userDoc.data(); const { email, name } = userData;
        if (!email) return res.status(400).json({ ok: false, error: 'user_has_no_email' });
        let firstName=name||'';let lastName='';const nameParts=(name||'').trim().split(/\s+/);if(nameParts.length>1){firstName=nameParts[0];lastName=nameParts.slice(1).join(' ')}
        let dynamicUrl = GUIDE_DYNAMIC_URL_BASE; try { const baseUrl = new URL(GUIDE_DYNAMIC_URL_BASE); const params = new URLSearchParams({ uid: user_id, anon_id: anon_id || 'anon_from_guide_api', utm_source: utms?.utm_source || 'convertkit', utm_medium: utms?.utm_medium || 'ebook-cta', utm_campaign: utms?.utm_campaign || 'lead-magnet-guide' }); for (const [k, v] of params) { baseUrl.searchParams.set(k, v); } dynamicUrl = baseUrl.toString(); } catch (urlError) { console.error(`[API /send-guide] Falha URL base '${GUIDE_DYNAMIC_URL_BASE}':`, urlError.message); }
        const subscriberData = { email: email, first_name: firstName, fields: { last_name: lastName, dynamic_cta_url: dynamicUrl } };
        if (!marketingAutomator?.addSubscriberToFunnel) { console.error("[API /send-guide] Erro: marketingAutomator.addSubscriberToFunnel não definido."); throw new Error("Marketing automator module not loaded."); }
        await marketingAutomator.addSubscriberToFunnel(subscriberData);
        await upsertDailyFact({ anon_id: anon_id || 'anon_unknown', user_id: user_id, event: 'convertkit_subscribe_success', page: reqContext?.page || '/api/send-guide', session_id: reqContext?.session_id, payload: { email, tagId: process.env.CONVERTKIT_TAG_ID, urlSent: dynamicUrl }, tsISO: new Date().toISOString() });
        res.status(200).json({ ok: true, message: 'subscriber_added_to_funnel' });
    } catch (e) {
        console.error(JSON.stringify({ route: '/api/send-guide', rid: req.rid, error: e.message || String(e) }));
        if (e.code === 'DB_NOT_INITIALIZED') return res.status(503).json({ ok: false, error: e.code });
        if (e.message?.includes('ConvertKit') || e.response?.data || e.message?.includes("Marketing automator")) { return res.status(e.response?.status || 500).json({ ok: false, error: 'convertkit_integration_failed', details: e.response?.data || e.message }); }
        res.status(500).json({ ok: false, error: 'funnel_integration_failed' });
    }
});

/* ──────────────────────────────────────────────────────────────
   8) Funil de Afiliados (Adapters v1.1.4) - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
app.post('/api/checkout', async (req, res) => { const logPrefix=`[API /checkout](rid:${req.rid})`;let platform="unknown";try{const{offerData,trackingParams}=req.body;if(!offerData?.affiliate_platform){console.warn(`${logPrefix} Falta offerData.affiliate_platform.`);return res.status(400).json({ok:!1,error:"missing_offerData"})}if(!trackingParams){console.warn(`${logPrefix} Falta trackingParams.`);return res.status(400).json({ok:!1,error:"missing_trackingParams"})}platform=offerData.affiliate_platform;console.log(`${logPrefix} Plataforma: ${platform}`);const adapter=PlatformAdapterBase.getInstance(platform),finalCheckoutUrl=await adapter.buildCheckoutUrl(offerData,trackingParams);if(!finalCheckoutUrl||typeof finalCheckoutUrl!=="string"){console.error(`${logPrefix} Adapter.buildCheckoutUrl() inválido:`,finalCheckoutUrl);throw new Error(`Adapter ${platform} falhou.`)}console.log(`${logPrefix} URL gerada.`);return res.status(200).json({ok:!0,finalCheckoutUrl})}catch(error){console.error(`${logPrefix} Falha ${platform}:`,error.message||error);return res.status(500).json({ok:!1,error:"checkout_url_generation_failed",platform})} });


/* ──────────────────────────────────────────────────────────────
   9) Erros globais - Idêntico v5.0.4
─────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason, promise) => { console.error('[UNHANDLED_REJECTION] Reason:', reason); });
process.on('uncaughtException', (err, origin) => { console.error('[UNCAUGHT_EXCEPTION] Error:', err, 'Origin:', origin); });

/* ──────────────────────────────────────────────────────────────
   10) Start - Modificado para exportar 'app' em teste (PATCH 1 OK)
─────────────────────────────────────────────────────────────── */
initAdmin(); // Tenta inicializar no boot

if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
  console.log('[BOOT] Ambiente teste. Exportando "app".');
  module.exports = app; // Exporta para supertest
} else {
  app.listen(PORT, () => { // Inicia servidor normalmente
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`✅ Server UP on port ${PORT}`);
    console.log(`📦 Version: v${VERSION} (${BUILD_DATE})`);
    console.log('🔧 Config:');
    console.log(`   - CORS Origens : ${allowedOrigins.slice(0,3).join(", ")}...`);
    console.log(`   - Google Auth  : ${CLIENT_IDS.length} Client ID(s)`);
    console.log(`   - Track Aberto : ${TRACK_OPEN}`);
    console.log(`   - Track Token  : ${TRACK_TOKEN?'Sim':'Não'}`);
    console.log(`   - Debug Token  : ${DEBUG_TOKEN?'Sim':'Não'}`);
    console.log(`   - Firestore    : Admin SDK (Fonte: ${SA_SOURCE}) ${_adminInited ? '✅' : '❌'}`); // Indica se inicializou
    console.log(`   - Adapters     : ${typeof PlatformAdapterBase?.getInstance==="function" ? '✅' : '❌'}`);
    console.log(`   - Guia URL Base: ${GUIDE_DYNAMIC_URL_BASE}`);
    console.log(`   - NODE_ENV     : ${process.env.NODE_ENV||"(N/A)"}`);
    console.log('──────────────────────────────────────────────────────────────');
  });
}