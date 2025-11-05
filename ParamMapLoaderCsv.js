/**
 * PZ Advisors - ParamMapLoaderCsv
 * Versão: v1.0.0 (Loader CSV + Mapeamento de Parâmetros)
 * Data: 2025-11-05
 * Descrição:
 * - Lê pz_parameter_map.csv (separador ';') e disponibiliza:
 *   1) Mapa dos parâmetros internos (pz_id_parameter) -> chaves por plataforma
 *      (ex.: digistore24_id_parameter, clickbank_id_parameter).
 *   2) Apenas linhas com status=active são consideradas.
 *   3) Normaliza placeholders no CSV: "{sid1}" -> "sid1".
 *   4) Retorna um objeto de query pronto para compor URLs de plataforma
 *      a partir de um trackingParams canónico (user_id, gclid, utms, etc.).
 * - Inclui cache + hot-reload (por mtime do arquivo).
 *
 * Uso típico nos Adapters:
 *    const ParamMap = require('./ParamMapLoaderCsv').getInstance();
 *    // Constrói query específica da plataforma a partir do trackingParams canónico
 *    const q = ParamMap.mapTrackingToPlatform(trackingParams, 'digistore24');
 *    // q => { sid1: '107...', sid2: 'TEST_GCLID', utm_source: 'google', ... }
 *    // Depois, anexe q na URL final conforme a regra da plataforma.
 */

const fs = require('fs');
const path = require('path');

class ParamMapLoaderCsv {
  constructor(csvPath) {
    this.version = '1.0.0';
    this.logPrefix = `[ParamMapLoaderCsv v${this.version}]`;
    this.csvPath = csvPath || process.env.PZ_PARAM_MAP_PATH || path.resolve('./pz_parameter_map.csv');

    this._cache = null;       // estrutura parseada
    this._mtimeMs = null;     // última modificação observada
    this._headers = null;     // cabeçalhos do CSV (normalizados)
    this._platformColumns = [ // colunas de plataforma suportadas
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

  // Singleton simples
  static getInstance(csvPath) {
    if (!this._instance) {
      this._instance = new ParamMapLoaderCsv(csvPath);
    } else {
      // Hot reload se mudou
      this._instance._loadOrReload(false);
    }
    return this._instance;
  }

  // --- API pública ---

  /**
   * Retorna o nome da coluna da plataforma (normalizada) a partir de uma string de plataforma.
   * Ex.: 'digistore24' -> 'digistore24_id_parameter'
   */
  getPlatformColumn(platform) {
    if (!platform) return null;
    const p = String(platform).toLowerCase();
    const col = `${p}_id_parameter`;
    return this._platformColumns.includes(col) ? col : null;
  }

  /**
   * Dado um pz_id_parameter (ex.: 'user_id') e a plataforma ('digistore24' | 'clickbank' | ...),
   * retorna a chave da plataforma (ex.: 'sid1' | 'aff_sub1' | 'utm_source' ...).
   * Considera apenas linhas status=active.
   */
  getPlatformKeyFor(pzId, platform) {
    const col = this.getPlatformColumn(platform);
    if (!col || !pzId) return null;
    const row = this._byPzId[pzId];
    if (!row || row.status !== 'active') return null;
    const raw = row[col] || '';
    return this._normalizePlaceholderToKey(raw); // "{sid1}" -> "sid1"
  }

  /**
   * Retorna um objeto com o mapeamento (apenas ativos) pz_id_parameter -> { [platformKey]: string }
   * útil para depuração ou *export*.
   */
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

  /**
   * Constrói o objeto de query da plataforma a partir do trackingParams canónico.
   * - Usa apenas linhas status=active.
   * - Apenas define chaves cujo valor (em trackingParams) exista (string/number/boolean não vazio).
   * - Normaliza e recorta valores (trim).
   */
  mapTrackingToPlatform(trackingParams = {}, platform) {
    const col = this.getPlatformColumn(platform);
    if (!col) {
      console.warn(`${this.logPrefix} Plataforma não suportada: ${platform}`);
      return {};
    }

    const query = {};
    for (const [pzId, row] of Object.entries(this._byPzId)) {
      if (row.status !== 'active') continue;

      // valor canónico vindo do front (pz_track ou fallbacks do head)
      const rawVal = trackingParams[pzId];
      const val = this._sanitizeVal(rawVal);
      if (val === '') continue; // não envia vazio

      // chave da plataforma (placeholder -> chave real)
      const platformKey = this._normalizePlaceholderToKey(row[col] || '');
      if (!platformKey) continue; // não mapeado para a plataforma

      query[platformKey] = val;
    }
    return query;
  }

  /**
   * Retorna uma visão completa da linha para um pz_id_parameter (para auditoria).
   */
  getRow(pzId) {
    return this._byPzId[pzId] || null;
  }

  // --- Internos ---

  _loadOrReload(initial = false) {
    try {
      const stat = fs.statSync(this.csvPath);
      const mtimeMs = stat.mtimeMs;
      const mustReload = initial || this._mtimeMs === null || mtimeMs !== this._mtimeMs;

      if (!mustReload && this._cache) return; // nada mudou

      const raw = fs.readFileSync(this.csvPath, 'utf8');
      const { headers, rows } = this._parseCsvSemicolon(raw);
      this._headers = headers;
      this._cache = rows;
      this._mtimeMs = mtimeMs;

      // index por pz_id_parameter (chave mestra)
      this._byPzId = {};
      for (const r of rows) {
        const pzId = r['pz_id_parameter'];
        if (!pzId) continue;
        // normaliza status para 'active' / 'inactive' (case-insensitive)
        r.status = String(r.status || '').toLowerCase().trim() === 'active' ? 'active' : 'inactive';
        this._byPzId[pzId] = r;
      }

      console.log(`${this.logPrefix} CSV carregado (${rows.length} linhas). Path: ${this.csvPath}`);

    } catch (e) {
      console.error(`${this.logPrefix} Falha ao carregar CSV em "${this.csvPath}":`, e?.message || e);
      // Mantém cache anterior se houver; caso contrário, inicializa vazio
      this._cache = this._cache || [];
      this._byPzId = this._byPzId || {};
    }
  }

  _parseCsvSemicolon(content) {
    // Parser simples para CSV separado por ';' com tolerância a aspas duplas.
    // 1) separa por quebras de linha
    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n').filter(l => l.trim().length > 0);

    if (lines.length === 0) return { headers: [], rows: [] };

    // Cabeçalho
    const headerLine = lines[0];
    const headers = this._splitSemicolon(headerLine).map(h => this._normHeader(h));

    // Linhas
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
    // Suporta ; como separador e campos entre aspas duplas contendo ; dentro
    const out = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        // toggle aspas (considera escape de aspas duplas "")
        const nextCh = line[i + 1];
        if (inQuotes && nextCh === '"') {
          cur += '"'; // aspas escapada
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
    // Converte "{sid1}" -> "sid1"; "{utm_source}" -> "utm_source"
    // Se vier vazio ou sem chaves, retorna limpo.
    if (!v) return '';
    const s = String(v).trim();
    const m = /^\{([^}]+)\}$/.exec(s);
    if (m && m[1]) return m[1].trim();
    // aceita também algo já “cru” (ex: sid1, utm_source)
    return s.replace(/^\{|\}$/g, '').trim();
  }

  _sanitizeVal(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    try {
      return String(v).trim();
    } catch {
      return '';
    }
  }
}

module.exports = ParamMapLoaderCsv;
