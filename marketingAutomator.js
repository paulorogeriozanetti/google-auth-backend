/**
 * PZ Marketing Automator Module – Versão 5.0.0 (Event-Driven) – 2025-10-15
 *
 * - CORREÇÃO CRÍTICA: Implementa a lógica Event-Driven para acionar a automação
 * do ConvertKit via Evento (requested_guide), em vez de adicionar uma Tag.
 * - Alinhado com o Guia Definitivo e permite que o subscritor re-entre na automação.
 * - Adiciona função de ajuda para encontrar/criar o subscritor antes de registar o evento.
 */

const axios = require('axios');

const CONVERTKIT_API_KEY = process.env.CONVERTKIT_API_KEY;
// Não precisamos mais do CONVERTKIT_TAG_ID, mas a variável é mantida para compatibilidade
// caso seja usada em outros locais, embora não seja usada abaixo.
const CONVERTKIT_TAG_ID = process.env.CONVERTKIT_TAG_ID; 
const CONVERTKIT_EVENT_NAME = 'requested_guide';
const CONVERTKIT_API_URL = 'https://api.convertkit.com/v3';

/**
 * Encontra um subscritor pelo e-mail ou o cria se não existir (e retorna o ID).
 * @param {object} subscriberInfo - Objeto com os dados do assinante (email, first_name, fields).
 * @returns {Promise<number>} O ID do subscritor no ConvertKit.
 */
async function findOrCreateSubscriber(subscriberInfo) {
    const endpoint = `${CONVERTKIT_API_URL}/subscribers`;
    const email = subscriberInfo.email;
    let subscriberId = null;

    // 1. Tenta encontrar o subscritor existente
    try {
        const searchRes = await axios.get(endpoint, {
            params: { api_secret: process.env.CONVERTKIT_API_SECRET, email_address: email }
        });
        if (searchRes.data.total_subscribers > 0) {
            subscriberId = searchRes.data.subscribers[0].id;
            console.log(`[MARKETING-AUTOMATOR] Subscritor encontrado: ID ${subscriberId}`);
            // Se encontrado, não faz um novo POST de subscrição para evitar resetar o status, mas retorna o ID
            return subscriberId;
        }
    } catch (error) {
        // Ignora erros de busca, passará para o passo de criação
        console.warn(`[MARKETING-AUTOMATOR] Erro ao buscar subscritor, tentando criar: ${error.message}`);
    }

    // 2. Se não encontrado, subscreve para garantir que existe
    // Usamos o endpoint de subscrição de formulário genérico ou tag (sem form/tag ID)
    // para garantir a criação/atualização de campos.
    const createEndpoint = `${CONVERTKIT_API_URL}/forms/0/subscribe`; // 0 é o ID para o formulário padrão "null"
    const payload = {
        api_key: CONVERTKIT_API_KEY,
        email: email,
        first_name: subscriberInfo.first_name,
        fields: subscriberInfo.fields,
    };

    try {
        const createRes = await axios.post(createEndpoint, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        subscriberId = createRes.data.subscription.subscriber.id;
        console.log(`[MARKETING-AUTOMATOR] Subscritor criado/atualizado: ID ${subscriberId}`);
        return subscriberId;
    } catch (error) {
        console.error(`[MARKETING-AUTOMATOR] Erro ao criar subscritor ${email}:`,
            JSON.stringify(error.response?.data || error.message || error)
        );
        throw error;
    }
}


/**
 * Adiciona ou atualiza um assinante e registra o evento 'requested_guide'.
 * Este é o método que dispara a Automação ConvertKit.
 * @param {object} subscriberInfo - Objeto com os dados do assinante.
 * @returns {Promise<object>} A resposta da API do ConvertKit (do registo do evento).
 */
async function addSubscriberToFunnel(subscriberInfo) {
    if (!CONVERTKIT_API_KEY || !process.env.CONVERTKIT_API_SECRET) {
        const errorMsg = 'Variáveis de ambiente do ConvertKit não estão definidas (API KEY e/ou API SECRET).';
        console.error(`[MARKETING-AUTOMATOR] ${errorMsg}`);
        throw new Error(errorMsg);
    }

    if (!subscriberInfo || !subscriberInfo.email) {
        throw new Error('O objeto subscriberInfo e o campo email são obrigatórios.');
    }

    try {
        // 1. Garante que o subscritor existe no ConvertKit
        const subscriberId = await findOrCreateSubscriber(subscriberInfo);

        // 2. Registra o evento 'requested_guide' para disparar a automação
        const eventEndpoint = `${CONVERTKIT_API_URL}/subscribers/${subscriberId}/events`;

        const eventPayload = {
            api_secret: process.env.CONVERTKIT_API_SECRET,
            name: CONVERTKIT_EVENT_NAME,
            // Não é necessário enviar campos adicionais aqui, pois já foram atualizados acima
        };

        console.log(`[MARKETING-AUTOMATOR] Registrando evento '${CONVERTKIT_EVENT_NAME}' para subscritor ID ${subscriberId}...`);
        const response = await axios.post(eventEndpoint, eventPayload, {
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[MARKETING-AUTOMATOR] Evento '${CONVERTKIT_EVENT_NAME}' registrado com sucesso.`);

        return response.data;
    } catch (error) {
        console.error(`[MARKETING-AUTOMATOR] Erro fatal no funil de automação:`,
            JSON.stringify(error.response?.data || error.message || error)
        );
        throw error;
    }
}

module.exports = {
    addSubscriberToFunnel
};