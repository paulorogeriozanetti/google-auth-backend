/**
 * PZ Advisors - Digistore24 Adapter
 * Nome/Versão: Digistore24Adapter v1.3.5-DS6f
 * Data: 2025-11-10
 *
 * Alterações vs v1.3.4-DR6e
 * - Corrige fallback heurístico quando CSV está ausente/vazio: mapeia corretamente
 *   user_id→sid1, gclid→sid2, fbclid→sid3, anon_id→sid4, cid/campaignkey 1:1 e
 *   sinônimos de afiliado → aff; UTMs 1:1 (utm_source/utm_medium/...)
 * - Mantém arquitetura data-driven: tenta ParamMap CSV (getInstance().mapTrackingToPlatform)
 *   e também aceita loaders com .load() + schema { parameters }.
 * - Mantém overrides da oferta: parameterAllowlist (substitui base) e parameterMap (prioridade)
 * - Mantém precedência de afiliado do tracking sobre affiliate_id do offer
 * - Mantém webhook S2S (auth_key) sem alterações funcionais
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// --- Utilidades CSV Loader ---------------------------------------------------
function _resolveCsvModule() {
  try {
    const mod = require('./ParamMapLoaderCsv');
    return mod?.default || mod || null;
  } catch (_) {
    return null;
  }
}

function _getParamMapSingleton() {
  const M = _resolveCsvModule();
  if (!M) return null;
  try {
    if (typeof M.getInstance === 'function') {
      return M.getInstance();
    }
  } catch (_) {}
  return null;
}

async function _tryLoadCsvSchema() {
  const M = _resolveCsvModule();
  if (!M) return null;
  try {
    // suporte a módulo com .load(url) (assíncrono)
    const loader = typeof M.load === 'function' ? M : (typeof M === 'function' ? new M() : null);
    if (loader && typeof loader.load === 'function') {
      const url = process.env.PZ_PARAMETER_MAP_URL || 'https://pzadvisors.com/wp-content/uploads/pz_parameter_map.csv';
      const schema = await loader.load(url);
      if (schema && typeof schema === 'object') return schema;
    }
  } catch (_) {}
  return null;
}

// --- Adapter ----------------------------------------------------------------
class Digistore24Adapter extends PlatformAdapterBase {
  constructor() {
    super();
    this.version = '1.3.5-DS6f';
    this.logPrefix = `[Digistore24Adapter v${this.version}]`;

    // Webhook (S2S)
    this.AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
    if (!this.AUTH_KEY) {
      console.warn(`${this.logPrefix} Variável DIGISTORE_AUTH_KEY não configurada. Webhooks S2S falharão.`);
    }
  }

  // ========================= BUILD CHECKOUT (DATA-DRIVEN) ====================
  /**
   * Constrói a URL de checkout Digistore24 a partir de checkout_url ou product_id.
   * Suporta: CSV ParamMap (singleton.mapTrackingToPlatform) → schema .load() → heurística
   */
  async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
    // 1) Base URL a partir de checkout_url ou product_id
    let baseUrl = offerData.checkout_url;
    const productId = offerData.product_id;
    if (!baseUrl && productId) {
      baseUrl = `https://www.digistore24.com/product/${productId}`;
      console.log(`${this.logPrefix} Construindo URL base a partir do product_id: ${productId}`);
    }

    const isValidBase =
      typeof baseUrl === 'string' &&
      (baseUrl.startsWith('https://www.digistore24.com/product/') ||
        baseUrl.startsWith('https://www.digistore24.com/redir/'));

    if (!isValidBase) {
      console.warn(`${this.logPrefix} checkout_url/product_id inválido ou ausente:`, baseUrl);
      return null;
    }

    console.log(`${this.logPrefix} Construindo URL de checkout para base: ${String(baseUrl).split('?')[0]}...`);

    try {
      const urlObj = new URL(baseUrl);

      // 2) Tentar primeiro CSV ParamMap (singleton API)
      let qs = {};
      const PM = _getParamMapSingleton();
      if (PM && typeof PM.mapTrackingToPlatform === 'function') {
        try {
          qs = PM.mapTrackingToPlatform(trackingParams, 'digistore24') || {};
        } catch (_) { qs = {}; }
      }

      // 3) Se CSV singleton não trouxe nada, tentar schema com .load() + rules
      if (!qs || Object.keys(qs).length === 0) {
        const schema = await _tryLoadCsvSchema();
        if (schema && schema.parameters && typeof schema.parameters === 'object') {
          const { allowlist, aliasMap } = this._rulesFromCsvSchema(schema, offerData);
          qs = this._buildQueryParamsDataDriven(trackingParams, { allowlist, aliasMap });
        }
      }

      // 4) Se ainda vazio → heurística (corrigida p/ Digistore)
      if (!qs || Object.keys(qs).length === 0) {
        console.warn(`${this.logPrefix} ParamMap CSV ausente/vazio. Aplicando heurística Digistore.`);
        const allowlist = this._heuristicAllowlist();
        const aliasMap = this._heuristicAliasMap();
        const { allowlist: finalAllow, aliasMap: finalAlias } = this._applyOfferOverrides(offerData, allowlist, aliasMap);
        qs = this._buildQueryParamsDataDriven(trackingParams, { allowlist: finalAllow, aliasMap: finalAlias });
      }

      // 5) Precedência do afiliado: tracking (qs.aff) sobrescreve affiliate_id de offer
      const trackingAff = qs.aff;
      if (!trackingAff) {
        const offerAff = offerData.affiliate_id;
        if (offerAff) urlObj.searchParams.set('aff', String(offerAff).trim());
      }

      // 6) Sanitização final e set na URL
      for (const [k, v] of Object.entries(qs)) {
        const safeValue = String(v).trim().substring(0, 100).replace(/[^a-zA-Z0-9._\-]/g, '_');
        if (safeValue !== '') urlObj.searchParams.set(k, safeValue);
      }

      const finalUrl = urlObj.toString();
      console.log(`${this.logPrefix} URL final gerada: ${finalUrl.split('?')[0]}?<params_ocultos>`);
      return finalUrl;
    } catch (error) {
      console.error(`${this.logPrefix} Erro ao construir URL Digistore24 (Base: ${baseUrl}):`, error?.message || error);
      return null;
    }
  }

  // ------------------------ CSV → Regras (allowlist/alias) -------------------
  _rulesFromCsvSchema(schema, offerData) {
    const params = schema.parameters || {};
    const baseAllow = new Set();
    const baseAlias = {};

    for (const [srcKey, rec] of Object.entries(params)) {
      const include = this._toBool(rec.include_in_checkout) || this._toBool(rec.include_in_checkout_default);
      if (include) {
        baseAllow.add(srcKey);
        const alias = (rec.alias || '').trim();
        if (alias) baseAlias[srcKey] = alias;
      }
    }

    return this._applyOfferOverrides(offerData, baseAllow, baseAlias);
  }

  _applyOfferOverrides(offerData, baseAllow, baseAlias) {
    const offerAllow = Array.isArray(offerData?.parameterAllowlist) ? offerData.parameterAllowlist : [];
    const offerMap = offerData?.parameterMap && typeof offerData.parameterMap === 'object' ? offerData.parameterMap : null;

    // allowlist: se offerAllow existir, ele SUBSTITUI a base
    const allowlist = offerAllow.length ? new Set(offerAllow) : new Set(baseAllow);

    // alias: mescla com prioridade do offerMap
    const aliasMap = { ...(baseAlias || {}), ...(offerMap || {}) };

    // sinônimos de afiliado sempre presentes (fonte → 'aff')
    ['affiliate', 'affiliate_id', 'ref', 'refid', 'tag', 'aid', 'aff'].forEach((k) => (aliasMap[k] = 'aff'));

    return { allowlist, aliasMap };
  }

  // ------------------------ Heurísticas (fallback corrigido) ------------------
  _heuristicAllowlist() {
    return new Set([
      // IDs/SIDs (fontes de entrada)
      'user_id', 'gclid', 'fbclid', 'anon_id',
      // Afiliado (fontes)
      'affiliate', 'affiliate_id', 'ref', 'refid', 'tag', 'aid',
      // Campaign keys
      'cid', 'campaignkey',
      // UTMs (1:1)
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      // utilitários
      'timestamp'
    ]);
  }

  _heuristicAliasMap() {
    return {
      // SIDs padrão Digistore
      user_id: 'sid1',
      gclid: 'sid2',
      fbclid: 'sid3',
      anon_id: 'sid4',

      // Campaign keys
      cid: 'cid',
      campaignkey: 'campaignkey',

      // Afiliado → aff
      affiliate: 'aff',
      affiliate_id: 'aff',
      ref: 'aff',
      refid: 'aff',
      tag: 'aff',
      aid: 'aff',

      // UTMs 1:1
      utm_source: 'utm_source',
      utm_medium: 'utm_medium',
      utm_campaign: 'utm_campaign',
      utm_term: 'utm_term',
      utm_content: 'utm_content',
    };
  }

  _buildQueryParamsDataDriven(trackingParams = {}, rules = { allowlist: new Set(), aliasMap: {} }) {
    const { allowlist, aliasMap } = rules;
    const out = {};

    for (const [srcKey, rawVal] of Object.entries(trackingParams || {})) {
      if (!allowlist.has(srcKey)) continue;
      if (this._isNullishValue(rawVal)) continue;
      const destKey = aliasMap[srcKey] || srcKey;
      out[destKey] = String(rawVal);
    }

    return out;
  }

  _toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return /^true|1|yes|y$/i.test(v.trim());
    return false;
  }

  _isNullishValue(val) {
    if (val == null) return true;
    const s = String(val).trim().toLowerCase();
    return s === '' || s === 'null' || s === 'undefined' || s === 'none' || s === 'na' || s === 'n/a';
  }

  // ============================= WEBHOOK (S2S) ===============================
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
      trackingId: payload.sid1 || null,
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