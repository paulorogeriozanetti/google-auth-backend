/**
 * DigistorePostback.js
 * Versão: v1.0.3
 * Data: 2025-11-13
 * Desc: Handler S2S (webhook) para a plataforma Digistore24.
 *
 * Alterações v1.0.3 (baseado no feedback):
 * - Remove o log da auth_key recebida em caso de falha (Segurança).
 * - Mantém todas as lógicas da v1.0.2 (caminhos flat, validação tx_id, NaN safe).
 */

// Importa os "Sinks" (Destinos)
// Caminhos corrigidos para diretório plano (v1.0.2)
const FirebaseSink = require('./FirebaseSink');
const Ga4Sink = require('./Ga4Sink');

// Lê a chave de autenticação do .env
const EXPECTED_AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;

/**
 * Mapeia o status do Digistore24 (ou 'event') para um tipo de evento canônico.
 * @param {string} dsStatus - O status ou evento do Digistore24.
 * @returns {string} - 'purchase', 'refund', 'chargeback', ou 'other'.
 */
function mapEventType(dsStatus) {
  const status = String(dsStatus).toLowerCase();
  switch (status) {
    case 'completed':
    case 'payment':
    case 'test':
      return 'purchase';
    case 'refund':
      return 'refund';
    case 'chargeback':
      return 'chargeback';
    default:
      return 'other';
  }
}

/**
 * Processa o webhook (GET) do Digistore24.
 * @param {object} req - O objeto de requisição do Express.
 * @param {object} res - O objeto de resposta do Express.
 */
async function handle(req, res) {
  // 1. Validação de Segurança
  if (!EXPECTED_AUTH_KEY) {
    console.error('[DigistorePostback] ERRO CRÍTICO: DIGISTORE_AUTH_KEY não está configurada no .env. Recusando.');
    // 500 porque é uma falha de configuração do servidor
    return res.status(500).send('Internal Server Configuration Error');
  }

  const receivedAuthKey = req.query.auth_key || '';

  if (receivedAuthKey !== EXPECTED_AUTH_KEY) {
    // --- Alteração v1.0.3: Não loga a chave recebida (Segurança) ---
    console.warn('[DigistorePostback] Tentativa de postback com auth_key inválida.');
    // --- Fim da Alteração v1.0.3 ---
    return res.status(403).send('Unauthorized');
  }

  // 2. Normalização (Parse do Payload)
  const query = req.query;
  const canonical = {};

  try {
    const eventStatus = query.event || query.status || 'completed';
    
    canonical.platform = 'digistore24';
    canonical.event_type = mapEventType(eventStatus);
    canonical.tx_id = query.transaction_id || query.order_id;
    canonical.order_id = query.order_id || query.transaction_id;

    // Validação explícita de tx_id (lógica v1.0.1)
    if (!canonical.tx_id) {
      console.error('[DigistorePostback] Payload sem transaction_id/order_id. Query:', query);
      return res.status(200).send('OK (missing tx_id)');
    }

    canonical.product_id = query.product_id || query.product; 
    canonical.sku = query.product_id || query.product;
    canonical.product_name = query.product || 'N/A';
    canonical.status = eventStatus;

    // Evitar NaN em gross_amount (lógica v1.0.1)
    const rawAmount = parseFloat(query.amount || '0');
    canonical.gross_amount = Number.isFinite(rawAmount) ? rawAmount : 0;

    canonical.currency = query.currency || 'USD';
    
    // Chaves de Atribuição (essenciais para os Sinks)
    canonical.cid = query.cid || query.trackingId || query.sid1 || null;
    canonical.gclid = query.gclid || query.sid2 || null;
    canonical.fbclid = query.fbclid || query.sid3 || null;
    canonical.campaignkey = query.campaign || query.campaignkey || null;
    
    // Timestamps
    canonical.event_time_iso = query.timestamp ? new Date(query.timestamp.replace(' ', 'T') + 'Z').toISOString() : new Date().toISOString();
    
    // Remover auth_key do payload bruto salvo (lógica v1.0.1)
    const { auth_key, ...rest } = query;
    canonical.raw = rest;

  } catch (parseError) {
    console.error(`[DigistorePostback] Falha ao normalizar o payload:`, parseError.message, query);
    return res.status(200).send('OK (parse error)');
  }

  // 3. Disparo para os "Sinks" (Destinos)
  try {
    await FirebaseSink.saveS2SEvent(canonical);
  } catch (error) {
    console.error(`[DigistorePostback] Falha no FirebaseSink (TX: ${canonical.tx_id}):`, error.message);
  }

  try {
    if (canonical.event_type === 'purchase') {
      Ga4Sink.sendPurchaseFromCanonical(canonical);
    }
  } catch (error) {
    console.error(`[DigistorePostback] Falha ao disparar o Ga4Sink (TX: ${canonical.tx_id}):`, error.message);
  }

  // 4. Responder 200 OK
  return res.status(200).send('OK');
}

module.exports = {
  handle
};