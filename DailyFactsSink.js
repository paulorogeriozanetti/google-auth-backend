/**
 * DailyFactsSink.js
 * Versão: v1.0.0
 * Data: 2025-11-13
 * Desc: Salva eventos S2S canônicos no agrupamento daily_facts,
 * reutilizando a mesma lógica do /api/track.
 */

const { getFirestore } = require('firebase-admin/firestore');
const { upsertDailyFact } = require('./DailyFactsService');

/**
 * Salva um evento S2S na coleção daily_facts.
 * @param {object} canonicalEvent 
 */
async function saveS2SEventToDailyFacts(canonicalEvent) {
  if (!canonicalEvent) {
    console.warn('[DailyFactsSink] Evento canônico vazio. Pulando.');
    return { ok: false, error: 'EMPTY_EVENT' };
  }

  const db = getFirestore();

  const anonId = canonicalEvent.anon_id || 'anon_unknown';
  const userId = canonicalEvent.user_id || null;

  // Prefixa o evento para diferenciar (ex: s2s_purchase)
  const baseType = canonicalEvent.event_type || 'other';
  const eventName = `s2s_${baseType}`; 

  const tsISO = canonicalEvent.event_time_iso || new Date().toISOString();

  // Payload focado em atributos de compra
  const payload = {
    source: 's2s_webhook',
    platform: canonicalEvent.platform,
    tx_id: canonicalEvent.tx_id,
    order_id: canonicalEvent.order_id,
    product_id: canonicalEvent.product_id,
    product_name: canonicalEvent.product_name,
    gross_amount: canonicalEvent.gross_amount,
    currency: canonicalEvent.currency,
    campaignkey: canonicalEvent.campaignkey,
    cid: canonicalEvent.cid,
    gclid: canonicalEvent.gclid,
    fbclid: canonicalEvent.fbclid,
    status: canonicalEvent.status,
  };

  return upsertDailyFact({
    db,
    anon_id: anonId,
    user_id: userId,
    tz_offset: 0, // S2S geralmente é UTC
    event: eventName,
    page: 's2s_postback',
    session_id: null,
    payload,
    tsISO
  });
}

module.exports = {
  saveS2SEventToDailyFacts
};