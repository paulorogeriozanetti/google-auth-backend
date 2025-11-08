/**
 * PZ Clickbank Adapter Unit Tests
 * Nome/Versão do teste: ClickbankAdapter.test v1.2.7-DR5
 * Data: 2025-11-08
 *
 * Escopo:
 * - Valida PRIORIDADE 4 (data-driven) lendo regras do CSV (via ParamMapLoaderCsv) e override por offerData.
 * - Garante propagação de parâmetros (gclid, UTMs, affiliate→aff, etc.) + regra especial user_id→tid.
 * - Exercita fallback heurístico quando CSV indisponível.
 * - Endurece verifyWebhook: aceita assinatura base64/hex, IV alternativo, normaliza trackingCodes (tid_/gclid_/fbclid_).
 * - NÃO testa o scraper (SCRAPER_MODE=off na suíte principal).
 */

// ---------------------------------------------------------------------
// PREP: ENV e mocks globais ANTES de importar o adapter
// ---------------------------------------------------------------------
process.env.CB_SCRAPER_MODE = 'off'; // evitar caminho do scraper por padrão
process.env.CLICKBANK_WEBHOOK_SECRET_KEY =
  process.env.CLICKBANK_WEBHOOK_SECRET_KEY || 'TEST_SECRET_0123456789';

// URL "fake" do CSV para o ParamMapLoaderCsv
process.env.PZ_PARAMETER_MAP_URL = 'https://example.com/pz_parameter_map.csv';

// ----------------------- MOCKS BÁSICOS -------------------------------

// axios/cheerio não serão usados (scraper off), mas deixamos mocks por segurança
jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn()
}), { virtual: true });

jest.mock('cheerio', () => {
  const api = {
    load: jest.fn().mockReturnValue({
      html: jest.fn(),
      find: jest.fn().mockReturnThis(),
      attr: jest.fn(),
      map: jest.fn(),
      get: jest.fn(),
      each: jest.fn()
    })
  };
  return api;
}, { virtual: true });

// MOCK do ParamMapLoaderCsv (caminho feliz)
const mockCsvRows = [
  // include_in_checkout => true
  { pz_id_parameter: 'gclid', include_in_checkout: '1' },
  { pz_id_parameter: 'utm_source', include_in_checkout: 'true' },
  { pz_id_parameter: 'utm_medium', include_in_checkout: 'yes' },
  { pz_id_parameter: 'utm_campaign', include_in_checkout: 'y' },
  { pz_id_parameter: 'utm_term', include_in_checkout: 1 },
  { pz_id_parameter: 'utm_content', include_in_checkout: 'TRUE' },
  // map_to (affiliate -> aff)
  { pz_id_parameter: 'affiliate', include_in_checkout: '1', map_to: 'aff' },
  // sid1..sid4 permitidos
  { pz_id_parameter: 'sid1', include_in_checkout: '1' },
  { pz_id_parameter: 'sid2', include_in_checkout: '1' },
  { pz_id_parameter: 'sid3', include_in_checkout: '1' },
  { pz_id_parameter: 'sid4', include_in_checkout: '1' },
  // user_id pode aparecer no mapa mas regra especial já cobre tid
  { pz_id_parameter: 'user_id', include_in_checkout: '1' }
];

class MockParamMapLoaderCsv {
  constructor(url) {
    this.url = url;
  }
  async load() {
    return mockCsvRows;
  }
}
jest.mock('./ParamMapLoaderCsv', () => MockParamMapLoaderCsv);

// MOCK de crypto (controle de HMAC/decifragem)
jest.mock('crypto', () => {
  const real = jest.requireActual('crypto');
  let _hmacInput = Buffer.alloc(0);

  return {
    // HMAC
    createHmac: jest.fn().mockImplementation((_algo, _key) => {
      return {
        update: jest.fn().mockImplementation((buf) => {
          _hmacInput = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
          return this;
        }),
        // devolver um hex determinístico baseado no input para o teste
        digest: jest.fn().mockImplementation((encoding) => {
          // para simplificar, devolvemos um hex fixo de 32 bytes
          const hex = 'a1'.repeat(32); // 64 chars hex (256 bits)
          return encoding === 'hex' ? hex : Buffer.from(hex, 'hex');
        })
      };
    }),

    // Hash para chave AES
    createHash: jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue(Buffer.alloc(32, 0x11)) // chave 32 bytes
    }),

    // Decifragem AES-256-CBC mockada
    createDecipheriv: jest.fn().mockImplementation((_algo, _key, _iv) => {
      return {
        update: jest.fn().mockImplementation((_buf, _inputEnc, _outEnc) => {
          // retornamos string vazia na update; final() retornará o JSON
          return '';
        }),
        final: jest.fn().mockImplementation((_outEnc) => {
          // payload de sucesso padrão: contem vendorVariables.tid_, trackingCodes e lineItems
          return JSON.stringify({
            transactionType: 'SALE',
            receipt: 'RCPT123',
            currency: 'USD',
            transactionTime: '2025-10-26T00:00:00Z',
            vendorVariables: { tid_: 'TID_FROM_VENDOR' },
            trackingCodes: ['gclid_ABC', 'tid_USER_FROM_TC', 'fbclid_XYZ'],
            lineItems: [{ itemNo: 1, productTitle: 'ProductTitle', accountAmount: 49.99 }],
            totalOrderAmount: 49.99,
            customer: { billing: { email: 'buyer@example.com' } }
          });
        })
      };
    }),

    // timingSafeEqual real (seguro)
    timingSafeEqual: jest.fn().mockImplementation((a, b) => {
      return real.timingSafeEqual(a, b);
    }),

    // Buffer real para base64/hex
    Buffer: real.Buffer
  };
});

// ---------------------------------------------------------------------
// IMPORTA O ADAPTER (após mocks)
const ClickbankAdapter = require('./ClickbankAdapter');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// ---------------------------------------------------------------------
// SUÍTES
// ---------------------------------------------------------------------
describe('ClickbankAdapter v1.2.7-DR5 — DATA-DRIVEN (CSV) & WEBHOOK', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CB_SCRAPER_MODE = 'off'; // garantir
    process.env.PZ_PARAMETER_MAP_URL = 'https://example.com/pz_parameter_map.csv';
  });

  // -------------------- buildCheckoutUrl (CSV) -----------------------
  describe('buildCheckoutUrl — regras via CSV (Fonte Única da Verdade)', () => {
    const hopWithPlaceholder = 'https://12345.hop.clickbank.net/?tid=[TRACKING_ID]';
    const hopNoPlaceholder = 'https://12345.hop.clickbank.net/';

    const trackingParams = {
      user_id: 'USER_ABC_789',
      gclid: 'G-111',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'sale',
      utm_term: 'kw',
      utm_content: 'ad1',
      affiliate: 'pzadvisors',
      sid1: 'S1',
      sid2: 'S2',
      sid3: 'S3',
      sid4: 'S4',
      // lixo que deve ser filtrado
      bogus: 'will_be_ignored',
      noneParam: 'none'
    };

    test('Substitui [TRACKING_ID] por tid e propaga parâmetros permitidos (mapeando affiliate→aff) [CSV rules]', async () => {
      const adapter = new ClickbankAdapter();

      const url = await adapter.buildCheckoutUrl(
        { hoplink: hopWithPlaceholder },
        trackingParams
      );

      expect(url).toBeDefined();
      expect(typeof url).toBe('string');
      expect(url).toContain('tid=USER_ABC_789');
      expect(url).toContain('gclid=G-111');
      expect(url).toContain('utm_source=google');
      expect(url).toContain('utm_medium=cpc');
      expect(url).toContain('utm_campaign=sale');
      expect(url).toContain('utm_term=kw');
      expect(url).toContain('utm_content=ad1');
      expect(url).toContain('aff=pzadvisors'); // mapeado
      expect(url).toContain('sid1=S1');
      expect(url).toContain('sid2=S2');
      expect(url).toContain('sid3=S3');
      expect(url).toContain('sid4=S4');

      // parâmetros não permitidos/nulos não devem aparecer
      expect(url).not.toContain('bogus=');
      expect(url).not.toContain('noneParam=');
    });

    test('Quando não há placeholder, injeta tid e parâmetros data-driven no hoplink', async () => {
      const adapter = new ClickbankAdapter();

      const url = await adapter.buildCheckoutUrl(
        { hoplink: hopNoPlaceholder },
        trackingParams
      );

      expect(url).toBeDefined();
      expect(url).toContain('tid=USER_ABC_789');
      expect(url).toContain('gclid=G-111');
      expect(url).toContain('utm_source=google');
      expect(url).toContain('aff=pzadvisors');
    });

    test('OfferData override: usa parameterAllowlist + parameterMap do offer quando presentes', async () => {
      const adapter = new ClickbankAdapter();

      const offerOverride = {
        hoplink: hopNoPlaceholder,
        parameterAllowlist: ['gclid', 'utm_source', 'affiliate'], // somente estes
        parameterMap: { affiliate: 'aff' }
      };

      const url = await adapter.buildCheckoutUrl(offerOverride, trackingParams);

      expect(url).toContain('tid=USER_ABC_789');
      expect(url).toContain('gclid=G-111');
      expect(url).toContain('utm_source=google');
      expect(url).toContain('aff=pzadvisors');

      // não deve conter outros UTMs pois a allowlist do offer é restrita
      expect(url).not.toContain('utm_medium=');
      expect(url).not.toContain('utm_campaign=');
      expect(url).not.toContain('utm_term=');
      expect(url).not.toContain('utm_content=');
    });
  });

  // ------------------ buildCheckoutUrl (fallback) --------------------
  describe('buildCheckoutUrl — fallback heurístico quando CSV indisponível', () => {
    beforeEach(() => {
      jest.resetModules();
      // Força o adapter a não encontrar o loader (require falha e cai no catch)
      jest.doMock('./ParamMapLoaderCsv', () => {
        throw new Error('not found');
      }, { virtual: true });

      process.env.PZ_PARAMETER_MAP_URL = ''; // sem URL
    });

    test('Propaga parâmetros heurísticos (gclid, UTMs, etc.) quando CSV não está disponível', async () => {
      // Reimporta o adapter isolado com o mock acima ativo
      const { default: _unused } = await import('node:module'); // ping isolator
      const A = require('./ClickbankAdapter');

      const adapter = new A();
      const url = await adapter.buildCheckoutUrl(
        { hoplink: 'https://12345.hop.clickbank.net/' },
        {
          user_id: 'U1',
          gclid: 'G1',
          utm_source: 'google',
          utm_medium: 'cpc',
          utm_campaign: 'camp',
          utm_term: 'term',
          utm_content: 'content',
          fbclid: 'FB1'
        }
      );

      expect(url).toBeDefined();
      expect(url).toContain('tid=U1');
      expect(url).toContain('gclid=G1');
      expect(url).toContain('utm_source=google');
      expect(url).toContain('utm_medium=cpc');
      expect(url).toContain('utm_campaign=camp');
      expect(url).toContain('utm_term=term');
      expect(url).toContain('utm_content=content');
      expect(url).toContain('fbclid=FB1');
    });
  });

  // ------------------------ verifyWebhook ----------------------------
  describe('verifyWebhook — HMAC + decifragem + normalização', () => {
    const base64IV = Buffer.from('0123456789abcdef').toString('base64'); // 16 bytes IV em base64
    const bodyBuf = Buffer.from('ENCRYPTED_PAYLOAD'); // conteúdo simbólico; decifragem é mockada

    function buildAdapter() {
      return new ClickbankAdapter();
    }

    test('Aceita assinatura HEX e retorna payload normalizado (vendor tid_ tem prioridade; trackingCodes extraídos)', async () => {
      const adapter = buildAdapter();

      // Nosso mock de HMAC devolve um hex com 64 chars "a1"
      const validHex = 'a1'.repeat(32);

      const data = await adapter.verifyWebhook(bodyBuf, {
        'x-clickbank-signature': validHex, // HEX
        'x-clickbank-cbsig-iv': base64IV
      });

      expect(data).not.toBeNull();
      expect(data.platform).toBe('clickbank');
      expect(data.status).toBe('paid');
      // vendorVariables.tid_ tem prioridade sobre trackingCodes.tid_
      expect(data.trackingId).toBe('TID_FROM_VENDOR');
      expect(data.gclid).toBe('ABC');
      expect(data.fbclid).toBe('XYZ');
      expect(data.amount).toBe(49.99);
      expect(data.orderId).toBe('RCPT123');
      expect(data.customerEmail).toBe('buyer@example.com');
    });

    test('Aceita assinatura BASE64 (mesmo valor do HEX equivalente em bytes) e valida com sucesso', async () => {
      const adapter = buildAdapter();

      // Mesmo hex do mock -> bytes -> base64
      const hex = 'a1'.repeat(32);
      const sigBase64 = Buffer.from(hex, 'hex').toString('base64');

      const data = await adapter.verifyWebhook(bodyBuf, {
        'x-clickbank-signature': sigBase64, // BASE64
        'x-clickbank-cbsig-iv': base64IV
      });

      expect(data).not.toBeNull();
      expect(data.status).toBe('paid');
    });

    test('Rejeita quando assinatura inválida (tamanho diferente) — timingSafeEqual não é executado', async () => {
      const adapter = buildAdapter();

      // base64 de poucos bytes para forçar tamanho diferente
      const badSig = Buffer.from('tooshort').toString('base64');

      const data = await adapter.verifyWebhook(bodyBuf, {
        'x-clickbank-signature': badSig,
        'x-clickbank-cbsig-iv': base64IV
      });

      expect(data).toBeNull();
    });

    test('Retorna null sem IV ou sem assinatura', async () => {
      const adapter = buildAdapter();

      let data = await adapter.verifyWebhook(bodyBuf, {
        'x-clickbank-signature': 'aaaa'
      });
      expect(data).toBeNull();

      data = await adapter.verifyWebhook(bodyBuf, {
        'x-clickbank-cbsig-iv': base64IV
      });
      expect(data).toBeNull();
    });

    test('Retorna null com body vazio', async () => {
      const adapter = buildAdapter();
      const data = await adapter.verifyWebhook(Buffer.from(''), {
        'x-clickbank-signature': 'a1'.repeat(32),
        'x-clickbank-cbsig-iv': base64IV
      });
      expect(data).toBeNull();
    });
  });

  // ---------------------- Instância/Herança --------------------------
  test('Instancia deve herdar de PlatformAdapterBase', () => {
    const adapter = new ClickbankAdapter();
    expect(adapter).toBeInstanceOf(PlatformAdapterBase);
  });
});