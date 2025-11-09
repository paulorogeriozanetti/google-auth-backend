/**
 * PZ Advisors - Digistore24 Adapter
 * Nome/Versão: Digistore24Adapter v1.3.4-DS7
 * Data: 2025-11-09
 *
 * Objetivo desta versão:
 * - Corrige regressão de "Offer override": quando a oferta define
 *   `parameterAllowlist` e `parameterMap`, o QS final deve ser
 *   reconstruído *estritamente* com base nesses overrides (o allowlist
 *   da oferta substitui o CSV/heurística). Alinha o fluxo com o
 *   ClickbankAdapter v1.3.3-DR6e (permitir→mapear) em vez de mapear→filtrar.
 * - Mantém compatibilidade com ParamMapLoaderCsv em diferentes formatos:
 *   `getInstance().mapTrackingToPlatform(...)`, classe com `.load()` que
 *   retorna schema `{ parameters: { key: { include_in_checkout, alias }}}`,
 *   ou objeto com `.load()`.
 * - Preserva *todas* as funcionalidades anteriores: construção via
 *   `product_id`/`checkout_url`, definição de `aff` (affiliate_id),
 *   fallback hardcoded (sid1/sid2/sid3/sid4/cid/campaignkey), sanitização
 *   e verificação de webhook via `DIGISTORE_AUTH_KEY`.
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// --- Loader flexível (similar ao ClickbankAdapter) ---
function _resolveParamLoaderModule() {
  try {
    const mod = require('./ParamMapLoaderCsv');
    const cand = mod?.default || mod;

    // Caso 1: singleton com mapTrackingToPlatform (API antiga usada nos testes)
    if (cand && typeof cand.getInstance === 'function') {
      const inst = cand.getInstance();
      if (inst && typeof inst.mapTrackingToPlatform === 'function') {
        return { type: 'mapper', map: (tracking, platform) => inst.mapTrackingToPlatform(tracking, platform) };
      }
      if (inst && typeof inst.load === 'function') {
        return { type: 'loader', load: (url) => inst.load(url) };
      }
    }

    // Caso 2: objeto/classe com .load() que retorna { parameters: { ... } }
    if (cand && typeof cand.load === 'function') {
      return { type: 'loader', load: (url) => cand.load(url) };
    }

    // Caso 3: classe/fábrica
    if (typeof cand === 'function') {
      try {
        const inst = new cand();
        if (inst && typeof inst.load === 'function') {
          return { type: 'loader', load: (url) => inst.load(url) };
        }
      } catch (_) {
        try {
          const inst2 = cand();
          if (inst2 && typeof inst2.load === 'function') {
            return { type: 'loader', load: (url) => inst2.load(url) };
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return null;
}

// Fallback estrito às versões anteriores
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
  constructor(opts = {}) {
    super();
    this.version = '1.3.4-DS7';
    this.logPrefix = `[Digistore24Adapter v${this.version}]`;

    // Webhook
    this.AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
    if (!this.AUTH_KEY) {
      console.warn(`${this.logPrefix} Variável DIGISTORE_AUTH_KEY não configurada. Webhooks S2S falharão.`);
    }

    // ParamMap CSV
    this.PARAM_MAP_URL = process.env.PZ_PARAMETER_MAP_URL || 'https://pzadvisors.com/wp-content/uploads/pz_parameter_map.csv';
    this.paramLoader = _resolveParamLoaderModule();
  }

  // ================== BUILD CHECKOUT ==================
  async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
    // 1) Base URL
    let baseUrl = offerData.checkout_url;
    const productId = offerData.product_id;
    if (!baseUrl && productId) {
      baseUrl = `https://www.digistore24.com/product/${productId}`;
      console.log(`${this.logPrefix} Construindo URL base a partir do product_id: ${productId}`);
    }

    const isValidBase =
      typeof baseUrl === 'string' &&
      (baseUrl.startsWith('https://www.digistore24.com/product/') || baseUrl.startsWith('https://www.digistore24.com/redir/'));

    if (!isValidBase) {
      console.warn(`${this.logPrefix} checkout_url/product_id inválido ou ausente:`, baseUrl);
      return null;
    }

    try {
      const urlObj = new URL(baseUrl);

      // 2) aff do offer (pode ser sobrescrito depois por QS)
      const affiliateId = offerData.affiliate_id;
      if (affiliateId) {
        urlObj.searchParams.set('aff', String(affiliateId).trim());
      } else {
        console.warn(`${this.logPrefix} affiliate_id não encontrado em offerData (param 'aff' não será setado).`);
      }

      // 3) Construção do QS base (CSV → mapper ou loader → schema) ou fallback
      let qs = {};
      if (this.paramLoader && this.paramLoader.type === 'mapper') {
        // API antiga usada nos testes: getInstance().mapTrackingToPlatform
        qs = this.paramLoader.map(trackingParams, 'digistore24') || {};
        const qsKeys = Object.keys(qs);
        console.log(`${this.logPrefix} ParamMap (mapper) ativo; QS CSV keys: ${qsKeys.join(',') || '(vazio)'}`);
      } else if (this.paramLoader && this.paramLoader.type === 'loader') {
        try {
          const map = await this.paramLoader.load(this.PARAM_MAP_URL);
          const { allowlist, aliasMap } = this._schemaToRules(map, 'digistore24');
          qs = this._buildQueryParamsDataDriven(trackingParams, { allowlist, aliasMap });
          console.log(`${this.logPrefix} ParamMap (loader) ativo; QS CSV keys: ${Object.keys(qs).join(',') || '(vazio)'}`);
        } catch (e) {
          console.warn(`${this.logPrefix} Falha ao ler CSV; aplicando fallback.`, e?.message || e);
          qs = fallbackHardcodedMap(trackingParams);
        }
      } else {
        console.warn(`${this.logPrefix} ParamMap CSV ausente; aplicando fallback hardcoded.`);
        qs = fallbackHardcodedMap(trackingParams);
      }

      // 4) Offer override estrito (parameterAllowlist + parameterMap)
      const offerAllow = Array.isArray(offerData.parameterAllowlist) ? offerData.parameterAllowlist : [];
      const offerMap = offerData.parameterMap && typeof offerData.parameterMap === 'object' ? offerData.parameterMap : null;
      if (offerAllow.length > 0) {
        const strictQs = {};
        for (const key of offerAllow) {
          if (Object.prototype.hasOwnProperty.call(trackingParams, key)) {
            const v = trackingParams[key];
            const sv = v == null ? '' : String(v).trim();
            if (sv !== '') {
              const target = offerMap && offerMap[key] ? offerMap[key] : key;
              strictQs[target] = sv;
            }
          }
        }
        qs = strictQs; // substitui CSV/fallback
      }

      // 5) Aplicar QS sanitizado (mantém campos preexistentes e permite override de aff via QS, se vier do CSV/override)
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

  // Converte schema `{ parameters: { key: { include_in_checkout, alias }}}` em regras
  _schemaToRules(schema, platform) {
    const allowlist = new Set();
    const aliasMap = {};
    if (schema && schema.parameters && typeof schema.parameters === 'object') {
      for (const [key, rec] of Object.entries(schema.parameters)) {
        const include = this._toBool(rec.include_in_checkout) || this._toBool(rec.include_in_checkout_default);
        if (include) {
          allowlist.add(key);
          const alias = (rec.alias || '').trim();
          if (alias) aliasMap[key] = alias;
        }
      }
    }
    return { allowlist, aliasMap };
  }

  _buildQueryParamsDataDriven(trackingParams = {}, rules = { allowlist: new Set(), aliasMap: {} }) {
    const { allowlist, aliasMap } = rules;
    const out = {};
    for (const [k, v] of Object.entries(trackingParams)) {
      if (!allowlist.has(k)) continue;
      const sv = v == null ? '' : String(v).trim();
      if (sv === '') continue;
      const target = aliasMap[k] || k;
      out[target] = sv;
    }
    return out;
  }

  _toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return /^true|1|yes|y$/i.test(v.trim());
    return false;
  }

  // ================== WEBHOOK (S2S) ==================
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
      cid: payload.cid || null,
      campaignkey: payload.campaignkey || null,

      transactionTypeRaw: payload.event,
      status: unifiedStatus,
      productSku: payload.product_id || 'N/A',
      amount: parseFloat(payload.amount || 0),
      currency: payload.currency || 'USD',
      customerEmail: payload.customer_email || null,
      eventTimestamp: payload.timestamp ? new Date(String(payload.timestamp).replace(' ', 'T') + 'Z') : new Date(),
      receivedTimestamp: new Date(),
      _rawPayload: this.safeLog(payload),
    };
  }
}

module.exports = Digistore24Adapter;