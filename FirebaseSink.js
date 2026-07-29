/**
 * FirebaseSink.js
 * Versão: v1.7.0
 * Data: 2026-07-29
 * Desc: Sink de captura ampla de eventos S2S canônicos no Firestore.
 *
 * Base funcional preservada: v1.0.2.
 *
 * Alterações v1.7.0:
 * - Restaura o caminho principal de analytics ao comportamento funcional v1.0.2:
 *   valida somente platform/tx_id, faz get()+set({ merge:true }), preserva
 *   created_at e atualiza updated_at.
 * - Remove qualquer importação ou chamada direta ao AdsSink. Uma falha de carga,
 *   configuração ou dependência do AdsSink não pode impedir o FirebaseSink de iniciar.
 * - Remove inferência/filtro local de ads_eligible. O FirebaseSink não decide quais
 *   eventos são úteis; grava o canonicalEvent integralmente para filtragem posterior.
 * - A semente do AdsSink é uma segunda operação, isolada e best-effort, executada
 *   somente quando o handler já enviou ads_eligible === true.
 * - Falhas na semente Ads são registradas, mas nunca rejeitam, desfazem ou alteram
 *   o resultado da gravação principal de analytics.
 * - A semente permanece create-once e guarda ads_envelope_src imutável.
 */

'use strict';

const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Mesma variável de ambiente da versão funcional.
const COLLECTION_NAME =
  process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions';

const ADS_STATUS_PENDING = 'pending';

const ADS_ENVELOPE_FIELDS = [
  'gclid',
  'event_time_iso',
  'order_id',
  'tx_id',
  'platform',
  'commission_amount',
  'commission_currency',
  'event_type',
  'event_name',
  'page_type',
  'product_id',
  'consent',
  'consent_ad_user_data',
  'consent_ad_personalization',
  'consent_source',
  'consent_captured_at',
];

function _pickEnvelopeSrc(canonicalEvent) {
  const out = {};

  for (const field of ADS_ENVELOPE_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(canonicalEvent, field) &&
      canonicalEvent[field] !== undefined
    ) {
      out[field] = canonicalEvent[field];
    }
  }

  return out;
}

/**
 * Segunda etapa isolada.
 *
 * Regras:
 * - não é chamada para eventos sem ads_eligible === true;
 * - não importa nem executa AdsSink;
 * - não altera campos canônicos de analytics;
 * - não substitui uma semente/estado Ads já existente;
 * - qualquer erro é tratado pelo chamador como best-effort.
 */
async function _seedAdsIfEligible(db, docRef, canonicalEvent) {
  if (canonicalEvent.ads_eligible !== true) {
    return { seeded: false, reason: 'not_eligible' };
  }

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);

    // A gravação principal já ocorreu. Esta guarda evita criar um documento parcial
    // caso ele tenha sido apagado entre as duas operações.
    if (!snapshot.exists) {
      return { seeded: false, reason: 'analytics_doc_missing' };
    }

    const existingData = snapshot.data() || {};

    // Create-once: não reinicia pending, lease, retry, validated ou uploaded.
    if (existingData.ads_upload_status) {
      return { seeded: false, reason: 'already_seeded' };
    }

    transaction.set(
      docRef,
      {
        ads_upload_status: ADS_STATUS_PENDING,
        ads_wake_at: FieldValue.serverTimestamp(),
        ads_envelope_src: _pickEnvelopeSrc(canonicalEvent),
      },
      { merge: true }
    );

    return { seeded: true, reason: 'seeded' };
  });
}

/**
 * Salva um evento S2S canônico no Firestore.
 * Assume que o app Firebase já foi inicializado pelo server.js.
 *
 * O contrato de sucesso refere-se à captura de analytics. A semente Ads é uma
 * operação posterior e best-effort, portanto nunca converte um analytics salvo
 * com sucesso em erro do FirebaseSink.
 *
 * @param {object} canonicalEvent Objeto de evento normalizado.
 * @returns {Promise<{ok: true, docId: string}>}
 */
async function saveS2SEvent(canonicalEvent) {
  // Validação preservada da v1.0.2: nenhuma regra Ads participa desta decisão.
  if (!canonicalEvent || !canonicalEvent.platform || !canonicalEvent.tx_id) {
    console.error(
      '[FirebaseSink] Evento canônico inválido. Faltando platform ou tx_id. Evento:',
      canonicalEvent
    );
    throw new Error('Invalid canonical event: missing platform or tx_id');
  }

  try {
    const db = getFirestore();

    // Sanitização preservada da v1.0.2.
    const safePlatform = String(canonicalEvent.platform).replace(/[^\w\-]+/g, '_');
    const safeTxId = String(canonicalEvent.tx_id).replace(/[^\w\-]+/g, '_');

    const docId = `${safePlatform}_${safeTxId}`;
    const docRef = db.collection(COLLECTION_NAME).doc(docId);

    // Caminho principal de analytics preservado: get() + set({ merge:true }).
    const existingDoc = await docRef.get();

    const baseData = existingDoc.exists
      ? {}
      : { created_at: FieldValue.serverTimestamp() };

    const dataToSave = {
      ...baseData,
      ...canonicalEvent,
      updated_at: FieldValue.serverTimestamp(),
    };

    // A captura de analytics termina aqui. Não depende de transação Ads.
    await docRef.set(dataToSave, { merge: true });

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[FirebaseSink] Evento S2S salvo com sucesso: ${docId}`);
    }

    // Segunda etapa isolada. É aguardada para maximizar a durabilidade da semente,
    // mas o erro é absorvido porque analytics já foi persistido com sucesso.
    if (canonicalEvent.ads_eligible === true) {
      try {
        const seedResult = await _seedAdsIfEligible(db, docRef, canonicalEvent);

        if (
          process.env.NODE_ENV !== 'production' &&
          seedResult.seeded
        ) {
          console.log(`[FirebaseSink] Semente Ads criada: ${docId}`);
        }
      } catch (seedError) {
        console.error(
          `[FirebaseSink] Analytics salvo, mas a semente Ads falhou (${docId}):`,
          seedError?.message || seedError
        );
      }
    }

    // Retorno preservado da v1.0.2.
    return { ok: true, docId: docId };
  } catch (error) {
    // Este catch cobre apenas o caminho principal ou erros anteriores ao seu commit.
    console.error(
      `[FirebaseSink] Falha ao salvar evento S2S (${canonicalEvent.tx_id}):`,
      error.message
    );
    throw error;
  }
}

module.exports = {
  saveS2SEvent,
};
