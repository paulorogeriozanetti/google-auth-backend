/**
 * PZ Digistore24 Adapter Unit Tests
 * Versão: 1.3.0
 * Data: 2025-10-26
 * Desc: Implementa testes unitários reais e corrige falhas de lógica:
 * - Corrige asserção para esperar '<removed>' (em vez de undefined) no rawPayload.
 * - Corrige teste de auth_key inválida para usar chave do mesmo comprimento, forçando a chamada a timingSafeEqual.
 */

// Define a variável de ambiente ANTES de importar o adapter
// Esta é a chave do seu link S2S (pode ser mockada com qualquer valor aqui, pois o teste não vai a um serviço real)
process.env.DIGISTORE_AUTH_KEY = process.env.DIGISTORE_AUTH_KEY || 'ds24_s2s_auth_pz_kyvD7wwnTvWN8AkgxlJnnQ';

// Agora importa a classe que queremos testar
// NOTA: Este require funcionará na v1.1.6 do Adapter, pois a verificação da chave foi movida.
const Digistore24Adapter = require('./Digistore24Adapter');
const PlatformAdapterBase = require('./PlatformAdapterBase');
// Importa o módulo crypto, que será mockado pelo Jest
const crypto = require('crypto'); 

// Mock da dependência 'crypto' (usada em verifyWebhook)
jest.mock('crypto', () => ({
  // Mock da função timingSafeEqual para simular a comparação
  timingSafeEqual: jest.fn((bufferA, bufferB) => {
    // Simula a comparação real (para testes)
    if (!bufferA || !bufferB || bufferA.length !== bufferB.length) {
      return false;
    }
    // Simples comparação de strings para o mock
    return bufferA.toString() === bufferB.toString();
  }),
  // Mock de Buffer.from
  Buffer: {
    from: jest.fn((str, encoding = 'utf8') => Buffer.from(str, encoding)),
  },
}));

// --- Início dos Testes Reais ---

describe('Digistore24Adapter (Testes Unitários Reais - v1.1.6)', () => {

  // Limpa o histórico de chamadas do mock do crypto antes de cada teste
  beforeEach(() => {
    crypto.timingSafeEqual.mockClear();
  });

  // Testes para o método buildCheckoutUrl
  describe('buildCheckoutUrl', () => {
    const mockOfferData = {
      offer_name: 'Produto Teste',
      // URL de checkout estática (simulando URL do produto)
      checkout_url: 'https://www.digistore24.com/product/12345',
      affiliate_id: 'pzadvisors',
    };
    
    const mockTrackingParams = {
      user_id: 'user_abc',
      gclid: 'gclid_xyz',
      fbclid: 'fbclid_123',
      anon_id: 'anon_def',
      cid: 'cid_789',
      campaignkey: 'campaign_test',
    };

    test('Deve construir a URL de checkout completa com todos os SIDs e parâmetros', async () => {
      const adapter = new Digistore24Adapter();
      const url = await adapter.buildCheckoutUrl(mockOfferData, mockTrackingParams);
      
      // Converte a URL de volta para um objeto URLSearchParams para facilitar a verificação
      const params = new URL(url).searchParams;
      
      // Verifica se a URL contém todos os parâmetros mapeados corretamente
      expect(params.get('aff')).toBe('pzadvisors');
      expect(params.get('sid1')).toBe('user_abc'); // Mapeado de user_id
      expect(params.get('sid2')).toBe('gclid_xyz'); // Mapeado de gclid
      expect(params.get('sid3')).toBe('fbclid_123'); // Mapeado de fbclid
      expect(params.get('sid4')).toBe('anon_def'); // Mapeado de anon_id
      expect(params.get('cid')).toBe('cid_789'); // Mapeado de cid
      expect(params.get('campaignkey')).toBe('campaign_test'); // Mapeado de campaignkey
      expect(url.startsWith(mockOfferData.checkout_url)).toBe(true);
    });

    test('Deve construir a URL apenas com affiliate_id se trackingParams estiver vazio', async () => {
      const adapter = new Digistore24Adapter();
      const url = await adapter.buildCheckoutUrl(mockOfferData, {}); // Sem tracking
      
      expect(url).toBe('https://www.digistore24.com/product/12345?aff=pzadvisors');
    });
    
    test('Deve retornar null se a checkout_url for do tipo "adapter:"', async () => {
        const adapter = new Digistore24Adapter();
        const badOfferData = {
             ...mockOfferData,
             checkout_url: 'adapter:digistore24' // Esta URL não é válida para este método
        };
        const url = await adapter.buildCheckoutUrl(badOfferData, mockTrackingParams);
        expect(url).toBeNull();
    });
  });

  // Testes para o método verifyWebhook (v1.1.6)
  describe('verifyWebhook (S2S v1.1.6 logic)', () => {

    // A chave correta definida no topo do ficheiro
    const validAuthKey = process.env.DIGISTORE_AUTH_KEY; 

    test('Deve retornar dados normalizados com auth_key válida e parâmetros S2S', async () => {
      const adapter = new Digistore24Adapter();
      // Simula a query do link S2S fornecido
      const mockQuery = {
        auth_key: validAuthKey,
        transaction_id: 'tx_12345',
        status: 'completed',
        amount: '25,50', // Testa conversão de vírgula
        product: 'Produto S2S Teste',
        sid3: 'user_xyz_s2s', // userId mapeado para sid3 (conforme adapter v1.1.5)
        gclid: 'gclid_s2s_test', // Parâmetro direto
        fbclid: 'fbclid_s2s_test', // Parâmetro direto
        campaign: 'campanha_s2s_teste', // 'campaign' mapeado para 'campaignkey'
        cid: 'cid_s2s_test'
      };
      
      const data = await adapter.verifyWebhook(mockQuery, {});
      
      expect(data).not.toBeNull();
      expect(data.platform).toBe('digistore24');
      expect(data.transactionId).toBe('tx_12345');
      expect(data.status).toBe('paid'); // Mapeado de 'completed'
      expect(data.amount).toBe(25.50); // Convertido para float
      expect(data.productName).toBe('Produto S2S Teste');
      expect(data.userId).toBe('user_xyz_s2s'); // Mapeado de sid3
      expect(data.gclid).toBe('gclid_s2s_test');
      expect(data.fbclid).toBe('fbclid_s2s_test');
      expect(data.campaignkey).toBe('campanha_s2s_teste'); // Mapeado de 'campaign'
      expect(data.cid).toBe('cid_s2s_test');
      // PATCH 1: Verifica se a chave foi MASCARADA por '<removed>'
      expect(data.rawPayload).toHaveProperty('auth_key', '<removed>'); 
      expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1); // Verifica se a validação foi feita
    });

    test('Deve retornar NULL se a auth_key for inválida (mesmo comprimento)', async () => {
      const adapter = new Digistore24Adapter();
      
      // PATCH 2: Constrói uma chave incorreta com o MESMO tamanho da chave válida,
      // para forçar a chamada ao timingSafeEqual no adapter (resolve o erro 0 != 1).
      const badKey = (process.env.DIGISTORE_AUTH_KEY || '').replace(/./g, 'x');
      
      const mockQuery = {
        auth_key: badKey, // Chave incorreta, mas de mesmo comprimento
        transaction_id: 'tx_456'
      };
      
      const data = await adapter.verifyWebhook(mockQuery, {});
      
      expect(data).toBeNull();
      // Agora, timingSafeEqual DEVE ser chamado
      expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
    });
    
    test('Deve retornar NULL se a auth_key estiver ausente', async () => {
      const adapter = new Digistore24Adapter();
      const mockQuery = {
        transaction_id: 'tx_789'
        // Sem auth_key
      };
      
      const data = await adapter.verifyWebhook(mockQuery, {});
      
      expect(data).toBeNull();
      // timingSafeEqual não deve ser chamado
      expect(crypto.timingSafeEqual).not.toHaveBeenCalled();
    });

    test('Deve mapear status "refunded" para "refunded"', async () => {
      const adapter = new Digistore24Adapter();
      const mockQuery = {
        auth_key: validAuthKey,
        status: 'refunded',
      };
      const data = await adapter.verifyWebhook(mockQuery, {});
      expect(data.status).toBe('refunded');
    });

    test('Deve mapear status "pending" para "pending"', async () => {
      const adapter = new Digistore24Adapter();
      const mockQuery = {
        auth_key: validAuthKey,
        status: 'waiting',
      };
      const data = await adapter.verifyWebhook(mockQuery, {});
      expect(data.status).toBe('pending');
    });

    test('Deve retornar status "unknown" se o status não for mapeado', async () => {
      const adapter = new Digistore24Adapter();
      const mockQuery = {
        auth_key: validAuthKey,
        status: 'status_desconhecido',
      };
      const data = await adapter.verifyWebhook(mockQuery, {});
      expect(data.status).toBe('unknown');
    });
  });

  // Teste de instância (opcional, mas bom)
  test('Deve ser uma instância de PlatformAdapterBase', () => {
      const adapter = new Digistore24Adapter();
      expect(adapter).toBeInstanceOf(PlatformAdapterBase);
  });
});