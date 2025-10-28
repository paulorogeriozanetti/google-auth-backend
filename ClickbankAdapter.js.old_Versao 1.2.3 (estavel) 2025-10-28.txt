console.log('--- [BOOT CHECK] Loading ClickbankAdapter v1.2.3 (lazy-scraper) ---');
/**
 * PZ Advisors - Clickbank Adapter
 * Versão: 1.2.3 (Lazy Scraper + Feature Flag)
 * Data: 2025-10-28
 * Desc:
 * - Implementa carregamento dinâmico ('lazy loading') para 'axios' e 'cheerio'
 * dentro do 'buildCheckoutUrl', controlado pela variável de ambiente 'CB_SCRAPER_MODE'.
 * - Objetivo: Evitar o erro 'File is not defined' (do 'undici') durante o 'require'
 * do módulo, carregando as dependências apenas quando o scraper está ativo ('on').
 * - Se 'CB_SCRAPER_MODE=off' (padrão), retorna apenas o hoplink rastreado (estável).
 * - Se 'CB_SCRAPER_MODE=on', tenta o scrape; se falhar, retorna o hoplink (fallback).
 * - Mantém patches anteriores (v1.1.17 - Secret Key, v1.2.1 - Array de links no scrape).
 */
// const axios = require('axios'); // Removido do topo
// const cheerio = require('cheerio'); // Removido do topo
const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

class ClickbankAdapter extends PlatformAdapterBase {
    constructor() {
        super();
        this.version = '1.2.3';
        this.logPrefix = '[ClickbankAdapter v1.2.3]';
        this.WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY;
        // Lê a feature flag; padrão 'off' se não definida
        this.SCRAPER_MODE = String(process.env.CB_SCRAPER_MODE || 'off').toLowerCase();
        console.log(`${this.logPrefix} Scraper Mode inicializado como: ${this.SCRAPER_MODE}`);
    }

    /**
     * @override
     * Constrói a URL final.
     * 1. Sempre constrói o hoplink rastreado com 'tid'.
     * 2. Se SCRAPER_MODE=on, tenta carregar dependências (axios/cheerio) e fazer o scrape.
     * 3. Retorna array de links (scrape ok), hoplink (scrape off/falha) ou null (erro).
     */
    async buildCheckoutUrl(offerData, trackingParams) {
        const userId = trackingParams?.user_id;
        const baseUrl = offerData?.hoplink;

        if (!baseUrl) {
            console.warn(`${this.logPrefix} 'hoplink' ausente no offerData.`);
            return null;
        }

        // --- ETAPA 1: Sempre construir o HopLink rastreado (caminho estável) ---
        let trackedHoplink;
        try {
            if (baseUrl.includes('[TRACKING_ID]')) {
                const safeTid = (userId || 'NO_USER_ID').substring(0, 100).replace(/[^a-zA-Z0-9_-]/g, '_');
                trackedHoplink = baseUrl.replace('[TRACKING_ID]', encodeURIComponent(safeTid));
            } else {
                const urlObj = new URL(baseUrl);
                if (userId && !urlObj.searchParams.has('tid')) {
                    urlObj.searchParams.set('tid', userId.substring(0, 100));
                }
                trackedHoplink = urlObj.toString();
            }
        } catch (e) {
            console.error(`${this.logPrefix} URL de hoplink inválida: ${baseUrl}`, e);
            return null;
        }

        // --- ETAPA 2: Se o scraper estiver DESLIGADO, retorna o hoplink estável ---
        if (this.SCRAPER_MODE !== 'on') {
            console.log(`${this.logPrefix} SCRAPER_MODE=off -> Retornando hoplink rastreado.`);
            return trackedHoplink;
        }

        // --- ETAPA 3: SCRAPER_MODE=on -> Tentar import dinâmico e scrape ---
        console.log(`${this.logPrefix} SCRAPER_MODE=on -> Tentando import dinâmico...`);
        try {
            // Carrega axios e cheerio dinamicamente AQUI
            const [{ default: axios }, cheerio] = await Promise.all([
                import('axios'),
                import('cheerio')
            ]);
            console.log(`${this.logPrefix} Axios e Cheerio carregados dinamicamente.`);

            console.log(`${this.logPrefix} Iniciando scrape do HopLink: ${trackedHoplink}`);
            const response = await axios.get(trackedHoplink, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/5.37.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                maxRedirects: 5,
                timeout: 10000 // Aumentado para 10s
            });

            const html = response.data;
            const $ = cheerio.load(html);

            // Lógica v1.2.1 (retorna array)
            const checkoutLinks = [];
            $('a[href*="pay.clickbank.net"]').each((i, elem) => {
                const link = $(elem).attr('href');
                if (link) {
                    try {
                       const absoluteUrl = new URL(link, response.request.res.responseUrl || trackedHoplink).toString();
                       // Garante que o TID está presente (caso a página o tenha removido)
                       const urlObj = new URL(absoluteUrl);
                       if (userId && !urlObj.searchParams.has('tid')) {
                           urlObj.searchParams.set('tid', userId.substring(0, 100));
                           checkoutLinks.push(urlObj.toString());
                       } else {
                           checkoutLinks.push(absoluteUrl);
                       }
                    } catch (urlError) {
                       console.warn(`${this.logPrefix} Ignorando link inválido encontrado no scrape: ${link}`);
                    }
                }
            });

            if (checkoutLinks.length > 0) {
                console.log(`${this.logPrefix} SCRAPE SUCESSO. ${checkoutLinks.length} links de checkout encontrados.`);
                return checkoutLinks; // Retorna o ARRAY
            } else {
                console.warn(`${this.logPrefix} SCRAPE FALHOU (nenhum link 'pay.clickbank.net' encontrado). Usando fallback (hoplink).`);
                return trackedHoplink; // Retorna STRING (fallback)
            }

        } catch (scrapeError) {
            // Este catch agora pega erros do import() E do axios/cheerio
            console.error(`${this.logPrefix} Erro durante import dinâmico ou scrape:`, scrapeError?.message || scrapeError);
            if (scrapeError.code === 'ECONNABORTED') {
                 console.error(`${this.logPrefix} Scrape falhou devido a TIMEOUT.`);
            } else if (scrapeError.response) {
                 console.error(`${this.logPrefix} Scrape falhou com status HTTP ${scrapeError.response.status}.`);
            } else if (scrapeError instanceof ReferenceError && scrapeError.message.includes('File is not defined')) {
                 console.error(`${this.logPrefix} ERRO CRÍTICO: 'File is not defined' ainda ocorre, mesmo com lazy loading. Desativando scraper.`);
                 // Poderia desativar permanentemente aqui se necessário
            }
            console.warn(`${this.logPrefix} Usando fallback (HopLink rastreado) devido a erro no scrape/import.`);
            return trackedHoplink; // Retorna STRING (fallback seguro)
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