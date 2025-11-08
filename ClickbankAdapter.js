console.log('--- [BOOT CHECK] Loading ClickbankAdapter v1.2.7-DR5 (single-source CSV rules) ---');
/**
 * PZ Advisors - Clickbank Adapter
 * Nome/Versão: ClickbankAdapter v1.2.7-DR5
 * Data: 2025-11-08
 *
 * Mudanças principais (em relação à v1.2.6-DR4):
 * - PRIORIDADE 4 FINALIZADA com Fonte Única da Verdade:
 *   -> Remove dependência de ENVs paralelas (PZ_PARAMETER_MAP_JSON/ALLOWLIST) para regras de checkout.
 *   -> Passa a ler as regras diretamente do CSV via ParamMapLoaderCsv (mesma abordagem do Digistore24Adapter).
 *   -> Mantém override por offerData.parameterAllowlist / offerData.parameterMap quando fornecidos.
 * - Mantém TODO o restante:
 *   -> Scraper robusto (lazy axios/cheerio), dedupe, limite 3, fallback HopLink.
 *   -> buildCheckoutUrl data-driven (injeta tid + parâmetros permitidos nas URLs).
 *   -> verifyWebhook com hardening (assinatura base64/hex; IV em x-clickbank-cbsig-iv/x-cb-iv).
 *   -> Normalização com extração de tid_/gclid_/fbclid_ a partir de trackingCodes/vendorVariables.
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// Carrega o loader do CSV (mesmo usado pelo Digistore)
let ParamMapLoaderCsv = null;
try {
  ParamMapLoaderCsv = require('./ParamMapLoaderCsv');
} catch (e) {
  // Mantemos execução, mas cairemos no fallback heurístico se o loader faltar.
  console.warn('[ClickbankAdapter v1.2.7-DR5] ParamMapLoaderCsv não encontrado. Usando fallback heurístico se necessário.');
}

class ClickbankAdapter extends PlatformAdapterBase {
  constructor() {
    super();
    this.version = '1.2.7-DR5';
    this.logPrefix = '[ClickbankAdapter v1.2.7-DR5]';
    this.WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY;

    // SCRAPER flag; padrão 'off'
    this.SCRAPER_MODE = String(process.env.CB_SCRAPER_MODE || 'off').toLowerCase();
    console.log(`${this.logPrefix} Scraper Mode: ${this.SCRAPER_MODE}`);

    // Cache de regras do CSV para evitar fetch a cada chamada (TTL 5 min)
    this._paramRulesCache = {
      ts: 0,
      allowlist: new Set(),
      map: {}
    };

    // URL do CSV (mesma config já usada no Digistore adapter)
    this.PARAM_MAP_URL =
      process.env.PZ_PARAMETER_MAP_URL ||
      process.env.PZ_PARAMETER_MAP_CSV_URL || // alias comum
      null;
  }

  // --------------------------------------------------------------------
  // Regras DATA-DRIVEN via CSV (Fonte Única da Verdade)
  // --------------------------------------------------------------------

  /**
   * Lê regras data-driven a partir de offerData OU CSV (ParamMapLoaderCsv) com cache.
   * Precedência:
   *  1) offerData.parameterAllowlist / offerData.parameterMap (mais específico por oferta)
   *  2) CSV via ParamMapLoaderCsv (include_in_checkout=true => permitido; map_to => renomeia)
   *  3) Fallback heurístico (seguro) se não houver CSV
   */
  async _getParamRules(offerData = {}) {
    // 1) Regras no offerData (override explícito)
    const allowFromOffer = Array.isArray(offerData.parameterAllowlist) ? offerData.parameterAllowlist : null;
    const mapFromOffer =
      offerData.parameterMap && typeof offerData.parameterMap === 'object'
        ? offerData.parameterMap
        : null;

    if (allowFromOffer && allowFromOffer.length > 0) {
      return {
        allowlist: new Set(allowFromOffer.map((s) => String(s).trim()).filter(Boolean)),
        map: mapFromOffer || {}
      };
    }

    // 2) CSV com cache (ParamMapLoaderCsv)
    const now = Date.now();
    const TTL_MS = 5 * 60 * 1000; // 5 minutos

    if (ParamMapLoaderCsv && this.PARAM_MAP_URL) {
      // Se cache válido, usa
      if (now - this._paramRulesCache.ts < TTL_MS && this._paramRulesCache.allowlist.size > 0) {
        return this._paramRulesCache;
      }

      try {
        // O loader deve expor algo como: new ParamMapLoaderCsv(url).load()
        // que retorna um array de linhas com campos (ex.: pz_id_parameter, include_in_checkout, map_to, alias, category, etc.)
        const loader = new ParamMapLoaderCsv(this.PARAM_MAP_URL);
        const rows = await loader.load();

        const allow = new Set();
        const map = {};

        for (const row of rows || []) {
          // Nomes de campos tolerantes (CSV pode vir capitalizado/variações)
          const key =
            row.pz_id_parameter || row.pzIdParameter || row.id_parameter || row.key || row.param || '';
          const include = row.include_in_checkout ?? row.includeInCheckout ?? row.checkout ?? row.include;

          const mapTo = row.map_to ?? row.mapTo ?? row.alias_param ?? row.alias ?? '';

          if (!key) continue;

          // Interpreta include como boolean (aceita "1", "true", true)
          const inc =
            include === true ||
            include === 1 ||
            (typeof include === 'string' && /^(1|true|yes|y)$/i.test(include.trim()));

          if (inc) {
            allow.add(String(key));
            if (mapTo) {
              map[String(key)] = String(mapTo);
            }
          }
        }

        if (allow.size > 0) {
          this._paramRulesCache = { ts: now, allowlist: allow, map };
          return this._paramRulesCache;
        }
        console.warn(`${this.logPrefix} CSV carregado mas sem parâmetros com include_in_checkout=true. Usando fallback heurístico.`);
      } catch (e) {
        console.warn(`${this.logPrefix} Falha ao ler CSV (${this.PARAM_MAP_URL}). Motivo:`, e?.message || e);
      }
    } else {
      if (!ParamMapLoaderCsv) {
        console.warn(`${this.logPrefix} ParamMapLoaderCsv indisponível.`);
      }
      if (!this.PARAM_MAP_URL) {
        console.warn(`${this.logPrefix} PZ_PARAMETER_MAP_URL não definido; usando fallback heurístico.`);
      }
    }

    // 3) Fallback heurístico (seguro)
    const heuristic = [
      'gclid',
      'fbclid',
      'dclid',
      'ttclid',
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'campaignkey',
      'click_timestamp',
      'timestamp',
      'aff',
      'affiliate',
      'ref',
      'refid',
      'tag',
      'sid1',
      'sid2',
      'sid3',
      'sid4',
      'anon_id',
      'user_id'
    ];
    return { allowlist: new Set(heuristic), map: {} };
  }

  /**
   * Filtra/renomeia parâmetros conforme allowlist/map e aplica regra especial de user_id→tid.
   */
  _buildQueryParamsDataDriven(trackingParams = {}, paramRules) {
    const out = {};
    const isBad = (v) => {
      if (v === null || v === undefined) return true;
      const sv = String(v).trim();
      return sv === '' || /^null$/i.test(sv) || /^undefined$/i.test(sv) || /^none$/i.test(sv);
    };

    // user_id => tid (ClickBank)
    if (!isBad(trackingParams.user_id)) {
      out.tid = String(trackingParams.user_id).substring(0, 100);
    }

    for (const [k, v] of Object.entries(trackingParams)) {
      if (k === 'user_id') continue;
      if (!paramRules.allowlist.has(k)) continue;
      if (isBad(v)) continue;

      const dest = k in paramRules.map ? paramRules.map[k] : k;
      if (dest === 'tid') continue; // não sobrescrever
      out[dest] = String(v);
    }

    return out;
  }

  /**
   * Aplica/mescla parâmetros a um URL.
   */
  _appendParamsToUrl(urlStr, paramsData = {}) {
    if (!urlStr) return null;
    try {
      const u = new URL(urlStr);

      if (paramsData.tid && !u.searchParams.has('tid')) {
        u.searchParams.set('tid', paramsData.tid);
      }
      Object.entries(paramsData).forEach(([k, v]) => {
        if (k === 'tid') return;
        if (!u.searchParams.has(k)) {
          u.searchParams.set(k, v);
        }
      });

      return u.toString();
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------
  // BUILD CHECKOUT URL
  // --------------------------------------------------------------------
  /**
   * @override
   * Constrói a URL final:
   *  1) Calcula HopLink com tid (compatível legado).
   *  2) Injeta parâmetros data-driven (CSV) no HopLink.
   *  3) Se SCRAPER_MODE=on, raspa checkout URLs e injeta os mesmos parâmetros.
   *  Retorna ARRAY (scrape OK) ou STRING (hoplink/fallback) ou null (erro).
   */
  async buildCheckoutUrl(offerData, trackingParams) {
    const baseUrl = offerData?.hoplink;
    if (!baseUrl) {
      console.warn(`${this.logPrefix} 'hoplink' ausente no offerData.`);
      return null;
    }

    // Carrega regras do CSV (ou override do offer) com cache
    const paramRules = await this._getParamRules(offerData);
    const paramsData = this._buildQueryParamsDataDriven(trackingParams || {}, paramRules);

    // 1) HopLink com tid (legado) + 2) injeção data-driven
    let hopWithTid;
    try {
      if (baseUrl.includes('[TRACKING_ID]')) {
        const safeTid = paramsData.tid || 'NO_USER_ID';
        hopWithTid = baseUrl.replace('[TRACKING_ID]', encodeURIComponent(safeTid));
      } else {
        hopWithTid = this._appendParamsToUrl(baseUrl, { tid: paramsData.tid || 'NO_USER_ID' }) || baseUrl;
      }
    } catch (e) {
      console.error(`${this.logPrefix} URL de hoplink inválida: ${baseUrl}`, e);
      return null;
    }
    const trackedHoplink = this._appendParamsToUrl(hopWithTid, paramsData) || hopWithTid;

    if (this.SCRAPER_MODE !== 'on') {
      console.log(`${this.logPrefix} SCRAPER_MODE=off -> Retornando hoplink data-driven.`);
      return trackedHoplink;
    }

    // 3) Scraper ON (lazy axios/cheerio)
    console.log(`${this.logPrefix} SCRAPER_MODE=on -> import dinâmico de axios/cheerio...`);
    try {
      const [{ default: axios }, cheerio] = await Promise.all([import('axios'), import('cheerio')]);
      console.log(`${this.logPrefix} Axios/Cheerio carregados.`);

      console.log(`${this.logPrefix} Iniciando scrape do HopLink: ${trackedHoplink}`);
      const response = await axios.get(trackedHoplink, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: trackedHoplink
        },
        maxRedirects: 5,
        timeout: 10000
      });

      const html = response.data;
      const $ = cheerio.load(html);
      const baseForRel = response.request?.res?.responseUrl || trackedHoplink;

      const CANDIDATE_SELECTORS = ['a[href]', 'form[action]', 'iframe[src]'];
      const CB_PATTERNS = ['pay.clickbank.net', 'clkbank.com', 'orders.clickbank.net'];
      const found = new Set();

      const isClickbankCheckoutUrl = (u) => {
        try {
          return CB_PATTERNS.some((p) => new URL(u).hostname.includes(p));
        } catch {
          return false;
        }
      };
      const toAbs = (raw) => {
        if (!raw) return null;
        try {
          return new URL(raw, baseForRel).toString();
        } catch {
          return null;
        }
      };

      // 1) Elementos
      for (const sel of CANDIDATE_SELECTORS) {
        $(sel).each((_, el) => {
          const raw = $(el).attr('href') || $(el).attr('action') || $(el).attr('src');
          const abs = toAbs(raw);
          if (abs && isClickbankCheckoutUrl(abs)) found.add(abs);
        });
      }

      // 2) Regex no HTML/script
      const scriptTxt = $('script').map((_, s) => $(s).html() || '').get().join('\n');
      const blob = `${html}\n${scriptTxt}`;
      const re =
        /\b(https?:\/\/[^\s"'<>]+(?:pay\.clickbank\.net|clkbank\.com|orders\.clickbank\.net)[^\s"'<>]*)/gi;
      let m;
      while ((m = re.exec(blob)) !== null) {
        const abs = toAbs(m[0]);
        if (abs && isClickbankCheckoutUrl(abs)) found.add(abs);
      }

      // 3) Injeta params data-driven em cada checkout URL; limita a 3
      const enriched = Array.from(found)
        .map((u) => this._appendParamsToUrl(u, paramsData))
        .filter(Boolean)
        .slice(0, 3);

      if (enriched.length > 0) {
        console.log(`${this.logPrefix} SCRAPE OK: ${enriched.length} checkout URL(s).`);
        return enriched;
      }
      console.warn(`${this.logPrefix} SCRAPE sem resultados. Fallback HopLink data-driven.`);
      return trackedHoplink;
    } catch (err) {
      console.error(`${this.logPrefix} Erro no scrape/import:`, err?.message || err);
      if (err?.code === 'ECONNABORTED') console.error(`${this.logPrefix} Motivo: TIMEOUT`);
      else if (err?.response) console.error(`${this.logPrefix} HTTP Status: ${err.response.status}`);
      return trackedHoplink; // fallback seguro
    }
  }

  // --------------------------------------------------------------------
  // VERIFY WEBHOOK
  // --------------------------------------------------------------------
  /**
   * @override
   * Verifica e descriptografa o webhook (INS) do ClickBank.
   * - Aceita assinatura em base64 OU hex.
   * - Aceita IV em 'x-clickbank-cbsig-iv' OU 'x-cb-iv'.
   * - Decifra corpo (Buffer) com AES-256-CBC; normaliza payload resultante.
   */
  async verifyWebhook(rawBodyBuffer, headers) {
    if (!this.WEBHOOK_SECRET_KEY) {
      console.error(`${this.logPrefix} Falha webhook: CLICKBANK_WEBHOOK_SECRET_KEY não configurada.`);
      return null;
    }
    if (!rawBodyBuffer || !headers) {
      console.warn(`${this.logPrefix} Webhook sem body/headers.`);
      return null;
    }

    const signatureHeader = headers['x-clickbank-signature'];
    const ivHeader = headers['x-clickbank-cbsig-iv'] || headers['x-cb-iv'];
    if (!signatureHeader || !ivHeader) {
      console.warn(`${this.logPrefix} Webhook sem assinatura ou IV.`);
      return null;
    }

    try {
      // 1) Validação HMAC (base64 OU hex)
      const hmac = crypto.createHmac('sha256', this.WEBHOOK_SECRET_KEY);
      hmac.update(rawBodyBuffer);
      const calcHex = hmac.digest('hex');
      const calcBuf = Buffer.from(calcHex, 'hex');

      let sigBuf = null;
      try {
        sigBuf = Buffer.from(signatureHeader, 'base64'); // tenta base64
        if (sigBuf.length !== calcBuf.length) {
          sigBuf = Buffer.from(signatureHeader, 'hex'); // tenta hex
        }
      } catch {
        try {
          sigBuf = Buffer.from(signatureHeader, 'hex');
        } catch (_) {
          /* noop */
        }
      }
      if (!sigBuf || sigBuf.length !== calcBuf.length || !crypto.timingSafeEqual(sigBuf, calcBuf)) {
        console.warn(`${this.logPrefix} Assinatura HMAC inválida.`);
        return null;
      }
      console.log(`${this.logPrefix} HMAC OK.`);

      // 2) Decifragem
      const iv = Buffer.from(ivHeader, 'base64');
      const key = crypto.createHash('sha256').update(this.WEBHOOK_SECRET_KEY).digest();
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(rawBodyBuffer, undefined, 'utf8'); // Buffer in
      decrypted += decipher.final('utf8');

      const payload = JSON.parse(decrypted);

      // 3) Normalização (inclui trackingCodes e vendorVariables.tid_)
      const normalized = this._normalizeWebhookPayload(payload);
      console.log(`${this.logPrefix} Webhook OK.`, this.safeLog(normalized));
      return normalized;
    } catch (e) {
      console.error(`${this.logPrefix} Erro ao processar webhook:`, e?.message || e);
      return null;
    }
  }

  // --------------------------------------------------------------------
  // Helpers internos de normalização
  // --------------------------------------------------------------------
  _extractFromTrackingCodes(codes = []) {
    const out = {};
    if (!Array.isArray(codes)) return out;
    for (const c of codes) {
      const s = String(c || '');
      if (s.startsWith('tid_') && !out.userId) out.userId = s.slice(4);
      else if (s.startsWith('gclid_') && !out.gclid) out.gclid = s.slice(7);
      else if (s.startsWith('fbclid_') && !out.fbclid) out.fbclid = s.slice(8);
    }
    return out;
  }

  _normalizeWebhookPayload(payload) {
    const {
      transactionType,
      receipt,
      vendorVariables,
      trackingCodes,
      lineItems,
      currency,
      transactionTime,
      totalOrderAmount,
      customer
    } = payload || {};

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
      default:
        status = 'other';
    }

    const firstItem = Array.isArray(lineItems) && lineItems.length ? lineItems[0] : {};
    const extracted = this._extractFromTrackingCodes(trackingCodes);

    const userId =
      (vendorVariables && (vendorVariables.tid_ || vendorVariables.tid)) ||
      extracted.userId ||
      null;

    return {
      platform: 'clickbank',
      transactionId: receipt,
      orderId: receipt,
      trackingId: userId, // nomenclatura legada do backend
      status,
      productSku: firstItem?.itemNo ?? 'N/A',
      amount:
        typeof firstItem?.accountAmount === 'number'
          ? firstItem.accountAmount
          : typeof totalOrderAmount === 'number'
          ? totalOrderAmount
          : 0,
      currency: currency || 'USD',
      customerEmail: customer?.billing?.email || null,
      eventTimestamp: transactionTime ? new Date(transactionTime) : new Date(),
      receivedTimestamp: new Date(),
      gclid: extracted.gclid || null,
      fbclid: extracted.fbclid || null,
      _rawPayload: this.safeLog(payload)
    };
  }
}

module.exports = ClickbankAdapter;