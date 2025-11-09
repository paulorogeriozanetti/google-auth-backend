console.log('--- [BOOT CHECK] Loading ClickbankAdapter v1.3.3-DR6e (CSV single-source + strict offerAllow override) ---');
/**
 * PZ Advisors - Clickbank Adapter
 * Nome/Versão: ClickbankAdapter v1.3.3-DR6e
 * Data: 2025-11-09
 *
 * Alterações vs v1.3.1-DR6c / v1.3.2-DR6d
 * - Corrige a REGRESSÃO no "OfferData override": quando offer.parameterAllowlist (ou parameterMap) existe,
 *   o allowlist passa a ser ESTRITO ao definido pelo offer (∪ keys(parameterMap) ∪ sinônimos de affiliate ∪ ['tid','user_id']),
 *   sem herdar CSV/heurística (elimina inclusão indevida, ex.: utm_medium).
 * - Mantém: CSV como fonte única (quando disponível), loader flexível, FORCE_HEURISTIC, scraper opcional,
 *   HMAC hardening, guard de body vazio, extração correta de gclid_/fbclid_/tid_.
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// Resolve diferentes "shapes" possíveis do módulo ParamMapLoaderCsv
function _resolveParamLoaderModule() {
  try {
    const mod = require('./ParamMapLoaderCsv');
    const cand = mod?.default || mod;

    // Objeto/singleton com .load
    if (cand && typeof cand.load === 'function') return cand;

    // Classe/fábrica que fornece instância com .load
    if (typeof cand === 'function') {
      try {
        const inst = new cand();
        if (inst && typeof inst.load === 'function') return { load: (url) => inst.load(url) };
      } catch (_) {
        try {
          const inst2 = cand();
          if (inst2 && typeof inst2.load === 'function') return { load: (url) => inst2.load(url) };
        } catch (_) { /* ignore */ }
      }
    }

    // Padrão getInstance()
    if (cand && typeof cand.getInstance === 'function') {
      const inst3 = cand.getInstance();
      if (inst3 && typeof inst3.load === 'function') return { load: (url) => inst3.load(url) };
    }
  } catch (_) { /* ignore */ }
  return null;
}

class ClickbankAdapter extends PlatformAdapterBase {
  /**
   * @param {Object} [opts]
   * @param {{load:(url:string)=>Promise<any>}} [opts.paramLoader]
   */
  constructor(opts = {}) {
    super();
    this.version = '1.3.3-DR6e';
    this.logPrefix = `[ClickbankAdapter v${this.version}]`;
    this.WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY || '';
    this.SCRAPER_MODE = String(process.env.CB_SCRAPER_MODE || 'off').toLowerCase();
    this.PARAM_MAP_URL =
      process.env.PZ_PARAMETER_MAP_URL ||
      'https://pzadvisors.com/wp-content/uploads/pz_parameter_map.csv';
    this.FORCE_HEURISTIC = String(process.env.PZ_PARAMETER_FORCE_HEURISTIC || '0') === '1';

    const resolved = _resolveParamLoaderModule();
    this.paramLoader =
      opts.paramLoader && typeof opts.paramLoader.load === 'function'
        ? opts.paramLoader
        : resolved;

    console.log(`${this.logPrefix} Scraper Mode: ${this.SCRAPER_MODE}`);
  }

  // =========================================================
  // ===============  BUILD CHECKOUT (DATA-DRIVEN) ===========
  // =========================================================

  /**
   * @returns {Promise<string | string[] | null>} string (hoplink) | array (scraped) | null
   */
  async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
    const baseUrl = offerData?.hoplink;
    if (!baseUrl) {
      console.warn(`${this.logPrefix} 'hoplink' ausente no offerData.`);
      return null;
    }

    // 1) Regras CSV (fonte única) com fallback heurístico
    const rules = await this._loadParamRules(offerData);

    // 2) Monta QS data-driven
    const paramsData = this._buildQueryParamsDataDriven(trackingParams, rules);

    // 3) Hoplink final (respeita placeholder [TRACKING_ID])
    let trackedHoplink;
    try {
      trackedHoplink = this._appendParamsToUrl(baseUrl, paramsData);
    } catch (e) {
      console.error(`${this.logPrefix} Hoplink inválido: ${baseUrl}`, e);
      return null;
    }

    // 4) Sem scraper → retorna hoplink data-driven
    if (this.SCRAPER_MODE !== 'on') {
      console.log(`${this.logPrefix} SCRAPER_MODE=off -> Retornando hoplink data-driven.`);
      return trackedHoplink;
    }

    // 5) Scraper robusto para pay.clickbank.net/clkbank.com (injeta QS em todos)
    try {
      const [{ default: axios }, cheerio] = await Promise.all([
        import('axios'),
        import('cheerio'),
      ]);

      const resp = await axios.get(trackedHoplink, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: trackedHoplink,
        },
        maxRedirects: 5,
        timeout: 10000,
      });

      const html = resp.data || '';
      const $ = cheerio.load(html);
      const base = resp.request?.res?.responseUrl || trackedHoplink;

      const CANDIDATES = ['a[href]', 'form[action]', 'iframe[src]'];
      const CB_HOSTS = ['pay.clickbank.net', 'clkbank.com'];
      const found = new Set();

      const toAbs = (u) => { try { return new URL(u, base).toString(); } catch { return null; } };
      const isCb = (url) => {
        try {
          const h = new URL(url).hostname;
          return CB_HOSTS.some((p) => h.includes(p));
        } catch { return false; }
      };

      for (const sel of CANDIDATES) {
        $(sel).each((_, el) => {
          const raw = $(el).attr('href') || $(el).attr('action') || $(el).attr('src');
          const abs = toAbs(raw);
          if (abs && isCb(abs)) found.add(abs);
        });
      }

      const scripts = $('script').map((_, s) => $(s).html() || '').get().join('\n');
      const bodyText = `${html}\n${scripts}`;
      const urlRegex = /\bhttps?:\/\/[^\s"'<>]+?(?:pay\.clickbank\.net|clkbank\.com)[^\s"'<>]*/gi;
      let m;
      while ((m = urlRegex.exec(bodyText)) !== null) {
        const abs = toAbs(m[0]);
        if (abs && isCb(abs)) found.add(abs);
      }

      const enriched = Array.from(found)
        .map((u) => this._appendParamsToUrl(u, paramsData))
        .filter(Boolean)
        .slice(0, 3);

      if (enriched.length) return enriched;
      console.warn(`${this.logPrefix} SCRAPE não encontrou links ClickBank. Fallback hoplink.`);
      return trackedHoplink;
    } catch (e) {
      console.error(`${this.logPrefix} Erro no SCRAPER:`, e?.message || e);
      return trackedHoplink;
    }
  }

  /**
   * Lê allowlist/aliases do CSV (fonte única). Se indisponível ou FORCE_HEURISTIC=1, usa heurística.
   * Regras de fusão:
   *  - Sem override do offer: allowlist = CSV.allowlist (ou heurística); alias = CSV.alias ∪ heurística.
   *  - Com override (parameterAllowlist OU parameterMap): allowlist é ESTRITO ao offer:
   *      allowlist = offer.parameterAllowlist ∪ keys(offer.parameterMap) ∪ ['tid','user_id'] ∪ sinônimosAffiliate
   *      alias     = { ...baseAlias, ...offer.parameterMap } // offer tem prioridade
   */
  async _loadParamRules(offerData) {
    // overrides do offer (maior prioridade)
    const offerAllow = this._safeArray(offerData?.parameterAllowlist);
    const offerMap =
      offerData?.parameterMap && typeof offerData.parameterMap === 'object'
        ? offerData.parameterMap
        : null;

    // 1) Coleta base (CSV ou heurística)
    let csvAllow = new Set();
    let csvAlias = {};
    if (!this.FORCE_HEURISTIC) {
      try {
        if (!this.paramLoader || typeof this.paramLoader.load !== 'function') {
          throw new Error('ParamMapLoaderCsv incompatível ou ausente');
        }
        const map = await this.paramLoader.load(this.PARAM_MAP_URL);
        if (map?.parameters && typeof map.parameters === 'object') {
          for (const [key, rec] of Object.entries(map.parameters)) {
            const include =
              this._toBool(rec.include_in_checkout) ||
              this._toBool(rec.include_in_checkout_default);
            if (include) {
              csvAllow.add(key);
              const alias = (rec.alias || '').trim();
              if (alias) csvAlias[key] = alias;
            }
          }
        } else {
          throw new Error('CSV vazio ou schema inesperado');
        }
      } catch (err) {
        console.warn(
          `${this.logPrefix} Falha ao ler CSV (${this.PARAM_MAP_URL}). Usando heurística.`,
          err?.message || err
        );
      }
    } else {
      console.log(`${this.logPrefix} FORCE_HEURISTIC=1 -> ignorando CSV e usando heurística.`);
    }

    const baseAllow = csvAllow.size ? csvAllow : this._heuristicAllowlist();
    const baseAlias = Object.keys(csvAlias).length ? csvAlias : this._heuristicAliasMap();

    // 2) Offer override: allowlist ESTRITO ao offer
    const affiliateSynonyms = ['affiliate', 'affiliate_id', 'ref', 'refid', 'tag', 'aid', 'aff'];
    const offerAliasKeys = offerMap ? Object.keys(offerMap) : [];
    const hasOfferOverride = (offerAllow.length > 0) || (offerAliasKeys.length > 0);

    if (hasOfferOverride) {
      const allowlistFinal = new Set([
        ...offerAllow,
        ...offerAliasKeys,
        'tid',
        'user_id',
        ...affiliateSynonyms, // só permite entrada; destino via alias abaixo
      ]);
      const aliasMapFinal = { ...baseAlias, ...(offerMap || {}) }; // offer vence
      return { allowlist: allowlistFinal, aliasMap: aliasMapFinal };
    }

    // 3) Sem override → usa base
    return { allowlist: new Set([...baseAllow]), aliasMap: { ...baseAlias } };
  }

  _heuristicAllowlist() {
    return new Set([
      'tid',
      'user_id',
      'aff',
      'affiliate',
      'affiliate_id',
      'ref',
      'refid',
      'tag',
      'aid',
      'gclid',
      'dclid',
      'fbclid',
      'ttclid',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'campaignkey',
      'sid',
      'sid1',
      'sid2',
      'sid3',
      'sid4',
      'anon_id',
      'click_timestamp',
      'timestamp',
    ]);
  }

  _heuristicAliasMap() {
    return {
      affiliate: 'aff',
      affiliate_id: 'aff',
      ref: 'aff',
      refid: 'aff',
      tag: 'aff',
      aid: 'aff',
    };
  }

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

  _buildQueryParamsDataDriven(trackingParams = {}, rules) {
    const { allowlist, aliasMap } = rules || { allowlist: new Set(), aliasMap: {} };
    const out = {};

    // user_id → tid (sempre)
    const userId = trackingParams.user_id;
    if (userId && !this._isNullishValue(userId)) {
      out.tid = String(userId).slice(0, 100);
    }

    for (const [k, v] of Object.entries(trackingParams)) {
      if (k === 'user_id') continue;
      if (!allowlist.has(k)) continue;       // valida pela chave de ENTRADA
      if (this._isNullishValue(v)) continue;
      const target = aliasMap[k] || k;       // aplica alias (offer tem prioridade)
      out[target] = String(v);
    }

    // fallback gentil para affiliate → aff
    if (out.affiliate && !out.aff) {
      out.aff = out.affiliate;
      delete out.affiliate;
    }
    return out;
  }

  _appendParamsToUrl(base, params = {}) {
    const hasPlaceholder = base.includes('[TRACKING_ID]');
    const tid = params.tid || '';

    if (hasPlaceholder) {
      const replaced = base.replace('[TRACKING_ID]', encodeURIComponent(tid || 'NO_USER_ID'));
      const u = new URL(replaced);
      for (const [k, v] of Object.entries(params)) {
        if (k === 'tid') continue;
        if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      }
      return u.toString();
    }

    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) {
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  // =========================================================
  // =================  WEBHOOK (HMAC + AES) =================
  // =========================================================

  async verifyWebhook(rawBodyBuffer, headers) {
    if (!this.WEBHOOK_SECRET_KEY) {
      console.error(`${this.logPrefix} Webhook falhou: CLICKBANK_WEBHOOK_SECRET_KEY não configurada.`);
      return null;
    }
    if (!rawBodyBuffer || !headers) {
      console.warn(`${this.logPrefix} Webhook sem body ou headers.`);
      return null;
    }
    if (Buffer.isBuffer(rawBodyBuffer) && rawBodyBuffer.length === 0) {
      console.warn(`${this.logPrefix} Webhook com body vazio.`);
      return null;
    }

    const signatureHeader = headers['x-clickbank-signature'] || headers['x-cb-signature'];
    const ivHeader = headers['x-clickbank-cbsig-iv'] || headers['x-cb-iv'];
    if (!signatureHeader || !ivHeader) {
      console.warn(`${this.logPrefix} Webhook sem assinatura ou IV.`);
      return null;
    }

    try {
      // 1) HMAC
      const hmac = crypto.createHmac('sha256', this.WEBHOOK_SECRET_KEY);
      hmac.update(rawBodyBuffer);
      const calcBuf = Buffer.from(hmac.digest('hex'), 'hex');

      const sigBuf = this._decodeSignature(signatureHeader);
      if (!sigBuf || sigBuf.length !== calcBuf.length || !crypto.timingSafeEqual(sigBuf, calcBuf)) {
        console.warn(`${this.logPrefix} Assinatura HMAC inválida.`);
        return null;
      }
      console.log(`${this.logPrefix} HMAC OK.`);

      // 2) Decifragem
      const iv = Buffer.from(ivHeader, 'base64');
      const key = crypto.createHash('sha256').update(this.WEBHOOK_SECRET_KEY).digest();
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(rawBodyBuffer, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      const payload = JSON.parse(decrypted);

      // 3) Normalização
      const normalized = this._normalizeWebhookPayload(payload);
      console.log(`${this.logPrefix} Webhook OK.`, this.safeLog(normalized));
      return normalized;
    } catch (err) {
      console.error(`${this.logPrefix} Erro ao processar webhook:`, err?.message || err);
      return null;
    }
  }

  _decodeSignature(sig) {
    const hexRe = /^[0-9a-f]+$/i;
    try {
      // Preferimos base64 quando contém '=' ou não é hexa puro
      if (!hexRe.test(sig) || sig.includes('=')) {
        const b64 = Buffer.from(sig, 'base64');
        if (b64.length) return b64;
      }
    } catch {}
    try {
      const hex = Buffer.from(sig, 'hex');
      if (hex.length) return hex;
    } catch {}
    return null;
  }

  _extractFromTrackingCodes(codes = []) {
    const out = { gclid: null, fbclid: null, tidFromCodes: null };
    if (!Array.isArray(codes)) return out;

    for (const sRaw of codes) {
      const s = String(sRaw || '');
      if (!out.gclid && /^gclid_/i.test(s)) {
        out.gclid = s.replace(/^gclid_/i, ''); // remove "gclid_"
      } else if (!out.fbclid && /^fbclid_/i.test(s)) {
        out.fbclid = s.replace(/^fbclid_/i, ''); // remove "fbclid_"
      } else if (!out.tidFromCodes && /^tid_/i.test(s)) {
        out.tidFromCodes = s.replace(/^tid_/i, '');
      }
    }
    return out;
  }

  _extractUserIdFromTid(tid = '') {
    const t = String(tid || '').trim();
    return t || null;
  }

  _normalizeWebhookPayload(payload) {
    const {
      transactionType,
      receipt,
      transactionTime,
      currency,
      totalOrderAmount,
      vendorVariables,
      trackingCodes,
      lineItems,
      customer,
    } = payload || {};

    const { gclid, fbclid, tidFromCodes } = this._extractFromTrackingCodes(trackingCodes);
    const vendorTid = vendorVariables?.tid_ || null;
    const trackingId = this._extractUserIdFromTid(vendorTid || tidFromCodes);

    let status = 'other';
    switch (transactionType) {
      case 'SALE':
      case 'TEST_SALE':
        status = 'paid'; break;
      case 'RFND':
      case 'TEST_RFND':
        status = 'refunded'; break;
      case 'CGBK':
      case 'TEST_CGBK':
        status = 'chargeback'; break;
    }

    const first = Array.isArray(lineItems) && lineItems.length ? lineItems[0] : {};
    const safeEmail = customer?.billing?.email || null;

    return {
      platform: 'clickbank',
      transactionId: receipt,
      orderId: receipt,
      trackingId,
      status,
      productSku: first.itemNo ?? 'N/A',
      amount: totalOrderAmount ?? first.accountAmount ?? 0,
      currency: currency || 'USD',
      customerEmail: safeEmail,
      eventTimestamp: transactionTime ? new Date(transactionTime) : new Date(),
      receivedTimestamp: new Date(),
      gclid: gclid || null,
      fbclid: fbclid || null,
      _rawPayload: this.safeLog(payload),
    };
  }
}

module.exports = ClickbankAdapter;