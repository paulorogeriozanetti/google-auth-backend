/**
 * Ga4Sink.js
 * Versão: v1.0.1
 * Data: 2025-11-13
 * Desc: Módulo "Sink" (destino) responsável por enviar eventos
 * S2S (como 'purchase') para o Google Analytics 4 (GA4)
 * via Measurement Protocol.
 *
 * Alterações v1.0.1 (baseado no feedback):
 * - Adiciona 'engagement_time_msec: 1' (obrigatório pelo GA4 MP).
 * - Adiciona verificação 'Number.isFinite' para 'value' e 'price' (evita NaN).
 */

const axios = require('axios');

// Lê as variáveis do .env
const MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID;
const API_SECRET = process.env.GA4_API_SECRET;
const GA4_URL = `https://www.google-analytics.com/mp/collect?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`;

/**
 * Verifica se um user_id é anônimo (gerado pelo frontend) ou real (do GSI).
 * @param {string} id - O user_id.
 * @returns {boolean}
 */
const isAnonUserId = (id) => !id || String(id).startsWith('usr_');

/**
 * Envia um evento de compra (purchase) para o GA4 MP a partir de um evento canônico.
 * @param {object} canonicalEvent - O objeto de evento normalizado vindo do Handler.
 */
async function sendPurchaseFromCanonical(canonicalEvent) {
  // 1. Guardas de Configuração
  if (!MEASUREMENT_ID || !API_SECRET) {
    console.warn('[Ga4Sink] GA4_MEASUREMENT_ID ou GA4_API_SECRET não configurados. Evento S2S não enviado.');
    return; // Não trava o fluxo, apenas avisa
  }

  if (!canonicalEvent || !canonicalEvent.tx_id) {
    console.error('[Ga4Sink] Evento canônico inválido ou sem tx_id. Evento S2S não enviado.');
    return;
  }

  // 2. Mapeamento de Dados (Canônico -> GA4)
  
  // O client_id (cid) é a chave de atribuição principal
  //
  const clientId = canonicalEvent.cid || canonicalEvent.trackingId || canonicalEvent.sid1 || 's2s_fallback_' + canonicalEvent.tx_id;
  
  // O user_id só é enviado se for um ID real (não-anônimo)
  const userId = (canonicalEvent.user_id && !isAnonUserId(canonicalEvent.user_id)) 
    ? String(canonicalEvent.user_id) 
    : undefined;

  // --- Alteração v1.0.1: Garantir que o valor nunca é NaN ---
  const rawValue = parseFloat(canonicalEvent.gross_amount || 0);
  const safeValue = Number.isFinite(rawValue) ? rawValue : 0;
  // --- Fim da Alteração v1.0.1 ---

  const ga4Event = {
    name: 'purchase',
    params: {
      transaction_id: String(canonicalEvent.tx_id),
      value: safeValue, // <-- Alteração v1.0.1
      currency: canonicalEvent.currency || 'USD',
      affiliation: canonicalEvent.platform,
      // Inclui o GCLID se estiver presente no evento canônico
      gclid: canonicalEvent.gclid || undefined,
      
      // --- Alteração v1.0.1: Adicionado engagement_time_msec ---
      engagement_time_msec: 1,
      // --- Fim da Alteração v1.0.1 ---

      // Estrutura de 'items' padrão do GA4
      items: [{
        item_id: canonicalEvent.sku || canonicalEvent.product_id || 'N/A',
        item_name: canonicalEvent.product_name || canonicalEvent.product_id || 'N/A',
        affiliation: canonicalEvent.platform,
        price: safeValue, // <-- Alteração v1.0.1
        quantity: 1
      }],
      // Parâmetros extra (análogos ao PHP)
      campaign: canonicalEvent.campaignkey || canonicalEvent.campaign || '(not set)',
      status: canonicalEvent.status || 'completed'
    }
  };

  // Limpa parâmetros indefinidos (GA4 MP não gosta de 'null' ou 'undefined' explícitos)
  Object.keys(ga4Event.params).forEach(key => 
    (ga4Event.params[key] === undefined || ga4Event.params[key] === null) && delete ga4Event.params[key]
  );
  
  // 3. Montagem do Payload Final
  const payload = {
    client_id: clientId,
    user_id: userId,
    events: [ga4Event]
  };

  // Limpa user_id se for undefined
  if (!payload.user_id) {
    delete payload.user_id;
  }

  // 4. Envio (não bloqueante)
  try {
    // Usamos axios, que já é uma dependência do projeto
    const response = await axios.post(GA4_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 4000 // Timeout de 4 segundos
    });

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Ga4Sink] Evento 'purchase' enviado com sucesso (TX: ${canonicalEvent.tx_id}). Status: ${response.status}`);
    }

  } catch (error) {
    // Erros aqui NÃO devem travar a resposta 200 do webhook.
    // Apenas logamos o erro.
    console.error(`[Ga4Sink] Erro ao enviar evento S2S (TX: ${canonicalEvent.tx_id}):`, error.message);
    if (error.response && error.response.data) {
      // Loga a resposta de erro do Google (útil para depurar payloads inválidos)
      console.error('[Ga4Sink] Resposta de erro do GA4:', JSON.stringify(error.response.data));
    }
  }
}

module.exports = {
  sendPurchaseFromCanonical
};