console.log('--- [BOOT CHECK] Loading Digistore24Adapter v1.3.9-DS6k (CSV single-source only + strict overrides + resilient heuristic) ---');
/**
 * PZ Advisors - Digistore24 Adapter
 * Nome/Versão: Digistore24Adapter v1.3.9-DS6k
 * Data: 2025-11-10
 *
 * Alterações vs v1.3.8-DS6j
 * - Remove completamente a API legada (getInstance/mapTrackingToPlatform). Usa apenas CSV via .load() (Fonte Única).
 * - Mantém PRIORIDADE 4: CSV (allowlist/alias) + Offer overrides (allowlist substitui base; alias do offer tem prioridade).
 * - Heurística de fallback resiliente COM UTMs e mapeamento DS (user_id→sid1, gclid→sid2, fbclid→sid3, anon_id→sid4, cid, campaignkey, UTMs 1:1, affiliate→aff).
 * - Precedência de affiliate: aff do offer prevalece; SÓ é sobrescrito por tracking.affiliate se e apenas se a allowlist permitir `affiliate`.
 * - Sanitização de valores (trim + substring + replace) e logs de diagnóstico preservados.
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// === CSV loader resolver (compatível com default/class/instância/fábrica) ===
function _resolveParamLoaderModule() {
  try {
    const mod = require('./ParamMapLoaderCsv');
    const cand = mod?.default || mod;
    if (cand && typeof cand.load === 'function') return cand; // shape { load(url) }
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
    if (cand && typeof cand.getInstance === 'function') {
      // getInstance legado: tentar extrair método .load se existir
      const inst3 = cand.getInstance();
      if (inst3 && typeof inst3.load === 'function') return { load: (url) => inst3.load(url) };
    }
  } catch (_) {}
  return null;
}

class Digistore24Adapter extends PlatformAdapterBase {
  constructor(opts = {}) {
    super();
    this.version = '1.3.9-DS6k';
    this.logPrefix = `[Digistore24Adapter v${this.version}]`;

    this.AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
    if (!this.AUTH_KEY) {
      console.warn(`${this.logPrefix} Variável DIGISTORE_AUTH_KEY não configurada. Webhooks S2S falharão.`);
    }

    this.PARAM_MAP_URL = process.env.PZ_PARAMETER_MAP_URL || 'https://pzadvisors.com/wp-content/uploads/pz_parameter_map.csv';
    this.FORCE_HEURISTIC = String(process.env.PZ_PARAMETER_FORCE_HEURISTIC || '0') === '1';

    const resolved = _resolveParamLoaderModule();
    this.paramLoader = opts.paramLoader && typeof opts.paramLoader.load === 'function' ? opts.paramLoader : resolved;
  }

  // =========================================================
  // ===============  BUILD CHECKOUT (DATA-DRIVEN) ===========
  // =========================================================

  /**
   * Constrói a URL de checkout para Digistore24 (product/redir), com QS mapeado via CSV + overrides + fallback heurístico.
   */
  async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
    // 1) Base URL: direta (checkout_url) ou por product_id
    let baseUrl = offerData.checkout_url;
    const productId = offerData.product_id;
    if (!baseUrl && productId) {
      baseUrl = `https://www.digistore24.com/product/${productId}`;
      console.log(`${this.logPrefix} Construindo URL base a partir do product_id: ${productId}`);
    }

    // 2) Validar base
    const isValidBase =
      typeof baseUrl === 'string' &&
      (baseUrl.startsWith('https://www.digistore24.com/product/') || baseUrl.startsWith('https://www.digistore24.com/redir/'));
    if (!isValidBase) {
      console.warn(`${this.logPrefix} checkout_url/product_id inválido ou ausente:`, baseUrl);
      return null;
    }

    try {
      const urlObj = new URL(baseUrl);

      // 3) Preparar regras (CSV como fonte única + overrides). Se falhar CSV → heurística DS.
      let rules = null;
      if (!this.FORCE_HEURISTIC && this.paramLoader && typeof this.paramLoader.load === 'function') {
        try {
          const map = await this.paramLoader.load(this.PARAM_MAP_URL);
          const { allowlist, aliasMap } = this._rulesFromCsv(map, offerData);
          rules = { allowlist, aliasMap };
        } catch (err) {
          console.warn(`${this.logPrefix} Falha ao ler CSV (${this.PARAM_MAP_URL}). Usando heurística.`, err?.message || err);
        }
      } else if (this.FORCE_HEURISTIC) {
        console.log(`${this.logPrefix} FORCE_HEURISTIC=1 -> ignorando CSV e usando heurística.`);
      }

      if (!rules) {
        const baseAllow = this._heuristicAllowlist();
        const baseAlias = this._heuristicAliasMap();
        rules = this._applyOfferOverrides(offerData, baseAllow, baseAlias);
      }

      // 4) Montar QS a partir de trackingParams segundo regras (allowlist source-keys + aliasMap → destino DS)
      const qs = this._buildQueryParamsDataDriven(trackingParams, rules);

      // 5) Affiliate precedence: offerData.affiliate_id prevalece; tracking.affiliate SÓ pode sobrescrever se allowlist permitir
      //    (Implementado após QS para termos tracking limpo; sanitização aplicada ao set final.)
      if (offerData.affiliate_id) {
        const affOffer = String(offerData.affiliate_id).trim();
        if (affOffer) urlObj.searchParams.set('aff', affOffer);
      }
      // Se allowlist inclui 'affiliate' e trackingParams.affiliate existir → override do tracking
      if (rules.allowlist.has('affiliate')) {
        const affTrack = trackingParams?.affiliate;
        if (!this._isNullishValue(affTrack)) {
          const safeAff = this._sanitizeValue(affTrack);
          if (safeAff) urlObj.searchParams.set('aff', safeAff);
        }
      }

      // 6) Set de QS (sanitizado) na URL
      for (const [k, v] of Object.entries(qs)) {
        const safeValue = this._sanitizeValue(v);
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

  // Lê CSV -> gera allowlist/alias base e aplica overrides do offer (allowlist substitui; alias do offer tem prioridade)
  _rulesFromCsv(map, offerData) {
    const allow = new Set();
    const alias = {};
    if (map?.parameters && typeof map.parameters === 'object') {
      for (const [key, rec] of Object.entries(map.parameters)) {
        const include = this._toBool(rec.include_in_checkout) || this._toBool(rec.include_in_checkout_default);
        if (include) {
          allow.add(key);
          const a = (rec.alias || '').trim();
          if (a) alias[key] = a;
        }
      }
    } else {
      throw new Error('CSV vazio ou schema inesperado');
    }
    return this._applyOfferOverrides(offerData, allow, alias);
  }

  _applyOfferOverrides(offerData, baseAllow, baseAlias) {
    const offerAllow = Array.isArray(offerData?.parameterAllowlist) ? new Set(offerData.parameterAllowlist) : null;
    const offerMap = offerData?.parameterMap && typeof offerData.parameterMap === 'object' ? offerData.parameterMap : null;

    // Allowlist: se oferta fornecer, substitui completamente a base; caso contrário, mantém a base
    const allowlist = offerAllow ? offerAllow : new Set([...baseAllow]);

    // Alias: base + offer (offer tem prioridade nas colisões)
    const aliasMap = { ...baseAlias, ...(offerMap || {}) };

    return { allowlist, aliasMap };
  }

  _heuristicAllowlist() {
    return new Set([
      'user_id',
      'gclid',
      'fbclid',
      'dclid',
      'ttclid',
      'anon_id',
      'cid',
      'campaignkey',
      'click_timestamp',
      'timestamp',
      // UTMs (resiliente)
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      // Afiliado (tracking pode sobrescrever somente se permitido)
      'affiliate',
    ]);
  }

  _heuristicAliasMap() {
    return {
      // Mapeamentos Sidx (fallback)
      user_id: 'sid1',
      gclid: 'sid2',
      fbclid: 'sid3',
      anon_id: 'sid4',
      // Mapeamentos 1:1/nominais
      cid: 'cid',
      campaignkey: 'campaignkey',
      utm_source: 'utm_source',
      utm_medium: 'utm_medium',
      utm_campaign: 'utm_campaign',
      utm_term: 'utm_term',
      utm_content: 'utm_content',
      // Afiliado
      affiliate: 'aff',
      affiliate_id: 'aff',
      ref: 'aff',
      refid: 'aff',
      tag: 'aff',
      aid: 'aff',
    };
  }

  _buildQueryParamsDataDriven(trackingParams = {}, rules = { allowlist: new Set(), aliasMap: {} }) {
    const { allowlist, aliasMap } = rules;
    const out = {};

    for (const [srcKey, rawVal] of Object.entries(trackingParams)) {
      if (!allowlist.has(srcKey)) continue; // somente chaves de entrada permitidas
      if (this._isNullishValue(rawVal)) continue;
      const destKey = aliasMap[srcKey] || srcKey;
      out[destKey] = String(rawVal);
    }
    return out;
  }

  _sanitizeValue(v) {
    return String(v).trim().substring(0, 100).replace(/[^a-zA-Z0-9._\-]/g, '_');
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

  // =========================================================
  // =================  WEBHOOK (AUTH KEY) ===================
  // =========================================================

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
}

module.exports = Digistore24Adapter;