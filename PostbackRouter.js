/**
 * PostbackRouter.js
 * Versão: v1.0.2
 * Data: 2025-11-13
 * Desc: Ponto de entrada único (roteador) para todos os webhooks S2S.
 * Identifica a plataforma e delega para o handler específico.
 *
 * Alterações v1.0.2 (baseado no feedback):
 * - Adiciona "airbag" (fallback 200 OK) se um handler for executado
 * sem erros, mas esquecer de enviar uma resposta.
 * - Mantém log de debug da v1.0.1.
 */

// Importa os handlers específicos da plataforma
//
const DigistorePostback = require('./DigistorePostback');
// const ClickbankPostback = require('./ClickbankPostback'); // Descomente quando estiver pronto
// const BuygoodsPostback = require('./BuygoodsPostback');   // Futuro

/**
 * Mapa de handlers de plataforma.
 * A chave DEVE corresponder ao :platform na URL (ex: /postback/digistore24)
 */
const handlers = {
  'digistore24': DigistorePostback.handle,
  
  // Stubs para plataformas futuras (retornam 200 OK para evitar retries)
  //
  'clickbank': async (req, res) => {
    console.warn(`[PostbackRouter] Plataforma 'clickbank' recebida, mas o handler ainda é um stub.`);
    res.status(200).send('OK (stub)'); 
  },
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

  // Log de debug (v1.0.1)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[PostbackRouter] Webhook recebido para plataforma: ${platform}`);
  }

  if (!handler) {
    console.warn(`[PostbackRouter] Recebido webhook para plataforma desconhecida: ${platform}`);
    return res.status(404).send('Not Found: Unknown platform');
  }

  try {
    // Delega o trabalho para o handler específico (ex: DigistorePostback.handle)
    await handler(req, res);
    
    // --- Alteração v1.0.2: "Airbag" de segurança ---
    // Se o handler foi executado com sucesso (não deu erro), mas
    // esqueceu de enviar uma resposta, enviamos um 200 OK para
    // impedir que a plataforma (ex: Digistore) fique tentando de novo.
    if (!res.headersSent) {
      console.warn(`[PostbackRouter] Handler para '${platform}' não enviou resposta. Enviando 200 OK por segurança (fallback).`);
      res.status(200).send('OK (router fallback)');
    }
    // --- Fim da Alteração v1.0.2 ---

  } catch (error) {
    // Pega erros catastróficos que o handler possa ter deixado vazar
    console.error(`[PostbackRouter] Erro CRÍTICO no handler da plataforma '${platform}':`, error.message);
    
    // Garante que o webhook receba uma resposta para evitar retries
    if (!res.headersSent) {
      // 500 porque o erro é no nosso servidor
      res.status(500).send('Internal Server Error');
    }
  }
}

module.exports = {
  handle
};