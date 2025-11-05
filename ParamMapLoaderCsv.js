/**
 * PZ Advisors - ParamMapLoaderCsv
 * Versão: v1.1.0 (CommonJS exports + helpers p/ testes + retrocompat)
 * Data: 2025-11-05
 * Descrição:
 * - Mantém a classe ParamMapLoaderCsv (loader CSV + mapeamento de parâmetros).
 * - Adiciona **exports CommonJS** esperados pelos testes/unit (loadParamMapCsv, mapParamsForPlatform, __resetCache).
 * - Mantém retrocompatibilidade: adapters podem continuar usando `getInstance()`.
 * - Lê pz_parameter_map.csv (separador ';') e disponibiliza:
 *   1) index por pz_id_parameter (apenas status=active).
 *   2) mapeamento p/ cada plataforma (colunas *_id_parameter), normalizando placeholders "{sid1}" -> "sid1".
 *   3) função para construir objeto de query da plataforma a partir de trackingParams canónico.
 *
 * Uso típico nos Adapters (retrocompat):
 *    const ParamMap = require('./ParamMapLoaderCsv').getInstance();
 *    const q = ParamMap.mapTrackingToPlatform(trackingParams, 'digistore24');
 *
 * Uso típico nos testes (helpers):
 *    const loader = require('./ParamMapLoaderCsv');
 *    const map = loader.loadParamMapCsv({ csvPath: '.../pz_parameter_map.csv' });
 *    const out = loader.mapParamsForPlatform('digistore24', payload);
 */

const fs = require('fs');
const path = require('path');

class ParamMapLoaderCsv {
  constructor(csvPath) {
    this.version = '1.1.0';
    this.logPrefix = `[ParamMapLoaderCsv v${this.version}]`;
    this.csvPath = csvPath || process.env.PZ_PARAM_MAP_PATH || path.resolve('./pz_parameter_map.csv');

    this._cache = null;       // linhas parseadas
    this._mtimeMs = null;     // última modificação observada
    this._headers = null;     // cabeçalhos do CSV (normalizados)
    this._byPzId = {};        // índice por pz_id_parameter
    this._platformColumns = [
      'digistore24_id_parameter',
      'clickbank_id_parameter',
      'clickgenius_id_parameter',
      'buygoods_id_parameter',
      'maxweb_id_parameter',
      'nutriprofits_id_parameter',
      'amazon_id_parameter'
    ];

    this._loadOrReload(true);
  }

  // Singleton
  static getInstance(csvPath) {
    if (!ParamMapLoaderCsv._instance) {
      ParamMapLoaderCsv._instance = new ParamMapLoaderCsv(csvPath);
    } else {
      // Se trocou o caminho, atualiza e força reload
      if (csvPath && ParamMapLoaderCsv._instance.csvPath !== csvPath) {
        ParamMapLoaderCsv._instance.csvPath = csvPath;
        ParamMapLoaderCsv._instance._mtimeMs = null; // força reload
      }
      ParamMapLoaderCsv._instance._loadOrReload(false);
    }
    return ParamMapLoaderCsv._instance;
  }

  // --- API da classe ---

  getPlatformColumn(platform) {
    if (!platform) return null;
    const p = String(platform).toLowerCase().trim();
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

  // --- Internos ---

  _loadOrReload(initial = false) {
    try {
      const stat = fs.statSync(this.csvPath);
      const mtimeMs = stat.mtimeMs;
      const mustReload = initial || this._mtimeMs === null || mtimeMs !== this._mtimeMs;

      if (!mustReload && this._cache) return;

      const raw = fs.readFileSync(this.csvPath, 'utf8');
      const { headers, rows } = this._parseCsvSemicolon(raw);
      this._headers = headers;
      this._cache = rows;
      this._mtimeMs = mtimeMs;

      // Reindexa por pz_id_parameter
      this._byPzId = {};
      for (const r of rows) {
        const pzId = r['pz_id_parameter'];
        if (!pzId) continue;
        r.status = String(r.status || '').toLowerCase().trim() === 'active' ? 'active' : 'inactive';
        this._byPzId[pzId] = r;
      }

      console.log(`${this.logPrefix} CSV carregado (${rows.length} linhas). Path: ${this.csvPath}`);
    } catch (e) {
      console.error(`${this.logPrefix} Falha ao carregar CSV em "${this.csvPath}":`, e?.message || e);
      this._cache = this._cache || [];
      this._byPzId = this._byPzId || {};
    }
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

/* =========================
 * Exports CommonJS esperados
 * =========================
 * - loadParamMapCsv({ csvPath }) -> { byPzKey, platforms }
 * - mapParamsForPlatform(platform, payload) -> { <key>=<value> ... }
 * - __resetCache() -> limpa singleton (para testes)
 * - getInstance() -> retrocompat com adapters
 * - ParamMapLoaderCsv (classe) -> export adicional
 */

// helper interno p/ montar { byPzKey, platforms } no formato usado nos testes
function _buildExportedMapStruct(instance) {
  // byPzKey = índice completo (todas as linhas), porém os testes focam em "ativas"
  const byPzKey = instance._byPzId || {};

  // platforms = por plataforma (apenas ativos)
  const platforms = {};
  for (const col of instance._platformColumns) {
    const platName = col.replace(/_id_parameter$/, '');
    platforms[platName] = {};
    for (const [pzId, row] of Object.entries(instance._byPzId)) {
      if (row.status !== 'active') continue;
      const key = instance._normalizePlaceholderToKey(row[col] || '');
      if (key) platforms[platName][pzId] = key;
    }
  }

  return { byPzKey, platforms };
}

function loadParamMapCsv({ csvPath } = {}) {
  const inst = ParamMapLoaderCsv.getInstance(csvPath);
  return _buildExportedMapStruct(inst);
}

function mapParamsForPlatform(platform, payload = {}) {
  const inst = ParamMapLoaderCsv.getInstance();
  return inst.mapTrackingToPlatform(payload, platform);
}

function __resetCache() {
  // Zera singleton e estados internos (usado pelos testes)
  if (ParamMapLoaderCsv._instance) {
    try {
      ParamMapLoaderCsv._instance._cache = null;
      ParamMapLoaderCsv._instance._byPzId = {};
      ParamMapLoaderCsv._instance._mtimeMs = null;
    } catch { /* ignore */ }
  }
  ParamMapLoaderCsv._instance = null;
}

module.exports = {
  // helpers p/ testes
  loadParamMapCsv,
  mapParamsForPlatform,
  __resetCache,
  // retrocompat
  getInstance: ParamMapLoaderCsv.getInstance,
  // export adicional da classe (útil para debug avançado)
  ParamMapLoaderCsv
};