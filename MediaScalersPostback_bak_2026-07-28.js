/**
 * MediaScalersPostback.js
 * Versão: v1.0.1
 * Data: 2026-07-17
 * Nome: MediaScalers (Everflow) S2S Postback Handler
 * Desc: Handler S2S (Server Postback GET) para a rede MediaScalers/Everflow.
 *
 * Alterações v1.0.1 (correções ditadas pelo ARCHITECT na revisão):
 * - Export renomeado para handleGet (contrato do PostbackRouter); handle mantido como alias.
 * - GA4 passa a ser aguardado (await) para capturar rejeições assíncronas (evita unhandledRejection).
 *
 * Contexto:
 * - O checkout MediaScalers é 100% FRONTEND (CTA da presell/lander -> tracking link
 *   clickrtrckr.com + subs client-side -> redirect). NÃO há adapter: o handler é o
 *   único backend MediaScalers e é INDEPENDENTE de qualquer adapter/loader CSV.
 * - Everflow dispara o postback via GET real (Specific Conversion Postback, NÃO Global).
 *
 * Aprovação: ARCHITECT (PLANO v5 / delta sobre v4) — APROVADO em 2026-07-17.
 *
 * Mapeamento dos Sub IDs (montados no frontend; podem vir vazios -> tolerar ausência):
 *   sub1 = user_id      sub2 = gclid        sub3 = fbclid       sub4 = anon_id
 *   sub5 = cid (DORMENTE — _ga client_id ainda não capturado; item 9 à parte)
 *   sub6 = campaignkey  sub7 = utm_source   sub8 = utm_medium
 *   sub9 = utm_campaign sub10 = utm_term
 *
 * Padrão de sinks: idêntico a DigistorePostback/ClickbankPostback (FirebaseSink,
 * DailyFactsSink, Ga4Sink — todos best-effort, nunca bloqueiam a resposta 200).
 *
 * NOTA (valor GA4): value_basis='affiliate_payout' e payout_amount/sale_amount ficam
 * explícitos no canônico. O Ga4Sink atual usa gross_amount; aqui gross_amount recebe o
 * sale_amount (venda) para preservar o contrato. Enquanto o Ga4Sink não for atualizado
 * para honrar value_basis (trabalho do bundle CB #9), o GA4 reportará o valor de venda.
 */

const FirebaseSink = require('./FirebaseSink');
const Ga4Sink = require('./Ga4Sink');
const DailyFactsSink = require('./DailyFactsSink');

// Segredo compartilhado configurado no Everflow (?ms_token=...) e no Railway.
const EXPECTED_MS_TOKEN = process.env.MEDIASCALERS_S2S_TOKEN || '';

/**
 * Retorna o primeiro valor não vazio.
 * @param  {...any} values
 * @returns {any|null}
 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
}

/**
 * Parser de data do Everflow (macro {datetime}) com UTC explícito.
 * Aceita:
 * - unix timestamp (segundos ou milissegundos)
 * - "YYYY-MM-DD HH:MM:SS" (assume UTC)
 * - ISO 8601
 * Fallback: data/hora atual.
 * @param {string|number} value
 * @returns {string} ISO 8601
 */
function parseEverflowDate(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return new Date().toISOString();
  }

  const str = String(value).trim();

  // Unix timestamp puramente numérico
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    // 13 dígitos ~ ms; 10 dígitos ~ s
    const ms = str.length >= 13 ? num : num * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  // "YYYY-MM-DD HH:MM:SS" -> força UTC
  try {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)
      ? str.replace(' ', 'T') + 'Z'
      : str;
    const d = new Date(normalized);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch (_) {
    // segue para fallback
  }

  return new Date().toISOString();
}

/**
 * Mapeia o tipo de evento. O Specific Conversion Postback dispara na conversão
 * (valid_cc_submit) => 'purchase'. Tolera event_type explícito para refund/chargeback.
 * @param {string} raw
 * @returns {string}
 */
function mapEventType(raw) {
  const t = String(raw || '').toLowerCase();
  switch (t) {
    case 'refund':
    case 'rfnd':
      return 'refund';
    case 'chargeback':
    case 'cgbk':
      return 'chargeback';
    default:
      return 'purchase';
  }
}

/**
 * Processa o postback (GET) do MediaScalers/Everflow.
 * @param {object} req - Objeto de requisição do Express.
 * @param {object} res - Objeto de resposta do Express.
 */
async function handleGet(req, res) {
  // 1. Validação de configuração
  if (!EXPECTED_MS_TOKEN) {
    console.error('[MediaScalersPostback] ERRO CRÍTICO: MEDIASCALERS_S2S_TOKEN não configurada.');
    return res.status(500).send('Internal Server Configuration Error');
  }

  const query = req.query || {};

  // 2. Validação de segurança (token compartilhado)
  const receivedToken = query.ms_token || '';
  if (receivedToken !== EXPECTED_MS_TOKEN) {
    // Segurança: não loga o token recebido
    console.warn('[MediaScalersPostback] Tentativa de postback com ms_token inválido.');
    return res.status(403).send('Unauthorized');
  }

  // 3. Normalização (canônico)
  const canonical = {};
  try {
    // Chave idempotente: conversion_id preferencial; fallback transaction_id.
    const txId = firstNonEmpty(query.conversion_id, query.transaction_id);
    if (!txId) {
      console.error('[MediaScalersPostback] Payload sem conversion_id/transaction_id.');
      return res.status(422).send('Unprocessable Entity (missing conversion_id/transaction_id)');
    }

    // Valores: payout (comissão) e sale (venda) separados.
    const payout = parseFloat(firstNonEmpty(query.payout_amount, query.payout, '0'));
    const sale = parseFloat(firstNonEmpty(query.sale_amount, query.revenue, query.amount, '0'));

    canonical.platform = 'mediascalers';
    canonical.event_type = mapEventType(query.event_type || query.event);
    canonical.conversion_type = 'valid_cc_submit';
    canonical.tx_id = txId;
    canonical.event_id = txId; // alias canônico adicional
    canonical.conversion_id = firstNonEmpty(query.conversion_id) || null;
    canonical.click_id = firstNonEmpty(query.transaction_id) || null;
    canonical.order_id = firstNonEmpty(query.order_id, txId);

    canonical.offer_id = firstNonEmpty(query.offer_id) || null;
    canonical.product_id = firstNonEmpty(query.offer_id) || 'N/A';
    canonical.sku = firstNonEmpty(query.offer_id) || 'N/A';
    canonical.product_name = firstNonEmpty(query.offer_name) || 'N/A';
    canonical.status = String(query.event_type || query.event || 'valid_cc_submit').toLowerCase();

    // Contrato de valores
    canonical.payout_amount = Number.isFinite(payout) ? payout : 0;
    canonical.sale_amount = Number.isFinite(sale) ? sale : 0;
    canonical.gross_amount = Number.isFinite(sale) ? sale : 0; // contrato: gross = venda
    canonical.value_basis = 'affiliate_payout';
    canonical.currency = firstNonEmpty(query.offer_currency, query.currency, 'USD');

    // Chaves de atribuição — Sub IDs (tolerantes a ausência).
    canonical.user_id = firstNonEmpty(query.sub1) || null;
    canonical.gclid = firstNonEmpty(query.sub2) || null;
    canonical.fbclid = firstNonEmpty(query.sub3) || null;
    canonical.anon_id = firstNonEmpty(query.sub4) || null;
    canonical.cid = firstNonEmpty(query.sub5) || null; // DORMENTE (item 9)
    canonical.campaignkey = firstNonEmpty(query.sub6) || null;
    canonical.utm_source = firstNonEmpty(query.sub7) || null;
    canonical.utm_medium = firstNonEmpty(query.sub8) || null;
    canonical.utm_campaign = firstNonEmpty(query.sub9) || null;
    canonical.utm_term = firstNonEmpty(query.sub10) || null;

    canonical.event_time_iso = parseEverflowDate(
      firstNonEmpty(query.event_time, query.datetime, query.timestamp)
    );

    // Segurança: remove o token antes de persistir o raw.
    const { ms_token, ...safeRaw } = query;
    canonical.raw = safeRaw;
  } catch (parseError) {
    console.error('[MediaScalersPostback] Falha ao normalizar o payload:', parseError.message);
    return res.status(200).send('OK (parse error)');
  }

  // 4. Disparo para os "Sinks" (best-effort, nunca bloqueiam o 200)

  // Sink 1: Transações (Raw S2S)
  try {
    await FirebaseSink.saveS2SEvent(canonical);
  } catch (error) {
    console.error(`[MediaScalersPostback] Falha no FirebaseSink (TX: ${canonical.tx_id}):`, error.message);
  }

  // Sink 2: Jornada do Usuário (Daily Facts) — requer anon_id
  try {
    if (canonical.anon_id) {
      await DailyFactsSink.saveS2SEventToDailyFacts(canonical);
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn(`[MediaScalersPostback] Evento S2S sem anon_id. daily_facts pulado. TX: ${canonical.tx_id}`);
    }
  } catch (error) {
    console.error(`[MediaScalersPostback] Falha no DailyFactsSink (TX: ${canonical.tx_id}):`, error.message);
  }

  // Sink 3: Google Analytics (somente compra)
  try {
    if (canonical.event_type === 'purchase') {
      await Ga4Sink.sendPurchaseFromCanonical(canonical);
    }
  } catch (error) {
    console.error(`[MediaScalersPostback] Falha ao disparar o Ga4Sink (TX: ${canonical.tx_id}):`, error.message);
  }

  // 5. Responder 200 OK
  return res.status(200).send('OK');
}

module.exports = {
  handleGet,
  handle: handleGet // alias de compatibilidade
};
