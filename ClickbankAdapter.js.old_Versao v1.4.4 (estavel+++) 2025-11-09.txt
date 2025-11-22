console.log('--- [BOOT CHECK] Loading ClickbankAdapter v1.3.4-DR6f (CSV single-source + strict offerAllow + placeholder hardening) ---');
/**
 * PZ Advisors - Clickbank Adapter
 * Nome/Versão: ClickbankAdapter v1.3.4-DR6f
 * Data: 2025-11-09
 *
 * Alterações vs v1.3.3-DR6e
 * - Hardening de _appendParamsToUrl para suportar corretamente hoplinks com placeholder:
 *   • "?tid=[TRACKING_ID]" → remove o par "tid=[TRACKING_ID]" antes de montar a URL e repõe tid via searchParams.
 *   • "?[TRACKING_ID]"     → remove o placeholder “nu” e injeta tid via searchParams (evita "U999=" fantasma).
 * - Mantém: Fonte Única CSV (ParamMapLoaderCsv), override estrito do offerAllow, alias do offer,
 *   webhook HMAC+AES endurecido, extração gclid_/fbclid_/tid_, e SCRAPER opcional.
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// Resolve o loader do CSV, aceitando várias "formas"
function _resolveParamLoaderModule() {
  try {
    const mod = require('./ParamMapLoaderCsv');
    const cand = mod?.default || mod;

    // 1) Objeto com .load
    if (cand && typeof cand.load === 'function') return cand;

    // 2) Classe / construtora
    if (typeof cand === 'function') {
      try {
        const inst = new cand();
        if (inst && typeof inst.load === 'function') {
          return { load: (url) => inst.load(url) };
        }
      } catch (_) {
        try {
          const inst2 = cand();
          if (inst2 && typeof inst2.load === 'function') {
            return { load: (url) => inst2.load(url) };
          }
        } catch (_) {}
      }
    }

    // 3) getInstance()
    if (cand && typeof cand.getInstance === 'function') {
      const inst3 = cand.getInstance();
      if (inst3 && typeof inst3.load === 'function') {
        return { load: (url) => inst3.load(url) };
      }
    }
  } catch (_) {}
  return null;
}

class ClickbankAdapter extends PlatformAdapterBase {
  /**
   * @param {Object} [opts]
   * @param {{load:(url:string)=>Promise<any>}} [opts.paramLoader]
   */
  constructor(opts = {}) {
    super();
    this.version = '1.3.4-DR6f';
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

    // 3) Hoplink final (respeita placeholder, agora endurecido)
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

      const toAbs = (u) => {
        try {
          return new URL(u, base).toString();
        } catch {
          return null;
        }
      };
      const isCb = (url) => {
        try {
          const h = new URL(url).hostname;
          return CB_HOSTS.some((p) => h.includes(p));
        } catch {
          return false;
        }
      };

      for (const sel of CANDIDATES) {
        $(sel).each((_, el) => {
          const raw = $(el).attr('href') || $(el).attr('action') || $(el).attr('src');
          const abs = toAbs(raw);
          if (abs && isCb(abs)) found.add(abs);
        });
      }

      const scripts = $('script')
        .map((_, s) => $(s).html() || '')
        .get()
        .join('\n');
      const bodyText = `${html}\n${scripts}`;
      const urlRegex =
        /\bhttps?:\/\/[^\s"'<>]+?(?:pay\.clickbank\.net|clkbank\.com)[^\s"'<>]*/gi;
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
   */
  async _loadParamRules(offerData) {
    const offerAllow = this._safeArray(offerData?.parameterAllowlist);
    const offerMap =
      offerData?.parameterMap && typeof offerData.parameterMap === 'object'
        ? offerData.parameterMap
        : null;

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

    // Se há override por oferta, ele é a base (restritivo); senão usa CSV/heurístico
    const allowlistBase = offerAllow.length ? new Set(offerAllow) : baseAllow;

    // Garante que chaves de alias e sinônimos de affiliate entram na allowlist final
    const affiliateSynonyms = ['affiliate', 'affiliate_id', 'ref', 'refid', 'tag', 'aid', 'aff'];
    const offerAliasKeys = offerMap ? Object.keys(offerMap) : [];
    const allowlistFinal = new Set([...allowlistBase, ...offerAliasKeys, ...affiliateSynonyms]);

    // Alias final: base + offer (offer tem prioridade)
    const aliasMapFinal = { ...baseAlias, ...(offerMap || {}) };

    return { allowlist: allowlistFinal, aliasMap: aliasMapFinal };
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

  _safeArray(v) {
    return Array.isArray(v) ? v : [];
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
      if (!allowlist.has(k)) continue;
      if (this._isNullishValue(v)) continue;
      const target = aliasMap[k] || k;
      out[target] = String(v);
    }

    // normalização tardia (compatibilidade)
    if (out.affiliate && !out.aff) {
      out.aff = out.affiliate;
      delete out.affiliate;
    }
    return out;
  }

  /**
   * Hardening para placeholders:
   * - Remove "tid=[TRACKING_ID]" (com ? ou &) antes de montar a URL.
   * - Remove "?[TRACKING_ID]" (placeholder nu) antes de montar a URL.
   * - Injeta sempre 'tid' via searchParams (sem criar chave fantasma "U999=").
   */
  _appendParamsToUrl(base, params = {}) {
    const tid = params.tid || '';
    let cleanBase = base;

    if (base.includes('[TRACKING_ID]')) {
      // Remove pares "tid=[TRACKING_ID]" precedidos por ? ou &, preservando corretamente a query
      cleanBase = cleanBase.replace(/([?&])tid=\[TRACKING_ID\](?:&)?/i, (m, sep) => {
        // se havia apenas "?tid=[TRACKING_ID]" no fim, substitui por ""; se havia "&", também limpa
        return sep === '?' ? '?' : '';
      });

      // Remove placeholder nu "?[TRACKING_ID]" (no início da query)
      cleanBase = cleanBase.replace(/\?\[TRACKING_ID\](?:&)?/i, (m) => {
        // se só havia o placeholder, remove completamente o '?'
        return '';
      });

      // Remove placeholder nu "&[TRACKING_ID]" se aparecer no meio (por segurança)
      cleanBase = cleanBase.replace(/&\[TRACKING_ID\](?:&)?/i, '');

      // Limpa possíveis finais inválidos '?', '&' ou '?&'
      cleanBase = cleanBase.replace(/[?&]$/, '');
      cleanBase = cleanBase.replace(/\?&/, '?');
    }

    const u = new URL(cleanBase);

    // Garante 'tid' (se ainda não presente na URL)
    if (tid && !u.searchParams.has('tid')) {
      u.searchParams.set('tid', tid);
    }

    // Injeta os demais parâmetros (sem duplicar 'tid')
    for (const [k, v] of Object.entries(params)) {
      if (k === 'tid') continue;
      if (!u.searchParams.has(k)) u.searchParams.set(k, v);
    }

    return u.toString();
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
        out.gclid = s.replace(/^gclid_/i, '');
      } else if (!out.fbclid && /^fbclid_/i.test(s)) {
        out.fbclid = s.replace(/^fbclid_/i, '');
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
        status = 'paid';
        break;
      case 'RFND':
      case 'TEST_RFND':
        status = 'refunded';
        break;
      case 'CGBK':
      case 'TEST_CGBK':
        status = 'chargeback';
        break;
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
