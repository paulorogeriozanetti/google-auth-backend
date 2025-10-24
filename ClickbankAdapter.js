/**
 * PZ Advisors - Clickbank Adapter
 * Versão: 1.1.4
 * Data: 2025-10-24
 * Desc: Incorpora melhorias do quarto duplo check.
 * - REFORÇO DE SEGURANÇA: Rejeita (return null) imediatamente se a assinatura HMAC for inválida.
 * - REFORÇO DE CONSISTÊNCIA: Filtra gclid_/fbclid_ do fallback de extração do userId.
 * - Atualiza versão para consistência.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// Configurações e Helper fetchWithRetry (idênticos v1.1.3)
const CLICKBANK_TRACKING_PARAM = 'tid';
const CLICKBANK_WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY;
if (!CLICKBANK_WEBHOOK_SECRET_KEY) {
  throw new Error('[ClickbankAdapter v1.1.4] Variável de ambiente CLICKBANK_WEBHOOK_SECRET_KEY não configurada!');
}
async function fetchWithRetry(url, opts = {}, tries = 3, delayMs = 500) { /* ...código idêntico v1.1.3... */ }

class ClickbankAdapter extends PlatformAdapterBase {

    constructor() {
        super();
        this.version = '1.1.4'; // Atualiza versão
        this.logPrefix = `[ClickbankAdapter v${this.version} - 2025-10-24]`;
    }

    // buildCheckoutUrl (idêntico v1.1.3)
    async buildCheckoutUrl(offerData, trackingParams) { /* ...código idêntico v1.1.3... */ }

     // verifyWebhook (REFORÇOS v1.1.4)
     async verifyWebhook(requestBody, requestHeaders) {
         console.log(`${this.logPrefix} Verificando webhook... Headers (sanitizados):`, this.safeLog(requestHeaders));

         // Cabeçalhos tolerantes (idêntico v1.1.3)
         const headers = Object.fromEntries(Object.entries(requestHeaders).map(([k, v]) => [k.toLowerCase(), v]));
         const ivHeader = headers['x-clickbank-cbsig-iv'] || headers['x-clickbank-iv'] || headers['x-cb-iv'];
         const signatureHeader = headers['x-clickbank-cbsignature'] || headers['x-clickbank-signature'] || headers['x-cb-signature'];

         if (!ivHeader || !requestBody || !(requestBody instanceof Buffer) || requestBody.length === 0 || !signatureHeader) {
            console.warn(`${this.logPrefix} Cabeçalhos/Payload (Buffer) inválidos ou ausentes.`);
            return null;
         }
         if (!CLICKBANK_WEBHOOK_SECRET_KEY) { /* ... (erro) ... */ return null; }

         try {
             const encryptedB64 = requestBody.toString('utf8');

             // 1. Validar Assinatura HMAC
             const calculatedMac = crypto.createHmac('sha256', CLICKBANK_WEBHOOK_SECRET_KEY).update(ivHeader + encryptedB64).digest();
             let receivedSignatureBuffer = null;
             try { receivedSignatureBuffer = Buffer.from(signatureHeader, 'base64'); } catch {}
             if (!receivedSignatureBuffer || receivedSignatureBuffer.length !== calculatedMac.length) {
                  try { receivedSignatureBuffer = Buffer.from(signatureHeader, 'hex'); } catch {}
             }

             // REFORÇO v1.1.4: Rejeita imediatamente se a assinatura for inválida
             if (!receivedSignatureBuffer || receivedSignatureBuffer.length !== calculatedMac.length || !crypto.timingSafeEqual(receivedSignatureBuffer, calculatedMac)) {
                 console.warn(`${this.logPrefix} Assinatura HMAC do webhook Clickbank INVÁLIDA.`);
                 return null; // Rejeita requisições não autênticas
             }
             
             console.log(`${this.logPrefix} Assinatura HMAC validada.`);

             // 2. Desencriptar Payload (idêntico v1.1.3)
             const key = crypto.createHash('sha256').update(CLICKBANK_WEBHOOK_SECRET_KEY).digest();
             const iv = Buffer.from(ivHeader, 'base64');
             const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
             let decryptedJson = decipher.update(encryptedB64, 'base64', 'utf8');
             decryptedJson += decipher.final('utf8');
             const notificationData = JSON.parse(decryptedJson);
             console.log(`${this.logPrefix} Payload desencriptado com sucesso (sanitizado):`, this.safeLog(notificationData));

             // 3. Normalizar Dados
             const txType = notificationData.transactionType;
             const lineItem = Array.isArray(notificationData.lineItems) && notificationData.lineItems[0] ? notificationData.lineItems[0] : {};
             const statusMap = {
                'SALE':'paid', 'BILL':'paid', 'RFND':'refunded', 'CGBK':'chargeback',
                'TEST_SALE':'test', 'TEST_BILL':'test', 'INSF':'failed',
                'CANCEL-REBILL':'cancelled', 'UNCANCEL-REBILL':'reactivated'
             };
             
             // REFORÇO v1.1.4: Filtra gclid_ e fbclid_ do fallback do userId
             let userId = null;
             const tcodes = Array.isArray(notificationData.trackingCodes) ? notificationData.trackingCodes : [];
             const tidPref = tcodes.find(s => typeof s === 'string' && s.toLowerCase().startsWith('tid_'));
             
             if (tidPref) {
                 userId = tidPref.substring(4);
             } else {
                 // Fallback: pega o primeiro tracking code que NÃO seja gclid_ ou fbclid_
                 userId = tcodes.find(s =>
                   typeof s === 'string' &&
                   !s.toLowerCase().startsWith('gclid_') &&
                   !s.toLowerCase().startsWith('fbclid_')
                 ) || null;
                 
                 if (userId) {
                     console.log(`${this.logPrefix} Fallback: usando tracking code não-clickid como User ID (sanitizado):`, this.safeLog({userId}));
                 }
             }

             const normalizedData = {
                 platform: 'clickbank',
                 userId: userId || null,
                 orderId: notificationData.receipt || null,
                 transactionId: (notificationData.receipt || 'rcpt') + '-' + (notificationData.transactionTime || Date.now()),
                 productId: lineItem.itemNo || null,
                 productName: lineItem.productTitle || null,
                 status: statusMap[txType] || 'unknown',
                 amount: parseFloat(lineItem.accountAmount) || 0.0,
                 currency: notificationData.currency || 'USD',
                 timestamp: notificationData.transactionTime ? new Date(notificationData.transactionTime) : new Date(),
                 customerName: [notificationData.customer?.billing?.firstName, notificationData.customer?.billing?.lastName].filter(Boolean).join(' ') || null,
                 customerEmail: notificationData.customer?.billing?.email || null,
                 vendor: notificationData.vendor || null,
                 gclid: tcodes.find(s => typeof s === 'string' && s.toLowerCase().startsWith('gclid_'))?.substring(6) || null,
                 fbclid: tcodes.find(s => typeof s === 'string' && s.toLowerCase().startsWith('fbclid_'))?.substring(7) || null,
                 affiliateName: notificationData.affiliate || null,
                 transactionType: txType,
                 rawPayload: notificationData
             };

             if (!normalizedData.userId || !normalizedData.orderId || normalizedData.status === 'unknown') {
               console.warn(`${this.logPrefix} Dados essenciais ausentes/indeterminados (sanitizado):`, this.safeLog(normalizedData));
             }

             console.log(`${this.logPrefix} Webhook Clickbank verificado e normalizado com sucesso.`);
             return normalizedData;

         } catch (error) {
            console.error(`${this.logPrefix} Falha crítica na validação/decifragem do webhook Clickbank:`, error?.message || error);
            return null;
         }
    }
}

module.exports = ClickbankAdapter;