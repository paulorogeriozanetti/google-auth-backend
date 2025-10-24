/**
 * PZ Marketing Automator Module – Versão 5.1.0 (Stability via Tags) – 2025-10-15
 *
 * - CORREÇÃO CRÍTICA: Reverte para a lógica de Tags para garantir a estabilidade do funil,
 * uma vez que o registo de Eventos falhou consistentemente nos testes da API.
 * - Confirma a utilização da API Key para o endpoint /tags/{id}/subscribe.
 * - Nenhuma funcionalidade deve ser perdida, mas a Automação do ConvertKit
 * DEVE ser reconfigurada para usar a Tag.
 */

const axios = require('axios');

const CONVERTKIT_API_KEY = process.env.CONVERTKIT_API_KEY;
const CONVERTKIT_TAG_ID = process.env.CONVERTKIT_TAG_ID; // Usaremos esta ID
const CONVERTKIT_API_URL = 'https://api.convertkit.com/v3';

/**
 * Adiciona ou atualiza um assinante e aplica a Tag para disparar a automação.
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

    // Endpoint de Tags (Comprovado que Funciona com API_KEY)
    const endpoint = `${CONVERTKIT_API_URL}/tags/${CONVERTKIT_TAG_ID}/subscribe`;

    const payload = {
        api_key: CONVERTKIT_API_KEY, // Usa a chave pública (KEY)
        email: subscriberInfo.email,
        first_name: subscriberInfo.first_name,
        fields: subscriberInfo.fields,
    };

    try {
        console.log(`[MARKETING-AUTOMATOR] Enviando subscritor ${subscriberInfo.email} para a API do ConvertKit (TAGS)...`);
        const response = await axios.post(endpoint, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[MARKETING-AUTOMATOR] Subscritor ${subscriberInfo.email} processado e Tag aplicada com sucesso.`);
        return response.data;
    } catch (error) {
        // Loga o erro, mas o código HTTP 401/500 será retornado ao Frontend pelo server.js
        console.error(`[MARKETING-AUTOMATOR] Erro ao processar subscritor:`,
            JSON.stringify(error.response?.data || error.message || error)
        );
        throw error;
    }
}

module.exports = {
    addSubscriberToFunnel
};