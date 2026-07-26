/**
 * PZ Advisors — AdsSink
 * Versão: v2.2.0
 * Data: 2026-07-25
 *
 * MUDANÇA v1.0.0 -> v2.0.0 (plano v8.2, aprovado por ARCHITECT + Gemini):
 *
 * 1. MÁQUINA DE ESTADOS DURÁVEL re-hospedada em `affiliate_transactions`
 *    (sem colecção outbox separada). O v1 tinha um "stale lock" de 10 minutos,
 *    sem backoff, sem limite de tentativas e sem classe de erro — foi REJEITADO.
 *
 * 2. PREDICADO DE CLAIM (aprovado, verbatim):
 *      elegível =
 *        ( (status ausente OU status=pending)
 *          E (ads_next_attempt_at ausente OU ads_next_attempt_at <= now) )
 *        OU ( status=retry     E ads_next_attempt_at <= now )
 *        OU ( status=in_flight E ads_lease_until     <  now )
 *
 *    NÃO elegível, explicitamente:
 *      - uploaded         -> idempotência
 *      - permanent_error  -> terminal
 *      - retry     com ads_next_attempt_at > now  -> backoff por cumprir
 *      - in_flight com ads_lease_until    >= now  -> lease válida de outro worker
 *
 *    Na recuperação de lease expirada, `ads_attempts` TAMBÉM é incrementado:
 *    uma lease perdida conta como tentativa e consome o limite. Sem isto, um
 *    worker que morre em loop reclama para sempre.
 *
 * 3. partial_failure — semântica corrigida (erro meu na v8.1, apanhado em revisão):
 *      - `partial_failure` é campo do REQUEST e é OBRIGATÓRIO a true.
 *      - `partial_failure_error` é campo da RESPONSE, do tipo google.rpc.Status.
 *      - HTTP 200 NÃO é sucesso. Só se marca `uploaded` quando a operação
 *        correspondente aparece em `results` SEM erro no seu índice.
 *      - `validate_only` é uma flag SEPARADA do request (fase F4).
 *
 * 4. Invariante merge-only: qualquer escrita neste documento usa merge:true.
 *    Nenhum caminho fora do AdsSink escreve campos `ads_*`.
 *
 * MUDANÇA v2.1.0 -> v2.2.0 (2ª revisão ARCHITECT — 3 defeitos):
 *
 * 1. CUSTOMER DO UPLOAD. O endpoint usava PZ_ADS_CUSTOMER_ID (conta operacional)
 *    enquanto o resource name da acção usava a MCC proprietária. Em cross-account
 *    conversion tracking o upload tem de ir para o conversion tracking customer.
 *    Verificado na documentação: google_ads_conversion_customer "indicates the
 *    Google Ads account that creates and manages conversions for this customer.
 *    For customers using cross-account conversion tracking, this is the ID of a
 *    manager account." Implementado _resolveConversionCustomerId(), com o
 *    preflight GAQL que o plano v5 declarava e nunca existiu, mais uma invariante
 *    dura: endpoint != dono do resource name => EC_CONFIG.
 *
 * 2. ALLOWLIST DE DUPLICADOS. Era `.some()`: um código "already exists" ao lado
 *    de um erro real dava o request inteiro como sucesso e o erro desaparecia.
 *    Passa a `codes.length > 0 && codes.every(...)`.
 *
 * 3. _mark() ENGOLIA FALHAS DO FIRESTORE. O Google aceitava, a escrita falhava em
 *    silêncio e sendConversion() devolvia sent:true. Agora propaga; contadores e
 *    confirmação ao chamador só depois de persistência bem-sucedida; o log do erro
 *    passa a vir antes da escrita.
 *
 * MUDANÇA v2.0.0 -> v2.1.0 (revisão de código ARCHITECT — 4 bloqueadores):
 *
 * A. DUPLICADOS. A allowlist da v2.0.0 estava errada. DUPLICATE_ORDER_ID e
 *    DUPLICATE_CLICK_CONVERSION_IN_REQUEST descrevem colisões DENTRO do mesmo
 *    request e o evento NÃO é processado — marcá-los `uploaded` perdia a
 *    conversão em silêncio. Os códigos que significam "o Google já tem" são
 *    CLICK_CONVERSION_ALREADY_EXISTS e ORDER_ID_ALREADY_IN_USE (este último
 *    acrescentado por mim: é exactamente o que uma repetição por lease expirada
 *    produz num sistema que envia orderId, como o nosso). Os dois DUPLICATE_*
 *    passam a erro de configuração — são impossíveis com 1 conversão/request.
 *
 * B. VALOR. `from_transaction` lia gross_amount e degradava ausência para 0.
 *    Somos afiliados: a receita é a COMISSÃO. Passa a commission_amount +
 *    commission_currency, fail-closed. Ver _resolveValue().
 *
 * C. validate_only já não devolve o documento a `pending`. Estado novo
 *    `validated`, não reclamável enquanto o dry-run estiver ligado; ao desligar,
 *    o documento é libertado e ads_attempts é ZERADO. Antes, cada ciclo de
 *    dry-run gastava uma tentativa até matar o documento em permanent_error.
 *
 * D. (no ConvMapLoaderCsv) duplicados de chave e fixed_value/currency.
 *
 * Princípios (não negociáveis, herdados da v1):
 * 1. NUNCA lança para o chamador. O postback responde 200 ao DS24 mesmo com o
 *    Google Ads em baixo. Falha do AdsSink != falha do postback.
 * 2. FAIL-CLOSED. Mapa inválido, flag off, sem gclid, sem acção → no-op registado.
 * 3. IDEMPOTENTE. Estado no próprio documento, reservado por transacção Firestore.
 *    Redundância: `orderId` enviado ao Google, que também deduplica do lado dele.
 * 4. SEM REGRA DE NEGÓCIO NO CÓDIGO. Acção, valor e consentimento vêm do CSV.
 *
 * Implementação HTTP: REST + google-auth-library + axios, ambos JÁ dependências
 * do backend. Deliberadamente NÃO se adiciona google-ads-api (~40 MB + gerador
 * gRPC para uma única chamada).
 *
 * Variáveis de ambiente (NOMES; valores só no Railway):
 *   PZ_ADSSINK_ENABLED                   'true' liga o envio. Default: desligado.
 *   PZ_ADSSINK_VALIDATE_ONLY             'true' → validateOnly (dry-run, F4).
 *   PZ_ADS_CUSTOMER_ID                   conta operacional, só dígitos. NÃO é o
 *                                        alvo do upload; serve para o preflight.
 *   PZ_ADS_LOGIN_CUSTOMER_ID             MCC, só dígitos (header login-customer-id).
 *   PZ_ADS_CONVERSION_ACTION_CUSTOMER_ID conversion tracking customer / dono das
 *                                        acções (MCC 440-410-8297). É ESTE que vai
 *                                        no endpoint E no resource name. Sem fallback.
 *   PZ_ADSSINK_SKIP_CONV_CUSTOMER_PREFLIGHT  'true' salta a confirmação via API.
 *   PZ_ADS_DEVELOPER_TOKEN
 *   PZ_ADS_CLIENT_ID
 *   PZ_ADS_CLIENT_SECRET
 *   PZ_ADS_REFRESH_TOKEN
 *   PZ_ADS_API_VERSION                   default 'v21'
 *   PZ_ADS_ACCOUNT_TZ_OFFSET             ex.: '+00:00'. Deve IGUALAR o fuso da conta.
 *   PZ_ADSSINK_HTTP_TIMEOUT_MS           default 10000
 *   PZ_ADSSINK_MAX_ATTEMPTS              default 6. Excedido → permanent_error + alarme.
 *   PZ_ADSSINK_LEASE_MS                  default 120000 (2 min).
 *   PZ_ADSSINK_BACKOFF_BASE_MS           default 60000 (1 min).
 *   PZ_ADSSINK_BACKOFF_MAX_MS            default 3600000 (1 h).
 */

const axios = require('axios');
const { UserRefreshClient } = require('google-auth-library');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');

const ConvMapLoaderCsv = require('./ConvMapLoaderCsv');
const ConsentResolver = require('./ConsentResolver');

const VERSION = '2.2.0';
const LOG = `[AdsSink v${VERSION}]`;
const COLLECTION_NAME = process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions';

// Estados da máquina durável.
const ST_PENDING = 'pending';
const ST_IN_FLIGHT = 'in_flight';
const ST_UPLOADED = 'uploaded';
// CORRECÇÃO v2.1.0: estado terminal ENQUANTO o dry-run estiver ligado. Ver _claim().
const ST_VALIDATED = 'validated';
const ST_RETRY = 'retry';
const ST_PERMANENT = 'permanent_error';

// Classes de erro.
const EC_TRANSIENT = 'transient';
const EC_PERMANENT = 'permanent';
const EC_CONFIG = 'config';

// Contadores de observabilidade — o risco maior desta fase é o silêncio.
const counters = {
  claimed: 0,
  uploaded: 0,
  retry_scheduled: 0,
  permanent_errors: 0,
  lease_recovered: 0,
  attempts_exhausted: 0,
  partial_failures: 0,
  duplicate_ignored: 0,
  validate_only_runs: 0,
  // v2.2.0
  state_write_failures: 0,
  conv_customer_preflights: 0,
  conv_customer_mismatch: 0,
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
  if (!client) {
    const e = new Error('oauth_credentials_missing');
    e.errorClass = EC_CONFIG;
    throw e;
  }

  const { token, res } = await client.getAccessToken();
  if (!token) {
    const e = new Error('oauth_no_token');
    e.errorClass = EC_CONFIG;
    throw e;
  }

  _accessToken = token;
  const expiresIn = Number(res?.data?.expires_in || 3300);
  _accessTokenExpiry = now + expiresIn * 1000;
  return _accessToken;
}

// ------------------------------------------------------------------- Helpers

function _digits(v) {
  return String(v ?? '').replace(/\D+/g, '');
}

function _envInt(name, dflt) {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Converte ISO-8601 para o formato exigido pelo Google Ads:
 *   'yyyy-mm-dd HH:mm:ss+|-HH:mm'
 * O offset NÃO é derivado do servidor (lição do DailyFactsSink, que gravava
 * tz_offset: 0 e deslocava a data). Vem de PZ_ADS_ACCOUNT_TZ_OFFSET e deve
 * igualar o fuso configurado na conta Google Ads.
 */
function _toAdsDateTime(isoString) {
  const offset = String(process.env.PZ_ADS_ACCOUNT_TZ_OFFSET || '+00:00').trim();
  if (!/^[+-]\d{2}:\d{2}$/.test(offset)) throw new Error(`tz_offset_invalido: "${offset}"`);

  const d = new Date(isoString);
  if (!Number.isFinite(d.getTime())) throw new Error(`event_time_invalido: "${isoString}"`);

  const sign = offset[0] === '-' ? -1 : 1;
  const offMin = sign * (parseInt(offset.slice(1, 3), 10) * 60 + parseInt(offset.slice(4, 6), 10));

  const shifted = new Date(d.getTime() + offMin * 60_000);
  const p = (n) => String(n).padStart(2, '0');

  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}${offset}`
  );
}

function _docIdFor(tx) {
  const safePlatform = String(tx.platform).replace(/[^\w\-]+/g, '_');
  const safeTxId = String(tx.tx_id).replace(/[^\w\-]+/g, '_');
  return `${safePlatform}_${safeTxId}`;
}

/**
 * Resolve o valor a enviar no ClickConversion.
 *
 * CORRECÇÃO v2.1.0 (revisão ARCHITECT). A versão anterior lia tx.gross_amount e
 * degradava ausência para 0. Duas coisas erradas de uma vez:
 *   1. O bruto NÃO é a nossa receita. Somos afiliados: a receita é a COMISSÃO.
 *      Alimentar o Smart Bidding com o bruto infla o ROAS por um factor igual à
 *      taxa de comissão e faz o motor licitar sobre um número que não existe.
 *   2. Degradar para 0 é pior do que falhar: uma conversão de valor 0 ensina
 *      activamente o modelo que aquele clique não vale nada.
 *
 * Regra nova: fail-closed sempre. Sem comissão válida não há envio — erro de
 * configuração, não de dados. Fica visível no ads_last_error e no alarme.
 *
 * NOTA DE SEQUÊNCIA: o DigistorePostback NÃO grava hoje commission_amount
 * (verificado em código — só grava gross_amount na linha 72). Enquanto o passo 4
 * do plano não o acrescentar, toda a linha com value_mode=from_transaction cai
 * em permanent_error. É deliberado: é preferível não enviar nada a enviar o bruto.
 *
 * @throws {Error & {errorClass:string}}
 */
function _resolveValue(tx, mapRow) {
  const fail = (msg) => { const e = new Error(msg); e.errorClass = EC_CONFIG; throw e; };

  if (mapRow.value_mode === 'none') return { value: null, currency: null };

  if (mapRow.value_mode === 'fixed') {
    const v = Number(mapRow.fixed_value);
    if (!Number.isFinite(v) || v <= 0) {
      fail(`value_mode=fixed com fixed_value inválido ("${mapRow.fixed_value}"): exige-se > 0`);
    }
    const cur = String(mapRow.currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) {
      fail(`value_mode=fixed sem currency explícita no CSV (recebido "${mapRow.currency}")`);
    }
    return { value: v, currency: cur };
  }

  // from_transaction → COMISSÃO do afiliado. Nunca o bruto, nunca um fallback.
  const v = Number(tx.commission_amount);
  if (!Number.isFinite(v) || v <= 0) {
    fail(
      `value_mode=from_transaction mas commission_amount ausente/inválido ` +
      `("${tx.commission_amount}"). Proibido substituir por gross_amount.`
    );
  }
  const cur = String(tx.commission_currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) {
    fail(
      `value_mode=from_transaction mas commission_currency ausente/inválida ` +
      `("${tx.commission_currency}"). Moeda não é adivinhável.`
    );
  }
  return { value: v, currency: cur };
}

/** Backoff exponencial truncado: BASE * 2^(attempts-1), limitado a MAX. */
function _backoffMs(attempts) {
  const base = _envInt('PZ_ADSSINK_BACKOFF_BASE_MS', 60_000);
  const max = _envInt('PZ_ADSSINK_BACKOFF_MAX_MS', 3_600_000);
  const n = Math.max(1, Number(attempts) || 1);
  const raw = base * Math.pow(2, n - 1);
  return Math.min(raw, max);
}

function _millis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  const n = Number(ts);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------- Claim (transacção Firestore)

/**
 * Reserva o direito de enviar esta transacção, aplicando o predicado aprovado.
 * Toda a decisão corre DENTRO da transacção Firestore — nunca lida fora e
 * escrita depois.
 *
 * @returns {Promise<{ok:boolean, reason?:string, attempts?:number, data?:object, recoveredLease?:boolean}>}
 */
async function _claim(docRef) {
  const db = getFirestore();
  const leaseMs = _envInt('PZ_ADSSINK_LEASE_MS', 120_000);
  const maxAttempts = _envInt('PZ_ADSSINK_MAX_ATTEMPTS', 6);

  return db.runTransaction(async (t) => {
    const snap = await t.get(docRef);
    if (!snap.exists) return { ok: false, reason: 'doc_inexistente' };

    const data = snap.data() || {};
    const status = data.ads_upload_status || null;
    const now = Date.now();

    const nextAttemptMs = _millis(data.ads_next_attempt_at);
    const leaseUntilMs = _millis(data.ads_lease_until);

    let eligible = false;
    let recoveredLease = false;
    let resetAttempts = false;
    const validateOnlyNow = process.env.PZ_ADSSINK_VALIDATE_ONLY === 'true';

    if (!status || status === ST_PENDING) {
      eligible = nextAttemptMs === null || nextAttemptMs <= now;
      if (!eligible) return { ok: false, reason: 'backoff_por_cumprir' };
    } else if (status === ST_RETRY) {
      eligible = nextAttemptMs !== null && nextAttemptMs <= now;
      if (!eligible) return { ok: false, reason: 'backoff_por_cumprir' };
    } else if (status === ST_IN_FLIGHT) {
      // Lease ausente é tratada como expirada: documento escrito por uma versão
      // anterior do sink, ou escrita parcial. Não se assume lease infinita.
      eligible = leaseUntilMs === null || leaseUntilMs < now;
      if (!eligible) return { ok: false, reason: 'lease_valida_noutro_worker' };
      recoveredLease = true;
    } else if (status === ST_UPLOADED) {
      return { ok: false, reason: 'ja_enviado' };
    } else if (status === ST_VALIDATED) {
      // CORRECÇÃO v2.1.0 (revisão ARCHITECT). Antes, o dry-run devolvia o
      // documento a `pending` mantendo o ads_attempts incrementado — o
      // reprocessador reclamava-o outra vez a cada ciclo até esgotar o limite e
      // marcar permanent_error um documento que nunca teve problema nenhum.
      //
      // Agora: validado com dry-run LIGADO → não reclamável (nada mais há a
      // aprender de o revalidar). Dry-run DESLIGADO → reclamável, e o contador
      // de tentativas é ZERADO, porque as tentativas gastas foram validações,
      // não envios. O envio real começa com o orçamento intacto.
      if (validateOnlyNow) return { ok: false, reason: 'ja_validado_em_dry_run' };
      resetAttempts = true;
    } else if (status === ST_PERMANENT) {
      return { ok: false, reason: 'erro_permanente_terminal' };
    } else {
      return { ok: false, reason: `status_desconhecido:${status}` };
    }

    // Lease perdida CONSOME tentativa — igual a qualquer outra tentativa.
    // Excepção: transição validated → envio real reinicia o orçamento (ver acima).
    const attempts = resetAttempts ? 1 : Number(data.ads_attempts || 0) + 1;

    if (attempts > maxAttempts) {
      t.set(docRef, {
        ads_upload_status: ST_PERMANENT,
        ads_attempts: attempts,
        ads_error_class: EC_PERMANENT,
        ads_last_error: `max_attempts_excedido (${attempts} > ${maxAttempts})`,
        ads_lease_until: FieldValue.delete(),
        ads_next_attempt_at: FieldValue.delete(),
        ads_sink_version: VERSION,
      }, { merge: true });
      return { ok: false, reason: 'max_attempts_excedido', attempts };
    }

    t.set(docRef, {
      ads_upload_status: ST_IN_FLIGHT,
      ads_attempts: attempts,
      ads_lease_until: Timestamp.fromMillis(now + leaseMs),
      ads_sink_version: VERSION,
    }, { merge: true });

    return { ok: true, attempts, data, recoveredLease };
  });
}

/**
 * Escrita de estado. SEMPRE merge:true — invariante merge-only do plano v8.2.
 *
 * CORRECÇÃO v2.2.0 (revisão ARCHITECT, defeito 3). Esta função ENGOLIA a falha
 * do Firestore. Consequência: o Google aceitava a conversão, a escrita de
 * `uploaded` falhava em silêncio e sendConversion() devolvia sent:true — a
 * máquina durável ficava a mentir e o documento permanecia in_flight sem que
 * ninguém soubesse. Agora propaga.
 *
 * Propagar é seguro e auto-curativo: o throw sobe ao catch externo, que
 * deliberadamente não escreve; a lease expira, o item é reclamado outra vez e o
 * reenvio devolve ORDER_ID_ALREADY_IN_USE, tratado como duplicado/uploaded.
 * Nunca se confirma `uploaded`/`validated` ao chamador sem persistência.
 */
async function _mark(docRef, patch) {
  try {
    await docRef.set({ ...patch, ads_state_updated_at: FieldValue.serverTimestamp() }, { merge: true });
  } catch (e) {
    counters.state_write_failures++;
    console.error(`${LOG} ALARME: falha ao persistir estado no Firestore:`, e?.message || e);
    const err = new Error(`firestore_state_write_failed: ${e?.message || e}`);
    err.errorClass = EC_TRANSIENT;
    err.isStateWriteFailure = true;
    throw err;
  }
}

// --------------------------------------------------- Classificação de erros

// Códigos de erro da Google Ads API que valem repetição. Tudo o resto que chega
// como partial failure é problema de dados/configuração: repetir só queima quota.
const TRANSIENT_CODES = new Set([
  'INTERNAL_ERROR',
  'TRANSIENT_ERROR',
  'DEADLINE_EXCEEDED',
  'RESOURCE_TEMPORARILY_EXHAUSTED',
  'RESOURCE_EXHAUSTED',
  'CONCURRENT_MODIFICATION',
]);

// CORRECÇÃO v2.1.0 (revisão ARCHITECT). A allowlist anterior estava errada:
// DUPLICATE_ORDER_ID e DUPLICATE_CLICK_CONVERSION_IN_REQUEST descrevem colisões
// DENTRO DO MESMO REQUEST e o evento NÃO é processado — tratá-los como sucesso
// perdia a conversão em silêncio.
//
// Verificado na documentação da API (ConversionUploadError):
//   CLICK_CONVERSION_ALREADY_EXISTS (23) — "same click and conversion_date_time
//     as an existing conversion" → o Google JÁ TEM. Idempotência a funcionar.
//   ORDER_ID_ALREADY_IN_USE (15) — "order ID that was previously recorded, so the
//     event was not processed" → o Google JÁ TEM (de um envio anterior nosso).
//     É EXACTAMENTE o que uma repetição por lease expirada produz.
//   DUPLICATE_ORDER_ID (16) — "multiple conversions with the same order ID [no
//     mesmo request] and were not processed" → bug de implementação.
//   DUPLICATE_CLICK_CONVERSION_IN_REQUEST (25) — idem → bug de implementação.
//
// Enviamos UMA conversão por request, portanto os dois últimos são impossíveis
// por construção: se aparecerem, é defeito nosso e tem de gritar, não passar.
const ALREADY_EXISTS_CODES = new Set([
  'CLICK_CONVERSION_ALREADY_EXISTS',
  'ORDER_ID_ALREADY_IN_USE',
]);

const IN_REQUEST_DUPLICATE_CODES = new Set([
  'DUPLICATE_ORDER_ID',
  'DUPLICATE_CLICK_CONVERSION_IN_REQUEST',
]);

/**
 * Extrai os códigos de erro de um google.rpc.Status vindo em partialFailureError.
 * Estrutura: status.details[] -> GoogleAdsFailure -> errors[] -> errorCode{...}
 */
function _extractGoogleAdsErrorCodes(partialFailureError) {
  const out = [];
  const details = Array.isArray(partialFailureError?.details) ? partialFailureError.details : [];
  for (const d of details) {
    const errs = Array.isArray(d?.errors) ? d.errors : [];
    for (const e of errs) {
      const codeObj = e?.errorCode || {};
      for (const k of Object.keys(codeObj)) {
        const v = codeObj[k];
        if (typeof v === 'string' && v) out.push(v);
      }
      if (!Object.keys(codeObj).length && e?.message) out.push(String(e.message).slice(0, 120));
    }
  }
  return out;
}

function _classifyHttp(status) {
  if (status === 429 || status >= 500) return EC_TRANSIENT;
  if (status === 401 || status === 403) return EC_CONFIG;
  return EC_PERMANENT;
}

// ------------------------------------------------------------------- Upload

/**
 * Envia UMA ClickConversion.
 *
 * partial_failure=true é OBRIGATÓRIO no request — a API rejeita o request se for
 * false quando há operações que podem falhar individualmente.
 *
 * @returns {Promise<{validateOnly:boolean, uploaded:boolean, duplicate:boolean, result?:object}>}
 * @throws  {Error & {errorClass:string}}
 */
// ------------------------------------------- Conversion tracking customer (v2.2.0)

// Cache do preflight. TTL longo: a definição de cross-account tracking muda em
// escala de meses, não de minutos.
let _convCustomer = { id: null, at: 0 };
const CONV_CUSTOMER_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Resolve o cliente ao qual o upload tem de ser dirigido.
 *
 * Documentado pela Google: `customer.conversion_tracking_setting.
 * google_ads_conversion_customer` "indicates the Google Ads account that creates
 * and manages conversions for this customer. For customers using cross-account
 * conversion tracking, this is the ID of a manager account." É esse ID — e não o
 * da conta operacional — que vai no endpoint E no resource name da acção.
 *
 * O preflight (declarado no plano v5 e nunca implementado até aqui) confirma
 * contra a API que o valor configurado é de facto o conversion customer da conta
 * operacional. Divergência é EC_CONFIG: fail-closed, não se adivinha.
 *
 * @returns {Promise<string>} só dígitos
 */
async function _resolveConversionCustomerId() {
  const configured = _digits(process.env.PZ_ADS_CONVERSION_ACTION_CUSTOMER_ID);
  if (!configured) {
    const e = new Error(
      'PZ_ADS_CONVERSION_ACTION_CUSTOMER_ID em falta. É o conversion tracking ' +
      'customer (MCC proprietária das acções) e não tem fallback: usar a conta ' +
      'operacional devolveria NOT_FOUND ou escreveria na conta errada.'
    );
    e.errorClass = EC_CONFIG;
    throw e;
  }

  if (process.env.PZ_ADSSINK_SKIP_CONV_CUSTOMER_PREFLIGHT === 'true') return configured;
  if (_convCustomer.id === configured && Date.now() - _convCustomer.at < CONV_CUSTOMER_TTL_MS) {
    return configured;
  }

  const operating = _digits(process.env.PZ_ADS_CUSTOMER_ID);
  if (!operating) {
    const e = new Error('PZ_ADS_CUSTOMER_ID em falta (necessário para o preflight do conversion customer)');
    e.errorClass = EC_CONFIG;
    throw e;
  }

  const version = process.env.PZ_ADS_API_VERSION || 'v21';
  const devToken = process.env.PZ_ADS_DEVELOPER_TOKEN;
  if (!devToken) { const e = new Error('PZ_ADS_DEVELOPER_TOKEN em falta'); e.errorClass = EC_CONFIG; throw e; }

  const token = await _getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': devToken,
    'Content-Type': 'application/json',
  };
  const loginCustomerId = _digits(process.env.PZ_ADS_LOGIN_CUSTOMER_ID);
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

  const url = `https://googleads.googleapis.com/${version}/customers/${operating}/googleAds:search`;
  const body = {
    query:
      'SELECT customer.id, ' +
      'customer.conversion_tracking_setting.google_ads_conversion_customer ' +
      'FROM customer LIMIT 1',
  };

  counters.conv_customer_preflights++;

  let res;
  try {
    res = await axios.post(url, body, {
      headers,
      timeout: _envInt('PZ_ADSSINK_HTTP_TIMEOUT_MS', 10_000),
      validateStatus: () => true,
    });
  } catch (netErr) {
    // Rede: transiente. Não se degrada para "assume o configurado" — isso
    // reintroduziria em silêncio o defeito que este preflight existe para apanhar.
    const e = new Error(`preflight_network_error: ${netErr?.code || netErr?.message || netErr}`);
    e.errorClass = EC_TRANSIENT;
    throw e;
  }

  if (res.status !== 200) {
    const detail = typeof res.data === 'object'
      ? JSON.stringify(res.data).slice(0, 600)
      : String(res.data).slice(0, 600);
    const e = new Error(`preflight_http_${res.status}: ${detail}`);
    e.errorClass = _classifyHttp(res.status);
    throw e;
  }

  const rows = Array.isArray(res.data?.results) ? res.data.results : [];
  const raw = rows[0]?.customer?.conversionTrackingSetting?.googleAdsConversionCustomer;
  const live = _digits(String(raw || '').split('/').pop());

  if (!live) {
    const e = new Error(
      'preflight: conversion_tracking_setting.google_ads_conversion_customer ausente ' +
      'na resposta. Sem confirmação, não se envia.'
    );
    e.errorClass = EC_CONFIG;
    throw e;
  }

  if (live !== configured) {
    counters.conv_customer_mismatch++;
    const e = new Error(
      `preflight_divergencia: a conta ${operating} declara conversion customer ${live}, ` +
      `mas PZ_ADS_CONVERSION_ACTION_CUSTOMER_ID=${configured}. Corrigir a variável ` +
      `(ou o cross-account tracking) antes de enviar seja o que for.`
    );
    e.errorClass = EC_CONFIG;
    throw e;
  }

  _convCustomer = { id: configured, at: Date.now() };
  console.log(`${LOG} preflight OK: conversion customer ${configured} confirmado pela API.`);
  return configured;
}

async function _uploadClickConversion(clickConversion, conversionCustomerId) {
  const version = process.env.PZ_ADS_API_VERSION || 'v21';
  const loginCustomerId = _digits(process.env.PZ_ADS_LOGIN_CUSTOMER_ID);
  const devToken = process.env.PZ_ADS_DEVELOPER_TOKEN;

  // CORRECÇÃO v2.2.0 (revisão ARCHITECT, defeito 1). O endpoint usava
  // PZ_ADS_CUSTOMER_ID (conta operacional 105-791-2552) enquanto o resource name
  // da acção usava a MCC proprietária. Em cross-account conversion tracking o
  // upload tem de ser dirigido ao CONVERSION TRACKING CUSTOMER — o mesmo ID nos
  // dois sítios. Ver _resolveConversionCustomerId().
  if (!conversionCustomerId) {
    const e = new Error('conversionCustomerId não resolvido (defeito interno)');
    e.errorClass = EC_CONFIG;
    throw e;
  }
  if (!devToken) { const e = new Error('PZ_ADS_DEVELOPER_TOKEN em falta'); e.errorClass = EC_CONFIG; throw e; }

  // Invariante dura: o resource name e o endpoint TÊM de referir o mesmo cliente.
  const owner = String(clickConversion.conversionAction || '').split('/')[1];
  if (owner !== conversionCustomerId) {
    const e = new Error(
      `divergencia_customer: endpoint=${conversionCustomerId} mas conversionAction pertence a ${owner}`
    );
    e.errorClass = EC_CONFIG;
    throw e;
  }

  const token = await _getAccessToken();
  const url = `https://googleads.googleapis.com/${version}/customers/${conversionCustomerId}:uploadClickConversions`;

  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': devToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

  const validateOnly = process.env.PZ_ADSSINK_VALIDATE_ONLY === 'true';

  const body = {
    conversions: [clickConversion],
    // REQUEST: obrigatório true. Sem isto a API rejeita o request inteiro.
    partialFailure: true,
    // Flag SEPARADA. Fase F4 (staging) corre com true.
    validateOnly,
  };

  const timeout = _envInt('PZ_ADSSINK_HTTP_TIMEOUT_MS', 10_000);

  let res;
  try {
    res = await axios.post(url, body, { headers, timeout, validateStatus: () => true });
  } catch (netErr) {
    // Timeout / DNS / socket: transiente por definição.
    const e = new Error(`network_error: ${netErr?.code || netErr?.message || netErr}`);
    e.errorClass = EC_TRANSIENT;
    throw e;
  }

  if (res.status !== 200) {
    const detail = typeof res.data === 'object'
      ? JSON.stringify(res.data).slice(0, 800)
      : String(res.data).slice(0, 800);
    const e = new Error(`http_${res.status}: ${detail}`);
    e.errorClass = _classifyHttp(res.status);
    throw e;
  }

  // ---- HTTP 200 NÃO É SUCESSO. Inspecção obrigatória. ----
  const partial = res.data?.partialFailureError || null;
  const results = Array.isArray(res.data?.results) ? res.data.results : [];

  if (partial) {
    counters.partial_failures++;
    const codes = _extractGoogleAdsErrorCodes(partial);

    // Bug de implementação: um request nosso leva exactamente uma conversão.
    // Verificado ANTES da allowlist para nunca ser mascarado por ela.
    if (codes.some((c) => IN_REQUEST_DUPLICATE_CODES.has(c))) {
      const e = new Error(
        `duplicado_dentro_do_request [${codes.join(',')}] — impossível por construção ` +
        `(1 conversão por request). Defeito de implementação, evento NÃO processado.`
      );
      e.errorClass = EC_CONFIG;
      throw e;
    }

    // CORRECÇÃO v2.2.0 (revisão ARCHITECT, defeito 2). Era `.some()`: bastava um
    // código "already exists" ao lado de um erro real para o request inteiro ser
    // dado como sucesso e o erro real desaparecer. Passa a `.every()` com guarda
    // de lista não vazia — só é duplicado se TUDO o que voltou for duplicado.
    if (codes.length > 0 && codes.every((c) => ALREADY_EXISTS_CODES.has(c))) {
      // O Google já tem esta conversão de um envio anterior. Idempotência a funcionar.
      counters.duplicate_ignored++;
      return { validateOnly, uploaded: true, duplicate: true, result: null };
    }

    const transient = codes.length > 0 && codes.every((c) => TRANSIENT_CODES.has(c));
    const e = new Error(
      `partial_failure_error [${codes.join(',') || 'sem_codigo'}]: ` +
      `${JSON.stringify(partial).slice(0, 700)}`
    );
    e.errorClass = transient ? EC_TRANSIENT : EC_PERMANENT;
    throw e;
  }

  // Sem partialFailureError, mas a operação tem de estar presente em results.
  // Em validateOnly a API NÃO devolve results — é o único caso em que a ausência
  // é legítima.
  const r0 = results[0];
  const hasResult = !!r0 && typeof r0 === 'object' && Object.keys(r0).length > 0;

  if (!validateOnly && !hasResult) {
    const e = new Error('resposta_200_sem_result: operação não confirmada pelo Google');
    e.errorClass = EC_TRANSIENT; // ambíguo → repetir é mais seguro que descartar
    throw e;
  }

  return { validateOnly, uploaded: !validateOnly, duplicate: false, result: r0 || null };
}

// --------------------------------------------------------------- API Pública

/**
 * Envia uma conversão para o Google Ads a partir do evento canónico.
 * NUNCA lança. Devolve sempre um objecto de resultado.
 *
 * @param {object} canonical  evento canónico (mesmo objecto do FirebaseSink)
 * @param {{event_name?:string, page_type?:string}} [opts]
 * @returns {Promise<{sent:boolean, reason:string, detail?:object}>}
 */
async function sendConversion(canonical, opts = {}) {
  const eventName = opts.event_name || canonical?.event_type || 'purchase';
  let docRef = null;

  try {
    // --- Guarda 1: feature-flag ---
    if (process.env.PZ_ADSSINK_ENABLED !== 'true') {
      return { sent: false, reason: 'disabled_by_flag' };
    }

    // --- Guarda 2: evento utilizável ---
    if (!canonical || !canonical.platform || !canonical.tx_id) {
      console.warn(`${LOG} Evento canónico sem platform/tx_id. Ignorado.`);
      return { sent: false, reason: 'evento_invalido' };
    }

    // --- Guarda 3: gclid. Sem gclid não há conversão offline por clique. ---
    const gclid = String(canonical.gclid || '').trim();
    if (!gclid) {
      return { sent: false, reason: 'sem_gclid' };
    }

    // --- Guarda 4: mapa válido (fail-closed) ---
    const map = ConvMapLoaderCsv.getInstance();
    if (!map.isValid()) {
      console.error(`${LOG} pz_conversion_map inválido — no-op. Erros: ${map.getErrors().slice(0, 3).join(' | ')}`);
      return { sent: false, reason: 'mapa_invalido' };
    }

    const mapRow = map.resolve({
      platform: canonical.platform,
      event_name: eventName,
      product_id: canonical.sku || canonical.product_id,
      page_type: opts.page_type || canonical.page_type,
    });
    if (!mapRow) {
      return { sent: false, reason: 'sem_linha_no_mapa' };
    }

    // --- Claim (predicado v8.2) ---
    const db = getFirestore();
    docRef = db.collection(COLLECTION_NAME).doc(_docIdFor(canonical));
    const claim = await _claim(docRef);
    if (!claim.ok) {
      if (claim.reason === 'max_attempts_excedido') {
        counters.attempts_exhausted++;
        counters.permanent_errors++;
        console.error(
          `${LOG} ALARME: tentativas esgotadas para tx=${canonical.tx_id} ` +
          `(${claim.attempts}). Documento marcado permanent_error. Requer intervenção.`
        );
      }
      return { sent: false, reason: claim.reason };
    }

    counters.claimed++;
    if (claim.recoveredLease) {
      counters.lease_recovered++;
      console.warn(
        `${LOG} Lease expirada recuperada para tx=${canonical.tx_id} ` +
        `(tentativa ${claim.attempts}). Worker anterior provavelmente morreu.`
      );
    }

    // --- Consentimento (costura isolada; hoje degenera em fallback) ---
    const consent = ConsentResolver.resolve({ tx: { ...claim.data, ...canonical }, mapRow });

    // --- Envio (a construção entra no try porque _resolveValue e _toAdsDateTime
    //     lançam erros de configuração que TÊM de ser classificados e escritos no
    //     documento; no catch externo perdiam-se e o item ficava a repetir às cegas
    //     até esgotar tentativas) ---
    try {
    // --- Construção do ClickConversion ---
    const { value, currency } = _resolveValue(canonical, mapRow);

    // ATENÇÃO: o resource name da acção de conversão usa o cliente que a POSSUI.
    // Na auditoria de 2026-07-24 todas as acções desta conta são propriedade da
    // MCC 440-410-8297, não da conta operacional 105-791-2552. Usar o customerId
    // errado devolve NOT_FOUND.
    // v2.2.0: resolvido UMA vez, com preflight contra a API, e usado tanto aqui
    // como no endpoint. Sem fallback silencioso para a conta operacional.
    const actionOwnerId = await _resolveConversionCustomerId();

    const clickConversion = {
      gclid,
      conversionAction: `customers/${actionOwnerId}/conversionActions/${mapRow.conversion_action_id}`,
      conversionDateTime: _toAdsDateTime(canonical.event_time_iso || new Date().toISOString()),
      // orderId é a segunda linha de defesa contra duplicados, do lado do Google.
      orderId: String(canonical.order_id || canonical.tx_id),
      consent: {
        adUserData: consent.adUserData,
        adPersonalization: consent.adPersonalization,
      },
    };
    if (value !== null) {
      clickConversion.conversionValue = value;
      clickConversion.currencyCode = currency;
    }

      const out = await _uploadClickConversion(clickConversion, actionOwnerId);

      if (out.validateOnly) {
        // CORRECÇÃO v2.1.0: estado `validated`, não `pending`. Com `pending` o
        // documento era reclamável de imediato no ciclo seguinte, gastando uma
        // tentativa por ciclo até morrer em permanent_error sem nunca ter falhado.
        // `validated` é terminal enquanto o dry-run estiver ligado; ao desligar,
        // _claim() liberta-o e ZERA ads_attempts.
        // v2.2.0: o contador só sobe DEPOIS da persistência confirmada.
        await _mark(docRef, {
          ads_upload_status: ST_VALIDATED,
          ads_lease_until: FieldValue.delete(),
          ads_next_attempt_at: FieldValue.delete(),
          ads_last_validated_at: FieldValue.serverTimestamp(),
          ads_last_error: FieldValue.delete(),
          ads_error_class: FieldValue.delete(),
        });
        counters.validate_only_runs++;
        console.log(`${LOG} VALIDADO (dry-run) tx=${canonical.tx_id} event=${eventName}`);
        return { sent: false, reason: 'validate_only' };
      }

      // v2.2.0: `uploaded` só é contado e confirmado ao chamador DEPOIS de a
      // escrita de estado ter sido persistida com sucesso.
      await _mark(docRef, {
        ads_upload_status: ST_UPLOADED,
        ads_uploaded_at: FieldValue.serverTimestamp(),
        ads_conversion_action_id: mapRow.conversion_action_id,
        ads_event_name: eventName,
        ads_map_kind: mapRow.map_kind,
        ads_duplicate_at_google: !!out.duplicate,
        ads_consent_ad_user_data: consent.adUserData,
        ads_consent_ad_personalization: consent.adPersonalization,
        ads_consent_source: consent.source,
        ads_consent_signal_present: consent.signalPresent,
        ads_lease_until: FieldValue.delete(),
        ads_next_attempt_at: FieldValue.delete(),
        ads_last_error: FieldValue.delete(),
        ads_error_class: FieldValue.delete(),
      });

      counters.uploaded++;
      console.log(
        `${LOG} ENVIADO tx=${canonical.tx_id} event=${eventName} ` +
        `action=${mapRow.conversion_action_id} consent=${consent.source}` +
        (out.duplicate ? ' (duplicado do lado do Google — tratado como sucesso)' : '')
      );

      return { sent: true, reason: out.duplicate ? 'ok_duplicado' : 'ok' };

    } catch (uploadError) {
      const errorClass = uploadError.errorClass || EC_PERMANENT;
      const message = String(uploadError.message || uploadError).slice(0, 900);
      const attempts = claim.attempts;

      // v2.2.0: o log vem ANTES da escrita. Como _mark() já propaga falhas do
      // Firestore, escrever primeiro faria perder o diagnóstico do erro original
      // exactamente no cenário em que ele é mais necessário.
      if (errorClass === EC_TRANSIENT) {
        const delay = _backoffMs(attempts);
        counters.retry_scheduled++;
        console.warn(
          `${LOG} Erro transiente (tx=${canonical.tx_id}, tentativa ${attempts}). ` +
          `Novo envio em ${Math.round(delay / 1000)}s. ${message}`
        );
        await _mark(docRef, {
          ads_upload_status: ST_RETRY,
          ads_next_attempt_at: Timestamp.fromMillis(Date.now() + delay),
          ads_lease_until: FieldValue.delete(),
          ads_last_error: message,
          ads_error_class: errorClass,
        });
      } else {
        // Permanente ou de configuração: terminal IMEDIATO, sem consumir backoff.
        counters.permanent_errors++;
        console.error(
          `${LOG} ALARME: erro ${errorClass} (tx=${canonical.tx_id}). ` +
          `Documento terminal. Requer intervenção. ${message}`
        );
        await _mark(docRef, {
          ads_upload_status: ST_PERMANENT,
          ads_next_attempt_at: FieldValue.delete(),
          ads_lease_until: FieldValue.delete(),
          ads_last_error: message,
          ads_error_class: errorClass,
        });
      }

      return { sent: false, reason: 'erro_upload', detail: { errorClass, message } };
    }

  } catch (fatal) {
    // Rede de segurança final: o postback nunca pode cair por causa do AdsSink.
    // Se já havia claim, a lease expira sozinha e o item é recuperado — não se
    // tenta escrever aqui, porque este ramo cobre justamente falhas do Firestore.
    //
    // v2.2.0: é também aqui que aterram as falhas de persistência propagadas por
    // _mark(). Correcto e auto-curativo: nada é confirmado ao chamador, o
    // documento fica in_flight, a lease expira e o reenvio devolve
    // ORDER_ID_ALREADY_IN_USE — tratado como duplicado/uploaded.
    if (fatal?.isStateWriteFailure) {
      console.error(
        `${LOG} ALARME: conversão possivelmente aceite pelo Google mas estado NÃO ` +
        `persistido. Recuperação por lease expirada + idempotência do orderId.`
      );
    }
    console.error(`${LOG} Erro não tratado:`, fatal?.message || fatal);
    return { sent: false, reason: 'erro_interno', detail: { message: String(fatal?.message || fatal) } };
  }
}

/** Estado do sink para healthcheck / relatório diário. */
function getHealth() {
  const map = ConvMapLoaderCsv.getInstance();
  return {
    version: VERSION,
    enabled: process.env.PZ_ADSSINK_ENABLED === 'true',
    validate_only: process.env.PZ_ADSSINK_VALIDATE_ONLY === 'true',
    max_attempts: _envInt('PZ_ADSSINK_MAX_ATTEMPTS', 6),
    lease_ms: _envInt('PZ_ADSSINK_LEASE_MS', 120_000),
    map_valid: map.isValid(),
    map_errors: map.getErrors().slice(0, 10),
    map_index: map.getIndexStats(),
    counters: { ...counters },
    consent: ConsentResolver.getCounters(),
    consent_signal_flow_dead: ConsentResolver.isSignalFlowDead(),
  };
}

module.exports = { sendConversion, getHealth, _toAdsDateTime, _backoffMs, VERSION };
