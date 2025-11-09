console.log('--- [BOOT CHECK] Loading Digistore24Adapter v1.3.4-DR6e (CSV single-source + strict offerAllow override + affiliate fix) ---');
/**
 * PZ Advisors - Digistore24 Adapter
 * Nome/Versão: Digistore24Adapter v1.3.4-DR6e
 * Data: 2025-11-09
 *
 * Alterações vs v1.2.2
 * - CSV como "fonte única" com loader flexível (getInstance().mapTrackingToPlatform OU load() -> schema.parameters)
 * - offer.parameterAllowlist agora **substitui** a allowlist base (não faz união)
 * - offer.parameterMap tem prioridade e é aplicado **após** normalização de sinônimos (affiliate → aff)
 * - Correção: valor de affiliate vindo do tracking (quando permitido) **aparece como aff**;
 *   se ausente no tracking, cai no offerData.affiliate_id (padrão)
 * - Heurísticas de allowlist/alias para Digistore24 preservadas (sid1..sid4, cid, campaignkey, utm_*)
 * - Sanitização de valores (trim + cap a 100 chars + replace de caracteres não permitidos) mantida
 * - Webhook S2S (auth_key + timingSafeEqual) mantido
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// ============================
// Param Loader Resolver (flex)
// ============================
function resolveParamLoader() {
  try {
    const mod = require('./ParamMapLoaderCsv');
    const cand = mod?.default || mod;

    // Caso clássico: singleton com getInstance().mapTrackingToPlatform
    if (cand && typeof cand.getInstance === 'function') {
      const inst = cand.getInstance();
      if (inst && typeof inst.mapTrackingToPlatform === 'function') {
        return { mode: 'singleton-map', instance: inst };
      }
    }

    // Caso alternativo: exporta .load() que retorna objeto com schema.parameters
    if (cand && typeof cand.load === 'function') {
      return { mode: 'loader', instance: cand };
    }
  } catch (_) {
    // sem módulo → segue heurística
  }
  return null;
}

// ================
// Heurísticas base
// ================
function heuristicAllowlist() {
  return new Set([
    'user_id',
    'gclid',
    'fbclid',
    'anon_id',
    'affiliate',
    'affiliate_id',
    'ref',
    'refid',
    'tag',
    'aid',
    'cid',
    'campaignkey',
    'utm_source',
    'utm_medium',
  ]);
}

function heuristicAliasMap() {
  return {
    user_id: 'sid1',
    gclid: 'sid2',
    fbclid: 'sid3',
    anon_id: 'sid4',
    affiliate: 'aff',
    affiliate_id: 'aff',
    ref: 'aff',
    refid: 'aff',
    tag: 'aff',
    aid: 'aff',
    cid: 'cid',
    campaignkey: 'campaignkey',
    utm_source: 'utm_source',
    utm_medium: 'utm_medium',
  };
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return /^true|1|yes|y$/i.test(v.trim());
  return false;
}

function isNullishValue(val) {
  if (val == null) return true;
  const s = String(val).trim().toLowerCase();
  return s === '' || s === 'null' || s === 'undefined' || s === 'none' || s === 'na' || s === 'n/a';
}

// Mapeamento hardcoded legado (fallback final)
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
  // tentativa de affiliate
  if (trackingParams.affiliate) {
    const val = String(trackingParams.affiliate).trim();
    if (val) out.aff = val.substring(0, 100).replace(/[^a-zA-Z0-9._\-]/g, '_');
  }
  return out;
}

class Digistore24Adapter extends PlatformAdapterBase {
  constructor() {
    super();
    this.version = '1.3.4-DR6e';
    this.logPrefix = `[Digistore24Adapter v${this.version}]`;

    this.AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
    if (!this.AUTH_KEY) {
      console.warn(`${this.logPrefix} Variável DIGISTORE_AUTH_KEY não configurada. Webhooks S2S falharão.`);
    }

    this.PARAM_MAP_URL = process.env.PZ_PARAMETER_MAP_URL || 'https://pzadvisors.com/wp-content/uploads/pz_parameter_map.csv';
    this.FORCE_HEURISTIC = String(process.env.PZ_PARAMETER_FORCE_HEURISTIC || '0') === '1';
    this._loader = resolveParamLoader();
  }

  // ===============================
  // ===== BUILD CHECKOUT (DR) =====
  // ===============================
  async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
    // 1) Base URL (product_id → canonical URL)
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

    console.log(`${this.logPrefix} Construindo URL de checkout para base: ${baseUrl.split('?')[0]}...`);

    try {
      const urlObj = new URL(baseUrl);

      // 2) Carrega regras (CSV → allowlist/alias) com override do offer
      const rules = await this._loadParamRules(offerData);

      // 3) Monta parâmetros mapeados a partir de trackingParams conforme regras
      let qs = this._buildQueryParamsDataDriven(trackingParams, rules);

      // 3.1) Affiliate default do offer, somente se ainda não definido pelo tracking
      const affiliateDefault = offerData.affiliate_id ? String(offerData.affiliate_id).trim() : '';
      if (affiliateDefault && !qs.aff) {
        qs.aff = affiliateDefault.substring(0, 100).replace(/[^a-zA-Z0-9._\-]/g, '_');
      }

      // 4) Grava na URL (sanitização final)
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

  async _loadParamRules(offerData) {
    const offerAllow = safeArray(offerData?.parameterAllowlist);
    const offerMap = offerData?.parameterMap && typeof offerData.parameterMap === 'object' ? offerData.parameterMap : null;

    let baseAllow = heuristicAllowlist();
    let baseAlias = heuristicAliasMap();

    if (!this.FORCE_HEURISTIC && this._loader) {
      try {
        if (this._loader.mode === 'singleton-map') {
          // o singleton já sabe mapear; usamos heurística apenas para allowlist base
          // (mantemos heurística de allowlist para evitar depender de schema de CSV aqui)
        } else if (this._loader.mode === 'loader') {
          const map = await this._loader.instance.load(this.PARAM_MAP_URL);
          if (map?.parameters && typeof map.parameters === 'object') {
            const newAllow = new Set();
            const newAlias = {};
            for (const [key, rec] of Object.entries(map.parameters)) {
              const include = toBool(rec.include_in_checkout) || toBool(rec.include_in_checkout_default);
              if (include) {
                newAllow.add(key);
                const alias = (rec.alias || '').trim();
                if (alias) newAlias[key] = alias;
              }
            }
            if (newAllow.size) baseAllow = newAllow;
            if (Object.keys(newAlias).length) baseAlias = { ...baseAlias, ...newAlias };
          } else {
            throw new Error('CSV vazio ou schema inesperado');
          }
        }
      } catch (err) {
        console.warn(`${this.logPrefix} Falha ao ler CSV (${this.PARAM_MAP_URL}). Usando heurística.`, err?.message || err);
      }
    } else if (this.FORCE_HEURISTIC) {
      console.log(`${this.logPrefix} FORCE_HEURISTIC=1 -> ignorando CSV e usando heurística.`);
    }

    // Normaliza sinônimos de affiliate para 'aff' **antes** do offerMap
    const affiliateSynonyms = ['affiliate', 'affiliate_id', 'ref', 'refid', 'tag', 'aid', 'aff'];
    affiliateSynonyms.forEach((k) => (baseAlias[k] = 'aff'));

    // offerAllow **substitui** baseAllow (não unir)
    const allowlistFinal = offerAllow.length ? new Set(offerAllow) : baseAllow;

    // alias: base + offerMap (offer tem prioridade)
    const aliasMapFinal = { ...baseAlias, ...(offerMap || {}) };

    // Garante que chaves do offerMap entrem na allowlist (para não bloquear por engano)
    if (offerMap) {
      Object.keys(offerMap).forEach((k) => allowlistFinal.add(k));
    }

    return { allowlist: allowlistFinal, aliasMap: aliasMapFinal };
  }

  _buildQueryParamsDataDriven(trackingParams = {}, rules) {
    const { allowlist, aliasMap } = rules || { allowlist: new Set(), aliasMap: {} };
    const out = {};

    for (const [k, v] of Object.entries(trackingParams)) {
      if (!allowlist.has(k)) continue;
      if (isNullishValue(v)) continue;
      const target = aliasMap[k] || k;
      const value = String(v);
      out[target] = value;
    }

    // Normalização tardia para affiliate
    if (out.affiliate && !out.aff) {
      out.aff = out.affiliate;
      delete out.affiliate;
    }

    return out;
  }

  // ===============================
  // ========= WEBHOOK S2S =========
  // ===============================
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
      eventTimestamp: payload.timestamp ? new Date(payload.timestamp.replace(' ', 'T') + 'Z') : new Date(),
      receivedTimestamp: new Date(),
      _rawPayload: this.safeLog(payload),
    };
  }
}

module.exports = Digistore24Adapter;