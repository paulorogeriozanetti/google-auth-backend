/**
 * PZ Advisors - Digistore24 Adapter
 * Versão: 1.1.8 (Merge Lógica v1.1.6 + v1.1.7)
 * Data: 2025-10-28
 * Desc: Mescla o suporte a 'product_id' (introduzido na v1.1.7)
 * com o mapeamento completo de parâmetros (aff, sid1-4, cid, campaignkey)
 * da versão original (v1.1.6), conforme sugestão do "outro chat".
 * - Mantém o log de diagnóstico no início de 'buildCheckoutUrl'.
 */
const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

class Digistore24Adapter extends PlatformAdapterBase {
    constructor() {
        super();
        this.version = '1.1.8'; // Atualizado
        this.logPrefix = `[Digistore24Adapter v${this.version}]`; // Atualizado

        // Chave de Autenticação S2S (webhook)
        this.AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
        if (!this.AUTH_KEY) {
            console.warn(`${this.logPrefix} Variável DIGISTORE_AUTH_KEY não configurada. Webhooks S2S falharão.`);
        }
    }

    /**
     * @override
     * Constrói a URL de checkout com parâmetros Sidx e Aff mapeados.
     * Aceita 'checkout_url' ou 'product_id'. Restaura mapeamento completo.
     */
    async buildCheckoutUrl(offerData = {}, trackingParams = {}) {
        // Log de diagnóstico v1.1.7 mantido
        console.log(`[DS24 ADAPTER] offerData recebido:`, JSON.stringify(offerData));

        // 1) Base URL: checkout_url direto OU construída via product_id
        let baseUrl = offerData.checkout_url;
        const productId = offerData.product_id;
        if (!baseUrl && productId) {
            baseUrl = `https://www.digistore24.com/product/${productId}`;
            console.log(`${this.logPrefix} Construindo URL base a partir do product_id: ${productId}`);
        }

        // 2) Validação da base
        if (!baseUrl || typeof baseUrl !== 'string' || !(baseUrl.startsWith('https://www.digistore24.com/product/') || baseUrl.startsWith('https://www.digistore24.com/redir/'))) {
            console.warn(`${this.logPrefix} checkout_url/product_id inválido ou ausente:`, baseUrl);
            return null;
        }

        console.log(`${this.logPrefix} Construindo URL de checkout para base: ${baseUrl.split('?')[0]}...`);

        try {
            const urlObj = new URL(baseUrl); // Renomeado para urlObj

            // 3) Affiliate ID (restaurado da v1.1.6)
            const affiliateId = offerData.affiliate_id;
            if (affiliateId) {
                urlObj.searchParams.set('aff', String(affiliateId));
            } else {
                console.warn(`${this.logPrefix} affiliate_id não encontrado em offerData (param 'aff' não será setado).`);
            }

            // 4) Mapa completo de tracking (mesclado v1.1.6 + v1.1.7)
            const paramMap = { // Restaurado mapeamento completo
                user_id: 'sid1',
                gclid: 'sid2',
                fbclid: 'sid3',
                anon_id: 'sid4', // Restaurado
                cid: 'cid',         // Restaurado
                campaignkey: 'campaignkey', // Restaurado
                // Adicione outros mapeamentos se necessário
            };

            if (trackingParams && typeof trackingParams === 'object') {
                for (const [key, dsKey] of Object.entries(paramMap)) {
                    const value = trackingParams[key];
                    if (value != null && value !== '') { // Verifica se não é null nem string vazia
                        // Limita o tamanho e remove caracteres inválidos para Sidx/outros params
                        const safeValue = String(value).substring(0, 100).replace(/[^a-zA-Z0-9_-]/g, '_');
                        urlObj.searchParams.set(dsKey, safeValue);
                    }
                }
            }

            const finalUrl = urlObj.toString();
            // Log mais seguro (não mostra todos os params)
            console.log(`${this.logPrefix} URL final gerada: ${finalUrl.split('?')[0]}?<params_ocultos>`);
            return finalUrl;

        } catch (error) {
            console.error(`${this.logPrefix} Erro ao construir URL Digistore24 (Base: ${baseUrl}):`, error?.message || error);
            return null; // Retorna null em caso de erro
        }
    }

    /**
     * @override
     * Verifica o webhook S2S (GET) do Digistore24 usando a auth_key.
     * Normaliza o payload para um formato padrão.
     */
    async verifyWebhook(queryPayload, headers, traceId = 'N/A') {
        if (!this.AUTH_KEY) {
            console.error(`${this.logPrefix} Webhook falhou: DIGISTORE_AUTH_KEY não configurada. [Trace: ${traceId}]`);
            return null;
        }
        if (!queryPayload || typeof queryPayload !== 'object') {
            console.warn(`${this.logPrefix} Webhook recebido sem payload (query). [Trace: ${traceId}]`);
            return null;
        }

        const receivedAuthKey = queryPayload.auth_key;
        if (!receivedAuthKey) {
            console.warn(`${this.logPrefix} Webhook sem 'auth_key'. [Trace: ${traceId}]`);
            return null;
        }

        // Comparação segura
        try {
            const keyBuf = Buffer.from(this.AUTH_KEY);
            const receivedKeyBuf = Buffer.from(receivedAuthKey);

            if (keyBuf.length !== receivedKeyBuf.length || !crypto.timingSafeEqual(keyBuf, receivedKeyBuf)) {
                console.warn(`${this.logPrefix} Falha na validação da auth_key do Webhook. [Trace: ${traceId}]`);
                return null;
            }
            console.log(`${this.logPrefix} Validação da auth_key do Webhook OK. [Trace: ${traceId}]`);

            // Normaliza o payload
            const normalizedData = this._normalizeWebhookPayload(queryPayload);
            normalizedData.trace_id = traceId; // Adiciona traceId

            // Log seguro
            const safeData = this.safeLog(queryPayload);
            console.log(`${this.logPrefix} Webhook S2S normalizado com sucesso.`, safeData);

            return normalizedData;

        } catch (error) {
            console.error(`${this.logPrefix} Erro durante a validação/normalização do Webhook:`, error?.message || error);
            return null;
        }
    }

    // --- Helpers Internos ---

    _normalizeWebhookPayload(payload) {
        let unifiedStatus = 'other';
        switch (payload.event) {
            case 'completed': case 'test': unifiedStatus = 'paid'; break;
            case 'refund': case 'chargeback': unifiedStatus = payload.event; break;
            case 'rebill_resumed': case 'rebill_cancelled': unifiedStatus = 'subscription_update'; break;
        }

        return {
            platform: 'digistore24',
            transactionId: payload.order_id,
            orderId: payload.order_id,
            trackingId: payload.sid1 || null, // Assume sid1 como nosso user_id
            sid2: payload.sid2 || null, sid3: payload.sid3 || null,
            sid4: payload.sid4 || null, // Mantido (se houver)
            // sid5: payload.sid5 || null, // Se necessário
            cid: payload.cid || null, // Mantido (se houver)
            campaignkey: payload.campaignkey || null, // Mantido (se houver)

            transactionTypeRaw: payload.event,
            status: unifiedStatus,
            productSku: payload.product_id || 'N/A',
            amount: parseFloat(payload.amount || 0),
            currency: payload.currency || 'USD',
            customerEmail: payload.customer_email || null,
            eventTimestamp: payload.timestamp ? new Date(payload.timestamp.replace(' ', 'T') + 'Z') : new Date(),
            receivedTimestamp: new Date(),
            _rawPayload: this.safeLog(payload),
        };
    }
}

module.exports = Digistore24Adapter;