/**
 * PZ Advisors - Digistore24 Adapter
 * Versão: 1.1.6
 * Data: 2025-10-26
 * Desc: CORREÇÃO TESTES UNITÁRIOS. Move a verificação da 'DIGISTORE_WEBHOOK_AUTH_KEY'
 * de fora da classe para dentro do método 'verifyWebhook'.
 * Isto impede que a importação do ficheiro falhe em ambientes de teste.
 * Mantém todos os ajustes S2S da v1.1.5.
 */
const PlatformAdapterBase = require('./PlatformAdapterBase');
const crypto = require('crypto');

// Configurações (idênticas v1.1.3+)
const DIGISTORE_AFFILIATE_PARAM = 'aff';
const DIGISTORE_TRACKING_PARAMS_MAP = {
    user_id: 'sid1', // **NOTA:** Mapeamento para URL de CHECKOUT
    gclid: 'sid2',
    fbclid: 'sid3',
    anon_id: 'sid4',
    cid: 'cid',
    campaignkey: 'campaignkey'
};

// A verificação da chave foi MOVIDA para dentro do 'verifyWebhook'
// const DIGISTORE_WEBHOOK_AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
// if (!DIGISTORE_WEBHOOK_AUTH_KEY) {
//   throw new Error('[Digistore24Adapter v1.1.5] Variável de ambiente DIGISTORE_AUTH_KEY não configurada!');
// }

class Digistore24Adapter extends PlatformAdapterBase {

    constructor() {
        super();
        this.version = '1.1.6'; // Atualiza versão
        this.logPrefix = `[Digistore24Adapter v${this.version} - 2025-10-26]`;
    }

    // buildCheckoutUrl permanece idêntico à v1.1.3+
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
            const urlForLog = finalUrl.split('?')[0] + '?<params_ocultos>';
            console.log(`${this.logPrefix} URL Final gerada: ${urlForLog}`);
            return finalUrl;
        } catch (error) {
            console.error(`${this.logPrefix} Erro ao construir URL:`, error);
            return null;
        }
    }

    // verifyWebhook AJUSTADO na v1.1.6
    async verifyWebhook(requestQuery, requestHeaders) {
        console.log(`${this.logPrefix} Verificando webhook S2S... Query (sanitizada):`, this.safeLog(requestQuery));

        // CORREÇÃO v1.1.6: Verifica a chave de ambiente AQUI, dentro do método.
        const DIGISTORE_WEBHOOK_AUTH_KEY = process.env.DIGISTORE_AUTH_KEY;
        if (!DIGISTORE_WEBHOOK_AUTH_KEY) {
            console.error(`${this.logPrefix} Erro crítico: DIGISTORE_AUTH_KEY não está configurada no ambiente.`);
            return null; // Falha segura
        }
        // FIM DA CORREÇÃO

        // 1. Validar auth_key (Timing Safe - idêntico v1.1.4)
        const receivedKey = Buffer.from(String(requestQuery.auth_key || ''), 'utf8');
        const configuredKey = Buffer.from(String(DIGISTORE_WEBHOOK_AUTH_KEY), 'utf8');

        const isValidKey = receivedKey.length === configuredKey.length && crypto.timingSafeEqual(receivedKey, configuredKey);

        if (!isValidKey) {
            console.warn(`${this.logPrefix} Chave de autenticação ('auth_key') do webhook INVÁLIDA recebida.`);
            return null;
        }
        console.log(`${this.logPrefix} Chave de autenticação validada.`);

        // 2. Mapear status (idêntico v1.1.4)
        const statusMap = {
             'completed': 'paid', 'paying': 'paid',
             'refunded': 'refunded', 'chargeback': 'chargeback',
             'aborted': 'aborted',
             'waiting': 'pending', 'pending': 'pending', 'open': 'pending'
        };

        // 3. getValue otimizado (idêntico v1.1.5)
        const lowerQuery = Object.fromEntries(
            Object.entries(requestQuery).map(([k, v]) => [String(k).toLowerCase(), v])
        );
        const getValue = (keys) => {
            for (const key of keys) {
                const k = String(key).toLowerCase();
                if (lowerQuery[k] !== undefined && lowerQuery[k] !== null && lowerQuery[k] !== '') return lowerQuery[k];
            }
            return null;
        };

        // 4. Normalizar os dados (Ajustado v1.1.5 para S2S)
        const rawStatus = (getValue(['status', 'billing_status']) || '').toLowerCase(); // S2S usa 'status'
        const status = statusMap[rawStatus] || 'unknown';
        if (status === 'unknown' && rawStatus) {
             console.warn(`${this.logPrefix} Status de billing não mapeado recebido: ${rawStatus}`);
        }

        let timestamp = new Date(); // Fallback

        const rawAmount = getValue(['amount', 'amount_affiliate_abs']) || '0';
        const normalizedAmountString = String(rawAmount).replace(',', '.');
        const amount = parseFloat(normalizedAmountString);

        // Mapeamento de IDs (Ajustado v1.1.5)
        const gclidValue = getValue(['gclid', 'sid2']);
        const fbclidValue = getValue(['fbclid', 'sid1']);
        const campaignValue = getValue(['campaignkey', 'campaign']);
        const userIdValue = getValue(['sid3', 'user_id']); // Assumindo user_id no sid3

        if (!userIdValue && getValue(['sid1'])) {
             console.warn(`${this.logPrefix} ALERTA: User ID (mapeado para sid3) não encontrado. Valor de sid1 ('${getValue(['sid1'])}') parece ser fbclid.`);
        } else if (!userIdValue) {
             console.warn(`${this.logPrefix} ALERTA: User ID (mapeado para sid3 ou user_id) não encontrado nos parâmetros do webhook.`);
        }

        // Prepara o rawPayload sem a auth_key
        const payloadCopy = { ...requestQuery };
        if (typeof payloadCopy.auth_key !== 'undefined') {
            payloadCopy.auth_key = '<removed>';
        } else {
           // Procura a chave original case-insensitive e remove se for 'auth_key'
           const originalAuthKey = Object.keys(requestQuery).find(k => k.toLowerCase() === 'auth_key');
           if (originalAuthKey) {
               delete payloadCopy[originalAuthKey];
               console.log(`${this.logPrefix} Chave de autenticação original '${originalAuthKey}' removida do rawPayload.`);
           }
        }

        const normalizedData = {
            platform: 'digistore24',
            userId: userIdValue,
            gclid: gclidValue,
            fbclid: fbclidValue,
            campaignkey: campaignValue,
            anonId: getValue(['sid4', 'anon_id']) || null,
            cid: getValue(['cid']) || null,
            orderId: getValue(['order_id']) || null,
            transactionId: getValue(['transaction_id', 'txn_id']) || null,
            productId: getValue(['product_id']) || null,
            productName: getValue(['product', 'product_name']) || null,
            status: status,
            amount: isNaN(amount) ? 0.0 : amount,
            currency: getValue(['currency']) || 'USD',
            timestamp: timestamp,
            affiliateName: getValue(['affiliate', 'affiliate_name']) || null,
            rawPayload: payloadCopy
        };

        if (!normalizedData.userId || !normalizedData.transactionId || status === 'unknown') {
             console.warn(`${this.logPrefix} Webhook S2S normalizado com dados essenciais em falta ou status desconhecido. Status: '${status}'. UserID: '${normalizedData.userId}'. TxID: '${normalizedData.transactionId}'.`);
        }

        console.log(`${this.logPrefix} Webhook S2S verificado e normalizado com sucesso.`);
        return normalizedData;
    }
}

module.exports = Digistore24Adapter;