/**
 * DigistorePostback.js
 * Versão: v1.3.0
 * Data: 2026-07-28
 * Desc: Handler S2S (webhook) para a plataforma Digistore24.
 *
 * Alterações v1.1.0:
 * - Adiciona captura de user_id e anon_id no objeto canônico.
 * - Implementa chamada ao DailyFactsSink para gravação dupla (jornada do usuário).
 *
 * Alterações v1.2.0 (Fase 2 — Purchase→AdsSink, decisão 2026-07-28):
 * - Captura commission_amount (de query.commission_amount, alimentado pelo placeholder
 *   {amount_affiliate_abs} no painel DS24 — troca pendente de amount= para
 *   commission_amount= na URL do postback, autorização de escrita à parte) e
 *   commission_currency (de query.currency, placeholder {currency}; painel DS24 já
 *   configurado em USD). Sem estes dois campos preenchidos, o AdsSink falha-fechado
 *   (permanent_error) por desenho — nunca envia o bruto como substituto.
 * - Adiciona Sink 4: AdsSink — chama AdsSink.sendConversion() para compras com gclid,
 *   à imagem dos 3 sinks já existentes (best-effort, nunca bloqueia a resposta 200).
 *
 * Alterações v1.3.0 (Fase 2 — correção de bloqueador ARCHITECT, ronda 2):
 * - Um postback de TESTE (eventStatus/status literal 'test') mapeia para event_type
 *   'purchase' (mapEventType), mas nunca deve ser tratado como venda real — nem no
 *   disparo imediato (Sink 4), nem na semente durável que o FirebaseSink grava. Passa
 *   a calcular canonical.ads_eligible (purchase + gclid + não-teste), lido por ambos
 *   os caminhos para não haver duas implementações divergentes de "é teste?".
 */

const FirebaseSink = require('./FirebaseSink');
const Ga4Sink = require('./Ga4Sink');
// --- Alteração v1.1.0: Importar novo Sink ---
const DailyFactsSink = require('./DailyFactsSink');
// --- Fim da Alteração v1.1.0 ---
// --- Alteração v1.2.0: Importar AdsSink (Fase 2 — Purchase→AdsSink) ---
const AdsSink = require('./AdsSink');
// --- Fim da Alteração v1.2.0 ---

const EXPECTED_AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;

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

async function handle(req, res) {
  if (!EXPECTED_AUTH_KEY) {
    console.error('[DigistorePostback] ERRO CRÍTICO: DIGISTORE_AUTH_KEY não configurada.');
    return res.status(500).send('Internal Server Configuration Error');
  }

  const receivedAuthKey = req.query.auth_key || '';

  if (receivedAuthKey !== EXPECTED_AUTH_KEY) {
    // Segurança: não loga a chave recebida
    console.warn('[DigistorePostback] Tentativa de postback com auth_key inválida.');
    return res.status(403).send('Unauthorized');
  }

  const query = req.query;
  const canonical = {};

  try {
    const eventStatus = query.event || query.status || 'completed';

    canonical.platform = 'digistore24';
    canonical.event_type = mapEventType(eventStatus);
    canonical.tx_id = query.transaction_id || query.order_id;
    canonical.order_id = query.order_id || query.transaction_id;

    if (!canonical.tx_id) {
      console.error('[DigistorePostback] Payload sem transaction_id/order_id. Query:', query);
      return res.status(200).send('OK (missing tx_id)');
    }

    canonical.product_id = query.product_id || query.product;
    canonical.sku = query.product_id || query.product;
    canonical.product_name = query.product || 'N/A';
    canonical.status = eventStatus;

    const rawAmount = parseFloat(query.amount || '0');
    canonical.gross_amount = Number.isFinite(rawAmount) ? rawAmount : 0;

    canonical.currency = query.currency || 'USD';

    // --- Alteração v1.2.0: Comissão do afiliado (Fase 2 — Purchase→AdsSink) ---
    // commission_amount vem de {amount_affiliate_abs} (painel DS24, troca de parâmetro
    // ainda pendente de autorização de escrita). commission_currency vem de {currency}
    // (painel DS24 já configurado em USD). Sem fallback: se faltar, o AdsSink
    // falha-fechado (permanent_error) em vez de adivinhar ou usar o bruto.
    const rawCommission = parseFloat(query.commission_amount || '0');
    canonical.commission_amount = Number.isFinite(rawCommission) ? rawCommission : 0;
    canonical.commission_currency = query.currency ? String(query.currency).toUpperCase() : null;
    // --- Fim da Alteração v1.2.0 ---

    // --- Alteração v1.1.0: Captura de Identidade Estendida ---
    canonical.cid = query.cid || query.trackingId || null;
    canonical.user_id = query.user_id || query.sid1 || null; // Captura User ID real
    canonical.anon_id = query.anon_id || query.sid4 || null; // Captura Anon ID para daily_facts
    // ---------------------------------------------------------

    canonical.gclid = query.gclid || query.sid2 || null;
    canonical.fbclid = query.fbclid || query.sid3 || null;
    canonical.campaignkey = query.campaign || query.campaignkey || null;

    // --- Alteração v1.3.0: Elegibilidade para o AdsSink (correção de bloqueador ARCHITECT) ---
    // Um postback de TESTE (eventStatus/status literal 'test') mapeia para event_type
    // 'purchase' (mapEventType), mas nunca deve ser tratado como venda real — nem no
    // disparo imediato (Sink 4), nem na semente durável que o FirebaseSink grava (senão
    // o reprocessador apanha-o mais tarde e envia-o na mesma). Um único campo, lido por
    // ambos os caminhos, evita duas implementações divergentes de "é teste?".
    const isTestTransaction = String(eventStatus).toLowerCase() === 'test';
    canonical.ads_eligible = canonical.event_type === 'purchase' && !!canonical.gclid && !isTestTransaction;
    // --- Fim da Alteração v1.3.0 ---

    canonical.event_time_iso = query.timestamp ? new Date(query.timestamp.replace(' ', 'T') + 'Z').toISOString() : new Date().toISOString();

    const { auth_key, ...rest } = query;
    canonical.raw = rest;

  } catch (parseError) {
    console.error(`[DigistorePostback] Falha ao normalizar o payload:`, parseError.message, query);
    return res.status(200).send('OK (parse error)');
  }

  // 3. Disparo para os "Sinks"

  // Sink 1: Transações (Raw S2S)
  try {
    await FirebaseSink.saveS2SEvent(canonical);
  } catch (error) {
    console.error(`[DigistorePostback] Falha no FirebaseSink (TX: ${canonical.tx_id}):`, error.message);
  }

  // --- Alteração v1.1.0: Sink 2: Jornada do Usuário (Daily Facts) ---
  try {
    if (canonical.anon_id) {
      await DailyFactsSink.saveS2SEventToDailyFacts(canonical);
    } else {
      // Warn apenas em debug para não poluir logs de produção se anon_id não for obrigatório
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[DigistorePostback] Evento S2S sem anon_id. daily_facts pulado. TX: ${canonical.tx_id}`);
      }
    }
  } catch (error) {
    console.error(`[DigistorePostback] Falha no DailyFactsSink (TX: ${canonical.tx_id}):`, error.message);
  }
  // --- Fim da Alteração v1.1.0 ---

  // Sink 3: Google Analytics
  try {
    if (canonical.event_type === 'purchase') {
      Ga4Sink.sendPurchaseFromCanonical(canonical);
    }
  } catch (error) {
    console.error(`[DigistorePostback] Falha ao disparar o Ga4Sink (TX: ${canonical.tx_id}):`, error.message);
  }

  // --- Alteração v1.3.0: Sink 4: AdsSink (Fase 2 — Purchase→AdsSink) ---
  // Best-effort, nunca bloqueia a resposta 200. Gate: canonical.ads_eligible já inclui
  // purchase + gclid + exclusão de teste (ver bloco acima). O AdsSink internamente já
  // verifica PZ_ADSSINK_ENABLED, gclid e o mapa de conversão — falha aqui é sempre
  // segura (fica em permanent_error/retry no Firestore, nunca lança).
  try {
    if (canonical.ads_eligible) {
      await AdsSink.sendConversion(canonical, { collection: 'affiliate_transactions' });
    }
  } catch (error) {
    console.error(`[DigistorePostback] Falha ao disparar o AdsSink (TX: ${canonical.tx_id}):`, error.message);
  }
  // --- Fim da Alteração v1.3.0 ---

  return res.status(200).send('OK');
}

module.exports = {
  handle
};
