/**
 * PZ Clickbank Adapter Unit Tests
 * Versão: 1.1.4
 * Data: 2025-10-26
 * Desc: CORRIGE o mock de 'crypto.Buffer.from' para respeitar o encoding 'base64',
 * resolvendo a falha na validação HMAC.
 */

// Define as variáveis de ambiente ANTES de importar o adapter
process.env.CLICKBANK_WEBHOOK_SECRET_KEY = process.env.CLICKBANK_WEBHOOK_SECRET_KEY || 'C7K9P2W5R8T1Z4X6';
const MOCK_SECRET = process.env.CLICKBANK_WEBHOOK_SECRET_KEY;

// Agora importa a classe que queremos testar
const ClickbankAdapter = require('./ClickbankAdapter');
const PlatformAdapterBase = require('./PlatformAdapterBase');
const crypto = require('crypto');

// MOCKS GLOBAIS COM VIRTUAL: TRUE
jest.mock('axios', () => ({ 
    post: jest.fn().mockResolvedValue({ status: 200, data: { status: 'ok' } }), 
    get: jest.fn() 
}), { virtual: true });

jest.mock('cheerio', () => () => ({
    html: jest.fn(),
    find: jest.fn().mockReturnThis(),
    attr: jest.fn().mockReturnValue('mocked_checkout_url'),
    load: jest.fn().mockReturnThis(),
}), { virtual: true }); 

// Mock da biblioteca Crypto (CORRIGIDO)
jest.mock('crypto', () => {
    // Preserva o 'crypto' real para usarmos Buffer.from real
    const actualCrypto = jest.requireActual('crypto'); 
    
    return {
        createHmac: jest.fn().mockReturnValue({ 
            update: jest.fn().mockReturnThis(), 
            digest: jest.fn().mockReturnValue(Buffer.from('mocked_mac_buffer_real')) // Um buffer real
        }),
        createHash: jest.fn().mockReturnValue({ 
            update: jest.fn().mockReturnThis(), 
            digest: jest.fn().mockReturnValue(Buffer.from('mocked_key_real')) 
        }),
        createDecipheriv: jest.fn().mockReturnValue({ 
            update: jest.fn().mockReturnThis(), 
            final: jest.fn().mockReturnValue('{"transactionType": "SALE", "receipt": "RCPT123", "transactionTime": "2025-10-26T00:00:00Z", "currency": "USD", "vendor": "vendorname", "affiliate": "affname", "trackingCodes": ["tid_user456", "gclid_abc", "fbclid_xyz"], "lineItems": [{"itemNo": 1, "productTitle": "ProductTitle", "accountAmount": 49.99}]}') 
        }),
        // Mock de timingSafeEqual
        timingSafeEqual: jest.fn().mockImplementation((a, b) => {
            // Simula a comparação real de buffers
            return actualCrypto.timingSafeEqual(a, b);
        }),
        // CORREÇÃO: Usa o Buffer real para que 'base64' funcione
        Buffer: actualCrypto.Buffer, 
    };
});


describe('ClickbankAdapter (Testes Unitários Reais - v1.1.4)', () => {
    
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Configuração dos mocks de crypto para o "caminho feliz"
        // 1. Mock do HMAC digest
        crypto.createHmac.mockReturnValue({
            update: jest.fn().mockReturnThis(),
            // O digest() do adapter deve corresponder ao que o timingSafeEqual espera
            digest: jest.fn().mockReturnValue(Buffer.from('mocked_mac_buffer_real')) 
        });
        // 2. Mock do timingSafeEqual
        crypto.timingSafeEqual.mockImplementation((a, b) => {
             // Compara os buffers reais (ambos devem ser <Buffer 'mocked_mac_buffer_real'>)
            return a.toString() === b.toString();
        });
    });

    // Testes para o método buildCheckoutUrl
    describe('buildCheckoutUrl', () => {
        const mockOfferData = {
            offer_name: 'Nitric Boost',
            hoplink: 'https://12345.hop.clickbank.net/?tid=[TRACKING_ID]', 
            affiliate_id: 'pzadvisors',
        };
        const mockTrackingParams = { user_id: 'user_abc_789', gclid: 'g1', fbclid: 'f1' };

        test('Deve construir a URL de checkout com o user_id mapeado para o parâmetro tid', async () => {
            const adapter = new ClickbankAdapter();
            const finalUrl = await adapter.buildCheckoutUrl(mockOfferData, mockTrackingParams);

            // Agora o 'finalUrl' não deve ser undefined
            expect(finalUrl).toBeDefined();
            expect(finalUrl).toContain('tid=user_abc_789');
            expect(finalUrl).toContain('12345.hop.clickbank.net');
        });

        test('Deve incluir gclid e fbclid como tracking codes (se houver lógica para isso)', async () => {
            const adapter = new ClickbankAdapter();
            const finalUrl = await adapter.buildCheckoutUrl(mockOfferData, mockTrackingParams);
            expect(finalUrl).toBeDefined();
            expect(finalUrl).toContain('tid=user_abc_789');
        });
        
        test('Deve retornar null se o hoplink estiver ausente', async () => {
             const adapter = new ClickbankAdapter();
             const badOfferData = { ...mockOfferData, hoplink: '' };
             const finalUrl = await adapter.buildCheckoutUrl(badOfferData, mockTrackingParams);
             expect(finalUrl).toBeNull();
        });
    });

    // Testes para o método verifyWebhook (HMAC, Decifragem e Normalização)
    describe('verifyWebhook (Clickbank HMAC Logic)', () => {
        
        // Simula o header 'x-clickbank-signature' (deve ser 'base64' de 'mocked_mac_buffer_real')
        const validSignatureBase64 = Buffer.from('mocked_mac_buffer_real').toString('base64');
        
        const mockHeaders = {
            'x-clickbank-signature': validSignatureBase64,
            'x-clickbank-cbsig-iv': 'mocked_iv_base64',
            'x-cb-iv': 'mocked_iv_base64',
        };
        const mockEncryptedBody = Buffer.from('encrypted_payload_data_base64');

        test('Deve retornar dados normalizados com headers válidos', async () => {
            const adapter = new ClickbankAdapter();
            const data = await adapter.verifyWebhook(mockEncryptedBody, mockHeaders);

            expect(data).not.toBeNull(); // Não deve ser null
            expect(data.platform).toBe('clickbank');
            expect(data.status).toBe('paid');
            expect(data.orderId).toBe('RCPT123');
            expect(data.amount).toBe(49.99);
            expect(data.userId).toBe('user456');
            expect(crypto.createHmac).toHaveBeenCalledTimes(1);
            expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1); // Deve ser chamado
            expect(crypto.createDecipheriv).toHaveBeenCalledTimes(1);
        });

        test('Deve retornar NULL se a assinatura HMAC for inválida (valor diferente)', async () => {
             const adapter = new ClickbankAdapter();
             // Assinatura inválida (mas base64 válida)
             const invalidSignatureBase64 = Buffer.from('invalid_mac_buffer').toString('base64');
             const invalidHeaders = { ...mockHeaders, 'x-clickbank-signature': invalidSignatureBase64 };

             const data = await adapter.verifyWebhook(mockEncryptedBody, invalidHeaders);

             expect(data).toBeNull();
             expect(crypto.createHmac).toHaveBeenCalledTimes(1);
             expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1); // Chamado, mas falha
             expect(crypto.createDecipheriv).not.toHaveBeenCalled(); // Não decifra
        });
        
        test('Deve retornar NULL se a assinatura HMAC tiver comprimento diferente', async () => {
             const adapter = new ClickbankAdapter();
             // Assinatura inválida (comprimento diferente)
             const invalidHeaders = { ...mockHeaders, 'x-clickbank-signature': Buffer.from('curto').toString('base64') };

             const data = await adapter.verifyWebhook(mockEncryptedBody, invalidHeaders);

             expect(data).toBeNull();
             expect(crypto.createHmac).toHaveBeenCalledTimes(1);
             // timingSafeEqual NÃO é chamado se os comprimentos forem diferentes
             expect(crypto.timingSafeEqual).not.toHaveBeenCalled(); 
             expect(crypto.createDecipheriv).not.toHaveBeenCalled();
        });

        test('Deve retornar NULL se o header IV estiver ausente', async () => {
             const adapter = new ClickbankAdapter();
             const noIvHeaders = { 'x-clickbank-signature': validSignatureBase64 }; // Sem IV

             const data = await adapter.verifyWebhook(mockEncryptedBody, noIvHeaders);

             expect(data).toBeNull();
             expect(crypto.createHmac).not.toHaveBeenCalled();
        });

        test('Deve retornar NULL se o body for vazio (Buffer.length === 0)', async () => {
             const adapter = new ClickbankAdapter();
             const emptyBody = Buffer.from('');

             const data = await adapter.verifyWebhook(emptyBody, mockHeaders);

             expect(data).toBeNull();
             expect(crypto.createHmac).not.toHaveBeenCalled();
        });

        test('Deve filtrar gclid/fbclid e usar o tid correto para userId', async () => {
            jest.clearAllMocks();
            const adapter = new ClickbankAdapter();
            
            // 1. Mock do HMAC digest
            crypto.createHmac.mockReturnValue({
                update: jest.fn().mockReturnThis(),
                digest: jest.fn().mockReturnValue(Buffer.from('mocked_mac_buffer_real')) 
            });
            // 2. Mock do timingSafeEqual
            crypto.timingSafeEqual.mockImplementation((a, b) => a.toString() === b.toString());
            // 3. Mock da Decifragem com payload de teste
            crypto.createDecipheriv.mockReturnValueOnce({ 
                update: jest.fn().mockReturnThis(), 
                final: jest.fn().mockReturnValue('{"transactionType": "SALE", "trackingCodes": ["gclid_1", "tid_USER_XYZ", "fbclid_2", "subid_ok"], "lineItems": [{"accountAmount": 1}]}') 
            });

            const data = await adapter.verifyWebhook(mockEncryptedBody, mockHeaders);

            expect(data).not.toBeNull(); // Garante que a validação passou
            expect(data.userId).toBe('USER_XYZ'); // Deve priorizar tid_
            expect(data.gclid).toBe('1'); // Deve extrair gclid_
        });
    });

    // Teste de instância
    test('Deve ser uma instância de PlatformAdapterBase', () => {
        const adapter = new ClickbankAdapter();
        expect(adapter).toBeInstanceOf(PlatformAdapterBase);
    });
});