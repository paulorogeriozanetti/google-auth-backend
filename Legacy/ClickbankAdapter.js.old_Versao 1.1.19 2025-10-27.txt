console.log('--- [BOOT CHECK] Loading ClickbankAdapter v1.1.19 ---'); 
/**
 * PZ Advisors - Clickbank Adapter
 * Versão: 1.1.19 (Rollback - Sem Scraper + Beacon)
 * Data: 2025-10-27
 * Desc:
 * - REVERTE para a lógica simples (sem scraper 'axios'/'cheerio') que apenas
 * adiciona o 'tid' ao 'hoplink' fornecido. (Baseado na funcionalidade v1.1.17).
 * - Adiciona log de diagnóstico ('[BOOT CHECK]') na linha 1.
 * - Mantém o patch v1.1.17 (verificação de SECRET_KEY movida para 'verifyWebhook').
 */
// const axios = require('axios'); // Removido
// const cheerio = require('cheerio'); // Removido
const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

class ClickbankAdapter extends PlatformAdapterBase {
    constructor() {
        super();
        this.version = '1.1.19'; // Atualizado
        this.logPrefix = '[ClickbankAdapter v1.1.19]';
        
        // A verificação da WEBHOOK_SECRET_KEY fica em verifyWebhook()
        this.WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY;
    }

    /**
     * @override
     * Constrói a URL final (HopLink) com o parâmetro de tracking 'tid'.
     * (Versão simples, sem scraper)
     */
    async buildCheckoutUrl(offerData, trackingParams) {
        const userId = trackingParams?.user_id;
        
        if (!offerData?.hoplink) {
            console.warn(`${this.logPrefix} 'hoplink' ausente no offerData para buildCheckoutUrl.`);
            return null;
        }

        let baseUrl = offerData.hoplink;

        if (!userId) {
            console.warn(`${this.logPrefix} 'user_id' ausente. Retornando URL base (hoplink) sem rastreamento.`);
            return baseUrl;
        }

        // ETAPA ÚNICA: Construir o HopLink rastreado
        let trackedHoplink;
        try {
            if (baseUrl.includes('[TRACKING_ID]')) {
                const safeTid = userId.substring(0, 100).replace(/[^a-zA-Z0-9_-]/g, '_');
                trackedHoplink = baseUrl.replace('[TRACKING_ID]', encodeURIComponent(safeTid));
            } else {
                const urlObj = new URL(baseUrl);
                if (!urlObj.searchParams.has('tid')) {
                    urlObj.searchParams.set('tid', userId.substring(0, 100));
                }
                trackedHoplink = urlObj.toString();
            }
            console.log(`${this.logPrefix} URL de hoplink rastreada construída: ${trackedHoplink}`);
            return trackedHoplink; // Retorna apenas o hoplink rastreado

        } catch (e) {
            console.error(`${this.logPrefix} URL de hoplink inválida: ${baseUrl}`, e);
            return null;
        }
    }

    /**
     * @override
     * Verifica e descriptografa o webhook (INS) do Clickbank.
     */
    async verifyWebhook(rawBodyBuffer, headers) {
        // Verificação JIT da chave secreta (v1.1.17)
        if (!this.WEBHOOK_SECRET_KEY) {
            console.error(`${this.logPrefix} Webhook falhou: Variável de ambiente CLICKBANK_WEBHOOK_SECRET_KEY não configurada.`);
            return null;
        }
        
        if (!rawBodyBuffer || !headers) {
            console.warn(`${this.logPrefix} Webhook recebido sem body ou headers.`);
            return null;
        }
        
        const ivHeader = headers['x-clickbank-cbsig-iv'];
        const signatureHeader = headers['x-clickbank-signature'];

        if (!ivHeader || !signatureHeader) {
            console.warn(`${this.logPrefix} Webhook sem headers IV ou Signature.`);
            return null;
        }

        try {
            // 1. Validação HMAC
            const hmac = crypto.createHmac('sha256', this.WEBHOOK_SECRET_KEY);
            hmac.update(rawBodyBuffer);
            const calculatedSignature = hmac.digest('hex');

            const sigBuf = Buffer.from(signatureHeader, 'hex');
            const calcSigBuf = Buffer.from(calculatedSignature, 'hex');
            
            if (sigBuf.length !== calcSigBuf.length || !crypto.timingSafeEqual(sigBuf, calcSigBuf)) {
                console.warn(`${this.logPrefix} Falha na validação HMAC do Webhook.`);
                return null;
            }
            console.log(`${this.logPrefix} Validação HMAC do Webhook OK.`);

            // 2. Descriptografia
            const iv = Buffer.from(ivHeader, 'base64');
            const key = crypto.createHash('sha256').update(this.WEBHOOK_SECRET_KEY).digest();
            
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decryptedPayload = decipher.update(rawBodyBuffer, 'base64', 'utf8');
            decryptedPayload += decipher.final('utf8');

            const jsonData = JSON.parse(decryptedPayload);
            
            // 3. Normalização
            const normalizedData = this._normalizeWebhookPayload(jsonData);
            
            const safeData = this.safeLog(jsonData);
            console.log(`${this.logPrefix} Webhook descriptografado e normalizado com sucesso.`, safeData);

            return normalizedData;

        } catch (error) {
            console.error(`${this.logPrefix} Erro crítico ao processar webhook Clickbank:`, error?.message || error);
            return null;
        }
    }

    // --- Helpers Internos ---

    _extractUserIdFromTid(tid = '') {
        return tid || null;
    }

    _normalizeWebhookPayload(payload) {
        const { transactionType, receipt, vendorVariables, lineItems } = payload;
        const trackingId = vendorVariables?.tid_ || null;
        
        let unifiedStatus = 'other';
        switch (transactionType) {
            case 'SALE': case 'TEST_SALE': unifiedStatus = 'paid'; break;
            case 'RFND': case 'TEST_RFND': unifiedStatus = 'refunded'; break;
            case 'CGBK': case 'TEST_CGBK': unifiedStatus = 'chargeback'; break;
        }
        
        const firstItem = lineItems && lineItems.length > 0 ? lineItems[0] : {};

        return {
            platform: 'clickbank',
            transactionId: receipt,
            orderId: receipt,
            trackingId: this._extractUserIdFromTid(trackingId),
            transactionTypeRaw: transactionType,
            status: unifiedStatus,
            productSku: firstItem.itemNo || 'N/A',
            amount: payload.totalOrderAmount || 0,
            currency: payload.currency || 'USD',
            customerEmail: payload.customer?.billing?.email || null,
            eventTimestamp: new Date(payload.transactionTime),
            receivedTimestamp: new Date(),
            _rawPayload: this.safeLog(payload),
        };
    }
}

module.exports = ClickbankAdapter;