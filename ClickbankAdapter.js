console.log('--- [BOOT CHECK] Loading ClickbankAdapter v1.6.0 (Smart Parsing + Canonical Offer ID + Vendor/ProductID-Aware Multi-Offer Scrape + OfferMap Defaults) ---');
/**
 * PZ Advisors - Clickbank Adapter
 * Nome/Versão: ClickbankAdapter v1.6.0
 * Data: 2025-11-22
 *
 * Alterações vs v1.5.0:
 * - Integra OfferMapLoaderCsv (pz_offer_map.csv) para preencher template_params
 *   (cbfid, cbskin, template, exitoffer) quando:
 *     • offer.offer_id existir (ex.: clickbank:endopump:500001) E
 *     • template_params vier null do scraping.
 * - NUNCA sobrescreve template_params que já vieram da raspagem (prioridade absoluta).
 * - Mantém toda a lógica anterior de scraping, normalização e retorno (legacy|rich).
 *
 * Alterações herdadas vs v1.4.4:
 * - Mantém toda a lógica de normalização inteligente (Smart Parsing) e offer_id canónico.
 * - Continua suportando CB_RETURN_MODE (legacy|rich) + override por chamada.
 * - Scraper "productID-aware":
 *     • Além de pay.clickbank/clkbank e cbitems (vendor-aware), detecta URLs
 *       com productID=... em landers de vendor (ex.: endopumpsecret.com/...productID=500001).
 *     • Quando encontrar productID e souber o vendor (offerData.vendor ou HTML),
 *       monta uma URL canónica https://<vendor>.pay.clickbank.net/?cbitems=<productID>.
 * - _normalizeClickbankOffer expõe template_params
 *   (cbfid, cbskin, template, exitoffer) extraídos da querystring.
 *
 * Alterações herdadas vs v1.3.4-DR6f:
 * - Mantém: scrape robusto (Cheerio), injeção data-driven de params, HMAC webhook, AES, etc.
 * - Adiciona: offer_id canónico clickbank:<vendor>:<cbitems> e metadata por oferta.
 */

const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// Resolve o loader do CSV de parâmetros de tracking (pz_parameter_map.csv)
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
    this.version = '1.6.0';
    this.logPrefix = `[ClickbankAdapter v${this.version}]`;

    this.WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY || '';
    this.SCRAPER_MODE = String(process.env.CB_SCRAPER_MODE || 'off').toLowerCase();
    // Modo de retorno default (pode ser sobreposto por chamada)
    this.RETURN_MODE = String(process.env.CB_RETURN_MODE || 'legacy').toLowerCase();

    this.PARAM_MAP_URL =
      process.env.PZ_PARAMETER_MAP_URL ||
      'https://pzadvisors.com/wp-content/uploads/pz_parameter_map.csv';
    this.FORCE_HEURISTIC = String(process.env.PZ_PARAMETER_FORCE_HEURISTIC || '0') === '1';

    const resolved = _resolveParamLoaderModule();
    this.paramLoader =
      opts.paramLoader && typeof opts.paramLoader.load === 'function'
        ? opts.paramLoader
        : resolved;

    // Singleton lazy do OfferMapLoaderCsv (pz_offer_map.csv)
    this._offerMapLoader = null;

    console.log(
      `${this.logPrefix} Scraper Mode: ${this.SCRAPER_MODE} | Default Return Mode: ${this.RETURN_MODE}`
    );
  }

  // =========================================================
  // ===============  BUILD CHECKOUT (DATA-DRIVEN) ===========
  // =========================================================

  /**
   * Retorna:
   *  - SCRAPER_MODE != 'on'  → string (hoplink data-driven, legado).
   *  - SCRAPER_MODE == 'on' e return_mode efetivo = 'legacy' → string[] (same v1.3.4).
   *  - SCRAPER_MODE == 'on' e return_mode efetivo = 'rich'   → { offers, primaryOffer, raw_count, ... }.
   *
   * O return_mode efetivo é decidido por:
   *   offerData.return_mode / offerData.returnMode  (se válido)
   *   senão, this.RETURN_MODE (CB_RETURN_MODE)      (default global)
   *
   * @returns {Promise<string | string[] | {offers: Object[], primaryOffer?: Object, raw_count: number} | null>}
   */
  async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
    const baseUrl = offerData?.hoplink;
    if (!baseUrl) {
      console.warn(`${this.logPrefix} 'hoplink' ausente no offerData.`);
      return null;
    }

    // Decide o modo de retorno efetivo (por chamada)
    let callReturnMode =
      offerData.return_mode ||
      offerData.returnMode ||
      this.RETURN_MODE ||
      'legacy';

    callReturnMode = String(callReturnMode).toLowerCase();
    if (callReturnMode !== 'rich' && callReturnMode !== 'legacy') {
      callReturnMode = 'legacy';
    }

    // 1) Regras CSV (fonte única) com fallback heurístico
    const rules = await this._loadParamRules(offerData);

    // 2) Monta QS data-driven
    const paramsData = this._buildQueryParamsDataDriven(trackingParams, rules);

    // 3) Hoplink final (respeita placeholder, endurecido)
    let trackedHoplink;
    try {
      trackedHoplink = this._appendParamsToUrl(baseUrl, paramsData);
    } catch (e) {
      console.error(`${this.logPrefix} Hoplink inválido: ${baseUrl}`, e);
      return null;
    }

    // 4) Sem scraper → retorna hoplink data-driven (legado string)
    if (this.SCRAPER_MODE !== 'on') {
      console.log(`${this.logPrefix} SCRAPER_MODE=off -> Retornando hoplink data-driven (string).`);
      return trackedHoplink;
    }

    // 5) Scraper robusto para pay.clickbank.net/clkbank.com
    try {
      const [{ default: axios }, cheerio] = await Promise.all([
        import('axios'),
        import('cheerio'),
      ]);

      console.log(
        `${this.logPrefix} Scraping: ${trackedHoplink} | Return Mode (effective): ${callReturnMode}`
      );

      const resp = await axios.get(trackedHoplink, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: trackedHoplink,
        },
        maxRedirects: 5,
        timeout: 12000, // 12s para garantir scrape completo
      });

      const html = resp.data || '';
      const $ = cheerio.load(html);
      const base = resp.request?.res?.responseUrl || trackedHoplink;

      // Conjunto de productID encontrados (para montar URLs canónicas)
      const productIds = new Set();

      // Tenta extrair vendor do HTML (window.clickbank.vendor / cbtb.clickbank.net/?vendor=...)
      const vendorFromHtml = this._extractVendorFromHtml(html);
      const vendorFromOfferData =
        offerData && offerData.vendor ? String(offerData.vendor).trim().toLowerCase() : null;

      const vendorHostHtml = vendorFromHtml ? `${vendorFromHtml}.pay.clickbank.net` : null;
      const vendorHostOffer = vendorFromOfferData
        ? `${vendorFromOfferData}.pay.clickbank.net`
        : null;

      const cbHostsSet = new Set(['pay.clickbank.net', 'clkbank.com']);
      if (vendorHostHtml) cbHostsSet.add(vendorHostHtml);
      if (vendorHostOffer) cbHostsSet.add(vendorHostOffer);
      const CB_HOSTS = Array.from(cbHostsSet);

      const vendorHost = vendorHostHtml || vendorHostOffer;

      const CANDIDATES = ['a[href]', 'form[action]', 'iframe[src]', 'area[href]'];
      const foundUrls = new Set();

      const toAbs = (u) => {
        try {
          return new URL(u, base).toString();
        } catch {
          return null;
        }
      };
      const isCb = (url) => {
        try {
          const h = new URL(url).hostname.toLowerCase();
          return CB_HOSTS.some((p) => {
            const hp = p.toLowerCase();
            return h === hp || h.endsWith(`.${hp}`);
          });
        } catch {
          return false;
        }
      };

      const collectProductIdFromRaw = (raw) => {
        if (!raw || !/productid=/i.test(raw)) return;
        try {
          const abs = toAbs(raw);
          if (!abs) return;
          const u = new URL(abs);
          const pId =
            u.searchParams.get('productID') ||
            u.searchParams.get('productId') ||
            u.searchParams.get('productid');
          if (pId) {
            productIds.add(pId);
          }
        } catch (_) {
          // ignora URLs mal-formadas
        }
      };

      // Varredura DOM (anchors, forms, iframes, areas)
      for (const sel of CANDIDATES) {
        $(sel).each((_, el) => {
          const raw = $(el).attr('href') || $(el).attr('action') || $(el).attr('src');
          const abs = toAbs(raw);
          if (abs && isCb(abs)) foundUrls.add(abs);

          // captura productID=... em links/forms/iframes/áreas
          if (raw && /productid=/i.test(raw)) {
            collectProductIdFromRaw(raw);
          }
        });
      }

      // Varredura Regex (fallback para scripts, etc.) em todo o HTML + scripts
      const scripts = $('script')
        .map((_, s) => $(s).html() || '')
        .get()
        .join('\n');
      const bodyText = `${html}\n${scripts}`;

      // Regex mais permissiva: aceita http(s):// e também //pay.clickbank.net...
      const urlRegex =
        /((?:https?:)?\/\/[^\s"'<>]*?(?:pay\.clickbank\.net|clkbank\.com)[^\s"'<>]*)/gi;

      let m;
      while ((m = urlRegex.exec(bodyText)) !== null) {
        const abs = toAbs(m[1] || m[0]);
        if (abs && isCb(abs)) foundUrls.add(abs);
      }

      // Extra: captura productID=... em textos/scripts (URLs completas)
      try {
        const productRegex = /((?:https?:)?\/\/[^\s"'<>]*?productid=\d+[^\s"'<>]*)/gi;
        let pm;
        while ((pm = productRegex.exec(bodyText)) !== null) {
          const raw = pm[1] || pm[0];
          collectProductIdFromRaw(raw);
        }
      } catch (err) {
        console.warn(
          `${this.logPrefix} Erro na coleta de URLs com productID via regex:`,
          err?.message || err
        );
      }

      // Varredura específica vendor-aware para cbitems= (URLs absolutas ou relativas)
      if (vendorHost) {
        try {
          const relRegex = /(href|src)\s*=\s*["']([^"']*cbitems=[^"']*)["']/gi;
          let m2;
          while ((m2 = relRegex.exec(html)) !== null) {
            const raw = m2[2] || '';
            let abs = null;

            if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) {
              abs = toAbs(raw);
            } else {
              // Trata como relativo para <vendor>.pay.clickbank.net
              const path = raw.startsWith('/') ? raw : `/${raw}`;
              abs = `https://${vendorHost}${path}`;
            }

            if (abs && isCb(abs)) {
              foundUrls.add(abs);
            }
          }
        } catch (err) {
          console.warn(
            `${this.logPrefix} Erro na coleta vendor/cbitems (vendor-aware scraping):`,
            err?.message || err
          );
        }
      }

      // Constrói URLs canónicas a partir de productID=..., quando soubermos o vendor
      if (productIds.size > 0) {
        const vendorForProductId = vendorFromOfferData || vendorFromHtml || null;
        if (vendorForProductId) {
          for (const pid of productIds) {
            try {
              const cbUrl = new URL(`https://${vendorForProductId}.pay.clickbank.net/`);
              cbUrl.searchParams.set('cbitems', pid);
              const abs = cbUrl.toString();
              if (abs && isCb(abs)) {
                foundUrls.add(abs);
              }
            } catch (err) {
              console.warn(
                `${this.logPrefix} Erro ao montar URL canónica para productID=${pid}:`,
                err?.message || err
              );
            }
          }
        } else {
          console.warn(
            `${this.logPrefix} Foram encontrados productID=..., mas não foi possível determinar o vendor (nem via offerData.vendor nem via HTML).`
          );
        }
      }

      // --- INÍCIO DA LÓGICA v1.4.x (Smart Parsing + Canonical ID) ---

      // 1) Injeta params em todas as URLs ClickBank encontradas e normaliza
      const normalizedOffersRaw = Array.from(foundUrls)
        .map((u) => this._appendParamsToUrl(u, paramsData))
        .filter(Boolean)
        .map((u) => this._normalizeClickbankOffer(u)); // nunca filtra aqui

      // 2) Aplica defaults de template (pz_offer_map.csv) APENAS quando template_params é null
      const normalizedOffers = this._applyOfferMapTemplateDefaults(normalizedOffersRaw);

      if (normalizedOffers.length > 0) {
        console.log(
          `${this.logPrefix} Sucesso: ${normalizedOffers.length} ofertas encontradas e normalizadas.`
        );

        // Modo "rich": objeto estruturado
        if (callReturnMode === 'rich') {
          const primaryOffer =
            normalizedOffers.find((o) => o && o.offer_id) || normalizedOffers[0];

          return {
            offers: normalizedOffers,
            primaryOffer,
            raw_count: normalizedOffers.length,
          };
        }

        // Modo "legacy": apenas array de URLs (compat v1.3.4)
        const urls = normalizedOffers
          .map((o) => o && o.url)
          .filter((u) => typeof u === 'string' && u.length > 0);

        if (urls.length > 0) {
          // Se quiser, pode limitar a 3 aqui para mimetizar v1.3.4: return urls.slice(0, 3);
          return urls;
        }
      }

      // --- FIM DA LÓGICA v1.4.x ---

      console.warn(`${this.logPrefix} SCRAPE não encontrou links válidos.`);

      // Fallback específico para modo "rich": devolve estrutura rica mesmo sem pay.clickbank
      if (callReturnMode === 'rich') {
        const normalized = this._normalizeClickbankOffer(trackedHoplink);
        const [normalizedWithDefaults] = this._applyOfferMapTemplateDefaults([normalized]);
        return {
          offers: [normalizedWithDefaults],
          primaryOffer: normalizedWithDefaults,
          raw_count: 1,
          fallback_reason: 'scrape_empty',
        };
      }

      // Modo legacy mantém comportamento antigo (string)
      console.warn(`${this.logPrefix} Fallback hoplink (string) em modo legacy.`);
      return trackedHoplink;
    } catch (e) {
      console.error(`${this.logPrefix} Erro no SCRAPER:`, e?.message || e);

      // Em modo rich, nunca retornamos string: devolve estrutura rica com fallback
      if (callReturnMode === 'rich') {
        const normalized = this._normalizeClickbankOffer(trackedHoplink);
        const [normalizedWithDefaults] = this._applyOfferMapTemplateDefaults([normalized]);
        return {
          offers: [normalizedWithDefaults],
          primaryOffer: normalizedWithDefaults,
          raw_count: 1,
          fallback_reason: 'scrape_error',
          error_message: e?.message || String(e),
        };
      }

      // Legacy: mantém compat, retorna hoplink string
      return trackedHoplink;
    }
  }

  /**
   * Analisa uma URL final do ClickBank e extrai metadados.
   * Padrão ID canónico: clickbank:<vendor>:<cbitems>
   *
   * v1.5.0+:
   * - Expõe template_params com { cbfid, cbskin, template, exitoffer } quando existirem na URL.
   */
  _normalizeClickbankOffer(urlStr) {
    try {
      const url = new URL(urlStr);

      // 1. Extrair Vendor (subdomínio)
      // Ex: https://endopeak.pay.clickbank.net -> endopeak
      let vendor = null;
      const hostParts = url.hostname.split('.');

      if (
        hostParts.length >= 4 &&
        hostParts[hostParts.length - 3] === 'pay' &&
        hostParts[hostParts.length - 2] === 'clickbank'
      ) {
        vendor = hostParts[0].toLowerCase();
      } else if (url.hostname === 'pay.clickbank.net') {
        // Caso raro de checkout genérico, poderíamos tentar QS; por segurança não forçamos vendor.
      }

      // 2. Extrair SKU (cbitems)
      const cbitems = url.searchParams.get('cbitems');

      let offer_id = null;
      if (vendor && cbitems) {
        offer_id = `clickbank:${vendor}:${cbitems}`;
      }

      // 3. Extrair parâmetros de template relevantes (cbfid, cbskin, template, exitoffer)
      const templateParams = {};
      const cbfid = url.searchParams.get('cbfid');
      const cbskin = url.searchParams.get('cbskin');
      const template = url.searchParams.get('template');
      const exitoffer = url.searchParams.get('exitoffer');

      if (cbfid) templateParams.cbfid = cbfid;
      if (cbskin) templateParams.cbskin = cbskin;
      if (template) templateParams.template = template;
      if (exitoffer) templateParams.exitoffer = exitoffer;

      const hasTemplateParams = Object.keys(templateParams).length > 0;

      return {
        url: urlStr,
        affiliate_platform: 'clickbank',
        vendor: vendor || null,
        sku: cbitems || null,
        offer_id: offer_id, // pode ser null se não identificável
        template_params: hasTemplateParams ? templateParams : null,
        // params: Object.fromEntries(url.searchParams) // manter comentado para não inchar payload
      };
    } catch (e) {
      return { url: urlStr, offer_id: null, error: e.message };
    }
  }

  /**
   * Extrai vendor do HTML:
   * - window.clickbank = { vendor: "puraboost", ... }
   * - <script src="//cbtb.clickbank.net/?vendor=puraboost">
   */
  _extractVendorFromHtml(html = '') {
    if (!html || typeof html !== 'string') return null;

    try {
      // Primeiro tenta via window.clickbank.vendor
      const windowMatch = html.match(
        /window\.clickbank\s*=\s*{[^}]*vendor\s*:\s*["']([^"']+)["']/i
      );
      if (windowMatch && windowMatch[1]) {
        return windowMatch[1].toLowerCase();
      }
    } catch (_) {}

    try {
      // Depois tenta via cbtb.clickbank.net/?vendor=...
      const cbtbMatch = html.match(
        /cbtb\.clickbank\.net\/\?[^"'<>]*\bvendor=([a-zA-Z0-9_-]+)/i
      );
      if (cbtbMatch && cbtbMatch[1]) {
        return cbtbMatch[1].toLowerCase();
      }
    } catch (_) {}

    return null;
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
      console.log(
        `${this.logPrefix} FORCE_HEURISTIC=1 -> ignorando CSV e usando heurística de allowlist/aliases.`
      );
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
        return sep === '?' ? '?' : '';
      });

      // Remove placeholder nu "?[TRACKING_ID]" (no início da query)
      cleanBase = cleanBase.replace(/\?\[TRACKING_ID\](?:&)?/i, () => {
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
  // ===========  OFFER MAP (pz_offer_map.csv) ===============
  // =========================================================

  /**
   * Lazy require do OfferMapLoaderCsv + singleton.
   * Tenta:
   *  - mod.default.getInstance()
   *  - mod.getInstance()
   *  - new mod()
   */
  _getOfferMapLoaderInstance() {
    if (this._offerMapLoader) return this._offerMapLoader;

    try {
      const mod = require('./OfferMapLoaderCsv');
      const cand = mod?.default || mod;

      if (cand && typeof cand.getInstance === 'function') {
        this._offerMapLoader = cand.getInstance();
        return this._offerMapLoader;
      }

      if (typeof cand === 'function') {
        this._offerMapLoader = new cand();
        return this._offerMapLoader;
      }

      console.warn(
        `${this.logPrefix} OfferMapLoaderCsv carregado, mas não expõe getInstance nem é construtor utilizável.`
      );
      this._offerMapLoader = null;
    } catch (err) {
      console.warn(
        `${this.logPrefix} OfferMapLoaderCsv não disponível (pz_offer_map.csv não será usado):`,
        err?.message || err
      );
      this._offerMapLoader = null;
    }

    return this._offerMapLoader;
  }

  /**
   * Aplica defaults de template (cbfid, cbskin, template, exitoffer) vindos do pz_offer_map.csv
   * APENAS quando:
   *   - offer.offer_id existir, e
   *   - offer.template_params for null (sem sobrescrever o que veio da raspagem).
   *
   * @param {Array<Object>} offers
   * @returns {Array<Object>} mesma referência de array, com objetos possivelmente enriquecidos
   */
  _applyOfferMapTemplateDefaults(offers) {
    if (!Array.isArray(offers) || offers.length === 0) return offers;

    const loader = this._getOfferMapLoaderInstance();
    if (!loader || typeof loader.getClickbankDefaults !== 'function') return offers;

    for (const offer of offers) {
      if (!offer || !offer.offer_id) continue;

      // Se já tem template_params do scraping, respeita 100%
      if (offer.template_params && Object.keys(offer.template_params).length > 0) {
        continue;
      }

      try {
        const defaults = loader.getClickbankDefaults(offer.offer_id);
        if (defaults) {
          // Copia simples; FE pode decidir usar só cbfid/cbskin, etc.
          offer.template_params = { ...defaults };
        }
      } catch (err) {
        console.warn(
          `${this.logPrefix} Erro ao aplicar defaults de OfferMap para ${offer.offer_id}:`,
          err?.message || err
        );
      }
    }

    return offers;
  }

  // =========================================================
  // =================  WEBHOOK (HMAC + AES) =================
  // =========================================================

  async verifyWebhook(rawBodyBuffer, headers) {
    if (!this.WEBHOOK_SECRET_KEY) {
      console.error(
        `${this.logPrefix} Webhook falhou: CLICKBANK_WEBHOOK_SECRET_KEY não configurada.`
      );
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