/**
 * PZ Marketing Automator Module – Versão 6.0.0 (Sequência Direta) – 2025-10-15
 *
 * - SOLUÇÃO DEFINITIVA: Altera o gatilho para subscrição direta da Sequência,
 * que é o único método de envio de e-mail que funcionou nos testes de produção.
 * - Requer que CONVERTKIT_API_SECRET e CONVERTKIT_SEQUENCE_ID sejam configurados.
 */

const axios = require('axios');

const CONVERTKIT_API_SECRET = process.env.CONVERTKIT_API_SECRET;
const CONVERTKIT_SEQUENCE_ID = process.env.CONVERTKIT_SEQUENCE_ID;
const CONVERTKIT_API_URL = 'https://api.convertkit.com/v3';

/**
 * Adiciona um assinante à Sequência de E-mails (Funil) para acionar o envio do guia.
 * @param {object} subscriberInfo - Objeto com os dados do assinante.
 * @returns {Promise<object>} A resposta da API do ConvertKit.
 */
async function addSubscriberToFunnel(subscriberInfo) {
    if (!CONVERTKIT_API_SECRET) {
        const errorMsg = 'Variável de ambiente CONVERTKIT_API_SECRET não está definida.';
        console.error(`[MARKETING-AUTOMATOR] ${errorMsg}`);
        throw new Error(errorMsg);
    }
    if (!CONVERTKIT_SEQUENCE_ID) {
        const errorMsg = 'Variável de ambiente CONVERTKIT_SEQUENCE_ID (ID da Sequência de E-mail) não está definida.';
        console.error(`[MARKETING-AUTOMATOR] ${errorMsg}`);
        throw new Error(errorMsg);
    }

    if (!subscriberInfo || !subscriberInfo.email) {
        throw new Error('O objeto subscriberInfo e o campo email são obrigatórios.');
    }

    // Endpoint corrigido: Subscrição direta da Sequência (Comprovado que Funciona)
    const endpoint = `${CONVERTKIT_API_URL}/sequences/${CONVERTKIT_SEQUENCE_ID}/subscribe`;

    const payload = {
        api_secret: CONVERTKIT_API_SECRET, // Usa a chave privada (SECRET)
        email: subscriberInfo.email,
        first_name: subscriberInfo.first_name,
        // Os campos personalizados são passados no nível superior do JSON
        fields: subscriberInfo.fields, 
    };

    try {
        console.log(`[MARKETING-AUTOMATOR] Subscribing ${subscriberInfo.email} to Sequence ID ${CONVERTKIT_SEQUENCE_ID}...`);
        const response = await axios.post(endpoint, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[MARKETING-AUTOMATOR] Subscription successful. Email should be sent.`);
        return response.data;
    } catch (error) {
        console.error(`[MARKETING-AUTOMATOR] Fatal Error during Sequence Subscription:`,
            JSON.stringify(error.response?.data || error.message || error)
        );
        throw error;
    }
}

module.exports = {
    addSubscriberToFunnel
};