/**
 * PostbackRouter.js
 * Versão: v1.0.6
 * Data: 2025-11-14
 * Desc: Ponto de entrada único (roteador) para todos os webhooks S2S.
 *
 * Alterações v1.0.6 (baseado no feedback):
 * - Confirma a lógica v1.0.5: Trata GET /postback/clickbank (Test IPN).
 * - Limpa comentários para versão de produção.
 * - Nenhuma funcionalidade perdida; Digistore (GET) e ClickBank (POST)
 * continuam a ser delegados aos seus handlers específicos.
 */

// Importa os handlers específicos da plataforma
const DigistorePostback = require('./DigistorePostback');
const ClickbankPostback = require('./ClickbankPostback');
// const BuygoodsPostback = require('./BuygoodsPostback');   // Futuro

/**
 * Mapa de handlers de plataforma.
 * A chave DEVE corresponder ao :platform na URL (ex: /postback/digistore24)
 */
const handlers = {
  'digistore24': DigistorePostback.handle,
  'clickbank': ClickbankPostback.handle,
  
  // Stubs para plataformas futuras (retornam 200 OK para evitar retries)
  'buygoods': async (req, res) => {
    console.warn(`[PostbackRouter] Plataforma 'buygoods' recebida, mas o handler ainda é um stub.`);
    res.status(200).send('OK (stub)');
  }
};

/**
 * Roteador principal para webhooks S2S.
 * @param {object} req - O objeto de requisição do Express.
 * @param {object} res - O objeto de resposta do Express.
 */
async function handle(req, res) {
  const platform = String(req.params.platform || 'unknown').toLowerCase();
  const handler = handlers[platform];
  const method = req.method.toUpperCase();

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[PostbackRouter] Webhook recebido: ${method} para plataforma: ${platform}`);
  }

  if (!handler) {
    console.warn(`[PostbackRouter] Recebido webhook para plataforma desconhecida: ${platform}`);
    return res.status(404).send('Not Found: Unknown platform');
  }

  // --- Lógica v1.0.5 (Mantida) ---
  // A ClickBank envia um 'GET' para testar a conexão ("Test IPN").
  // O handler ClickbankPostback.js espera um 'POST' com 'notification/iv'.
  // Portanto, o Router deve tratar o 'GET' de teste do ClickBank separadamente.
  
  if (platform === 'clickbank' && method === 'GET') {
    console.log(`[PostbackRouter] ClickBank GET (Test IPN) recebido. Respondendo 200 OK. Query:`, req.query);
    // Responde 200 OK para o "Test Connection" do ClickBank
    return res.status(200).send('OK (Test Connection)');
  }
  // --- Fim da Lógica v1.0.5 ---

  try {
    // Delega o trabalho para o handler específico
    // (DigistorePostback.handle para GET, ClickbankPostback.handle para POST)
    await handler(req, res);
    
    // "Airbag" de segurança (v1.0.2)
    if (!res.headersSent) {
      console.warn(`[PostbackRouter] Handler para '${platform}' não enviou resposta. Enviando 200 OK por segurança (fallback).`);
      res.status(200).send('OK (router fallback)');
    }

  } catch (error) {
    // Pega erros catastróficos que o handler possa ter deixado vazar
    console.error(`[PostbackRouter] Erro CRÍTICO no handler da plataforma '${platform}':`, error.message);
    
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  }
}

module.exports = {
  handle
};