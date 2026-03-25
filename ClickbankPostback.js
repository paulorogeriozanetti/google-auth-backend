/**
 * ClickbankPostback.js
 * Versão: v1.0.3
 * Data: 2026-03-25
 * Nome: ClickBank S2S Postback Handler
 * Desc: Handler S2S (webhook) para a plataforma ClickBank.
 *
 * Alterações v1.0.3:
 * - Mantém integralmente a lógica de descriptografia INS 8.0 e os Sinks da v1.0.2.
 * - Adiciona parser robusto para vendorVariables em formato objeto, JSON string ou querystring.
 * - Passa a capturar campaignkey, utm_source, utm_medium, utm_campaign, utm_term, utm_content.
 * - Adiciona fallback de anon_id e user_id via vendorVariables e trackingCodes.
 * - Adiciona captura opcional de dclid e click_timestamp.
 * - Mantém compatibilidade retroativa com tx_id, gross_amount e campos já usados pelos sinks.
 */

const crypto = require('crypto');
const FirebaseSink = require('./FirebaseSink');
const Ga4Sink = require('./Ga4Sink');
const DailyFactsSink = require('./DailyFactsSink');

// Lê o segredo do .env
const WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY || '';

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
 * Converte vendorVariables em um objeto plano.
 * Suporta:
 * - objeto já parseado
 * - string JSON
 * - string querystring (ex: "tid=123&campaignkey=abc")
 * @param {any} input
 * @returns {object}
 */
function toPlainObject(input) {
  if (!input) return {};

  if (typeof input === 'object' && !Array.isArray(input)) {
    return input;
  }

  if (typeof input !== 'string') {
    return {};
  }

  const raw = input.trim();
  if (!raw) return {};

  // Tenta JSON primeiro
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_) {
      // segue para querystring
    }
  }

  // Tenta querystring
  try {
    const params = new URLSearchParams(raw);
    const out = {};
    for (const [key, value] of params.entries()) {
      out[key] = value;
    }
    return out;
  } catch (_) {
    return {};
  }
}

/**
 * Extrai sinais de tracking do array trackingCodes.
 * @param {Array} trackingCodes
 * @returns {object}
 */
function extractTrackingCodes(trackingCodes) {
  return (Array.isArray(trackingCodes) ? trackingCodes : []).reduce((acc, code) => {
    const s = String(
      typeof code === 'string'
        ? code
        : code?.trackingCode || code?.code || code?.value || ''
    );

    if (!s) return acc;

    if (!acc.gclid && s.startsWith('gclid_')) acc.gclid = s.substring(6);
    else if (!acc.fbclid && s.startsWith('fbclid_')) acc.fbclid = s.substring(7);
    else if (!acc.dclid && s.startsWith('dclid_')) acc.dclid = s.substring(6);
    else if (!acc.user_id && s.startsWith('sid1_')) acc.user_id = s.substring(5);
    else if (!acc.anon_id && s.startsWith('sid4_')) acc.anon_id = s.substring(5);
    else if (!acc.campaignkey && s.startsWith('campaignkey_')) acc.campaignkey = s.substring(12);
    else if (!acc.click_timestamp && s.startsWith('click_timestamp_')) acc.click_timestamp = s.substring(16);

    return acc;
  }, {});
}

/**
 * Mapeia o tipo de transação do ClickBank para um evento canônico.
 * @param {string} cbType - O transactionType do ClickBank.
 * @returns {string} - 'purchase', 'refund', 'chargeback', ou 'other'.
 */
function mapEventType(cbType) {
  const type = String(cbType).toLowerCase();
  switch (type) {
    case 'sale':
    case 'test_sale':
      return 'purchase';
    case 'rfnd':
    case 'test_rfnd':
      return 'refund';
    case 'cgbk':
    case 'test_cgbk':
      return 'chargeback';
    default:
      return 'other'; // ex: bill, cancel_rebill
  }
}

/**
 * Processa o webhook (POST) do ClickBank.
 * Espera um body 'application/x-www-form-urlencoded' parseado pelo Express.
 * @param {object} req - O objeto de requisição do Express.
 * @param {object} res - O objeto de resposta do Express.
 */
async function handle(req, res) {
  // 1. Validação de Segurança (Chave Secreta)
  if (!WEBHOOK_SECRET_KEY) {
    console.error('[ClickbankPostback] ERRO CRÍTICO: CLICKBANK_WEBHOOK_SECRET_KEY não configurada.');
    return res.status(500).send('Internal Server Configuration Error');
  }

  // Lógica de Validação INS 8.0
  const { notification, iv } = req.body || {};

  if (!notification || !iv) {
    console.warn('[ClickbankPostback] notification/iv ausentes no body (esperado application/x-www-form-urlencoded).');
    return res.status(400).send('Bad Request');
  }

  let payload;
  try {
    // 1.1) Preparar Chave e IV
    const key = crypto.createHash('sha256')
      .update(WEBHOOK_SECRET_KEY)
      .digest();

    const ivBuf = Buffer.from(iv, 'base64');

    // 1.2) Descriptografar o 'notification'
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, ivBuf);

    let decrypted = decipher.update(notification, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    payload = JSON.parse(decrypted);
  } catch (err) {
    console.error('[ClickbankPostback] Falha ao descriptografar:', err.message);
    return res.status(401).send('Unauthorized (Decryption Failed)');
  }

  // 2. Normalização (Parse do Payload)
  const canonical = {};
  try {
    const {
      transactionType,
      receipt,
      transactionTime,
      currency,
      totalOrderAmount,
      vendorVariables,
      trackingCodes,
      lineItems
    } = payload || {};

    const vv = toPlainObject(vendorVariables);
    const tracking = extractTrackingCodes(trackingCodes);
    const firstItem = Array.isArray(lineItems) && lineItems.length ? lineItems[0] : {};

    const vendorTid = firstNonEmpty(
      vv.user_id,
      vv.sid1,
      vv.tid_,
      vv.tid,
      vv.aff_sub1,
      tracking.user_id
    );

    const canonicalAnonId = firstNonEmpty(
      vv.anon_id,
      vv.sid4,
      vv.aff_sub4,
      tracking.anon_id
    );

    const canonicalCampaignKey = firstNonEmpty(
      vv.campaignkey,
      vv.campaign_key,
      vv.campaign
    );

    const rawAmount = parseFloat(totalOrderAmount || firstItem.accountAmount || '0');

    canonical.platform = 'clickbank';
    canonical.event_type = mapEventType(transactionType); // Canônico: purchase, refund, etc.
    canonical.tx_id = receipt;
    canonical.event_id = receipt; // alias canônico adicional, sem remover tx_id
    canonical.order_id = receipt;
    canonical.product_id = firstItem.itemNo || 'N/A';
    canonical.sku = firstItem.itemNo || 'N/A';
    canonical.product_name = firstItem.productTitle || 'N/A';
    canonical.status = String(transactionType).toLowerCase(); // Status real do vendor: sale, rfnd, etc.
    canonical.gross_amount = Number.isFinite(rawAmount) ? rawAmount : 0;
    canonical.amount_gross = canonical.gross_amount; // alias adicional, sem remover gross_amount
    canonical.currency = currency || 'USD';

    // Chaves de Atribuição (essenciais para os Sinks)
    canonical.user_id = vendorTid || null; // O 'tid' do ClickBank continua compatível como user_id
    canonical.anon_id = canonicalAnonId || null;
    canonical.gclid = firstNonEmpty(vv.gclid, vv.sid2, tracking.gclid) || null;
    canonical.fbclid = firstNonEmpty(vv.fbclid, vv.sid3, tracking.fbclid) || null;
    canonical.dclid = firstNonEmpty(vv.dclid, vv.sid5, tracking.dclid) || null;
    canonical.campaignkey = canonicalCampaignKey || null;
    canonical.utm_source = firstNonEmpty(vv.utm_source) || null;
    canonical.utm_medium = firstNonEmpty(vv.utm_medium) || null;
    canonical.utm_campaign = firstNonEmpty(vv.utm_campaign) || null;
    canonical.utm_term = firstNonEmpty(vv.utm_term) || null;
    canonical.utm_content = firstNonEmpty(vv.utm_content) || null;
    canonical.click_timestamp = firstNonEmpty(vv.click_timestamp, tracking.click_timestamp) || null;

    // Parser de data robusto
    try {
      canonical.event_time_iso = transactionTime ? new Date(transactionTime).toISOString() : new Date().toISOString();
    } catch (dateError) {
      console.warn(`[ClickbankPostback] Falha ao parsear transactionTime '${transactionTime}'. Usando data atual.`);
      canonical.event_time_iso = new Date().toISOString();
    }

    canonical.raw = payload; // Payload já decriptografado (seguro)
  } catch (parseError) {
    console.error('[ClickbankPostback] Falha ao normalizar o payload:', parseError.message, payload);
    return res.status(200).send('OK (parse error)');
  }

  // 3. Disparo para os "Sinks"

  // Sink 1: Transações (Raw S2S)
  try {
    await FirebaseSink.saveS2SEvent(canonical);
  } catch (error) {
    console.error(`[ClickbankPostback] Falha no FirebaseSink (TX: ${canonical.tx_id}):`, error.message);
  }

  // Sink 2: Jornada do Usuário (Daily Facts)
  try {
    if (canonical.anon_id) {
      await DailyFactsSink.saveS2SEventToDailyFacts(canonical);
    } else {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[ClickbankPostback] Evento S2S sem anon_id. daily_facts pulado. TX: ${canonical.tx_id}`);
      }
    }
  } catch (error) {
    console.error(`[ClickbankPostback] Falha no DailyFactsSink (TX: ${canonical.tx_id}):`, error.message);
  }

  // Sink 3: Google Analytics
  try {
    if (canonical.event_type === 'purchase') {
      Ga4Sink.sendPurchaseFromCanonical(canonical);
    }
  } catch (error) {
    console.error(`[ClickbankPostback] Falha ao disparar o Ga4Sink (TX: ${canonical.tx_id}):`, error.message);
  }

  // 4. Responder 200 OK
  return res.status(200).send('OK');
}

module.exports = {
  handle
};