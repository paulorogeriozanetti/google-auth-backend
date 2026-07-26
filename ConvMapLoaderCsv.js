/**
 * PZ Advisors — ConvMapLoaderCsv
 * Versão: v2.1.0
 * Data: 2026-07-25
 *
 * MUDANÇA v1.0.0 -> v2.0.0 (plano v8.2, aprovado por ARCHITECT + Gemini):
 * - DOIS ESQUEMAS no MESMO ficheiro, distinguidos pela coluna nova `map_kind`.
 *   O v1 tinha um único índice `platform|event_name|product_id`, o que é
 *   estruturalmente errado para micro-conversões: `cta_click` em circo2-dg,
 *   endocap-method e jetterix-us são três conversões distintas e o v1 não as
 *   conseguia separar (não tinha page_type na chave).
 *
 *   map_kind=purchase -> chave  platform | event_name | product_id
 *                        product_id aceita '*'. page_type é IGNORADO.
 *                        (538693/538694/538695 são três SKUs — 1, 3 e 6 frascos —
 *                        do MESMO produto, não offer_id vs platform_product_id.)
 *
 *   map_kind=micro    -> chave  page_type | event_name | platform
 *                        page_type aceita '*'. product_id é IGNORADO.
 *
 *   Os índices são PARALELOS e independentes: não há colisão possível entre eles,
 *   porque nunca são consultados com a mesma chave. resolve() escolhe o índice a
 *   partir do map_kind derivado do evento (purchase -> purchase; resto -> micro).
 *
 * - FAIL-CLOSED preservado e alargado: uma linha inválida (incluindo map_kind
 *   ausente/desconhecido) invalida o ficheiro INTEIRO. O AdsSink lê isValid() e
 *   entra em no-op. Regra: "uma linha quebrada anula o arquivo".
 *
 * Colunas (v2):
 *   map_kind                 purchase | micro                       [NOVO, obrigatório]
 *   platform                 digistore24 | clickbank | ...
 *   page_type                circo2-dg | endocap-method | ... | '*' [NOVO]
 *   event_name               purchase | cta_click | hit_presell | ...
 *   product_id               SKU exacto (ex.: 538693) ou '*'
 *   conversion_action_id     ID numérico da acção de conversão (Import/Offline)
 *   conversion_action_name   apenas legibilidade humana, não usado pelo código
 *   status                   active | inactive
 *   value_mode               from_transaction | fixed | none
 *   fixed_value              número > 0 (obrigatório e só usado com value_mode=fixed)
 *   currency                 ISO-4217 (OBRIGATÓRIA com value_mode=fixed; sem fallback)
 *
 * MUDANÇA v2.0.0 -> v2.1.0 (revisão de código ARCHITECT):
 * - Duplicados: QUALQUER chave repetida invalida o mapa, seja qual for o status.
 *   Antes, linhas inactive entravam no índice antes da verificação e podiam
 *   sobrescrever silenciosamente uma linha activa — a ordem das linhas do CSV
 *   passava a decidir o resultado.
 * - value_mode=fixed: fixed_value tem de ser > 0 (zero era aceite) e currency
 *   passa a ser obrigatória e explícita (não há fallback implícito para USD).
 *   consent_passthrough      enabled | disabled       (adenda v7.3)
 *   consent_fallback         GRANTED | DENIED | UNSPECIFIED (adenda v7.3)
 *   notes                    livre
 *
 * Nota de arquitectura: o código executa, os CSVs decidem. Nenhuma regra de
 * negócio (que acção, que valor, que consentimento) vive neste ficheiro.
 */

const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL: URLCtor } = require('url');

const VALID_MAP_KIND = new Set(['purchase', 'micro']);
const VALID_PASSTHROUGH = new Set(['enabled', 'disabled']);
const VALID_CONSENT = new Set(['GRANTED', 'DENIED', 'UNSPECIFIED']);
const VALID_VALUE_MODE = new Set(['from_transaction', 'fixed', 'none']);
const VALID_STATUS = new Set(['active', 'inactive']);

class ConvMapLoaderCsv {
  constructor(csvPath) {
    this.version = '2.1.0';
    this.logPrefix = `[ConvMapLoaderCsv v${this.version}]`;

    const envUrl = process.env.PZ_CONVERSION_MAP_URL || process.env.PZ_CONVERSION_MAP_PATH;
    const defaultUrl = 'https://pzadvisors.com/wp-content/uploads/2026/07/pz_conversion_map.csv';

    this.csvPath = csvPath || envUrl || defaultUrl;

    this._cache = null;
    this._headers = null;
    this._mtimeMs = null;

    // Índices paralelos (v8.2).
    this._byPurchase = {};
    this._byMicro = {};

    // Estado de validação (fail-closed)
    this._valid = false;
    this._errors = [];
    this._loadedAt = null;

    this._isRemote = this._looksLikeHttp(this.csvPath);
    this._httpETag = null;
    this._httpLastModified = null;
    this._httpLastFetchAt = 0;
    this._httpRefreshMs = parseInt(process.env.PZ_CONVERSION_MAP_REFRESH_MS || '600000', 10);

    this._loadOrReload(true);
  }

  static getInstance(csvPath) {
    if (!this._instance) {
      this._instance = new ConvMapLoaderCsv(csvPath);
    } else {
      this._instance._loadOrReload(false);
    }
    return this._instance;
  }

  // ---------------- API Pública ----------------

  /** O mapa passou a validação fail-closed? Se false, o AdsSink deve ficar no-op. */
  isValid() {
    return this._valid === true;
  }

  /** Lista de erros de validação (vazia quando isValid() === true). */
  getErrors() {
    return this._errors.slice();
  }

  /**
   * Deriva o map_kind a partir do nome do evento.
   * Regra aprovada: purchase -> 'purchase'; QUALQUER outro evento -> 'micro'.
   * Fica isolada aqui para que a regra não se espalhe pelo AdsSink.
   */
  static kindForEvent(eventName) {
    return String(eventName ?? '').trim().toLowerCase() === 'purchase' ? 'purchase' : 'micro';
  }

  /**
   * Resolve a linha aplicável a uma conversão.
   *
   * map_kind=purchase: chave platform|event_name|product_id, exacto > '*'.
   * map_kind=micro:    chave page_type|event_name|platform,  exacto > '*'.
   *
   * Devolve null se não houver linha, se a linha estiver inactive, ou se o mapa
   * estiver inválido.
   *
   * @param {{platform:string, event_name:string, product_id?:string|number, page_type?:string}} q
   * @returns {Object|null}
   */
  resolve(q) {
    if (!this.isValid()) return null;
    if (!q || !q.event_name) return null;

    const eventName = this._norm(q.event_name);
    const platform = this._norm(q.platform);
    const kind = ConvMapLoaderCsv.kindForEvent(eventName);

    let row = null;

    if (kind === 'purchase') {
      if (!platform) return null;
      const productId = String(q.product_id ?? '').trim();
      const exact = productId ? this._byPurchase[`${platform}|${eventName}|${productId}`] : null;
      const wildcard = this._byPurchase[`${platform}|${eventName}|*`];
      row = exact || wildcard || null;
    } else {
      const pageType = this._norm(q.page_type);
      if (!pageType) return null;
      // A plataforma continua na chave micro (3.º elemento). Quando o evento não
      // tem plataforma associada (micro-conversão puramente de site), usa-se '*'.
      const plat = platform || '*';
      row =
        this._byMicro[`${pageType}|${eventName}|${plat}`] ||
        this._byMicro[`${pageType}|${eventName}|*`] ||
        this._byMicro[`*|${eventName}|${plat}`] ||
        this._byMicro[`*|${eventName}|*`] ||
        null;
    }

    if (!row) return null;
    if (row.status !== 'active') return null;

    return row;
  }

  /** Todas as linhas activas (diagnóstico / validação visual). */
  getActiveRows() {
    return [...Object.values(this._byPurchase), ...Object.values(this._byMicro)]
      .filter((r) => r.status === 'active');
  }

  /** Contagem por índice — usado no healthcheck. */
  getIndexStats() {
    const act = (o) => Object.values(o).filter((r) => r.status === 'active').length;
    return {
      purchase_total: Object.keys(this._byPurchase).length,
      purchase_active: act(this._byPurchase),
      micro_total: Object.keys(this._byMicro).length,
      micro_active: act(this._byMicro),
    };
  }

  // ---------------- Internos ----------------

  _looksLikeHttp(str) {
    try {
      const u = new URLCtor(String(str));
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  _loadOrReload(initial = false) {
    if (this._isRemote) return this._loadRemoteCsv(initial);
    return this._loadLocalCsv(initial);
  }

  _loadLocalCsv(initial) {
    try {
      const stat = fs.statSync(this.csvPath);
      const mtimeMs = stat.mtimeMs;
      const mustReload = initial || this._mtimeMs === null || mtimeMs !== this._mtimeMs;
      if (!mustReload && this._cache) return;

      const raw = fs.readFileSync(this.csvPath, 'utf8');
      this._applyRawCsv(raw);
      this._mtimeMs = mtimeMs;
    } catch (e) {
      console.error(`${this.logPrefix} Falha ao carregar CSV local "${this.csvPath}":`, e?.message || e);
      this._invalidate(`csv_load_error: ${e?.message || e}`);
    }
  }

  _loadRemoteCsv(initial) {
    const now = Date.now();
    const tooSoon = !initial && (now - this._httpLastFetchAt) < this._httpRefreshMs;
    if (tooSoon && this._cache) return;

    this._httpLastFetchAt = now;

    const url = this.csvPath;
    const client = url.startsWith('https://') ? https : http;

    const headers = {};
    if (this._httpETag) headers['If-None-Match'] = this._httpETag;
    if (this._httpLastModified) headers['If-Modified-Since'] = this._httpLastModified;

    const timeout = parseInt(process.env.PZ_CONVERSION_MAP_HTTP_TIMEOUT || '5000', 10);

    const req = client.request(url, { headers, method: 'GET', timeout }, (res) => {
      const { statusCode } = res;

      if (statusCode === 304) { res.resume(); return; }

      if (statusCode !== 200) {
        console.warn(`${this.logPrefix} HTTP ${statusCode} ao buscar CSV. Mantendo cache anterior (se houver).`);
        res.resume();
        if (!this._cache) this._invalidate(`http_${statusCode}`);
        return;
      }

      const etag = res.headers.etag || null;
      const lastMod = res.headers['last-modified'] || null;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          this._applyRawCsv(Buffer.concat(chunks).toString('utf8'));
          this._httpETag = etag;
          this._httpLastModified = lastMod;
        } catch (e) {
          console.error(`${this.logPrefix} Falha ao processar CSV remoto:`, e?.message || e);
          this._invalidate(`csv_parse_error: ${e?.message || e}`);
        }
      });
    });

    req.on('timeout', () => {
      console.warn(`${this.logPrefix} Timeout ao buscar CSV. Mantendo cache anterior (se houver).`);
      req.destroy(new Error('timeout'));
    });
    req.on('error', (e) => {
      console.warn(`${this.logPrefix} Erro na requisição do CSV: ${e?.message || e}. Mantendo cache anterior (se houver).`);
      if (!this._cache) this._invalidate(`http_error: ${e?.message || e}`);
    });
    req.end();

    // Primeira carga é assíncrona por natureza. O AdsSink trata isValid()===false
    // como no-op, portanto não há spin-wait: nunca envia sobre um mapa não carregado.
    if (!this._cache) this._ensureEmpty();
  }

  _applyRawCsv(raw) {
    const { headers, rows } = this._parseCsvSemicolon(raw);
    this._headers = headers;
    this._cache = rows;

    const errors = [];
    const byPurchase = {};
    const byMicro = {};

    if (!rows.length) errors.push('csv_vazio');

    if (rows.length && !headers.includes('map_kind')) {
      // Sem esta coluna não há como saber qual índice usar. Não se adivinha.
      errors.push('coluna map_kind ausente no cabeçalho (obrigatória desde v2.0.0)');
    }

    rows.forEach((r, i) => {
      const line = i + 2; // +1 cabeçalho, +1 base-1

      const mapKind = this._norm(r.map_kind);
      const platform = this._norm(r.platform);
      const eventName = this._norm(r.event_name);
      const pageType = this._norm(r.page_type) || '*';
      const productId = String(r.product_id ?? '').trim() || '*';
      const status = this._norm(r.status) || 'inactive';

      r.map_kind = mapKind;
      r.platform = platform;
      r.event_name = eventName;
      r.page_type = pageType;
      r.product_id = productId;
      r.status = status;

      if (!VALID_STATUS.has(status)) {
        errors.push(`linha ${line}: status inválido "${r.status}"`);
        return;
      }

      if (!VALID_MAP_KIND.has(mapKind)) {
        errors.push(`linha ${line}: map_kind inválido "${r.map_kind}" (esperado purchase|micro)`);
        return;
      }

      // Coerência semântica: purchase tem de ser map_kind=purchase e vice-versa.
      // Sem esta guarda, uma linha purchase marcada como micro ficaria num índice
      // que resolve() nunca consulta para esse evento — falha silenciosa.
      if (eventName && ConvMapLoaderCsv.kindForEvent(eventName) !== mapKind) {
        errors.push(
          `linha ${line}: map_kind="${mapKind}" incoerente com event_name="${eventName}" ` +
          `(esperado "${ConvMapLoaderCsv.kindForEvent(eventName)}")`
        );
        return;
      }

      const key = mapKind === 'purchase'
        ? `${platform}|${eventName}|${productId}`
        : `${pageType}|${eventName}|${platform || '*'}`;
      const index = mapKind === 'purchase' ? byPurchase : byMicro;

      // CORRECÇÃO v2.1.0 (revisão ARCHITECT). Antes, a verificação de duplicados
      // só olhava para linhas activas e só corria DEPOIS de inserir as inactivas.
      // Consequência: uma linha inactiva colocada abaixo de uma activa com a mesma
      // chave sobrescrevia-a em silêncio, e a ordem das linhas do CSV passava a
      // decidir se a conversão era ou não enviada. A regra aprovada é literal:
      // QUALQUER chave repetida invalida o mapa inteiro, seja qual for o status.
      // Verificado ANTES de qualquer inserção.
      if (Object.prototype.hasOwnProperty.call(index, key)) {
        errors.push(
          `linha ${line}: chave duplicada em ${mapKind} "${key}" ` +
          `(status desta linha: ${status}; duplicação invalida o mapa independentemente do status)`
        );
        return;
      }

      // Linhas inactivas não são validadas em profundidade nem utilizáveis, mas
      // continuam no índice para diagnóstico e para ocupar a chave.
      if (status !== 'active') {
        if (eventName) index[key] = r;
        return;
      }

      if (!eventName) errors.push(`linha ${line}: event_name vazio`);

      if (mapKind === 'purchase') {
        if (!platform) errors.push(`linha ${line}: platform vazia (obrigatória em map_kind=purchase)`);
      } else {
        if (!pageType || pageType === '*') {
          // '*' é aceite, mas exige nota explícita — um curinga global em micro
          // captura TODOS os page_types e é quase sempre engano de preenchimento.
          if (!String(r.notes ?? '').trim()) {
            errors.push(
              `linha ${line}: page_type="*" em map_kind=micro sem justificação na coluna notes`
            );
          }
        }
      }

      const actionId = String(r.conversion_action_id ?? '').trim();
      if (!/^\d+$/.test(actionId)) {
        errors.push(`linha ${line}: conversion_action_id inválido "${actionId}" (esperado numérico)`);
      }
      r.conversion_action_id = actionId;

      const valueMode = this._norm(r.value_mode) || 'from_transaction';
      if (!VALID_VALUE_MODE.has(valueMode)) {
        errors.push(`linha ${line}: value_mode inválido "${r.value_mode}"`);
      }
      r.value_mode = valueMode;

      // CORRECÇÃO v2.1.0: fixed exige valor ESTRITAMENTE > 0. Zero era aceite e
      // um valor zero ensina activamente o Smart Bidding que o clique não vale nada.
      if (valueMode === 'fixed') {
        const fv = parseFloat(String(r.fixed_value ?? '').replace(',', '.'));
        if (!Number.isFinite(fv) || fv <= 0) {
          errors.push(
            `linha ${line}: fixed_value inválido "${r.fixed_value}" para value_mode=fixed ` +
            `(exige-se número > 0)`
          );
        }
        r.fixed_value = fv;
      } else {
        r.fixed_value = null;
      }

      const currency = String(r.currency ?? '').trim().toUpperCase();
      if (currency && !/^[A-Z]{3}$/.test(currency)) {
        errors.push(`linha ${line}: currency inválida "${r.currency}" (esperado ISO-4217)`);
      }
      // CORRECÇÃO v2.1.0: com value_mode=fixed a moeda é OBRIGATÓRIA e explícita.
      // Não há fallback plausível — 'USD' por omissão era um palpite silencioso.
      if (valueMode === 'fixed' && !currency) {
        errors.push(
          `linha ${line}: currency obrigatória quando value_mode=fixed (sem fallback implícito)`
        );
      }
      r.currency = currency || null;

      // --- Colunas de consentimento (adenda v7.3) ---
      // Ausente comporta-se como 'disabled'. Presente e fora da lista → fail-closed.
      const rawPass = String(r.consent_passthrough ?? '').trim();
      const passthrough = rawPass === '' ? 'disabled' : rawPass.toLowerCase();
      if (!VALID_PASSTHROUGH.has(passthrough)) {
        errors.push(`linha ${line}: consent_passthrough inválido "${rawPass}" (esperado enabled|disabled)`);
      }
      r.consent_passthrough = passthrough;

      const rawFallback = String(r.consent_fallback ?? '').trim();
      const fallback = rawFallback === '' ? 'UNSPECIFIED' : rawFallback.toUpperCase();
      if (!VALID_CONSENT.has(fallback)) {
        errors.push(`linha ${line}: consent_fallback inválido "${rawFallback}" (esperado GRANTED|DENIED|UNSPECIFIED)`);
      }
      r.consent_fallback = fallback;

      // A verificação de duplicados corre lá acima, ANTES de qualquer inserção e
      // independentemente do status. Aqui a chave está garantidamente livre.
      index[key] = r;
    });

    this._byPurchase = byPurchase;
    this._byMicro = byMicro;
    this._errors = errors;
    this._valid = errors.length === 0;
    this._loadedAt = Date.now();

    if (this._valid) {
      const s = this.getIndexStats();
      console.log(
        `${this.logPrefix} CSV carregado e VÁLIDO (${rows.length} linhas | ` +
        `purchase: ${s.purchase_active} activas | micro: ${s.micro_active} activas).`
      );
    } else {
      console.error(`${this.logPrefix} CSV INVÁLIDO — AdsSink em no-op. ${errors.length} erro(s):`);
      errors.slice(0, 20).forEach((e) => console.error(`${this.logPrefix}   - ${e}`));
    }
  }

  _invalidate(reason) {
    this._ensureEmpty();
    this._valid = false;
    if (reason) this._errors = [String(reason)];
    console.error(`${this.logPrefix} Mapa marcado INVÁLIDO: ${reason}`);
  }

  _ensureEmpty() {
    this._cache = this._cache || [];
    this._byPurchase = this._byPurchase || {};
    this._byMicro = this._byMicro || {};
    this._headers = this._headers || [];
  }

  _norm(v) {
    return String(v ?? '').trim().toLowerCase();
  }

  _parseCsvSemicolon(content) {
    const lines = String(content || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => l.trim().length > 0);

    if (lines.length === 0) return { headers: [], rows: [] };

    const headers = this._splitSemicolon(lines[0]).map((h) => this._normHeader(h));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this._splitSemicolon(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = (cols[idx] ?? '').trim(); });
      rows.push(row);
    }
    return { headers, rows };
  }

  _splitSemicolon(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
        continue;
      }
      if (ch === ';' && !inQuotes) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  _normHeader(h) {
    return String(h || '')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^\w]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
}

module.exports = ConvMapLoaderCsv;
