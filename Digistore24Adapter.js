/**
 * PZ Advisors - Digistore24 Adapter
 * Versão: 1.2.1 (Sanitize com trim)
 * Data: 2025-11-05
 * Desc:
 * - Ajusta sanitização para aplicar `.trim()` antes do replace, evitando
 *   converter espaços em "_" (corrige teste "sanitiza valores e ignora vazios").
 * - Mantém integração ParamMap CSV (P0.4) + fallback hardcoded e toda a
 *   compatibilidade anterior (product_id, aff/sidX/cid/campaignkey).
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// Lazy require para evitar erro em ambientes de teste sem o arquivo
let ParamMapSingleton = null;
function getParamMap() {
  try {
    if (!ParamMapSingleton) {
      const Loader = require('./ParamMapLoaderCsv');
      ParamMapSingleton = Loader.getInstance();
    } else {
      // garante hot-reload se o arquivo CSV for alterado
      ParamMapSingleton = require('./ParamMapLoaderCsv').getInstance();
    }
    return ParamMapSingleton;
  } catch (e) {
    // Sem CSV ou sem módulo – o fallback cobre
    return null;
  }
}

// Fallback estrito às versões anteriores (v1.1.6/1.1.8) com sanitize + trim
function fallbackHardcodedMap(trackingParams = {}) {
  const map = {
    user_id: 'sid1',
    gclid: 'sid2',
    fbclid: 'sid3',
    anon_id: 'sid4',
    cid: 'cid',
    campaignkey: 'campaignkey',
  };
  const out = {};
  for (const [pzKey, dsKey] of Object.entries(map)) {
    const v = trackingParams[pzKey];
    if (v !== undefined && v !== null) {
      const trimmed = String(v).trim();
      if (trimmed !== '') {
        out[dsKey] = trimmed.substring(0, 100).replace(/[^a-zA-Z0-9._\-]/g, '_');
      }
    }
  }
  return out;
}

class Digistore24Adapter extends PlatformAdapterBase {
  constructor() {
    super();
    this.version = '1.2.1';
    this.logPrefix = `[Digistore24Adapter v${this.version}]`;

    // Chave de Autenticação S2S (webhook)
    this.AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
    if (!this.AUTH_KEY) {
      console.warn(`${this.logPrefix} Variável DIGISTORE_AUTH_KEY não configurada. Webhooks S2S falharão.`);
    }
  }

  /**
   * @override
   * Constrói a URL de checkout com parâmetros Sidx e Aff mapeados.
   * Aceita 'checkout_url' ou 'product_id'.
   * Passo P0.4: usa ParamMapLoaderCsv (data-driven). Fallback para hardcode.
   */
  async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
    console.log(`[DS24 ADAPTER] offerData recebido:`, JSON.stringify(offerData));

    // 1) Base URL: checkout_url direto OU construída via product_id
    let baseUrl = offerData.checkout_url;
    const productId = offerData.product_id;
    if (!baseUrl && productId) {
      baseUrl = `https://www.digistore24.com/product/${productId}`;
      console.log(`${this.logPrefix} Construindo URL base a partir do product_id: ${productId}`);
    }

    // 2) Validação da base
    const isValidBase =
      typeof baseUrl === 'string' &&
      (baseUrl.startsWith('https://www.digistore24.com/product/') ||
        baseUrl.startsWith('https://www.digistore24.com/redir/'));

    if (!isValidBase) {
      console.warn(`${this.logPrefix} checkout_url/product_id inválido ou ausente:`, baseUrl);
      return null;
    }

    console.log(`${this.logPrefix} Construindo URL de checkout para base: ${baseUrl.split('?')[0]}...`);

    try {
      const urlObj = new URL(baseUrl);

      // 3) Affiliate ID
      const affiliateId = offerData.affiliate_id;
      if (affiliateId) {
        urlObj.searchParams.set('aff', String(affiliateId).trim());
      } else {
        console.warn(`${this.logPrefix} affiliate_id não encontrado em offerData (param 'aff' não será setado).`);
      }

      // 4) Montagem da query de tracking via ParamMap (data-driven)
      let qs = {};
      const PM = getParamMap();

      if (PM) {
        // Tenta usar o CSV (apenas 'active'). Pode retornar {} se CSV vazio/inválido.
        qs = PM.mapTrackingToPlatform(trackingParams, 'digistore24') || {};
      }

      // 4.1) Fallback se CSV não trouxe nada (mantém funcionalidade legada)
      if (!qs || Object.keys(qs).length === 0) {
        console.warn(`${this.logPrefix} ParamMap CSV ausente/vazio para Digistore24. Aplicando fallback hardcoded.`);
        qs = fallbackHardcodedMap(trackingParams);
      }

      // 4.2) Saneamento final e set na URL (agora com trim antes do replace)
      for (const [k, v] of Object.entries(qs)) {
        const safeValue = String(v).trim().substring(0, 100).replace(/[^a-zA-Z0-9._\-]/g, '_');
        if (safeValue !== '') {
          urlObj.searchParams.set(k, safeValue);
        }
      }

      const finalUrl = urlObj.toString();
      console.log(`${this.logPrefix} URL final gerada: ${finalUrl.split('?')[0]}?<params_ocultos>`);
      return finalUrl;
    } catch (error) {
      console.error(`${this.logPrefix} Erro ao construir URL Digistore24 (Base: ${baseUrl}):`, error?.message || error);
      return null;
    }
  }

  /**
   * @override
   * Verifica o webhook S2S (GET) do Digistore24 usando a auth_key.
   * Normaliza o payload para um formato padrão (compatível com versões anteriores).
   */
  async verifyWebhook(queryPayload, headers, traceId = 'N/A') {
    if (!this.AUTH_KEY) {
      console.error(`${this.logPrefix} Webhook falhou: DIGISTORE_AUTH_KEY não configurada. [Trace: ${traceId}]`);
      return null;
    }
    if (!queryPayload || typeof queryPayload !== 'object') {
      console.warn(`${this.logPrefix} Webhook recebido sem payload (query). [Trace: ${traceId}]`);
      return null;
    }

    const receivedAuthKey = queryPayload.auth_key;
    if (!receivedAuthKey) {
      console.warn(`${this.logPrefix} Webhook sem 'auth_key'. [Trace: ${traceId}]`);
      return null;
    }

    try {
      const keyBuf = Buffer.from(this.AUTH_KEY);
      const receivedKeyBuf = Buffer.from(receivedAuthKey);

      if (keyBuf.length !== receivedKeyBuf.length || !crypto.timingSafeEqual(keyBuf, receivedKeyBuf)) {
        console.warn(`${this.logPrefix} Falha na validação da auth_key do Webhook. [Trace: ${traceId}]`);
        return null;
      }
      console.log(`${this.logPrefix} Validação da auth_key do Webhook OK. [Trace: ${traceId}]`);

      const normalizedData = this._normalizeWebhookPayload(queryPayload);
      normalizedData.trace_id = traceId;

      const safeData = this.safeLog(queryPayload);
      console.log(`${this.logPrefix} Webhook S2S normalizado com sucesso.`, safeData);

      return normalizedData;
    } catch (error) {
      console.error(`${this.logPrefix} Erro durante a validação/normalização do Webhook:`, error?.message || error);
      return null;
    }
  }

  // --- Helpers Internos ---

  _normalizeWebhookPayload(payload) {
    let unifiedStatus = 'other';
    switch (payload.event) {
      case 'completed':
      case 'test':
        unifiedStatus = 'paid';
        break;
      case 'refund':
      case 'chargeback':
        unifiedStatus = payload.event;
        break;
      case 'rebill_resumed':
      case 'rebill_cancelled':
        unifiedStatus = 'subscription_update';
        break;
    }

    return {
      platform: 'digistore24',
      transactionId: payload.order_id,
      orderId: payload.order_id,
      trackingId: payload.sid1 || null, // nosso user_id
      sid2: payload.sid2 || null,
      sid3: payload.sid3 || null,
      sid4: payload.sid4 || null,
      // sid5: payload.sid5 || null,
      cid: payload.cid || null,
      campaignkey: payload.campaignkey || null,

      transactionTypeRaw: payload.event,
      status: unifiedStatus,
      productSku: payload.product_id || 'N/A',
      amount: parseFloat(payload.amount || 0),
      currency: payload.currency || 'USD',
      customerEmail: payload.customer_email || null,
      eventTimestamp: payload.timestamp ? new Date(payload.timestamp.replace(' ', 'T') + 'Z') : new Date(),
      receivedTimestamp: new Date(),
      _rawPayload: this.safeLog(payload),
    };
  }
}

module.exports = Digistore24Adapter;