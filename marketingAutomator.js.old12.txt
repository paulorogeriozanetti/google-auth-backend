/**
 * PZ Marketing Automator Module – Versão 4.2.0 – 2025-09-29
 *
 * - Atualização de versionamento para alinhamento com o server.js v4.2.0.
 * - Nenhuma alteração funcional necessária. O módulo continua estável e
 * pronto para produção, utilizando Axios para a comunicação com o ConvertKit.
 */

const axios = require('axios');

const CONVERTKIT_API_KEY = process.env.CONVERTKIT_API_KEY;
const CONVERTKIT_TAG_ID = process.env.CONVERTKIT_TAG_ID;
const CONVERTKIT_API_URL = 'https://api.convertkit.com/v3';

/**
 * Adiciona ou atualiza um assinante em um funil de marketing (via API do ConvertKit).
 * @param {object} subscriberInfo - Objeto com os dados do assinante.
 * @returns {Promise<object>} A resposta da API do ConvertKit.
 */
async function addSubscriberToFunnel(subscriberInfo) {
  if (!CONVERTKIT_API_KEY || !CONVERTKIT_TAG_ID) {
    const errorMsg = 'Variáveis de ambiente do ConvertKit não estão definidas.';
    console.error(`[MARKETING-AUTOMATOR] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  if (!subscriberInfo || !subscriberInfo.email) {
    throw new Error('O objeto subscriberInfo e o campo email são obrigatórios.');
  }

  const endpoint = `${CONVERTKIT_API_URL}/tags/${CONVERTKIT_TAG_ID}/subscribe`;

  const payload = {
    api_key: CONVERTKIT_API_KEY,
    email: subscriberInfo.email,
    first_name: subscriberInfo.first_name,
    fields: subscriberInfo.fields,
  };

  try {
    console.log(`[MARKETING-AUTOMATOR] Enviando assinante ${subscriberInfo.email} para a API do ConvertKit...`);
    const response = await axios.post(endpoint, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`[MARKETING-AUTOMATOR] Assinante ${subscriberInfo.email} processado com sucesso.`);
    return response.data;
  } catch (error) {
    console.error(`[MARKETING-AUTOMATOR] Erro ao processar assinante ${subscriberInfo.email}:`,
      JSON.stringify(error.response?.data || error.message || error)
    );
    throw error;
  }
}

module.exports = {
  addSubscriberToFunnel
};