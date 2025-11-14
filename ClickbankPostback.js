/**
 * ClickbankPostback.js
 * Versão: v1.0.2
 * Data: 2025-11-13
 * Desc: Handler S2S (webhook) para a plataforma ClickBank.
 *
 * Alterações v1.0.2 (Refinamento de Feedback):
 * - Adiciona try/catch robusto ao parser de 'transactionTime' [cite: Analisar feedback abaixo. Se necessário gerar v1.0.2...].
 * - Remove comentários [cite: ...] para versão de produção limpa [cite: Analisar feedback abaixo. Se necessário gerar v1.0.2...].
 * - Nenhuma funcionalidade perdida; mantém lógica INS 8.0 e Sinks (Firebase, DailyFacts, GA4) da v1.0.1.
 */

const crypto = require('crypto');
const FirebaseSink = require('./FirebaseSink');
const Ga4Sink = require('./Ga4Sink');
const DailyFactsSink = require('./DailyFactsSink');

// Lê o segredo do .env
const WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY || '';

/**
 * Mapeia o tipo de transação do ClickBank para um evento canônico.
 * @param {string} cbType - O transactionType do ClickBank.
 * @returns {string} - 'purchase', 'refund', 'chargeback', ou 'other'.
 */
function mapEventType(cbType) {
  const type = String(cbType).toLowerCase();
  switch (type) {
    case 'sale':
    case 'test_sale':
      return 'purchase';
    case 'rfnd':
    case 'test_rfnd':
      return 'refund';
    case 'cgbk':
    case 'test_cgbk':
      return 'chargeback';
    default:
      return 'other'; // ex: bill, cancel_rebill
  }
}

/**
 * Processa o webhook (POST) do ClickBank.
 * Espera um body 'application/x-www-form-urlencoded' parseado pelo Express.
 * @param {object} req - O objeto de requisição do Express.
 * @param {object} res - O objeto de resposta do Express.
 */
async function handle(req, res) {
  // 1. Validação de Segurança (Chave Secreta)
  if (!WEBHOOK_SECRET_KEY) {
    console.error('[ClickbankPostback] ERRO CRÍTICO: CLICKBANK_WEBHOOK_SECRET_KEY não configurada.');
    return res.status(500).send('Internal Server Configuration Error');
  }

  // Lógica de Validação INS 8.0 (v1.0.1)
  const { notification, iv } = req.body || {};
  
  if (!notification || !iv) {
    console.warn('[ClickbankPostback] notification/iv ausentes no body (esperado application/x-www-form-urlencoded).');
    return res.status(400).send('Bad Request');
  }

  let payload;
  try {
    // 1.1) Preparar Chave e IV
    const key = crypto.createHash('sha256')
      .update(WEBHOOK_SECRET_KEY)
      .digest();
    
    const ivBuf = Buffer.from(iv, 'base64');

    // 1.2) Descriptografar o 'notification'
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, ivBuf);
    
    let decrypted = decipher.update(notification, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    payload = JSON.parse(decrypted);

  } catch (err) {
    console.error('[ClickbankPostback] Falha ao descriptografar:', err.message);
    return res.status(401).send('Unauthorized (Decryption Failed)');
  }

  // 2. Normalização (Parse do Payload)
  const canonical = {};
  try {
    const { transactionType, receipt, transactionTime, currency, totalOrderAmount, vendorVariables, trackingCodes, lineItems } = payload || {};

    // Extrai GCLID/FBCLID/SID4(anon_id) dos trackingCodes
    const tracking = (trackingCodes || []).reduce((acc, code) => {
      const s = String(code || '');
      if (!acc.gclid && s.startsWith('gclid_')) acc.gclid = s.substring(6);
      else if (!acc.fbclid && s.startsWith('fbclid_')) acc.fbclid = s.substring(7);
      else if (!acc.anon_id && s.startsWith('sid4_')) acc.anon_id = s.substring(5); // Mapeamento de anon_id
      return acc;
    }, {});

    const vendorTid = vendorVariables?.tid_ || vendorVariables?.tid || null;
    const firstItem = Array.isArray(lineItems) && lineItems.length ? lineItems[0] : {};

    const rawAmount = parseFloat(totalOrderAmount || firstItem.accountAmount || '0');
    
    canonical.platform = 'clickbank';
    canonical.event_type = mapEventType(transactionType); // Canônico: purchase, refund, etc.
    canonical.tx_id = receipt;
    canonical.order_id = receipt;
    canonical.product_id = firstItem.itemNo || 'N/A';
    canonical.sku = firstItem.itemNo || 'N/A';
    canonical.product_name = firstItem.productTitle || 'N/A';
    canonical.status = String(transactionType).toLowerCase(); // Status real do vendor: sale, rfnd, etc.
    canonical.gross_amount = Number.isFinite(rawAmount) ? rawAmount : 0;
    canonical.currency = currency || 'USD';
    
    // Chaves de Atribuição (essenciais para os Sinks)
    canonical.user_id = vendorTid || null; // O 'tid' do ClickBank é o nosso 'user_id'
    canonical.anon_id = tracking.anon_id || null; // 'sid4' (anon_id)
    canonical.gclid = tracking.gclid || null;
    canonical.fbclid = tracking.fbclid || null;
    
    // --- Alteração v1.0.2: Parser de data mais robusto ---
    try {
      canonical.event_time_iso = transactionTime ? new Date(transactionTime).toISOString() : new Date().toISOString();
    } catch (dateError) {
      console.warn(`[ClickbankPostback] Falha ao parsear transactionTime '${transactionTime}'. Usando data atual.`);
      canonical.event_time_iso = new Date().toISOString();
    }
    // --- Fim da Alteração v1.0.2 ---

    canonical.raw = payload; // Payload já decriptografado (seguro)

  } catch (parseError) {
    console.error(`[ClickbankPostback] Falha ao normalizar o payload:`, parseError.message, payload);
    return res.status(200).send('OK (parse error)');
  }

  // 3. Disparo para os "Sinks"
  
  // Sink 1: Transações (Raw S2S)
  try {
    await FirebaseSink.saveS2SEvent(canonical);
  } catch (error) {
    console.error(`[ClickbankPostback] Falha no FirebaseSink (TX: ${canonical.tx_id}):`, error.message);
  }

  // Sink 2: Jornada do Usuário (Daily Facts)
  try {
    if (canonical.anon_id) {
      await DailyFactsSink.saveS2SEventToDailyFacts(canonical);
    } else {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[ClickbankPostback] Evento S2S sem anon_id. daily_facts pulado. TX: ${canonical.tx_id}`);
      }
    }
  } catch (error) {
    console.error(`[ClickbankPostback] Falha no DailyFactsSink (TX: ${canonical.tx_id}):`, error.message);
  }

  // Sink 3: Google Analytics
  try {
    if (canonical.event_type === 'purchase') {
      Ga4Sink.sendPurchaseFromCanonical(canonical);
    }
  } catch (error) {
    console.error(`[ClickbankPostback] Falha ao disparar o Ga4Sink (TX: ${canonical.tx_id}):`, error.message);
  }

  // 4. Responder 200 OK
  return res.status(200).send('OK');
}

module.exports = {
  handle
};