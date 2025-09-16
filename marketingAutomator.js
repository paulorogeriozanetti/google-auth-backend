/**
 * PZ Marketing Automator Module – Versão 1.0.0 – 2025-09-17
 *
 * Módulo de abstração para provedores de automação de marketing.
 * - Objetivo: Isolar a lógica de comunicação com o ESP (Email Service Provider)
 * do resto da aplicação, facilitando futuras manutenções ou migrações.
 * - Implementação Inicial: ConvertKit.
 * - A função `addSubscriberToFunnel` é a única interface exposta para o resto
 * do backend, tornando a troca de provedor transparente para as rotas da API.
 */

const ConvertKit = require('node-convertkit');

/* ──────────────────────────────────────────────────────────────
   1) Configuração e Inicialização do Cliente
─────────────────────────────────────────────────────────────── */

// Carrega as credenciais das variáveis de ambiente
const CONVERTKIT_API_KEY = process.env.CONVERTKIT_API_KEY;
const CONVERTKIT_API_SECRET = process.env.CONVERTKIT_API_SECRET;
const CONVERTKIT_TAG_ID = process.env.CONVERTKIT_TAG_ID;

let ck; // Variável para armazenar o cliente inicializado

// Valida se as variáveis essenciais foram configuradas
if (!CONVERTKIT_API_KEY || !CONVERTKIT_TAG_ID) {
  console.warn('[MARKETING-AUTOMATOR] Variáveis de ambiente CONVERTKIT_API_KEY ou CONVERTKIT_TAG_ID não foram definidas. O módulo não funcionará.');
} else {
  // Inicializa o cliente do ConvertKit
  ck = new ConvertKit(CONVERTKIT_API_KEY, CONVERTKIT_API_SECRET);
  console.log('[MARKETING-AUTOMATOR] Cliente ConvertKit inicializado.');
}


/* ──────────────────────────────────────────────────────────────
   2) Função Principal de Interface (Exportada)
─────────────────────────────────────────────────────────────── */

/**
 * Adiciona ou atualiza um assinante em um funil de marketing (através de uma tag no ConvertKit).
 * Esta função é agnóstica à plataforma e serve como ponto de entrada para o backend.
 *
 * @param {object} subscriberInfo - Objeto com os dados do assinante.
 * @param {string} subscriberInfo.email - O endereço de e-mail do assinante (obrigatório).
 * @param {string} [subscriberInfo.first_name] - O primeiro nome do assinante (opcional).
 * @param {object} [subscriberInfo.fields] - Um objeto com campos personalizados a serem atualizados.
 * @returns {Promise<object>} A resposta da API do provedor de e-mail.
 */
async function addSubscriberToFunnel(subscriberInfo) {
  // Garante que o módulo não tente rodar sem as configurações
  if (!ck) {
    const errorMsg = 'Cliente ConvertKit não inicializado devido à falta de credenciais.';
    console.error(`[MARKETING-AUTOMATOR] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // Validação dos dados de entrada
  if (!subscriberInfo || !subscriberInfo.email) {
    throw new Error('O objeto subscriberInfo e o campo email são obrigatórios.');
  }

  try {
    console.log(`[MARKETING-AUTOMATOR] Adicionando/atualizando assinante ${subscriberInfo.email} na tag ${CONVERTKIT_TAG_ID}...`);
    
    // A função `tags.addSubscriber` do ConvertKit já lida com "upsert":
    // Se o e-mail não existe, ele é criado e adicionado à tag.
    // Se o e-mail já existe, seus dados (nome, campos) são atualizados e ele é adicionado à tag (se já não estiver).
    const response = await ck.tags.addSubscriber(CONVERTKIT_TAG_ID, subscriberInfo);

    console.log(`[MARKETING-AUTOMATOR] Assinante ${subscriberInfo.email} processado com sucesso.`);
    return response;

  } catch (error) {
    // Captura e loga erros específicos da API para facilitar o debug
    console.error(`[MARKETING-AUTOMATOR] Erro ao processar assinante ${subscriberInfo.email}:`, 
      JSON.stringify(error.response?.data || error.message || error)
    );
    // Re-lança o erro para que a rota da API possa tratá-lo
    throw error;
  }
}

/* ──────────────────────────────────────────────────────────────
   3) Exportação do Módulo
─────────────────────────────────────────────────────────────── */

// Expomos apenas a função de interface genérica, escondendo os detalhes da implementação.
module.exports = {
  addSubscriberToFunnel
};