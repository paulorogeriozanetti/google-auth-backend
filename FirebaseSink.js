/**
 * FirebaseSink.js
 * Versão: v1.5.0
 * Data: 2026-07-28
 * Desc: Módulo "Sink" (destino) responsável por gravar
 * eventos S2S canônicos no Firestore.
 *
 * Alterações v1.0.2 (baseado no feedback):
 * - Corrige regex de sanitização do docId (usando `/[^\w\-]+/g`).
 * - Adiciona sanitização também para `platform` no docId.
 * - Mantém lógica de `created_at` imutável da v1.0.1.
 *
 * Alterações v1.1.0..v1.4.0 (Fase 2 — rondas de revisão ARCHITECT; consolidadas e
 * SUBSTITUÍDAS pela v1.5.0 antes de qualquer deploy — as versões intermédias nunca
 * chegaram a produção):
 * - v1.1.0: semente durável ads_upload_status:'pending' + ads_wake_at na mesma
 *   transacção dos campos crus; get()+set() passam a db.runTransaction().
 * - v1.2.0–v1.4.0: tentativa de imutabilidade do envelope por congelamento dos campos
 *   canónicos de topo (create-once → incondicional → +consent → +event_name).
 *   REJEITADA em regressão: um refund/chargeback com o mesmo tx_id da compra ficava
 *   com campos canónicos da compra e raw do reembolso — documento incoerente.
 *
 * Alterações v1.5.0 (Fase 2 — correção estrutural pós-regressão, APROVADO):
 * - A imutabilidade do envelope MUDA DE SÍTIO: em vez de congelar campos de topo, a
 *   semente grava ads_envelope_src — cópia congelada dos ADS_ENVELOPE_FIELDS tal como
 *   chegaram na entrega que semeou (create-once por construção: vive no adsSeed,
 *   guardado por !existingData.ads_upload_status). O AdsSink v3.0.1 constrói o
 *   envelope a partir deste snapshot (fallback: documento completo, para docs sem
 *   snapshot — micro outbox e legado).
 * - Os campos canónicos de topo VOLTAM À SEMÂNTICA v1.0.2 INTEGRAL: última entrega
 *   vence, para todos os documentos e todos os campos. Um refund/chargeback pós-compra
 *   actualiza event_type/status/raw normalmente. Zero regressão em
 *   affiliate_transactions.
 * - Ordem do spread: `...adsSeed` aplicado DEPOIS de `...canonicalEvent` (preferência
 *   defensiva do ARCHITECT no veredicto de aprovação — nenhum handler produz chaves
 *   ads_* no canonical hoje, mas esta ordem elimina a dependência dessa verificação
 *   manual).
 * - REGRA DE DESENHO: campos do envelope completam-se ANTES da semente (o canonical
 *   chega completo a saveS2SEvent; a semente e o snapshot vão na mesma transacção).
 *   Nenhum caminho pode "completar" o snapshot depois — ausências no seed são
 *   definitivas (o AdsSink falha-fechado sobre elas, por desenho).
 */

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');

// Usa a mesma variável de ambiente do server.js
const COLLECTION_NAME = process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions';

// Espelha AdsSink.js: ST_PENDING = 'pending'. O AdsSink.js não exporta esta constante —
// se a renomear um dia, esta semente tem de ser actualizada a par (acoplamento aceite,
// mínimo necessário para a semente funcionar sem duplicar lógica do AdsSink aqui).
const ADS_STATUS_PENDING = 'pending';

// Campos copiados para o snapshot congelado ads_envelope_src no momento da semente.
// Espelha: AdsSink.js:_ensureEnvelope (gclid, event_time_iso, order_id, tx_id,
// platform, commission_amount, commission_currency; event_type/event_name para a
// resolução do evento; page_type/product_id para a linha do mapa) +
// ConsentResolver.readSignal (consent aninhado e formas achatadas).
const ADS_ENVELOPE_FIELDS = [
  'gclid', 'event_time_iso', 'order_id', 'tx_id', 'platform',
  'commission_amount', 'commission_currency', 'event_type', 'event_name',
  'page_type', 'product_id',
  'consent', 'consent_ad_user_data', 'consent_ad_personalization',
  'consent_source', 'consent_captured_at',
];

/**
 * Copia apenas os ADS_ENVELOPE_FIELDS presentes no evento (ausências ficam ausentes —
 * o Firestore não aceita undefined, e o AdsSink falha-fechado sobre ausências por
 * desenho; um snapshot não inventa campos).
 */
function _pickEnvelopeSrc(canonicalEvent) {
  const out = {};
  for (const field of ADS_ENVELOPE_FIELDS) {
    if (field in canonicalEvent && canonicalEvent[field] !== undefined) {
      out[field] = canonicalEvent[field];
    }
  }
  return out;
}

/**
 * Salva um evento S2S canônico no Firestore.
 * Assume que o app Firebase já foi inicializado (pelo server.js).
 * @param {object} canonicalEvent - O objeto de evento normalizado.
 */
async function saveS2SEvent(canonicalEvent) {
  if (!canonicalEvent || !canonicalEvent.platform || !canonicalEvent.tx_id) {
    console.error('[FirebaseSink] Evento canônico inválido. Faltando platform ou tx_id. Evento:', canonicalEvent);
    throw new Error('Invalid canonical event: missing platform or tx_id');
  }

  const db = getFirestore();

  // Sanitização robusta do docId (v1.0.2)
  const safePlatform = String(canonicalEvent.platform).replace(/[^\w\-]+/g, '_');
  const safeTxId = String(canonicalEvent.tx_id).replace(/[^\w\-]+/g, '_');
  const docId = `${safePlatform}_${safeTxId}`;
  const docRef = db.collection(COLLECTION_NAME).doc(docId);

  try {
    await db.runTransaction(async (t) => {
      const existingDoc = await t.get(docRef);
      const exists = existingDoc.exists;
      const existingData = exists ? (existingDoc.data() || {}) : {};

      // Preserva created_at imutável (lógica v1.0.1, agora dentro da transacção)
      const baseData = exists ? {} : { created_at: FieldValue.serverTimestamp() };

      // v1.5.0: semente durável do AdsSink + snapshot congelado do envelope, juntos e
      // create-once (a guarda !existingData.ads_upload_status cobre ambos). Só compras
      // elegíveis (ads_eligible calculado pelo handler: purchase + gclid + não-teste).
      const adsSeed = (canonicalEvent.ads_eligible && !existingData.ads_upload_status)
        ? {
            ads_upload_status: ADS_STATUS_PENDING,
            ads_wake_at: Timestamp.now(),
            ads_envelope_src: _pickEnvelopeSrc(canonicalEvent),
          }
        : {};

      // v1.5.0: campos de topo com semântica v1.0.2 integral — última entrega vence,
      // sem excepções. A imutabilidade do envelope vive em ads_envelope_src, não aqui.
      // Ordem do spread: adsSeed DEPOIS de canonicalEvent (defesa explícita — nenhum
      // handler produz chaves ads_* hoje, mas esta ordem não depende disso).
      const dataToSave = {
        ...baseData,
        ...canonicalEvent,
        ...adsSeed,
        // updated_at é sempre atualizado
        updated_at: FieldValue.serverTimestamp(),
      };

      t.set(docRef, dataToSave, { merge: true });
    });

    // Log menos verboso (removido em produção, ativado em debug)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[FirebaseSink] Evento S2S salvo com sucesso: ${docId}`);
    }

    return { ok: true, docId: docId };

  } catch (error) {
    console.error(`[FirebaseSink] Falha ao salvar evento S2S (${canonicalEvent.tx_id}):`, error.message);
    // Propaga o erro para o Router/Handler poder logar, mas não travar
    throw error;
  }
}

module.exports = {
  saveS2SEvent
};