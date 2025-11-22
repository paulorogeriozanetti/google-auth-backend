/**
 * PZ Advisors - OfferMapLoaderCsv
 * Versão: v1.0.0 (HTTP fetch + ETag/Last-Modified cache + Defaults por offer_id)
 * Data: 2025-11-22
 *
 * Descrição:
 * - Lê pz_offer_map.csv a partir de UMA fonte oficial (WordPress) via HTTP(S),
 *   quando PZ_OFFER_MAP_URL (ou PZ_OFFER_MAP_PATH) começar com http/https.
 * - Mantém suporte a caminho local (fs) como fallback técnico (ex.: dev/offline).
 * - Cache em memória com ETag/Last-Modified e janela de refresh configurável.
 * - Indexa por offer_id (coluna "offer_ID" → normalizada para "offer_id").
 * - Expõe helpers para obter defaults ClickBank (cbfid/cbskin/template/exitoffer).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL: URLCtor } = require('url');

class OfferMapLoaderCsv {
  constructor(csvPath) {
    this.version = '1.0.0';
    this.logPrefix = `[OfferMapLoaderCsv v${this.version}]`;

    const envUrl = process.env.PZ_OFFER_MAP_URL || process.env.PZ_OFFER_MAP_PATH;
    const defaultUrl = 'https://pzadvisors.com/wp-content/uploads/2025/10/pz_offer_map.csv';

    // Caminho/URL final do CSV
    this.csvPath = csvPath || envUrl || defaultUrl;

    // cache de conteúdo + índices
    this._cache = null;       // array de linhas (objetos)
    this._headers = null;     // lista de cabeçalhos normalizados
    this._mtimeMs = null;     // apenas para caminho local
    this._byOfferId = {};     // índice offer_id -> row

    // HTTP cache
    this._isRemote = this._looksLikeHttp(this.csvPath);
    this._httpETag = null;
    this._httpLastModified = null;
    this._httpLastFetchAt = 0;
    this._httpRefreshMs = parseInt(process.env.PZ_OFFER_MAP_REFRESH_MS || '600000', 10); // 10 min default

    this._loadOrReload(true);
  }

  // Singleton simples (mesmo padrão do ParamMapLoaderCsv)
  static getInstance(csvPath) {
    if (!this._instance) {
      this._instance = new OfferMapLoaderCsv(csvPath);
    } else {
      this._instance._loadOrReload(false);
    }
    return this._instance;
  }

  // ---------------- API Pública ----------------

  /**
   * Retorna a linha completa do CSV para um offerId (coluna offer_ID → offer_id).
   * @param {string} offerId
   * @returns {Object|null}
   */
  getRow(offerId) {
    if (!offerId) return null;
    return this._byOfferId[offerId] || null;
  }

  /**
   * Retorna defaults de ClickBank para um offer_id (se existirem e estiver "active").
   * Estrutura: { cbfid, cbskin, template, exitoffer } ou null se não houver nada.
   *
   * Mapeia as colunas:
   * - cb_default_cbfid
   * - cb_default_cbskin
   * - cb_default_template
   * - cb_default_exitoffer
   *
   * @param {string} offerId
   * @returns {{cbfid:string|null, cbskin:string|null, template:string|null, exitoffer:string|null} | null}
   */
  getClickbankDefaults(offerId) {
    const row = this.getRow(offerId);
    if (!row) return null;

    const status = String(row.status || '').toLowerCase().trim();
    if (status && status !== 'active') {
      return null;
    }

    const cbfid = (row.cb_default_cbfid || '').trim();
    const cbskin = (row.cb_default_cbskin || '').trim();
    const template = (row.cb_default_template || '').trim();
    const exitoffer = (row.cb_default_exitoffer || '').trim();

    const hasAny = cbfid || cbskin || template || exitoffer;
    if (!hasAny) return null;

    return {
      cbfid: cbfid || null,
      cbskin: cbskin || null,
      template: template || null,
      exitoffer: exitoffer || null,
    };
  }

  /**
   * Retorna um mapa de todos os offer_id ativos que tenham algum default de ClickBank.
   * { [offerId]: { cbfid, cbskin, template, exitoffer } }
   *
   * @returns {Record<string, {cbfid:string|null, cbskin:string|null, template:string|null, exitoffer:string|null}>}
   */
  getAllClickbankDefaults() {
    const out = {};
    for (const [offerId, row] of Object.entries(this._byOfferId)) {
      const status = String(row.status || '').toLowerCase().trim();
      if (status && status !== 'active') continue;

      const cbfid = (row.cb_default_cbfid || '').trim();
      const cbskin = (row.cb_default_cbskin || '').trim();
      const template = (row.cb_default_template || '').trim();
      const exitoffer = (row.cb_default_exitoffer || '').trim();
      if (!(cbfid || cbskin || template || exitoffer)) continue;

      out[offerId] = {
        cbfid: cbfid || null,
        cbskin: cbskin || null,
        template: template || null,
        exitoffer: exitoffer || null,
      };
    }
    return out;
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
    if (this._isRemote) {
      return this._loadRemoteCsv(initial);
    }
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
      console.log(
        `${this.logPrefix} CSV (local) carregado (${this._cache.length} linhas). Path: ${this.csvPath}`
      );
    } catch (e) {
      console.error(
        `${this.logPrefix} Falha ao carregar CSV local "${this.csvPath}":`,
        e?.message || e
      );
      this._ensureEmpty();
    }
  }

  _loadRemoteCsv(initial) {
    const now = Date.now();
    const tooSoon = !initial && (now - this._httpLastFetchAt) < this._httpRefreshMs;

    // Janela de refresh para evitar fetch a cada chamada
    if (tooSoon && this._cache) return;

    this._httpLastFetchAt = now;

    const url = this.csvPath;
    const isHttps = url.startsWith('https://');
    const client = isHttps ? https : http;

    const headers = {};
    if (this._httpETag) headers['If-None-Match'] = this._httpETag;
    if (this._httpLastModified) headers['If-Modified-Since'] = this._httpLastModified;

    const reqOpts = {
      timeout: parseInt(process.env.PZ_OFFER_MAP_HTTP_TIMEOUT || '5000', 10),
    };

    const doFetch = (resolve) => {
      const req = client.request(
        url,
        { headers, method: 'GET', ...reqOpts },
        (res) => {
          const { statusCode } = res;

          if (statusCode === 304) {
            // Não modificado → mantém cache
            console.log(`${this.logPrefix} CSV remoto não modificado (304). Mantendo cache.`);
            res.resume();
            return resolve();
          }

          if (statusCode !== 200) {
            console.warn(
              `${this.logPrefix} HTTP ${statusCode} ao buscar CSV remoto. Mantendo cache anterior (se houver).`
            );
            res.resume();
            return resolve();
          }

          const etag = res.headers.etag || null;
          const lastMod = res.headers['last-modified'] || null;
          const chunks = [];

          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              this._applyRawCsv(raw);

              this._httpETag = etag;
              this._httpLastModified = lastMod;

              console.log(
                `${this.logPrefix} CSV (remoto) carregado (${this._cache.length} linhas). URL: ${url}`
              );
            } catch (e) {
              console.error(
                `${this.logPrefix} Falha ao processar CSV remoto:`,
                e?.message || e
              );
              this._ensureEmpty();
            }
            resolve();
          });
        }
      );

      req.on('timeout', () => {
        console.warn(
          `${this.logPrefix} Timeout ao buscar CSV remoto. Mantendo cache anterior (se houver).`
        );
        req.destroy(new Error('timeout'));
      });
      req.on('error', (e) => {
        console.warn(
          `${this.logPrefix} Erro na requisição do CSV remoto: ${e?.message || e}. Mantendo cache anterior (se houver).`
        );
        resolve();
      });
      req.end();
    };

    // Execução síncrona do ponto de vista do chamador (similar ao ParamMapLoaderCsv)
    let done = false;
    doFetch(() => {
      done = true;
    });

    // spin-wait leve (máx 100ms) para a primeira carga remota
    const start = Date.now();
    while (!this._cache && (Date.now() - start) < 100 && !done) {
      /* no-op */
    }

    if (!this._cache) {
      // Se ainda não carregou, garante estruturas vazias; próxima chamada já pode ter cache
      this._ensureEmpty();
    }
  }

  _applyRawCsv(raw) {
    const { headers, rows } = this._parseCsvSemicolon(raw);
    this._headers = headers;
    this._cache = rows;

    this._byOfferId = {};

    for (const r of rows) {
      // Cabeçalho "offer_ID" vira "offer_id" pelo _normHeader
      const offerId = r.offer_id || r.offerid || r.id || null;
      if (!offerId) continue;

      // Normaliza status para 'active'/'inactive'
      r.status = String(r.status || '').toLowerCase().trim() || 'inactive';

      this._byOfferId[offerId] = r;
    }
  }

  _ensureEmpty() {
    this._cache = this._cache || [];
    this._byOfferId = this._byOfferId || {};
    this._headers = this._headers || [];
  }

  _parseCsvSemicolon(content) {
    const lines = String(content || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => l.trim().length > 0);

    if (lines.length === 0) return { headers: [], rows: [] };

    const headerLine = lines[0];
    const headers = this._splitSemicolon(headerLine).map((h) => this._normHeader(h));

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = this._splitSemicolon(lines[i]);
      const row = {};
      headers.forEach((h, idx) => {
        row[h] = (cols[idx] ?? '').trim();
      });
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
        const nextCh = line[i + 1];
        if (inQuotes && nextCh === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (ch === ';' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
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

module.exports = OfferMapLoaderCsv;