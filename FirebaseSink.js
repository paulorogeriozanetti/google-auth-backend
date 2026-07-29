/**
 * FirebaseSink.js
 * Versão: v1.6.0
 * Data: 2026-07-29
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
 *
 * Alterações v1.5.1 (hotfix de integração):
 * - Resolve ads_eligible de forma compatível quando handlers antigos não enviam o
 *   campo: apenas purchase + gclid + ausência de marcador de teste.
 * - Persiste o valor efetivo de ads_eligible e mantém a semente pending +
 *   ads_envelope_src na mesma transação.
 * - Após commit, aciona AdsSink.sendConversion em fire-and-forget. O documento já
 *   está duravelmente reclamável; se o processo cair, o reprocessador assume.
 * - Compatível com handlers novos que já chamam AdsSink: o claim/lease torna a
 *   segunda chamada idempotente.
 *
 * Alterações v1.6.0 (desacoplamento Analytics / AdsSink):
 * - Restaura para analytics o caminho simples e abrangente da v1.0.2:
 *   docRef.get() + docRef.set(..., { merge:true }). A captura canónica deixa de
 *   depender de uma transação Firestore.
 * - A semente do AdsSink passa para uma SEGUNDA etapa, transacional e isolada,
 *   executada apenas para eventos elegíveis.
 * - Uma falha/abort/timeout na semente Ads é registada, mas NÃO rejeita nem desfaz
 *   a gravação de analytics já concluída.
 * - AdsSink.sendConversion só é acionado quando a semente existe ou já existia.
 * - created_at, updated_at, docId e semântica last-delivery-wins permanecem iguais
 *   ao backup v1.0.2 para os campos canónicos.
 */

const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const AdsSink = require('./AdsSink');

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

const TEST_MARKERS = new Set([
  '1', 'true', 'yes', 'y', 'test', 'test_sale', 'test-sale', 'sandbox',
]);

function _isPositiveTestMarker(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === null || value === undefined) return false;
  return TEST_MARKERS.has(String(value).trim().toLowerCase());
}

function _isTestEvent(canonicalEvent) {
  const raw = canonicalEvent && typeof canonicalEvent.raw === 'object'
    ? canonicalEvent.raw
    : {};
  const candidates = [
    canonicalEvent?.is_test,
    canonicalEvent?.isTest,
    canonicalEvent?.test,
    canonicalEvent?.test_mode,
    canonicalEvent?.status,
    canonicalEvent?.event_status,
    raw?.is_test,
    raw?.isTest,
    raw?.test,
    raw?.test_mode,
    raw?.status,
    raw?.event,
    raw?.event_type,
    raw?.transaction_type,
  ];
  return candidates.some(_isPositiveTestMarker);
}

/**
 * Compatibilidade com handlers de versões diferentes.
 * - Um boolean explícito continua soberano.
 * - Sem valor explícito, só inferimos elegibilidade para purchase com gclid e sem
 *   marcador de teste conhecido. Qualquer outro evento falha fechado.
 */
function _resolveAdsEligible(canonicalEvent) {
  if (canonicalEvent?.ads_eligible === true) return true;
  if (canonicalEvent?.ads_eligible === false) return false;

  const explicit = String(canonicalEvent?.ads_eligible ?? '').trim().toLowerCase();
  if (explicit === 'true' || explicit === '1' || explicit === 'yes') return true;
  if (explicit === 'false' || explicit === '0' || explicit === 'no') return false;

  const eventType = String(
    canonicalEvent?.event_type || canonicalEvent?.event_name || canonicalEvent?.event || ''
  ).trim().toLowerCase();
  const hasGclid = !!String(canonicalEvent?.gclid || '').trim();

  return eventType === 'purchase' && hasGclid && !_isTestEvent(canonicalEvent);
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
  const adsEligible = _resolveAdsEligible(canonicalEvent);

  // ---------------------------------------------------------------------------
  // ETAPA 1 — ANALYTICS (prioridade máxima, sem transação)
  //
  // Mantém o comportamento comprovado da v1.0.2: captura o maior volume possível
  // com get()+set(merge:true). O pipeline Ads não participa desta escrita.
  // ---------------------------------------------------------------------------
  try {
    const existingDoc = await docRef.get();

    const baseData = existingDoc.exists
      ? {}
      : { created_at: FieldValue.serverTimestamp() };

    await docRef.set({
      ...baseData,
      ...canonicalEvent,
      ads_eligible: adsEligible,
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[FirebaseSink] Evento S2S salvo com sucesso: ${docId}`);
    }
  } catch (error) {
    console.error(`[FirebaseSink] Falha ao salvar analytics (${canonicalEvent.tx_id}):`, error.message);
    // Apenas a falha da própria gravação de analytics rejeita saveS2SEvent.
    throw error;
  }

  // Eventos não elegíveis terminam aqui. Analytics já está persistido.
  if (!adsEligible) {
    return {
      ok: true,
      docId,
      adsEligible: false,
      adsSeeded: false,
      adsReason: 'not_eligible',
    };
  }

  // ---------------------------------------------------------------------------
  // ETAPA 2 — ADS SEED (transação isolada, best-effort)
  //
  // A transação protege somente o snapshot create-once e o estado pending.
  // Falhas nesta etapa nunca apagam nem tornam inválida a captura de analytics.
  // ---------------------------------------------------------------------------
  let adsSeeded = false;
  let adsSeedExists = false;
  let adsSeedError = null;

  try {
    const seedResult = await db.runTransaction(async (t) => {
      const snap = await t.get(docRef);

      if (!snap.exists) {
        // Muito improvável após a etapa 1; tratamos como falha recuperável do Ads.
        throw new Error('analytics_doc_missing_before_ads_seed');
      }

      const data = snap.data() || {};

      // Create-once: qualquer estado Ads já presente significa que outro worker ou
      // entrega já semeou/reclamou este documento. Não substituir o snapshot.
      if (data.ads_upload_status) {
        return { seeded: false, exists: true, status: data.ads_upload_status };
      }

      t.set(docRef, {
        ads_upload_status: ADS_STATUS_PENDING,
        ads_wake_at: Timestamp.now(),
        ads_envelope_src: _pickEnvelopeSrc(canonicalEvent),
        ads_state_updated_at: FieldValue.serverTimestamp(),
      }, { merge: true });

      return { seeded: true, exists: true, status: ADS_STATUS_PENDING };
    });

    adsSeeded = !!seedResult?.seeded;
    adsSeedExists = !!seedResult?.exists;
  } catch (error) {
    adsSeedError = String(error?.message || error);
    console.error(
      `[FirebaseSink] ALARME: analytics salvo, mas falhou a semente Ads (${docId}):`,
      adsSeedError
    );
  }

  // Só aciona inline quando há uma semente reclamável. Se a semente falhou, uma
  // reentrega futura pode tentar novamente sem comprometer o evento de analytics.
  if (
    adsSeedExists &&
    process.env.PZ_ADSSINK_ENABLED === 'true'
  ) {
    setImmediate(() => {
      AdsSink.sendConversion(canonicalEvent)
        .then((result) => {
          if (process.env.NODE_ENV !== 'production') {
            console.log(
              `[FirebaseSink] AdsSink acionado ${docId}: ${result?.reason || 'sem_resultado'}`
            );
          }
        })
        .catch((error) => {
          // sendConversion é never-throw, mas esta guarda evita unhandled rejection.
          console.error(
            `[FirebaseSink] Falha ao acionar AdsSink (${docId}):`,
            error?.message || error
          );
        });
    });
  }

  return {
    ok: true,
    docId,
    adsEligible: true,
    adsSeeded,
    adsSeedExists,
    adsSeedError,
  };
}

module.exports = {
  saveS2SEvent,
  _resolveAdsEligible,
};