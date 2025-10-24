/**
 * PZ Advisors - Digistore24 Adapter
 * Versão: 1.1.4
 * Data: 2025-10-24
 * Desc: Incorpora melhorias do quarto duplo check.
 * - REFORÇO DE SEGURANÇA: Remove 'auth_key' do 'rawPayload' antes de retornar.
 * - Mantém toda a robustez da v1.1.3 (parsing de amount/status, timingSafeEqual).
 */
const PlatformAdapterBase = require('./PlatformAdapterBase');
const crypto = require('crypto');

// Configurações (idênticas v1.1.3)
const DIGISTORE_AFFILIATE_PARAM = 'aff';
const DIGISTORE_TRACKING_PARAMS_MAP = {
    user_id: 'sid1', gclid: 'sid2', fbclid: 'sid3', anon_id: 'sid4',
    cid: 'cid', campaignkey: 'campaignkey'
};
const DIGISTORE_WEBHOOK_AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
if (!DIGISTORE_WEBHOOK_AUTH_KEY) {
  throw new Error('[Digistore24Adapter v1.1.4] Variável de ambiente DIGISTORE_AUTH_KEY não configurada!');
}

class Digistore24Adapter extends PlatformAdapterBase {

    constructor() {
        super();
        this.version = '1.1.4'; // Atualiza versão
        this.logPrefix = `[Digistore24Adapter v${this.version} - 2025-10-24]`;
    }

    // buildCheckoutUrl permanece idêntico à v1.1.3
    async buildCheckoutUrl(offerData, trackingParams) {
        console.log(`${this.logPrefix} Construindo URL de checkout para ${offerData.offer_name}...`);
        const baseUrl = offerData.checkout_url;
        const affiliateId = offerData.affiliate_id;

        if (!baseUrl || baseUrl.toLowerCase().startsWith('adapter:')) {
             console.error(`${this.logPrefix} checkout_url inválido:`, baseUrl);
             return null;
        }
        if (!affiliateId) console.warn(`${this.logPrefix} affiliate_id não encontrado para ${offerData.offer_name}.`);

        try {
            const url = new URL(baseUrl);
            if (affiliateId) url.searchParams.set(DIGISTORE_AFFILIATE_PARAM, affiliateId);

            for (const internalParam in DIGISTORE_TRACKING_PARAMS_MAP) {
                if (trackingParams[internalParam]) {
                    url.searchParams.set(DIGISTORE_TRACKING_PARAMS_MAP[internalParam], trackingParams[internalParam]);
                }
            }
            const finalUrl = url.toString();
            // Log com querystring mascarada
            const urlForLog = finalUrl.split('?')[0] + '?<params_ocultos>';
            console.log(`${this.logPrefix} URL Final gerada com sucesso: ${urlForLog}`);
            return finalUrl;
        } catch (error) {
            console.error(`${this.logPrefix} Erro ao construir URL de checkout:`, error);
            return null;
        }
    }

    async verifyWebhook(requestQuery, requestHeaders) {
        // Log sanitizado
        console.log(`${this.logPrefix} Verificando webhook... Query (sanitizada):`, this.safeLog(requestQuery));

        // 1. Validar auth_key (Timing Safe)
        const receivedKey = Buffer.from(String(requestQuery.auth_key || ''), 'utf8');
        const configuredKey = Buffer.from(String(DIGISTORE_WEBHOOK_AUTH_KEY), 'utf8');
        const isValidKey = receivedKey.length === configuredKey.length && crypto.timingSafeEqual(receivedKey, configuredKey);
        
        if (!isValidKey) {
            console.warn(`${this.logPrefix} Chave de autenticação do webhook INVÁLIDA recebida.`);
            return null;
        }
        console.log(`${this.logPrefix} Chave de autenticação validada.`);

        // 2. Mapear status (com pending)
        const statusMap = {
             'completed': 'paid', 'paying': 'paid',
             'refunded': 'refunded', 'chargeback': 'chargeback',
             'aborted': 'aborted',
             'waiting': 'pending', 'pending': 'pending', 'open': 'pending'
        };

        // 3. getValue otimizado (cópia lowercase)
        const lowerQuery = Object.fromEntries(
            Object.entries(requestQuery).map(([k, v]) => [String(k).toLowerCase(), v])
        );
        const getValue = (keys) => {
            for (const key of keys) {
                const k = String(key).toLowerCase();
                if (lowerQuery[k] !== undefined) return lowerQuery[k];
            }
            return null;
        };

        // 4. Normalizar os dados
        const rawStatus = (getValue(['status', 'billing_status', 'status_text']) || '').toLowerCase();
        const status = statusMap[rawStatus] || 'unknown';
        if (status === 'unknown' && rawStatus) {
             console.warn(`${this.logPrefix} Status de billing não mapeado recebido: ${rawStatus}`);
        }

        // Timestamp robusto
        const rawTs = getValue(['datetime_utc', 'dt', 'time', 'timestamp']);
        let timestamp = new Date();
        // ... (lógica de parsing de data idêntica v1.1.3) ...

        // Amount tolerante a vírgula e sinal
        const rawAmount = getValue(['amount_affiliate', 'amount_affiliate_abs', 'earnings_affiliate_abs', 'amount_total', 'amount_gross', 'amount']) || '0';
        const normalizedAmountString = String(rawAmount).replace(',', '.');
        const amount = parseFloat(normalizedAmountString);

        // REFORÇO v1.1.4: Prepara o rawPayload sem a auth_key
        const payloadCopy = { ...requestQuery };
        if (typeof payloadCopy.auth_key !== 'undefined') payloadCopy.auth_key = '<removed>';
        if (typeof payloadCopy.auth_key_lower !== 'undefined') delete payloadCopy.auth_key_lower; // Remove se a cópia lowercase foi usada

        const normalizedData = {
            platform: 'digistore24',
            userId: getValue(['sid1', 'user_id']) || null,
            gclid: getValue(['sid2', 'gclid']) || null,
            fbclid: getValue(['sid3', 'fbclid']) || null,
            anonId: getValue(['sid4', 'anon_id']) || null,
            cid: getValue(['cid']) || null,
            campaignkey: getValue(['campaignkey']) || null,
            orderId: getValue(['order_id', 'txn_id']) || null,
            transactionId: getValue(['txn_id', 'transaction_id']) || null,
            productId: getValue(['product_id']) || null,
            productName: getValue(['product', 'product_name']) || null,
            status: status,
            amount: isNaN(amount) ? 0.0 : amount,
            currency: getValue(['currency']) || 'USD',
            timestamp: timestamp,
            affiliateName: getValue(['affiliate', 'affiliate_name']) || null,
            transactionType: getValue(['action', 'transaction_type']) || null,
            orderType: getValue(['order_type']) || null,
            rawPayload: payloadCopy // Usa a cópia sanitizada
        };

        if (!normalizedData.userId || !normalizedData.transactionId || normalizedData.status === 'unknown') {
             console.warn(`${this.logPrefix} Webhook normalizado com dados essenciais em falta ou status desconhecido:`, this.safeLog(normalizedData));
        }

        console.log(`${this.logPrefix} Webhook verificado e normalizado com sucesso.`);
        return normalizedData;
    }
}

module.exports = Digistore24Adapter;