/**
 * PZ Advisors - Marketing Automation Module
 * Version: v2.0.0
 * Date: 2025-10-15
 * Desc: Versão com a lógica de "remover-e-adicionar" tag para garantir a reentrada na automação do ConvertKit.
 * - A função 'addSubscriberToFunnel' agora remove primeiro a tag do subscritor antes de a adicionar novamente.
 * - Esta ação força o ConvertKit a registar um novo evento "tag_added", acionando a automação em todas as autenticações.
 */

// A dependência 'fetch' será fornecida pelo ambiente do Node.js (>=18) ou pelo server.js
const fetch = (typeof globalThis.fetch === 'function')
  ? globalThis.fetch.bind(globalThis)
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const CONVERTKIT_API_KEY = process.env.CONVERTKIT_API_KEY || '';
const CONVERTKIT_TAG_ID = process.env.CONVERTKIT_TAG_ID || '';

/**
 * Adiciona ou atualiza um subscritor no ConvertKit e atribui-lhe a tag do funil.
 * @param {object} subscriberData - Dados do subscritor.
 * @param {string} subscriberData.email - O email do subscritor.
 * @param {string} subscriberData.first_name - O primeiro nome do subscritor.
 */
async function addSubscriberToFunnel(subscriberData) {
    if (!CONVERTKIT_API_KEY || !CONVERTKIT_TAG_ID) {
        console.error('[MARKETING] Variáveis de ambiente CONVERTKIT_API_KEY ou CONVERTKIT_TAG_ID não estão configuradas.');
        throw new Error('Marketing automation is not configured.');
    }

    if (!subscriberData || !subscriberData.email) {
        console.warn('[MARKETING] Dados do subscritor insuficientes (email em falta). A abortar.');
        return;
    }

    const { email, first_name } = subscriberData;

    // --- INÍCIO DA NOVA LÓGICA ---

    // Passo 1: Remover a tag do subscritor para forçar um novo evento de "adição".
    // Esta chamada não gera erro se o subscritor não tiver a tag.
    try {
        console.log(`[MARKETING] Step 1: Attempting to remove tag [${CONVERTKIT_TAG_ID}] from ${email}`);
        const removeRes = await fetch(`https://api.convertkit.com/v3/tags/${CONVERTKIT_TAG_ID}/unsubscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_secret: CONVERTKIT_API_KEY, // Nota: A API do ConvertKit usa api_secret aqui
                email: email,
            }),
        });
        if (!removeRes.ok) {
            // Regista a falha na remoção, mas não interrompe o fluxo. O passo seguinte (adicionar) é o mais importante.
            console.warn(`[MARKETING] Warning: Failed to remove tag from ${email}. Status: ${removeRes.status}. Proceeding to add tag.`);
        } else {
            console.log(`[MARKETING] Step 1: Tag removal successful or subscriber did not have the tag.`);
        }
    } catch (error) {
        console.error(`[MARKETING] Error during tag removal for ${email}:`, error.message);
    }

    // Passo 2: Adicionar a tag novamente. Esta ação irá agora acionar a automação.
    console.log(`[MARKETING] Step 2: Attempting to add tag [${CONVERTKIT_TAG_ID}] to ${email}`);
    const addRes = await fetch(`https://api.convertkit.com/v3/tags/${CONVERTKIT_TAG_ID}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: CONVERTKIT_API_KEY,
            email: email,
            first_name: first_name,
        }),
    });

    if (!addRes.ok) {
        const errorBody = await addRes.text();
        console.error(`[MARKETING] Error: Failed to add tag to ${email}. Status: ${addRes.status}. Body: ${errorBody}`);
        throw new Error('Failed to subscribe user to the marketing funnel tag.');
    }
    
    console.log(`[MARKETING] Step 2: Tag addition successful for ${email}. Automation should trigger.`);
    // --- FIM DA NOVA LÓGICA ---

    return await addRes.json();
}

module.exports = {
    addSubscriberToFunnel,
};