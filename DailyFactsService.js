/**
 * DailyFactsService.js
 * Versão: v1.0.0
 * Data: 2025-11-13
 * Desc: Serviço responsável por gravar/atualizar a coleção daily_facts.
 * Reutilizável pelo /api/track (Server) e pelos Sinks S2S.
 */

const { FieldValue, Timestamp } = require('firebase-admin/firestore');

// --- Helpers Utilitários (extraídos do server.js v5.6.0) ---

function zeroPad(n, w = 2) { return String(n).padStart(w, '0'); }

function deriveDayParts(tsISO, tzOffsetMin) {
  let d = tsISO ? new Date(tsISO) : new Date();
  const tz = Number.isFinite(+tzOffsetMin) ? +tzOffsetMin : 0;
  if (tz !== 0) d = new Date(d.getTime() + tz * 60 * 1000);
  return {
    y: d.getUTCFullYear(),
    m: zeroPad(d.getUTCMonth() + 1),
    d: zeroPad(d.getUTCDate())
  };
}

function deriveDayLabel(tsISO, tzOffsetMin) {
  const p = deriveDayParts(tsISO, tzOffsetMin);
  return `${p.y}-${p.m}-${p.d}`;
}

function parseClientTimestamp(val) {
  try {
    if (!val) return null;
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return Timestamp.fromDate(d);
  } catch {
    return null;
  }
}

function toPlainJSON(obj) {
  try {
    return JSON.parse(JSON.stringify(obj || null));
  } catch {
    return null;
  }
}

function clean(v) {
  if (v === undefined || v === null) return "";
  const s = String(v).trim();
  if (s === 'null' || s === '"null"' || s === "'null'") return "";
  return s;
}

/**
 * upsertDailyFact
 * Replica exatamente a lógica de negócio usada pelo /api/track,
 * mas encapsulada para reutilização.
 *
 * @param {object} opts - Opções de gravação.
 * @param {object} opts.db - Instância do Firestore.
 * @param {string} opts.anon_id - ID anônimo do usuário.
 * @param {string|null} opts.user_id - ID real do usuário (opcional).
 * @param {number} opts.tz_offset - Offset de fuso horário em minutos.
 * @param {string} opts.event - Nome do evento.
 * @param {string} opts.page - URL ou identificador da página.
 * @param {string} opts.session_id - ID da sessão (opcional).
 * @param {object} opts.payload - Dados do evento.
 * @param {string} opts.tsISO - Timestamp ISO do evento.
 */
async function upsertDailyFact({ db, anon_id, user_id, tz_offset, event, page, session_id, payload, tsISO }) {
  if (!db) {
    console.warn('[upsertDailyFact] DB não disponível. Pulando gravação.');
    return { ok: false, id: null, error: 'DB_NOT_INITIALIZED' };
  }

  // Higiene de Dados
  if (payload && payload.got && typeof payload.got === 'object') {
    Object.keys(payload.got).forEach(k => {
      const cleanedValue = clean(payload.got[k]);
      if (cleanedValue === "") {
        delete payload.got[k];
      } else {
        payload.got[k] = cleanedValue;
      }
    });
  }

  const safeAnon = (anon_id && typeof anon_id === 'string') ? anon_id : 'anon_unknown';
  const tz = Number.isFinite(+tz_offset) ? +tz_offset : 0;
  const day = deriveDayLabel(tsISO, tz);

  const docIdPattern = process.env.FACTS_DOC_PATTERN || '${anon_id}_${YYYY-MM-DD}';
  const parts = deriveDayParts(tsISO, tz);
  const docId = docIdPattern
    .replace('${anon_id}', safeAnon)
    .replace('${YYYY-MM-DD}', day)
    .replace('${y}', parts.y)
    .replace('${m}', parts.m)
    .replace('${d}', parts.d);

  const collName = process.env.FIRESTORE_FACTS_COLLECTION || 'daily_facts';
  const docRef = db.collection(collName).doc(docId);

  const event_id = payload?.event_id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (payload.event_id) delete payload.event_id;

  const newEvent = toPlainJSON({
    event,
    event_id,
    ts_server: FieldValue.serverTimestamp(),
    ts_client: parseClientTimestamp(tsISO),
    tz_offset: Number.isFinite(tz) ? tz : null,
    page,
    session_id,
    payload
  });

  const final_user_id = (user_id && typeof user_id === 'string') ? user_id : null;
  const final_person_id = final_user_id || safeAnon;

  const updatePayload = {
    updated_at: FieldValue.serverTimestamp(),
    events: FieldValue.arrayUnion(newEvent),
    [`counters.${event}`]: FieldValue.increment(1),
    person_id: final_person_id,
    ...(final_user_id ? { user_id: final_user_id } : {})
  };

  try {
    await docRef.update(updatePayload);
  } catch (error) {
    const notFound = error?.code === 5 || error?.code === 'not-found' || /NOT_FOUND/i.test(error?.message || '');
    if (notFound) {
      const seedPayload = {
        kind: 'user',
        date: day,
        entity_id: safeAnon,
        anon_id: safeAnon,
        person_id: final_person_id,
        ...(final_user_id ? { user_id: final_user_id } : {}),
        ...(Number.isFinite(tz) ? { tz_offset: tz } : {}),
        events: [newEvent],
        counters: { [event]: 1 },
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp()
      };
      await docRef.set(seedPayload);
    } else {
      if (error.code === 6 || /ALREADY_EXISTS/i.test(error.message)) {
        console.warn(`[TRACK] Ignorando evento duplicado (idempotência): ${docId} / ${event_id}`);
        return { ok: true, id: docId, op: 'ignored_duplicate' };
      }
      console.error(JSON.stringify({
        tag: 'upsert_daily_fact_failed',
        docId,
        error: error.message || String(error),
        code: error.code
      }));
      throw error;
    }
  }
  return { ok: true, id: docId };
}

module.exports = {
  upsertDailyFact,
  toPlainJSON
};