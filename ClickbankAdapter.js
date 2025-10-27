/**
 * PZ Advisors - Clickbank Adapter
 * Versão: 1.1.17 (Patch de Correção Node.js + Robustez)
 * Data: 2025-10-27
 * Desc:
 * - (FIX) Remove a função '_scrapePresellUrl' não utilizada, que continha
 * código de navegador (FormData, File) e causava o erro 'File is not defined'.
 * - (ROBUST) Move a verificação da 'CLICKBANK_WEBHOOK_SECRET_KEY' do construtor
 * para dentro do 'verifyWebhook', impedindo que a ausência da chave
 * quebre a rota '/api/checkout'.
 */
const axios = require('axios');
const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

class ClickbankAdapter extends PlatformAdapterBase {
    constructor() {
        super();
        this.version = '1.1.17';
        this.logPrefix = '[ClickbankAdapter v1.1.17]';
        
        // A verificação da WEBHOOK_SECRET_KEY foi movida para verifyWebhook()
        // para permitir que o adapter seja instanciado (ex: para buildCheckoutUrl)
        // mesmo se a chave de webhook não estiver configurada.
        this.WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY;
    }

    /**
     * @override
     * Constrói a URL de checkout (HopLink) com parâmetros de tracking.
     * O Clickbank usa um placeholder [TRACKING_ID] ou um parâmetro ?tid=
     */
    async buildCheckoutUrl(offerData, trackingParams) {
        if (!offerData?.hoplink) {
            console.warn(`${this.logPrefix} 'hoplink' ausente no offerData para buildCheckoutUrl.`);
            return null;
        }

        let url = offerData.hoplink;
        const userId = trackingParams?.user_id;

        if (!userId) {
            console.warn(`${this.logPrefix} 'user_id' ausente no trackingParams. URL não será rastreada.`);
            return url; // Retorna a URL base sem rastreamento
        }

        // Tenta substituir o placeholder [TRACKING_ID] (preferencial)
        if (url.includes('[TRACKING_ID]')) {
            // Limita a 100 caracteres e remove caracteres perigosos
            const safeTid = userId.substring(0, 100).replace(/[^a-zA-Z0-9_-]/g, '_');
            url = url.replace('[TRACKING_ID]', encodeURIComponent(safeTid));
        }
        // Fallback: Adiciona como parâmetro ?tid=
        else {
            try {
                const urlObj = new URL(url);
                // Evita adicionar 'tid' se já existir (raro)
                if (!urlObj.searchParams.has('tid')) {
                    urlObj.searchParams.set('tid', userId.substring(0, 100));
                }
                url = urlObj.toString();
            } catch (e) {
                console.error(`${this.logPrefix} URL de hoplink inválida: ${url}`, e);
                return null; // Retorna null se a URL for inválida
            }
        }
        
        console.log(`${this.logPrefix} URL de checkout construída: ${url}`);
        return url;
    }

    /**
     * @override
     * Verifica e descriptografa o webhook (INS) do Clickbank.
     * 1. Valida o HMAC (Header x-clickbank-signature)
     * 2. Decifra o payload (AES-256-CBC)
     * 3. Normaliza o payload
     */
    async verifyWebhook(rawBodyBuffer, headers) {
        // --- INÍCIO DA CORREÇÃO v1.1.17 ---
        // A verificação da chave agora é feita aqui (JIT - Just-in-Time)
        if (!this.WEBHOOK_SECRET_KEY) {
            console.error(`${this.logPrefix} Webhook falhou: Variável de ambiente CLICKBANK_WEBHOOK_SECRET_KEY não configurada.`);
            return null;
        }
        // --- FIM DA CORREÇÃO v1.1.17 ---
        
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
            // 1. Validação HMAC (SHA-256)
            const hmac = crypto.createHmac('sha256', this.WEBHOOK_SECRET_KEY);
            hmac.update(rawBodyBuffer);
            const calculatedSignature = hmac.digest('hex');

            // Comparação segura (timing attacks)
            const sigBuf = Buffer.from(signatureHeader, 'hex');
            const calcSigBuf = Buffer.from(calculatedSignature, 'hex');
            
            if (sigBuf.length !== calcSigBuf.length || !crypto.timingSafeEqual(sigBuf, calcSigBuf)) {
                console.warn(`${this.logPrefix} Falha na validação HMAC do Webhook.`);
                return null;
            }
            console.log(`${this.logPrefix} Validação HMAC do Webhook OK.`);

            // 2. Descriptografia (AES-256-CBC)
            const iv = Buffer.from(ivHeader, 'base64');
            const key = crypto.createHash('sha256').update(this.WEBHOOK_SECRET_KEY).digest(); // Gera chave de 32 bytes
            
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decryptedPayload = decipher.update(rawBodyBuffer, 'base64', 'utf8');
            decryptedPayload += decipher.final('utf8');

            const jsonData = JSON.parse(decryptedPayload);
            
            // 3. Normalização
            const normalizedData = this._normalizeWebhookPayload(jsonData);
            
            // Sanitiza para log
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
        // Lógica de extração (ex: "TEST_ID_B_gclid_123")
        // No v1.1.17, apenas retornamos o TID completo como o ID de rastreamento principal.
        return tid || null;
    }

    _normalizeWebhookPayload(payload) {
        const { transactionType, receipt, vendorVariables, lineItems } = payload;
        
        // Pega o TID (Tracking ID) de vendorVariables
        const trackingId = vendorVariables?.tid_ || null;
        
        // Status unificado
        let unifiedStatus = 'other';
        switch (transactionType) {
            case 'SALE':
            case 'TEST_SALE':
                unifiedStatus = 'paid';
                break;
            case 'RFND':
            case 'TEST_RFND':
                unifiedStatus = 'refunded';
                break;
            case 'CGBK':
            case 'TEST_CGBK':
                unifiedStatus = 'chargeback';
                break;
        }
        
        // Assume o primeiro item de linha para dados do produto
        const firstItem = lineItems && lineItems.length > 0 ? lineItems[0] : {};

        return {
            platform: 'clickbank',
            transactionId: receipt, // O 'receipt' é o ID de transação/pedido único do CB
            orderId: receipt,
            trackingId: this._extractUserIdFromTid(trackingId), // Nosso 'user_id'
            
            transactionTypeRaw: transactionType,
            status: unifiedStatus,
            
            productSku: firstItem.itemNo || 'N/A',
            
            // Valores financeiros
            amount: payload.totalOrderAmount || 0,
            currency: payload.currency || 'USD',
            
            // Dados do cliente (se disponível)
            customerEmail: payload.customer?.billing?.email || null,
            
            // Timestamps
            eventTimestamp: new Date(payload.transactionTime),
            receivedTimestamp: new Date(),
            
            // Payload completo para auditoria (sanitizado)
            _rawPayload: this.safeLog(payload),
        };
    }

    // --- FUNÇÃO REMOVIDA (CAUSA DO ERRO 'File is not defined') ---
    // _scrapePresellUrl(url) { ... }
}

module.exports = ClickbankAdapter;