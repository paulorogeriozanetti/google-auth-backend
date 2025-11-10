/**
 * PZ Advisors - Digistore24 Adapter
 * Nome/Versão: Digistore24Adapter v1.4.1-DS7a
 * Data: 2025-11-10
 *
 * Alterações vs v1.4.0-DS7
 * - Precedência de affiliate corrigida: aplica-se primeiro o affiliate_id do offer
 *   e depois os parâmetros data-driven (QS) podem sobrescrever se a allowlist permitir.
 * - Aplicação do QS agora usa set() SEM checar existência, permitindo overwrite legítimo.
 * - Heurística mantém UTMs e chaves sid1..sid4 na allowlist para resiliência data‑driven
 *   quando o CSV estiver indisponível.
 * - Mantém remoção da API legada baseada em mapTrackingToPlatform como fonte principal;
 *   CSV esperado via .load(schema) e, se falhar, cai para heurística DR (resiliente).
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// =============================
// ===== CSV Loader Resolver ===
// =============================
function _resolveParamLoaderModule() {
  try {
    const mod = require('./ParamMapLoaderCsv');
    const cand = mod?.default || mod;

    // Objeto com .load
    if (cand && typeof cand.load === 'function') return cand;

    // Classe/fábrica cujo instance tem .load
    if (typeof cand === 'function') {
      try {
        const inst = new cand();
        if (inst && typeof inst.load === 'function') return { load: (url) => inst.load(url) };
      } catch (_) {
        try {
          const inst2 = cand();
          if (inst2 && typeof inst2.load === 'function') return { load: (url) => inst2.load(url) };
        } catch (_) {}
      }
    }

    // Singleton com getInstance().load()
    if (cand && typeof cand.getInstance === 'function') {
      const inst3 = cand.getInstance();
      if (inst3 && typeof inst3.load === 'function') return { load: (url) => inst3.load(url) };
    }
  } catch (_) {}
  return null;
}

class Digistore24Adapter extends PlatformAdapterBase {
  constructor(opts = {}) {
    super();
    this.version = '1.4.1-DS7a';
    this.logPrefix = `[Digistore24Adapter v${this.version}]`;

    this.PARAM_MAP_URL = process.env.PZ_PARAMETER_MAP_URL || 'https://pzadvisors.com/wp-content/uploads/pz_parameter_map.csv';
    this.FORCE_HEURISTIC = String(process.env.PZ_PARAMETER_FORCE_HEURISTIC || '0') === '1';

    // Webhook auth
    this.AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
    if (!this.AUTH_KEY) {
      console.warn(`${this.logPrefix} Variável DIGISTORE_AUTH_KEY não configurada. Webhooks S2S falharão.`);
    }

    // Loader CSV (injeção opcional via opts.paramLoader)
    const resolved = _resolveParamLoaderModule();
    this.paramLoader = opts.paramLoader && typeof opts.paramLoader.load === 'function' ? opts.paramLoader : resolved;
  }

  // =========================================================
  // ===================== BUILD CHECKOUT ====================
  // =========================================================
  async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
    // 1) Base URL pela oferta
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

    // 2) Regras (CSV -> heurística), com overrides da oferta
    const rules = await this._loadParamRules(offerData);

    // 3) QS data-driven (aplica allowlist+alias nos trackingParams)
    const qs = this._buildQueryParamsDataDriven(trackingParams, rules);

    // 4) Montagem final da URL
    try {
      const urlObj = new URL(baseUrl);

      // 4.1) Define affiliate padrão do offer primeiro
      if (offerData.affiliate_id) {
        urlObj.searchParams.set('aff', this._sanitize(String(offerData.affiliate_id)));
      }

      // 4.2) Aplica QS calculado (permite overwrite legítimo)
      for (const [k, v] of Object.entries(qs)) {
        const safe = this._sanitize(String(v));
        if (safe !== '') urlObj.searchParams.set(k, safe);
      }

      const finalUrl = urlObj.toString();
      console.log(`${this.logPrefix} URL final gerada: ${finalUrl.split('?')[0]}?<params_ocultos>`);
      return finalUrl;
    } catch (err) {
      console.error(`${this.logPrefix} Erro ao construir URL Digistore24 (Base: ${baseUrl}):`, err?.message || err);
      return null;
    }
  }

  // Lê allowlist/aliases do CSV; aplica overrides da oferta; fallback heurístico
  async _loadParamRules(offerData = {}) {
    const offerAllowArr = this._safeArray(offerData.parameterAllowlist);
    const hasOfferAllow = offerAllowArr.length > 0;
    const offerAllow = new Set(offerAllowArr);

    const offerMap = offerData?.parameterMap && typeof offerData.parameterMap === 'object' ? offerData.parameterMap : null;

    let baseAllow = new Set();
    let baseAlias = {};

    if (!this.FORCE_HEURISTIC && this.paramLoader && typeof this.paramLoader.load === 'function') {
      try {
        const schema = await this.paramLoader.load(this.PARAM_MAP_URL);
        if (schema?.parameters && typeof schema.parameters === 'object') {
          for (const [key, rec] of Object.entries(schema.parameters)) {
            const include = this._toBool(rec.include_in_checkout) || this._toBool(rec.include_in_checkout_default);
            if (include) {
              baseAllow.add(key);
              const alias = (rec.alias || '').trim();
              if (alias) baseAlias[key] = alias;
            }
          }
        } else {
          throw new Error('CSV vazio ou schema inesperado');
        }
      } catch (err) {
        console.warn(`${this.logPrefix} Falha ao ler CSV (${this.PARAM_MAP_URL}). Usando heurística.`, err?.message || err);
      }
    }

    if (baseAllow.size === 0) baseAllow = this._heuristicAllowlist();
    if (Object.keys(baseAlias).length === 0) baseAlias = this._heuristicAliasMap();

    // aliasMap final: base + offerMap (offer tem prioridade)
    const aliasKeys = offerMap ? Object.keys(offerMap) : [];
    const aliasMapFinal = { ...baseAlias, ...(offerMap || {}) };

    // allowlist final:
    // - se offer define allowlist -> estrito (NÃO injeta sinônimos de affiliate automaticamente)
    // - se não define -> base + sinônimos padrão
    const affiliateSynonyms = ['affiliate', 'affiliate_id', 'ref', 'refid', 'tag', 'aid'];
    const allowlistBase = hasOfferAllow ? new Set(offerAllow) : new Set(baseAllow);
    const allowlistFinal = new Set([
      ...allowlistBase,
      ...aliasKeys, // garantir entrada para chaves que só existem via alias
      ...(hasOfferAllow ? [] : affiliateSynonyms),
    ]);

    return { allowlist: allowlistFinal, aliasMap: aliasMapFinal };
  }

  _buildQueryParamsDataDriven(trackingParams = {}, rules = { allowlist: new Set(), aliasMap: {} }) {
    const { allowlist, aliasMap } = rules;
    const out = {};

    for (const [k, v] of Object.entries(trackingParams)) {
      if (!allowlist.has(k)) continue;
      if (this._isNullishValue(v)) continue;
      const target = aliasMap[k] || k; // mapeia user_id->sid1, gclid->sid2, affiliate->aff, etc.

      // Regra de affiliate: só entra se allowlist permitir (já garantido acima)
      out[target] = String(v);
    }

    return out;
  }

  // ==========================
  // ===== Heurísticas DR ====
  // ==========================
  _heuristicAllowlist() {
    return new Set([
      // IDs & clids
      'user_id', 'gclid', 'fbclid', 'dclid', 'ttclid', 'anon_id',
      // campaign keys
      'cid', 'campaignkey', 'click_timestamp', 'timestamp',
      // UTMs (data-driven resiliente)
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      // affiliate synonyms (só serão injetados se NÃO houver offerAllowlist)
      'affiliate', 'affiliate_id', 'ref', 'refid', 'tag', 'aid',
      // sidx (se já vierem do front em algum caso legado)
      'sid1', 'sid2', 'sid3', 'sid4',
    ]);
  }

  _heuristicAliasMap() {
    return {
      // Mapeamentos principais Digistore
      user_id: 'sid1',
      gclid: 'sid2',
      fbclid: 'sid3',
      anon_id: 'sid4',

      // Chaves "direct"
      cid: 'cid',
      campaignkey: 'campaignkey',

      // Afiliado (quando permitido)
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

  // ==========================
  // ===== Webhook (GET) =====
  // ==========================
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
      eventTimestamp: payload.timestamp ? new Date((payload.timestamp || '').replace(' ', 'T') + 'Z') : new Date(),
      receivedTimestamp: new Date(),
      _rawPayload: this.safeLog(payload),
    };
  }

  // ==========================
  // ======= Utils ==========
  // ==========================
  _safeArray(v) { return Array.isArray(v) ? v : []; }

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

  _sanitize(v) {
    return String(v).trim().substring(0, 100).replace(/[^a-zA-Z0-9._\-]/g, '_');
  }
}

module.exports = Digistore24Adapter;