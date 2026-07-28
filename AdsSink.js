/**
 * PZ Advisors — AdsSink
 * Versão: v3.0.1
 * Data: 2026-07-28
 *
 * MIGRAÇÃO v2.3.0 -> v3.0.0 — Google Ads UploadClickConversions (BLOQUEADO a novas
 * integrações desde 15/jun/2026) -> **Data Manager API** (events:ingest +
 * requestStatus:retrieve). Plano APROVADO por ARCHITECT (v3.1). Ver docs de projecto.
 *
 * Modelo submit->poll (events:ingest é ASSÍNCRONO: devolve só {requestId}; só
 * requestStatus:retrieve confirma SUCCESS/FAILED). Envelope imutável write-once.
 * Estados submitting/polling com fase recuperável. Reprocessador conduz a fase poll.
 *
 * CORREÇÕES da revisão de código completo (ARCHITECT, fase 2):
 *  1. `validated` volta ao envio real: mantém ads_wake_at e entra na query do
 *     reprocessador; ao desligar o dry-run é promovido a submit.
 *  2. FENCING TOKEN: o claim gera ads_lease_token; toda a transição de fase é um
 *     CAS transacional (_markGuarded) que exige o token corrente. Um worker cuja
 *     lease expirou não sobrescreve o estado escrito por um worker mais recente.
 *  3. DEADLINE também em falhas de transporte no poll: timeout/5xx durante o
 *     retrieve incrementa ads_poll_attempts e respeita ads_poll_deadline (24h).
 *
 * Alterações v3.0.1 (Fase 2 — Purchase→AdsSink, correção estrutural ARCHITECT,
 * 2026-07-28): _ensureEnvelope() passa a construir o envelope a partir de
 * data.ads_envelope_src (snapshot congelado gravado pelo FirebaseSink v1.5.0 no
 * momento do seed) quando existir, com fallback para o documento completo (data)
 * quando não existir — preserva byte-a-byte o comportamento anterior para o caminho
 * micro (ads_micro_outbox, seed próprio do server.js) e para documentos legados sem
 * snapshot. Motivo: sem este snapshot, um refund/chargeback com o mesmo tx_id da
 * compra (mesmo docId) alterava os campos de topo do documento (event_type, gclid,
 * comissão) depois do seed mas antes do 1º claim, contaminando o envelope da compra.
 * Nenhuma outra função deste ficheiro foi alterada.
 *
 * Env: ver secção no fundo do plano. NÃO usa developer token nem google-ads-api.
 */

'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { UserRefreshClient } = require('google-auth-library');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');

const ConvMapLoaderCsv = require('./ConvMapLoaderCsv');
const ConsentResolver = require('./ConsentResolver');

const VERSION = '3.0.1';
const LOG = `[AdsSink v${VERSION}]`;
const COLLECTION_NAME = process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions';
const PAYLOAD_VERSION = 'dm-v1';

const DM_BASE = 'https://datamanager.googleapis.com/v1';
const DM_INGEST_URL = `${DM_BASE}/events:ingest`;
const DM_STATUS_URL = `${DM_BASE}/requestStatus:retrieve`;

const ST_PENDING = 'pending';
const ST_SUBMITTING = 'submitting';
const ST_SUBMITTED = 'submitted';
const ST_POLLING = 'polling';
const ST_UPLOADED = 'uploaded';
const ST_VALIDATED = 'validated';
const ST_RETRY = 'retry';
const ST_PERMANENT = 'permanent_error';

const EC_TRANSIENT = 'transient';
const EC_PERMANENT = 'permanent';
const EC_CONFIG = 'config';

// Estados-base reclamáveis pelo reprocessador. ST_VALIDATED é acrescentado à query
// DINAMICAMENTE, e SÓ com o dry-run DESLIGADO (ver reprocessOnce): enquanto o dry-run
// está ligado, _claim recusa validated sem mexer no ads_wake_at, logo se estivesse na
// query os mesmos docs reapareceriam em cada ciclo e ocupariam o `limit`, esfomeando
// pending/retry/submitted.
const REPROCESS_STATES_BASE = [ST_PENDING, ST_RETRY, ST_SUBMITTED, ST_SUBMITTING, ST_POLLING];

const counters = {
  claimed: 0, submitted: 0, uploaded: 0, polled: 0, still_processing: 0,
  retry_scheduled: 0, permanent_errors: 0, lease_recovered: 0, attempts_exhausted: 0,
  poll_deadline_exceeded: 0, duplicate_ignored: 0, validate_only_runs: 0,
  state_write_failures: 0, reprocess_runs: 0, stale_lease_discarded: 0,
};

// ---------------------------------------------------------------- OAuth cache
let _oauthClient = null;
let _accessToken = null;
let _accessTokenExpiry = 0;

function _getOAuthClient() {
  if (_oauthClient) return _oauthClient;
  const { PZ_ADS_CLIENT_ID, PZ_ADS_CLIENT_SECRET, PZ_ADS_REFRESH_TOKEN } = process.env;
  if (!PZ_ADS_CLIENT_ID || !PZ_ADS_CLIENT_SECRET || !PZ_ADS_REFRESH_TOKEN) return null;
  _oauthClient = new UserRefreshClient(PZ_ADS_CLIENT_ID, PZ_ADS_CLIENT_SECRET, PZ_ADS_REFRESH_TOKEN);
  return _oauthClient;
}

async function _getAccessToken() {
  const now = Date.now();
  if (_accessToken && now < _accessTokenExpiry - 60_000) return _accessToken;
  const client = _getOAuthClient();
  if (!client) { const e = new Error('oauth_credentials_missing'); e.errorClass = EC_CONFIG; throw e; }
  const { token, res } = await client.getAccessToken();
  if (!token) { const e = new Error('oauth_no_token'); e.errorClass = EC_CONFIG; throw e; }
  _accessToken = token;
  const expiresIn = Number(res?.data?.expires_in || 3300);
  _accessTokenExpiry = now + expiresIn * 1000;
  return _accessToken;
}

// ------------------------------------------------------------------- Helpers
function _digits(v) { return String(v ?? '').replace(/\D+/g, ''); }
function _envInt(name, dflt) { const n = parseInt(process.env[name] ?? '', 10); return Number.isFinite(n) && n > 0 ? n : dflt; }
function _toRfc3339(iso) { const d = new Date(iso); if (!Number.isFinite(d.getTime())) throw new Error(`event_time_invalido: "${iso}"`); return d.toISOString(); }
function _docIdFor(tx) { return `${String(tx.platform).replace(/[^\w\-]+/g, '_')}_${String(tx.tx_id).replace(/[^\w\-]+/g, '_')}`; }
function _millis(ts) { if (!ts) return null; if (typeof ts.toMillis === 'function') return ts.toMillis(); if (ts instanceof Date) return ts.getTime(); const n = Number(ts); return Number.isFinite(n) ? n : null; }
function _backoffMs(a) { const b = _envInt('PZ_ADSSINK_BACKOFF_BASE_MS', 60_000); const m = _envInt('PZ_ADSSINK_BACKOFF_MAX_MS', 3_600_000); return Math.min(b * Math.pow(2, Math.max(1, Number(a) || 1) - 1), m); }
function _pollBackoffMs(a) { const b = _envInt('PZ_ADSSINK_POLL_BASE_MS', 30_000); const m = _envInt('PZ_ADSSINK_POLL_MAX_MS', 1_800_000); return Math.min(b * Math.pow(2, Math.max(1, Number(a) || 1) - 1), m); }

function _dmConsent(v) {
  const s = String(v || '').toUpperCase();
  if (s === 'GRANTED' || s === 'CONSENT_GRANTED') return 'CONSENT_GRANTED';
  if (s === 'DENIED' || s === 'CONSENT_DENIED') return 'CONSENT_DENIED';
  return 'CONSENT_STATUS_UNSPECIFIED';
}

function _resolveValue(tx, mapRow) {
  const fail = (m) => { const e = new Error(m); e.errorClass = EC_CONFIG; throw e; };
  if (mapRow.value_mode === 'none') return { value: null, currency: null };
  if (mapRow.value_mode === 'fixed') {
    const v = Number(mapRow.fixed_value);
    if (!Number.isFinite(v) || v <= 0) fail(`value_mode=fixed com fixed_value inválido ("${mapRow.fixed_value}")`);
    const cur = String(mapRow.currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) fail(`value_mode=fixed sem currency ("${mapRow.currency}")`);
    return { value: v, currency: cur };
  }
  const v = Number(tx.commission_amount);
  if (!Number.isFinite(v) || v <= 0) fail(`value_mode=from_transaction sem commission_amount ("${tx.commission_amount}")`);
  const cur = String(tx.commission_currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) fail(`value_mode=from_transaction sem commission_currency ("${tx.commission_currency}")`);
  return { value: v, currency: cur };
}

// -------------------------------------------------- Envelope imutável (write-once)
function _buildEnvelope(src, mapRow, consent) {
  const gclid = String(src.gclid || '').trim();
  if (!gclid) { const e = new Error('envelope_sem_gclid'); e.errorClass = EC_CONFIG; throw e; }
  const eventTimeIso = src.event_time_iso || src.event_time || null;
  if (!eventTimeIso) { const e = new Error('envelope_sem_event_time_iso'); e.errorClass = EC_CONFIG; throw e; }
  const eventTimestamp = _toRfc3339(eventTimeIso);
  const transactionId = String(src.order_id || src.tx_id || '');
  if (!transactionId) { const e = new Error('envelope_sem_transaction_id'); e.errorClass = EC_CONFIG; throw e; }
  const operating = _digits(process.env.PZ_DM_OPERATING_ACCOUNT_ID || process.env.PZ_ADS_CONVERSION_ACTION_CUSTOMER_ID);
  const login = _digits(process.env.PZ_DM_LOGIN_ACCOUNT_ID || process.env.PZ_ADS_LOGIN_CUSTOMER_ID);
  if (!operating) { const e = new Error('PZ_DM_OPERATING_ACCOUNT_ID em falta'); e.errorClass = EC_CONFIG; throw e; }
  if (!login) { const e = new Error('PZ_DM_LOGIN_ACCOUNT_ID em falta'); e.errorClass = EC_CONFIG; throw e; }
  const cad = _digits(mapRow.conversion_action_id);
  if (!cad) { const e = new Error(`conversion_action_id inválido ("${mapRow.conversion_action_id}")`); e.errorClass = EC_CONFIG; throw e; }
  const { value, currency } = _resolveValue(src, mapRow);
  const env = {
    payload_version: PAYLOAD_VERSION, eventTimestamp, transactionId, gclid,
    conversion_action_id: cad, operating_account_id: operating, login_account_id: login,
    consent: { adUserData: _dmConsent(consent.adUserData), adPersonalization: _dmConsent(consent.adPersonalization) },
  };
  if (value !== null) { env.conversionValue = value; env.currency = currency; }
  return env;
}

function _ingestBody(env, validateOnly) {
  const event = { eventTimestamp: env.eventTimestamp, transactionId: env.transactionId, eventSource: 'WEB', adIdentifiers: { gclid: env.gclid } };
  if (typeof env.conversionValue === 'number') { event.conversionValue = env.conversionValue; event.currency = env.currency; }
  return {
    destinations: [{
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: env.operating_account_id },
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: env.login_account_id },
      productDestinationId: env.conversion_action_id,
    }],
    events: [event], consent: env.consent, validateOnly: !!validateOnly,
  };
}

// --------------------------------------------------- Classificação de erros
function _classifyHttp(status) { if (status === 429 || status >= 500) return EC_TRANSIENT; if (status === 401 || status === 403) return EC_CONFIG; return EC_PERMANENT; }

const PR_DUPLICATE = new Set(['PROCESSING_ERROR_REASON_DUPLICATE_TRANSACTION_ID', 'PROCESSING_ERROR_REASON_DUPLICATE_GCLID']);
const PR_TRANSIENT = new Set(['PROCESSING_ERROR_REASON_INTERNAL_ERROR', 'PROCESSING_ERROR_REASON_UNSPECIFIED']);

function _classifyReasons(reasons) {
  const list = Array.isArray(reasons) ? reasons.filter(Boolean) : [];
  if (list.length === 0) return 'permanent';
  if (list.every((r) => PR_DUPLICATE.has(r))) return 'uploaded';
  if (list.some((r) => !PR_DUPLICATE.has(r) && !PR_TRANSIENT.has(r))) return 'permanent';
  if (list.some((r) => PR_TRANSIENT.has(r))) return 'retry';
  return 'permanent';
}

// ------------------------------------------------------------- HTTP: ingest/poll
async function _ingestEvent(env, validateOnly) {
  const token = await _getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const timeout = _envInt('PZ_ADSSINK_HTTP_TIMEOUT_MS', 10_000);
  let res;
  try { res = await axios.post(DM_INGEST_URL, _ingestBody(env, validateOnly), { headers, timeout, validateStatus: () => true }); }
  catch (netErr) { const e = new Error(`network_error: ${netErr?.code || netErr?.message || netErr}`); e.errorClass = EC_TRANSIENT; throw e; }
  if (res.status !== 200) {
    const detail = typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 800) : String(res.data).slice(0, 800);
    const e = new Error(`ingest_http_${res.status}: ${detail}`); e.errorClass = _classifyHttp(res.status); throw e;
  }
  const requestId = res.data?.requestId || null;
  if (validateOnly) return { validateOnly: true, requestId };
  if (!requestId) { const e = new Error('ingest_200_sem_requestId'); e.errorClass = EC_TRANSIENT; throw e; }
  return { validateOnly: false, requestId };
}

async function _retrieveStatus(requestId) {
  const token = await _getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const timeout = _envInt('PZ_ADSSINK_HTTP_TIMEOUT_MS', 10_000);
  let res;
  try { res = await axios.get(DM_STATUS_URL, { headers, timeout, params: { requestId }, validateStatus: () => true }); }
  catch (netErr) { const e = new Error(`status_network_error: ${netErr?.code || netErr?.message || netErr}`); e.errorClass = EC_TRANSIENT; throw e; }
  if (res.status !== 200) {
    const detail = typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 800) : String(res.data).slice(0, 800);
    const e = new Error(`status_http_${res.status}: ${detail}`); e.errorClass = _classifyHttp(res.status); throw e;
  }
  const per = Array.isArray(res.data?.requestStatusPerDestination) ? res.data.requestStatusPerDestination : [];
  const d0 = per[0] || {};
  const status = d0.requestStatus || 'REQUEST_STATUS_UNKNOWN';
  const reasons = [];
  const ec = d0.errorInfo?.errorCounts;
  if (Array.isArray(ec)) for (const c of ec) if (c?.reason) reasons.push(c.reason);
  return { status, reasons };
}

// ---------------------------------------------- Claim (transacção + fencing token)
async function _claim(docRef) {
  const db = getFirestore();
  const leaseMs = _envInt('PZ_ADSSINK_LEASE_MS', 120_000);
  const maxAttempts = _envInt('PZ_ADSSINK_MAX_ATTEMPTS', 6);
  const leaseToken = crypto.randomBytes(16).toString('hex'); // FENCING TOKEN (correção #2)

  return db.runTransaction(async (t) => {
    const snap = await t.get(docRef);
    if (!snap.exists) return { ok: false, reason: 'doc_inexistente' };
    const data = snap.data() || {};
    const status = data.ads_upload_status || ST_PENDING;
    const now = Date.now();
    const validateOnlyNow = process.env.PZ_ADSSINK_VALIDATE_ONLY === 'true';
    const hasRequestId = !!data.ads_dm_request_id;

    if (status === ST_UPLOADED) return { ok: false, reason: 'ja_enviado' };
    if (status === ST_PERMANENT) return { ok: false, reason: 'erro_permanente_terminal' };
    if (status === ST_VALIDATED && validateOnlyNow) return { ok: false, reason: 'ja_validado_em_dry_run' };

    const wakeMs = _millis(data.ads_wake_at);
    const leaseUntilMs = _millis(data.ads_lease_until);
    let phase = null, recoveredLease = false, resetAttempts = false;

    if (status === ST_PENDING || status === ST_RETRY) {
      if (wakeMs !== null && wakeMs > now) return { ok: false, reason: 'backoff_por_cumprir' };
      phase = 'submit';
    } else if (status === ST_VALIDATED) { // só chega aqui com dry-run OFF -> envio real
      resetAttempts = true; phase = 'submit';
    } else if (status === ST_SUBMITTED) {
      if (wakeMs !== null && wakeMs > now) return { ok: false, reason: 'poll_por_cumprir' };
      phase = 'poll';
    } else if (status === ST_SUBMITTING) {
      if (leaseUntilMs !== null && leaseUntilMs >= now) return { ok: false, reason: 'lease_valida_noutro_worker' };
      recoveredLease = true; phase = hasRequestId ? 'poll' : 'submit';
    } else if (status === ST_POLLING) {
      if (leaseUntilMs !== null && leaseUntilMs >= now) return { ok: false, reason: 'lease_valida_noutro_worker' };
      recoveredLease = true; phase = 'poll';
    } else {
      return { ok: false, reason: `status_desconhecido:${status}` };
    }

    const leaseUntil = Timestamp.fromMillis(now + leaseMs);
    if (phase === 'submit') {
      const attempts = resetAttempts ? 1 : Number(data.ads_attempts || 0) + 1;
      if (attempts > maxAttempts) {
        t.set(docRef, {
          ads_upload_status: ST_PERMANENT, ads_attempts: attempts, ads_error_class: EC_PERMANENT,
          ads_last_error: `max_attempts_excedido (${attempts} > ${maxAttempts})`,
          ads_lease_until: FieldValue.delete(), ads_next_attempt_at: FieldValue.delete(),
          ads_wake_at: FieldValue.delete(), ads_lease_token: FieldValue.delete(), ads_sink_version: VERSION,
        }, { merge: true });
        return { ok: false, reason: 'max_attempts_excedido', attempts };
      }
      const patch = {
        ads_upload_status: ST_SUBMITTING, ads_attempts: attempts, ads_lease_until: leaseUntil,
        ads_wake_at: leaseUntil, ads_lease_token: leaseToken, ads_sink_version: VERSION,
      };
      if (resetAttempts) { // validated -> envio real: recomeça limpo
        patch.ads_dm_request_id = FieldValue.delete(); patch.ads_poll_attempts = FieldValue.delete(); patch.ads_poll_deadline = FieldValue.delete();
      }
      t.set(docRef, patch, { merge: true });
      return { ok: true, phase, attempts, data, recoveredLease, leaseToken };
    }

    // poll — não consome tentativa de ingest; limitado por ads_poll_deadline.
    t.set(docRef, { ads_upload_status: ST_POLLING, ads_lease_until: leaseUntil, ads_wake_at: leaseUntil, ads_lease_token: leaseToken, ads_sink_version: VERSION }, { merge: true });
    return { ok: true, phase, attempts: Number(data.ads_attempts || 0), data, recoveredLease, leaseToken };
  });
}

/**
 * Escrita de estado com FENCING (correção #2): CAS transacional. Só escreve se o
 * ads_lease_token do doc ainda for o do worker. Se outro worker (mais recente)
 * reclamou o doc, a escrita é DESCARTADA (throw isStale) — o worker antigo não
 * corrompe o estado do novo. Falha do Firestore propaga (isStateWriteFailure).
 */
async function _markGuarded(docRef, leaseToken, patch) {
  const db = getFirestore();
  let stale = false;
  try {
    await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);
      if (!snap.exists) { const e = new Error('doc_desapareceu'); e.errorClass = EC_TRANSIENT; throw e; }
      if ((snap.data() || {}).ads_lease_token !== leaseToken) { stale = true; return; }
      t.set(docRef, { ...patch, ads_state_updated_at: FieldValue.serverTimestamp() }, { merge: true });
    });
  } catch (e) {
    counters.state_write_failures++;
    console.error(`${LOG} ALARME: falha ao persistir estado (guarded):`, e?.message || e);
    const err = new Error(`firestore_state_write_failed: ${e?.message || e}`);
    err.errorClass = EC_TRANSIENT; err.isStateWriteFailure = true; throw err;
  }
  if (stale) {
    counters.stale_lease_discarded++;
    console.warn(`${LOG} escrita DESCARTADA por fencing (lease reclamada por worker mais recente). doc=${docRef.id || docRef._key || '?'}`);
    const e = new Error('lease_roubada'); e.isStale = true; e.errorClass = EC_TRANSIENT; throw e;
  }
  return { stale: false };
}

// ------------------------------------------------------- Fases (submit/poll)
async function _ensureEnvelope(docRef, data, leaseToken) {
  if (data.ads_envelope && data.ads_envelope.payload_version) return data.ads_envelope;
  // Correcção de revisão (v3.0.0): o 1º envelope é construído EXCLUSIVAMENTE a partir
  // do documento persistido (o seed create-only), NUNCA do canonical em memória.
  // v3.0.1: quando o seed gravou ads_envelope_src (FirebaseSink v1.5.0), é ESSE
  // snapshot congelado que alimenta o envelope — os campos de topo do documento podem
  // entretanto ter avançado no ciclo de vida (refund/chargeback com o mesmo tx_id) sem
  // afectar o envelope decidido no seed. Fallback para o documento completo preserva
  // compatibilidade com docs sem snapshot (ads_micro_outbox seeded pelo server.js,
  // docs legados).
  const base = (data.ads_envelope_src && typeof data.ads_envelope_src === 'object') ? data.ads_envelope_src : data;
  const eventName = base.event_type || base.event_name || 'purchase';
  const map = ConvMapLoaderCsv.getInstance();
  if (!map.isValid()) { const e = new Error('mapa_invalido_no_envelope'); e.errorClass = EC_CONFIG; throw e; }
  const src = {
    gclid: base.gclid, event_time_iso: base.event_time_iso, order_id: base.order_id, tx_id: base.tx_id,
    platform: base.platform, commission_amount: base.commission_amount, commission_currency: base.commission_currency,
  };
  const mapRow = map.resolve({ platform: src.platform, event_name: eventName, product_id: base.product_id, page_type: base.page_type });
  if (!mapRow) { const e = new Error('sem_linha_no_mapa_no_envelope'); e.errorClass = EC_CONFIG; throw e; }
  const consent = ConsentResolver.resolve({ tx: base, mapRow });
  const env = _buildEnvelope(src, mapRow, consent);
  env.event_name = eventName; env.map_kind = mapRow.map_kind;
  await _markGuarded(docRef, leaseToken, { ads_envelope: env }); // write-once, guarded
  return env;
}

async function _doSubmit(docRef, claim) {
  const env = await _ensureEnvelope(docRef, claim.data, claim.leaseToken);
  const validateOnly = process.env.PZ_ADSSINK_VALIDATE_ONLY === 'true';
  const out = await _ingestEvent(env, validateOnly);

  if (out.validateOnly) {
    // correção #1: mantém ads_wake_at=now para o reprocessador o promover quando o dry-run desligar.
    await _markGuarded(docRef, claim.leaseToken, {
      ads_upload_status: ST_VALIDATED, ads_wake_at: Timestamp.now(),
      ads_lease_until: FieldValue.delete(), ads_last_validated_at: FieldValue.serverTimestamp(),
      ads_last_error: FieldValue.delete(), ads_error_class: FieldValue.delete(),
    });
    counters.validate_only_runs++;
    console.log(`${LOG} VALIDADO (dry-run) tx=${env.transactionId}`);
    return { sent: false, reason: 'validate_only' };
  }

  const pollDelay = _pollBackoffMs(1);
  await _markGuarded(docRef, claim.leaseToken, {
    ads_upload_status: ST_SUBMITTED, ads_dm_request_id: out.requestId, ads_poll_attempts: 0,
    ads_submitted_at: FieldValue.serverTimestamp(),
    ads_poll_deadline: Timestamp.fromMillis(Date.now() + _envInt('PZ_ADSSINK_POLL_DEADLINE_MS', 86_400_000)),
    ads_next_attempt_at: Timestamp.fromMillis(Date.now() + pollDelay),
    ads_wake_at: Timestamp.fromMillis(Date.now() + pollDelay),
    ads_lease_until: FieldValue.delete(), ads_last_error: FieldValue.delete(), ads_error_class: FieldValue.delete(),
  });
  counters.submitted++;
  console.log(`${LOG} SUBMETIDO tx=${env.transactionId} requestId=${out.requestId}`);
  return { sent: false, reason: 'submitted' };
}

/**
 * Correção #3: reagenda o poll OU expira, SEMPRE respeitando ads_poll_deadline e
 * incrementando ads_poll_attempts. Usado tanto no PROCESSING como em falhas de
 * transporte (timeout/5xx) durante o retrieve.
 */
async function _pollRescheduleOrExpire(docRef, leaseToken, data, note) {
  const deadlineMs = _millis(data.ads_poll_deadline);
  if (deadlineMs !== null && Date.now() > deadlineMs) {
    counters.poll_deadline_exceeded++; counters.permanent_errors++;
    console.error(`${LOG} ALARME: poll deadline (24h) excedido — permanent. ${note}`);
    await _markGuarded(docRef, leaseToken, {
      ads_upload_status: ST_PERMANENT, ads_error_class: EC_PERMANENT, ads_last_error: `poll_deadline_excedido: ${note}`,
      ads_lease_until: FieldValue.delete(), ads_wake_at: FieldValue.delete(), ads_next_attempt_at: FieldValue.delete(),
    });
    return { sent: false, reason: 'poll_deadline_excedido' };
  }
  const pollAttempts = Number(data.ads_poll_attempts || 0) + 1;
  const delay = _pollBackoffMs(pollAttempts);
  counters.still_processing++;
  await _markGuarded(docRef, leaseToken, {
    ads_upload_status: ST_SUBMITTED, ads_poll_attempts: pollAttempts,
    ads_next_attempt_at: Timestamp.fromMillis(Date.now() + delay), ads_wake_at: Timestamp.fromMillis(Date.now() + delay),
    ads_lease_until: FieldValue.delete(),
  });
  return { sent: false, reason: 'processing' };
}

async function _doPoll(docRef, claim) {
  const data = claim.data;
  const requestId = data.ads_dm_request_id;
  const env = data.ads_envelope || {};
  if (!requestId) {
    await _markGuarded(docRef, claim.leaseToken, {
      ads_upload_status: ST_RETRY, ads_lease_until: FieldValue.delete(),
      ads_next_attempt_at: Timestamp.fromMillis(Date.now()), ads_wake_at: Timestamp.fromMillis(Date.now()),
      ads_last_error: 'polling_sem_requestId', ads_error_class: EC_TRANSIENT,
    });
    return { sent: false, reason: 'polling_sem_requestId' };
  }

  const { status, reasons } = await _retrieveStatus(requestId);
  counters.polled++;

  if (status === 'SUCCESS') {
    await _markGuarded(docRef, claim.leaseToken, {
      ads_upload_status: ST_UPLOADED, ads_uploaded_at: FieldValue.serverTimestamp(),
      ads_conversion_action_id: env.conversion_action_id, ads_event_name: env.event_name, ads_map_kind: env.map_kind,
      ads_lease_until: FieldValue.delete(), ads_wake_at: FieldValue.delete(), ads_next_attempt_at: FieldValue.delete(),
      ads_last_error: FieldValue.delete(), ads_error_class: FieldValue.delete(),
    });
    counters.uploaded++;
    console.log(`${LOG} CONFIRMADO (SUCCESS) tx=${env.transactionId}`);
    return { sent: true, reason: 'ok' };
  }

  if (status === 'PROCESSING' || status === 'REQUEST_STATUS_UNKNOWN') {
    return await _pollRescheduleOrExpire(docRef, claim.leaseToken, data, `status=${status}`);
  }

  // FAILED / PARTIAL_SUCCESS
  const verdict = _classifyReasons(reasons);
  if (verdict === 'uploaded') {
    counters.duplicate_ignored++;
    await _markGuarded(docRef, claim.leaseToken, {
      ads_upload_status: ST_UPLOADED, ads_uploaded_at: FieldValue.serverTimestamp(), ads_duplicate_at_google: true,
      ads_conversion_action_id: env.conversion_action_id, ads_event_name: env.event_name, ads_map_kind: env.map_kind,
      ads_lease_until: FieldValue.delete(), ads_wake_at: FieldValue.delete(), ads_next_attempt_at: FieldValue.delete(),
      ads_last_error: FieldValue.delete(), ads_error_class: FieldValue.delete(),
    });
    counters.uploaded++;
    console.log(`${LOG} CONFIRMADO (duplicado ${reasons.join(',')}) tx=${env.transactionId}`);
    return { sent: true, reason: 'ok_duplicado' };
  }
  if (verdict === 'retry') {
    const delay = _backoffMs(Number(data.ads_attempts || 0));
    counters.retry_scheduled++;
    console.warn(`${LOG} FAILED transiente [${reasons.join(',')}] tx=${env.transactionId} — re-ingest em ${Math.round(delay / 1000)}s`);
    await _markGuarded(docRef, claim.leaseToken, {
      ads_upload_status: ST_RETRY, ads_dm_request_id: FieldValue.delete(), ads_poll_attempts: FieldValue.delete(),
      ads_next_attempt_at: Timestamp.fromMillis(Date.now() + delay), ads_wake_at: Timestamp.fromMillis(Date.now() + delay),
      ads_lease_until: FieldValue.delete(), ads_last_error: `failed_transiente [${reasons.join(',')}]`, ads_error_class: EC_TRANSIENT,
    });
    return { sent: false, reason: 'retry_failed' };
  }
  counters.permanent_errors++;
  console.error(`${LOG} ALARME: FAILED permanente [${reasons.join(',')}] tx=${env.transactionId}`);
  await _markGuarded(docRef, claim.leaseToken, {
    ads_upload_status: ST_PERMANENT, ads_error_class: EC_PERMANENT,
    ads_last_error: `failed_permanente [${reasons.join(',') || 'sem_motivo'}]`,
    ads_lease_until: FieldValue.delete(), ads_wake_at: FieldValue.delete(), ads_next_attempt_at: FieldValue.delete(),
  });
  return { sent: false, reason: 'failed_permanente' };
}

async function _runClaimed(docRef, claim, txLabel) {
  try {
    if (claim.phase === 'submit') return await _doSubmit(docRef, claim);
    return await _doPoll(docRef, claim);
  } catch (err) {
    // Falha de persistência ou lease roubada: não escrever aqui (o novo dono decide;
    // a lease expira e recupera-se).
    if (err.isStateWriteFailure || err.isStale) throw err;
    const errorClass = err.errorClass || EC_PERMANENT;
    const message = String(err.message || err).slice(0, 900);

    if (claim.phase === 'poll') {
      if (errorClass === EC_TRANSIENT) {
        // correção #3: falha de transporte no poll respeita o deadline.
        return await _pollRescheduleOrExpire(docRef, claim.leaseToken, claim.data, `transporte: ${message}`);
      }
      counters.permanent_errors++;
      console.error(`${LOG} ALARME: erro ${errorClass} no poll (tx=${txLabel}). Terminal. ${message}`);
      await _markGuarded(docRef, claim.leaseToken, {
        ads_upload_status: ST_PERMANENT, ads_last_error: message, ads_error_class: errorClass,
        ads_lease_until: FieldValue.delete(), ads_wake_at: FieldValue.delete(), ads_next_attempt_at: FieldValue.delete(),
      });
      return { sent: false, reason: 'erro_fase', detail: { errorClass, message } };
    }

    // submit phase
    if (errorClass === EC_TRANSIENT) {
      const delay = _backoffMs(claim.attempts);
      counters.retry_scheduled++;
      console.warn(`${LOG} Erro transiente (submit, tx=${txLabel}). Retoma em ${Math.round(delay / 1000)}s. ${message}`);
      await _markGuarded(docRef, claim.leaseToken, {
        ads_upload_status: ST_RETRY, ads_next_attempt_at: Timestamp.fromMillis(Date.now() + delay), ads_wake_at: Timestamp.fromMillis(Date.now() + delay),
        ads_lease_until: FieldValue.delete(), ads_last_error: message, ads_error_class: errorClass,
      });
    } else {
      counters.permanent_errors++;
      console.error(`${LOG} ALARME: erro ${errorClass} (submit, tx=${txLabel}). Terminal. ${message}`);
      await _markGuarded(docRef, claim.leaseToken, {
        ads_upload_status: ST_PERMANENT, ads_last_error: message, ads_error_class: errorClass,
        ads_lease_until: FieldValue.delete(), ads_wake_at: FieldValue.delete(), ads_next_attempt_at: FieldValue.delete(),
      });
    }
    return { sent: false, reason: 'erro_fase', detail: { errorClass, message } };
  }
}

// --------------------------------------------------------------- API Pública
async function sendConversion(canonical, opts = {}) {
  let docRef = null;
  try {
    if (process.env.PZ_ADSSINK_ENABLED !== 'true') return { sent: false, reason: 'disabled_by_flag' };
    if (!canonical || !canonical.platform || !canonical.tx_id) return { sent: false, reason: 'evento_invalido' };
    if (!String(canonical.gclid || '').trim()) return { sent: false, reason: 'sem_gclid' };
    const map = ConvMapLoaderCsv.getInstance();
    if (!map.isValid()) { console.error(`${LOG} pz_conversion_map inválido — no-op. ${map.getErrors().slice(0, 3).join(' | ')}`); return { sent: false, reason: 'mapa_invalido' }; }

    const db = getFirestore();
    docRef = db.collection(opts.collection || COLLECTION_NAME).doc(_docIdFor(canonical));
    const claim = await _claim(docRef);
    if (!claim.ok) {
      if (claim.reason === 'max_attempts_excedido') { counters.attempts_exhausted++; counters.permanent_errors++; console.error(`${LOG} ALARME: tentativas esgotadas tx=${canonical.tx_id} (${claim.attempts}).`); }
      return { sent: false, reason: claim.reason };
    }
    counters.claimed++;
    if (claim.recoveredLease) { counters.lease_recovered++; console.warn(`${LOG} Lease recuperada tx=${canonical.tx_id} fase=${claim.phase}.`); }
    return await _runClaimed(docRef, claim, canonical.tx_id);
  } catch (fatal) {
    if (fatal?.isStale) { console.warn(`${LOG} lease roubada durante o envio (tx=${canonical?.tx_id}) — outro worker assume.`); return { sent: false, reason: 'lease_roubada' }; }
    if (fatal?.isStateWriteFailure) console.error(`${LOG} ALARME: estado não persistido. Recuperação por lease + idempotência do transactionId.`);
    console.error(`${LOG} Erro não tratado:`, fatal?.message || fatal);
    return { sent: false, reason: 'erro_interno', detail: { message: String(fatal?.message || fatal) } };
  }
}

async function reprocessOnce(opts = {}) {
  counters.reprocess_runs++;
  const out = { scanned: 0, processed: 0, results: {} };
  if (process.env.PZ_ADSSINK_ENABLED !== 'true') { out.reason = 'disabled_by_flag'; return out; }
  try {
    const db = getFirestore();
    const coll = opts.collection || COLLECTION_NAME;
    const limit = opts.limit || _envInt('PZ_ADSSINK_REPROCESS_BATCH', 50);
    // Estados da query: validated só entra com o dry-run DESLIGADO (evita starvation).
    const validateOnly = process.env.PZ_ADSSINK_VALIDATE_ONLY === 'true';
    const states = validateOnly ? REPROCESS_STATES_BASE : [...REPROCESS_STATES_BASE, ST_VALIDATED];
    const nowTs = Timestamp.fromMillis(Date.now());
    const snap = await db.collection(coll)
      .where('ads_upload_status', 'in', states)
      .where('ads_wake_at', '<=', nowTs)
      .orderBy('ads_wake_at', 'asc')
      .limit(limit)
      .get();
    out.scanned = snap.size;
    for (const doc of snap.docs) {
      const docRef = doc.ref;
      let claim;
      try { claim = await _claim(docRef); } catch (e) { console.error(`${LOG} claim falhou ${doc.id}:`, e?.message || e); continue; }
      if (!claim.ok) { out.results[claim.reason] = (out.results[claim.reason] || 0) + 1; continue; }
      counters.claimed++;
      if (claim.recoveredLease) counters.lease_recovered++;
      try {
        const r = await _runClaimed(docRef, claim, doc.id);
        out.processed++; out.results[r.reason] = (out.results[r.reason] || 0) + 1;
      } catch (e) {
        // isStale/isStateWriteFailure/fatal: não escreve; lease expira e recupera.
        out.results[e?.isStale ? 'lease_roubada' : 'erro'] = (out.results[e?.isStale ? 'lease_roubada' : 'erro'] || 0) + 1;
        if (!e?.isStale) console.error(`${LOG} fase falhou ${doc.id}:`, e?.message || e);
      }
    }
    return out;
  } catch (fatal) {
    console.error(`${LOG} reprocessOnce erro:`, fatal?.message || fatal);
    out.error = String(fatal?.message || fatal);
    return out;
  }
}

function getHealth() {
  const map = ConvMapLoaderCsv.getInstance();
  return {
    version: VERSION, api: 'data_manager',
    enabled: process.env.PZ_ADSSINK_ENABLED === 'true', validate_only: process.env.PZ_ADSSINK_VALIDATE_ONLY === 'true',
    max_attempts: _envInt('PZ_ADSSINK_MAX_ATTEMPTS', 6), poll_deadline_ms: _envInt('PZ_ADSSINK_POLL_DEADLINE_MS', 86_400_000),
    map_valid: map.isValid(), map_errors: map.getErrors().slice(0, 10), map_index: map.getIndexStats(),
    counters: { ...counters }, consent: ConsentResolver.getCounters(), consent_signal_flow_dead: ConsentResolver.isSignalFlowDead(),
  };
}

module.exports = { sendConversion, reprocessOnce, getHealth, _toRfc3339, _backoffMs, _classifyReasons, _markGuarded, VERSION };
