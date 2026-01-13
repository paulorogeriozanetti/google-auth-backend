/**
 * PZ Advisors - ParamMapLoaderCsv
 * Versão: v1.2.0 (HTTP fetch + ETag/Last-Modified cache + Refresh)
 * Data: 2025-11-05
 * Descrição:
 * - Lê pz_parameter_map.csv a partir de UMA fonte oficial (WordPress) via HTTP(S),
 *   quando PZ_PARAM_MAP_PATH (ou PZ_PARAM_MAP_URL) começar com http/https.
 * - Mantém suporte a caminho local (fs) como fallback técnico (ex.: ambientes de dev offline).
 * - Cache em memória com ETag/Last-Modified e janela de refresh configurável.
 * - Mantém a mesma API pública das versões anteriores.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL: URLCtor } = require('url');

class ParamMapLoaderCsv {
  constructor(csvPath) {
    this.version = '1.2.0';
    this.logPrefix = `[ParamMapLoaderCsv v${this.version}]`;

    const envUrl = process.env.PZ_PARAM_MAP_URL || process.env.PZ_PARAM_MAP_PATH;
    this.csvPath = csvPath || envUrl || path.resolve('./pz_parameter_map.csv');

    // cache de conteúdo + índices
    this._cache = null;
    this._mtimeMs = null; // apenas para caminho local
    this._headers = null;
    this._byPzId = {};
    this._platformColumns = [
      'digistore24_id_parameter',
      'clickbank_id_parameter',
      'clickgenius_id_parameter',
      'buygoods_id_parameter',
      'maxweb_id_parameter',
      'nutriprofits_id_parameter',
      'amazon_id_parameter',
    ];

    // HTTP cache
    this._isRemote = this._looksLikeHttp(this.csvPath);
    this._httpETag = null;
    this._httpLastModified = null;
    this._httpLastFetchAt = 0;
    this._httpRefreshMs = parseInt(process.env.PZ_PARAM_MAP_REFRESH_MS || '600000', 10); // 10 min default

    this._loadOrReload(true);
  }

  static getInstance(csvPath) {
    if (!this._instance) {
      this._instance = new ParamMapLoaderCsv(csvPath);
    } else {
      this._instance._loadOrReload(false);
    }
    return this._instance;
  }

  // ---------------- API Pública ----------------

  getPlatformColumn(platform) {
    if (!platform) return null;
    const p = String(platform).toLowerCase();
    const col = `${p}_id_parameter`;
    return this._platformColumns.includes(col) ? col : null;
  }

  getPlatformKeyFor(pzId, platform) {
    const col = this.getPlatformColumn(platform);
    if (!col || !pzId) return null;
    const row = this._byPzId[pzId];
    if (!row || row.status !== 'active') return null;
    const raw = row[col] || '';
    return this._normalizePlaceholderToKey(raw);
  }

  getActiveMap(platform) {
    const col = this.getPlatformColumn(platform);
    if (!col) return {};
    const out = {};
    for (const [pzId, row] of Object.entries(this._byPzId)) {
      if (row.status !== 'active') continue;
      const k = this._normalizePlaceholderToKey(row[col] || '');
      if (k) out[pzId] = k;
    }
    return out;
  }

  mapTrackingToPlatform(trackingParams = {}, platform) {
    const col = this.getPlatformColumn(platform);
    if (!col) {
      console.warn(`${this.logPrefix} Plataforma não suportada: ${platform}`);
      return {};
    }
    const query = {};
    for (const [pzId, row] of Object.entries(this._byPzId)) {
      if (row.status !== 'active') continue;
      const rawVal = trackingParams[pzId];
      const val = this._sanitizeVal(rawVal);
      if (val === '') continue;
      const platformKey = this._normalizePlaceholderToKey(row[col] || '');
      if (!platformKey) continue;
      query[platformKey] = val;
    }
    return query;
  }

  getRow(pzId) {
    return this._byPzId[pzId] || null;
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
      console.log(`${this.logPrefix} CSV (local) carregado (${this._cache.length} linhas). Path: ${this.csvPath}`);
    } catch (e) {
      console.error(`${this.logPrefix} Falha ao carregar CSV local "${this.csvPath}":`, e?.message || e);
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

    const reqOpts = { timeout: parseInt(process.env.PZ_PARAM_MAP_HTTP_TIMEOUT || '5000', 10) };

    const doFetch = (resolve) => {
      const req = client.request(url, { headers, method: 'GET', ...reqOpts }, (res) => {
        const { statusCode } = res;

        if (statusCode === 304) {
          // Não modificado → mantém cache
          console.log(`${this.logPrefix} CSV remoto não modificado (304). Mantendo cache.`);
          res.resume();
          return resolve();
        }

        if (statusCode !== 200) {
          console.warn(`${this.logPrefix} HTTP ${statusCode} ao buscar CSV remoto. Mantendo cache anterior (se houver).`);
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

            console.log(`${this.logPrefix} CSV (remoto) carregado (${this._cache.length} linhas). URL: ${url}`);
          } catch (e) {
            console.error(`${this.logPrefix} Falha ao processar CSV remoto:`, e?.message || e);
            this._ensureEmpty();
          }
          resolve();
        });
      });

      req.on('timeout', () => {
        console.warn(`${this.logPrefix} Timeout ao buscar CSV remoto. Mantendo cache anterior (se houver).`);
        req.destroy(new Error('timeout'));
      });
      req.on('error', (e) => {
        console.warn(`${this.logPrefix} Erro na requisição do CSV remoto: ${e?.message || e}. Mantendo cache anterior (se houver).`);
        resolve();
      });
      req.end();
    };

    // Execução síncrona do ponto de vista do chamador (carrega na 1ª vez e mantém em memória).
    // Como este método é chamado durante o ciclo da factory (getInstance/_loadOrReload),
    // usamos um truque simples: bloquear novas leituras até a promise ser resolvida.
    // (Como estamos no mesmo "tick", e é só uma leitura rápida, isso é suficiente.)
    let done = false;
    doFetch(() => { done = true; });

    // spin-wait leve (máx 100ms) para a primeira carga remota
    const start = Date.now();
    while (!this._cache && (Date.now() - start) < 100 && !done) { /* no-op */ }

    if (!this._cache) {
      // Se ainda não carregou, garante estruturas vazias, mas próxima chamada já terá cache
      this._ensureEmpty();
    }
  }

  _applyRawCsv(raw) {
    const { headers, rows } = this._parseCsvSemicolon(raw);
    this._headers = headers;
    this._cache = rows;

    // index por pz_id_parameter
    this._byPzId = {};
    for (const r of rows) {
      const pzId = r['pz_id_parameter'];
      if (!pzId) continue;
      r.status = String(r.status || '').toLowerCase().trim() === 'active' ? 'active' : 'inactive';
      this._byPzId[pzId] = r;
    }
  }

  _ensureEmpty() {
    this._cache = this._cache || [];
    this._byPzId = this._byPzId || {};
    this._headers = this._headers || [];
  }

  _parseCsvSemicolon(content) {
    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };

    const headerLine = lines[0];
    const headers = this._splitSemicolon(headerLine).map(h => this._normHeader(h));

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
        const nextCh = line[i + 1];
        if (inQuotes && nextCh === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
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

  _normalizePlaceholderToKey(v) {
    if (!v) return '';
    const s = String(v).trim();
    const m = /^\{([^}]+)\}$/.exec(s);
    if (m && m[1]) return m[1].trim();
    return s.replace(/^\{|\}$/g, '').trim();
  }

  _sanitizeVal(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    try { return String(v).trim(); } catch { return ''; }
  }
}

module.exports = ParamMapLoaderCsv;