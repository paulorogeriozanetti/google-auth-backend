console.log('--- [BOOT CHECK] Loading ClickbankAdapter v1.2.8-DR6 (single-source CSV rules + fixes) ---');
/**
 * PZ Advisors - Clickbank Adapter
 * Nome/Versão: ClickbankAdapter v1.2.8-DR6
 * Data: 2025-11-08
 * Mudanças desta versão (em relação ao v1.2.7-DR5):
 * - PRIORIDADE 4 mantida: regras DATA-DRIVEN lidas do CSV único (ParamMapLoaderCsv).
 * - Corrige extração de trackingCodes: remove off-by-one (gclid_/fbclid_).
 * - Hardening do webhook:
 *   - Guard para body vazio (Buffer.length === 0) e headers nulos.
 *   - Aceita assinatura HMAC em HEX ou BASE64 (decodificação robusta).
 * - Mantém SCRAPER opcional (CB_SCRAPER_MODE=on) e injeta TODOS parâmetros data-driven nas URLs raspadas.
 * - Compatível com allowlist/aliases do CSV (ex.: affiliate→aff), com fallback heurístico caso CSV indisponível.
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');
const ParamMapLoaderCsv = require('./ParamMapLoaderCsv'); // Fonte única da verdade (mesmo CSV do Digistore)

class ClickbankAdapter extends PlatformAdapterBase {
  constructor() {
    super();
    this.version = '1.2.8-DR6';
    this.logPrefix = `[ClickbankAdapter v${this.version}]`;
    this.WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY || '';
    this.SCRAPER_MODE = String(process.env.CB_SCRAPER_MODE || 'off').toLowerCase();
    this.PARAM_MAP_URL =
      process.env.PZ_PARAMETER_MAP_URL ||
      'https://pzadvisors.com/wp-content/uploads/pz_parameter_map.csv'; // default público do WP
    console.log(`${this.logPrefix} Scraper Mode: ${this.SCRAPER_MODE}`);
  }

  // =========================================================
  // ===============  BUILD CHECKOUT (DATA-DRIVEN) ===========
  // =========================================================

  /**
   * Constrói a URL final de checkout/hoplink do ClickBank:
   * 1) Lê regras do CSV (fonte única): allowlist + aliases + include_in_checkout.
   * 2) Mapeia user_id -> tid e aplica aliases (ex.: affiliate→aff).
   * 3) Injeta TODOS parâmetros permitidos no hoplink (e nas URLs raspadas, se SCRAPER on).
   * 4) Se SCRAPER off ou falhar, retorna hoplink data-driven.
   *
   * @returns {Promise<string | string[] | null>} string (hoplink final) | array (scraped) | null
   */
  async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
    const baseUrl = offerData?.hoplink;
    if (!baseUrl) {
      console.warn(`${this.logPrefix} 'hoplink' ausente no offerData.`);
      return null;
    }

    // 1) Carregar regras data-driven (CSV) ou heurística
    const rules = await this._loadParamRules(offerData);

    // 2) Construir o dicionário de parâmetros a propagar, aplicando allowlist + aliases
    const paramsData = this._buildQueryParamsDataDriven(trackingParams, rules);

    // 3) Produzir hoplink com TID e parâmetros data-driven
    let trackedHoplink;
    try {
      trackedHoplink = this._appendParamsToUrl(baseUrl, paramsData);
    } catch (e) {
      console.error(`${this.logPrefix} Hoplink inválido: ${baseUrl}`, e);
      return null;
    }

    // 4) SCRAPER opcional
    if (this.SCRAPER_MODE !== 'on') {
      console.log(`${this.logPrefix} SCRAPER_MODE=off -> Retornando hoplink data-driven.`);
      return trackedHoplink;
    }

    // 5) Scrape robusto (carregamento dinâmico)
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

      if (enriched.length) {
        return enriched; // ARRAY de URLs de checkout com parâmetros injetados
      }
      console.warn(`${this.logPrefix} SCRAPE não encontrou links ClickBank. Fallback hoplink.`);
      return trackedHoplink;
    } catch (e) {
      console.error(`${this.logPrefix} Erro no SCRAPER:`, e?.message || e);
      return trackedHoplink;
    }
  }

  /**
   * Carrega regras a partir do CSV (fonte única) ou usa heurística.
   * - allowlist: Set de parâmetros permitidos
   * - aliasMap: Map de substituições (ex.: affiliate→aff)
   * - offer overrides: offerData.parameterAllowlist / parameterMap (se fornecidos)
   */
  async _loadParamRules(offerData) {
    // 1) Offer-level overrides (quando presentes)
    const offerAllow = this._safeArray(offerData?.parameterAllowlist);
    const offerMap = offerData?.parameterMap && typeof offerData.parameterMap === 'object'
      ? offerData.parameterMap
      : null;

    // 2) CSV (fonte única da verdade)
    let csvAllow = new Set();
    let csvAlias = {};
    try {
      const map = await ParamMapLoaderCsv.load(this.PARAM_MAP_URL);
      // Esperado: map.parameters[key] = { include_in_checkout, alias, ... }
      if (map?.parameters && typeof map.parameters === 'object') {
        for (const [key, rec] of Object.entries(map.parameters)) {
          const include =
            this._toBool(rec.include_in_checkout) ||
            this._toBool(rec.include_in_checkout_default);
          if (include) {
            csvAllow.add(key);
            const alias = (rec.alias || '').trim();
            if (alias) {
              csvAlias[key] = alias;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`${this.logPrefix} Falha ao ler CSV (${this.PARAM_MAP_URL}). Usando heurística.`, err?.message || err);
    }

    // 3) Allowlist + aliases consolidados
    let allowlist = csvAllow.size ? csvAllow : this._heuristicAllowlist();
    let aliasMap = Object.keys(csvAlias).length ? csvAlias : this._heuristicAliasMap();

    // Offer override (mais prioritário)
    if (offerAllow.length) {
      allowlist = new Set(offerAllow);
    }
    if (offerMap) {
      aliasMap = { ...aliasMap, ...offerMap };
    }

    // Normalização de alias especial para affiliate
    // (aceita 'affiliate' e sinônimos, todos → 'aff')
    const affiliateKeys = ['affiliate', 'affiliate_id', 'ref', 'refid', 'tag', 'aid', 'aff'];
    affiliateKeys.forEach((k) => (aliasMap[k] = 'aff'));

    return { allowlist, aliasMap };
  }

  _heuristicAllowlist() {
    // Fallback: parâmetros típicos de tracking e afiliação
    return new Set([
      'tid', 'user_id',
      'aff', 'affiliate', 'affiliate_id', 'ref', 'refid', 'tag', 'aid',
      'gclid', 'dclid', 'fbclid', 'ttclid',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'campaignkey',
      'sid', 'sid1', 'sid2', 'sid3', 'sid4',
      'anon_id', 'click_timestamp', 'timestamp',
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
      // demais sem alias
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

  /**
   * Constrói objeto de QS data-driven a partir de trackingParams, aplicando:
   * - user_id -> tid
   * - allowlist
   * - aliases
   */
  _buildQueryParamsDataDriven(trackingParams = {}, rules) {
    const { allowlist, aliasMap } = rules || { allowlist: new Set(), aliasMap: {} };
    const out = {};

    // Regra fixa: mapear user_id -> tid
    const userId = trackingParams.user_id;
    if (userId && !this._isNullishValue(userId)) {
      out.tid = String(userId).slice(0, 100);
    }

    for (const [k, v] of Object.entries(trackingParams)) {
      if (k === 'user_id') continue; // já mapeado para tid
      if (!allowlist.has(k)) continue;
      if (this._isNullishValue(v)) continue;

      const target = aliasMap[k] || k;
      out[target] = String(v);
    }

    // Deduplicar: se 'aff' e 'affiliate' chegarem, prevalece 'aff'
    if (out.affiliate && !out.aff) {
      out.aff = out.affiliate;
      delete out.affiliate;
    }

    return out;
  }

  /**
   * Aplica params no hoplink (suporta placeholder [TRACKING_ID] -> tid)
   */
  _appendParamsToUrl(base, params = {}) {
    const url = new URL(base);
    const hasPlaceholder = base.includes('[TRACKING_ID]');
    const tid = params.tid || '';

    if (hasPlaceholder) {
      // Substitui placeholder; mantém os demais params via QS.
      const replaced = base.replace('[TRACKING_ID]', encodeURIComponent(tid || 'NO_USER_ID'));
      const u = new URL(replaced);
      for (const [k, v] of Object.entries(params)) {
        if (k === 'tid') continue; // já embutido via placeholder
        if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      }
      return u.toString();
    }

    // Sem placeholder: injeta tudo via searchParams (certificando-se de que tid exista se fornecido)
    for (const [k, v] of Object.entries(params)) {
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  // =========================================================
  // =================  WEBHOOK (HMAC + AES) =================
  // =========================================================

  /**
   * Verifica e decifra o INS do ClickBank:
   * - HMAC SHA-256 do body (bytes) com secret key
   * - Assinatura aceita em HEX **ou** BASE64 (decodificação robusta)
   * - IV aceito de 'x-clickbank-cbsig-iv' ou 'x-cb-iv' (BASE64)
   * - AES-256-CBC (key = SHA256(secret)), payload = body(base64) -> utf8
   */
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
      // 1) HMAC (bytes)
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
    // Tenta BASE64 primeiro; se falhar, tenta HEX.
    // Critério: se contiver caracteres fora [0-9a-f] ou tiver '=', provavelmente é BASE64.
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
        // "gclid_" = 6 chars -> slice(6)
        out.gclid = s.replace(/^gclid_/i, '');
      } else if (!out.fbclid && /^fbclid_/i.test(s)) {
        // "fbclid_" = 7 chars -> slice(7)
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
    // Estrutura ClickBank (INS): transactionType, receipt, vendorVariables.tid_, trackingCodes[], etc.
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