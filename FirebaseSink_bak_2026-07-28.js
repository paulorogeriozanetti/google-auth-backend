/**
 * FirebaseSink.js
 * Versão: v1.0.2
 * Data: 2025-11-13
 * Desc: Módulo "Sink" (destino) responsável por gravar
 * eventos S2S canônicos no Firestore.
 *
 * Alterações v1.0.2 (baseado no feedback):
 * - Corrige regex de sanitização do docId (usando `/[^\w\-]+/g`).
 * - Adiciona sanitização também para `platform` no docId.
 * - Mantém lógica de `created_at` imutável da v1.0.1.
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Usa a mesma variável de ambiente do server.js
const COLLECTION_NAME = process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'affiliate_transactions';

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

  try {
    const db = getFirestore();

    // --- Alteração v1.0.2: Sanitização robusta do docId ---
    
    // Substitui qualquer coisa que NÃO seja (^) letra, número, underscore ou hífen por _
    const safePlatform = String(canonicalEvent.platform).replace(/[^\w\-]+/g, '_');
    const safeTxId = String(canonicalEvent.tx_id).replace(/[^\w\-]+/g, '_');
    
    const docId = `${safePlatform}_${safeTxId}`;
    const docRef = db.collection(COLLECTION_NAME).doc(docId);
    // --- Fim da Alteração v1.0.2 ---

    // --- Lógica v1.0.1 mantida: Preservar created_at ---
    const existingDoc = await docRef.get();
    
    // Define created_at apenas se o documento não existir
    const baseData = existingDoc.exists ? {} : {
      created_at: FieldValue.serverTimestamp()
    };

    const dataToSave = {
      ...baseData, // Contém created_at apenas na primeira gravação
      ...canonicalEvent,
      // updated_at é sempre atualizado
      updated_at: FieldValue.serverTimestamp()
    };
    // --- Fim da Lógica v1.0.1 ---

    // Usa set com merge:true para criar ou atualizar o registro
    await docRef.set(dataToSave, { merge: true });

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