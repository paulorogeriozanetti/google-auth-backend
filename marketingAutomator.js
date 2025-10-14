/**
 * PZ Advisors - Marketing Automation Module
 * Version: v3.1.0 (Debug-Enhanced)
 * Date: 2025-10-14
 * Desc: Implementa a lógica correta de 'disparo de evento' e adiciona logging detalhado.
 * - Altera a estratégia de 'adicionar tag' para 'disparar evento', alinhando-se com a automação final do ConvertKit.
 * - Adiciona logs explícitos da resposta da API do ConvertKit (status e body) para facilitar o troubleshooting.
 * - Simplifica o código para uma única chamada de API focada no evento 'requested_guide'.
 */

// A dependência 'fetch' será fornecida pelo ambiente do Node.js (>=18) ou pelo server.js
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const CONVERTKIT_API_SECRET = process.env.CONVERTKIT_API_SECRET || '';

/**
 * Dispara o evento 'requested_guide' no ConvertKit para um subscritor.
 * Esta ação aciona a automação de entrega do guia.
 * @param {object} subscriberData - Dados do subscritor.
 * @param {string} subscriberData.email - O email do subscritor.
 * @param {string} [subscriberData.first_name] - O primeiro nome opcional do subscritor.
 */
async function fireGuideRequestedEvent(subscriberData) {
    if (!CONVERTKIT_API_SECRET) {
        console.error('[MARKETING] Variável de ambiente CONVERTKIT_API_SECRET não está configurada.');
        throw new Error('Marketing automation is not configured.');
    }

    if (!subscriberData || !subscriberData.email) {
        console.warn('[MARKETING] Dados do subscritor insuficientes (email em falta). A abortar.');
        return;
    }

    const { email, first_name } = subscriberData;
    const url = 'https://api.convertkit.com/v3/events';
    const payload = {
        api_secret: CONVERTKIT_API_SECRET,
        event: 'requested_guide',
        email: email,
        metadata: {
            // A API de eventos aceita metadados, como o nome.
            first_name: first_name || null,
        }
    };

    console.log(`[MARKETING] Attempting to fire event 'requested_guide' for ${email}`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        // --- INÍCIO DO LOGGING DETALHADO ---
        // Lê a resposta como texto para garantir que podemos logar mesmo que não seja um JSON válido.
        const responseBody = await response.text();

        console.log(`[MARKETING] ConvertKit API Response Status: ${response.status}`);
        console.log(`[MARKETING] ConvertKit API Response Body: ${responseBody}`);
        // --- FIM DO LOGGING DETALHADO ---

        if (!response.ok) {
            // Se a resposta não for 2xx, lança um erro com os detalhes obtidos.
            throw new Error(`ConvertKit API failed with status ${response.status}.`);
        }

        console.log(`[MARKETING] Event 'requested_guide' fired successfully for ${email}. Automation should trigger.`);
        
        // Tenta fazer o parse do corpo da resposta apenas se o status for OK.
        return JSON.parse(responseBody);

    } catch (error) {
        // Captura e loga qualquer erro, seja da chamada fetch ou do nosso 'throw' customizado.
        console.error(`[MARKETING] CRITICAL ERROR during event firing for ${email}:`, error.message);
        throw error; // Re-lança o erro para que o 'server.js' saiba que a operação falhou.
    }
}

module.exports = {
    // A função exportada foi renomeada para refletir a nova lógica.
    // Lembre-se de atualizar a chamada a esta função no seu server.js.
    fireGuideRequestedEvent,
};