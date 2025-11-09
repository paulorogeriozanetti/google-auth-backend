/**
 * PZ Clickbank Adapter Unit Tests — DR6b Compat
 * Versão dos testes: 1.1.8
 * Data: 2025-11-08
 * Notas:
 * - Remove o uso de dynamic import/VM Modules no teste de fallback heurístico.
 * - Garante fonte única (CSV) via mock do ParamMapLoaderCsv, e fallback heurístico forçado por ENV.
 * - Mantém hardening do webhook (HMAC HEX/BASE64, IV headers, body vazio).
 */

// ====== ENV BASE ======
process.env.CB_SCRAPER_MODE = process.env.CB_SCRAPER_MODE || 'off';
process.env.CLICKBANK_WEBHOOK_SECRET_KEY =
  process.env.CLICKBANK_WEBHOOK_SECRET_KEY || 'TEST_SECRET_0123456789';
process.env.PZ_PARAMETER_MAP_URL =
  process.env.PZ_PARAMETER_MAP_URL || 'https://example.com/pz_parameter_map.csv';

// ====== IMPORTS (alguns serão reimportados isoladamente em testes específicos) ======
const path = require('path');

// MOCKS GLOBAIS (axios/cheerio não usados com SCRAPER_MODE=off, mas mantidos por segurança)
jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({ status: 200, data: '<html></html>', request: { res: { responseUrl: 'https://mocked' } } }),
  post: jest.fn().mockResolvedValue({ status: 200, data: { ok: true } }),
}), { virtual: true });

jest.mock('cheerio', () => {
  const api = {
    load: jest.fn(() => {
      const $ = (sel) => api;
      $.html = () => '';
      $.find = () => api;
      $.attr = () => null;
      $.map = () => ({ get: () => [] });
      $.get = () => [];
      return $;
    })
  };
  return api;
}, { virtual: true });

// ====== MOCK PARCIAL DO CRYPTO: usa crypto real para HMAC; mocka APENAS createDecipheriv ======
const realCrypto = jest.requireActual('crypto');
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  // payload padrão; pode ser ajustado dentro de cada teste redefinindo o mock
  let mockedPayload = {
    transactionType: 'SALE',
    receipt: 'RCPT123',
    transactionTime: '2025-10-26T00:00:00Z',
    currency: 'USD',
    totalOrderAmount: 49.99,
    vendorVariables: { tid_: 'TID_FROM_VENDOR' },
    trackingCodes: ['gclid_ABC', 'tid_USER_FROM_TC', 'fbclid_XYZ'],
    customer: { billing: { email: 'buyer@example.com' } },
    lineItems: [{ itemNo: 1, productTitle: 'ProductTitle', accountAmount: 49.99 }],
  };

  // Permite ao teste ajustar o payload retornado pelo "decipher"
  const setPayload = (obj) => { mockedPayload = obj; };

  return {
    ...actual,
    // Exponibiliza helper para alterar o payload nos testes
    __setMockedDecryptedPayload: setPayload,
    createDecipheriv: jest.fn(() => ({
      update: jest.fn().mockReturnValue(''),
      final: jest.fn().mockReturnValue(JSON.stringify(mockedPayload)),
    })),
  };
});

// Helper para ler o crypto (mock) e real quando precisamos de digest verdadeiro
const crypto = require('crypto'); // mockado (parcial)
const ClickbankAdapter = require('./ClickbankAdapter');
const PlatformAdapterBase = require('./PlatformAdapterBase');

// ====== MOCK DO LOADER CSV PADRÃO (para cenários CSV OK) ======
jest.mock('./ParamMapLoaderCsv', () => {
  return {
    // Loader "flexível": retorna estrutura esperada pelo adapter DR6b
    load: jest.fn().mockResolvedValue({
      allowlist: [
        'user_id', 'gclid', 'fbclid',
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'affiliate'
      ],
      aliasMap: {
        affiliate: 'aff'
      }
    }),
  };
});

// ====== SUÍTE ======
describe('ClickbankAdapter v1.3.0-DR6b — DATA-DRIVEN (CSV) & WEBHOOK', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Garante SCRAPER off para não depender de axios/cheerio
    process.env.CB_SCRAPER_MODE = 'off';
    delete process.env.PZ_PARAMETER_FORCE_HEURISTIC;
  });

  test('Instancia deve herdar de PlatformAdapterBase', () => {
    const a = new ClickbankAdapter();
    expect(a).toBeInstanceOf(PlatformAdapterBase);
  });

  // ====== BUILD CHECKOUT (CSV REGRAS) ======
  describe('buildCheckoutUrl — regras via CSV (Fonte Única da Verdade)', () => {
    test('Substitui [TRACKING_ID] por tid e propaga parâmetros permitidos (mapeando affiliate→aff) [CSV rules]', async () => {
      const a = new ClickbankAdapter();
      const offerData = {
        hoplink: 'https://12345.hop.clickbank.net/?tid=[TRACKING_ID]',
      };
      const trackingParams = {
        user_id: 'USR_001',
        affiliate: 'pzadvisors',
        gclid: 'G-111',
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'camp',
        utm_term: 'kw',
        utm_content: 'ad1'
      };

      const url = await a.buildCheckoutUrl(offerData, trackingParams);
      expect(url).toContain('tid=USR_001');
      expect(url).toContain('aff=pzadvisors'); // alias mapeado
      expect(url).toContain('gclid=G-111');
      expect(url).toContain('utm_source=google');
      expect(url).toContain('utm_medium=cpc');
      expect(url).toContain('utm_campaign=camp');
      expect(url).toContain('utm_term=kw');
      expect(url).toContain('utm_content=ad1');
      expect(url).toMatch(/12345\.hop\.clickbank\.net/);
    });

    test('Quando não há placeholder, injeta tid e parâmetros data-driven no hoplink', async () => {
      const a = new ClickbankAdapter();
      const offerData = {
        hoplink: 'https://12345.hop.clickbank.net/',
      };
      const trackingParams = {
        user_id: 'USR_ABC',
        gclid: 'G-222',
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'sale',
      };

      const url = await a.buildCheckoutUrl(offerData, trackingParams);
      expect(url).toContain('tid=USR_ABC');
      expect(url).toContain('gclid=G-222');
      expect(url).toContain('utm_source=google');
      expect(url).toContain('utm_medium=cpc');
      expect(url).toContain('utm_campaign=sale');
    });

    test('OfferData override: usa parameterAllowlist + parameterMap do offer quando presentes', async () => {
      // Simula regras por oferta sobrescrevendo CSV
      jest.doMock('./ParamMapLoaderCsv', () => ({
        load: jest.fn().mockResolvedValue({
          allowlist: ['user_id'], // Loader "pobre"
          aliasMap: {}
        }),
      }));
      jest.resetModules();
      const A = require('./ClickbankAdapter'); // reimport sob novo mock
      const a = new A();

      const offerData = {
        hoplink: 'https://12345.hop.clickbank.net/?tid=[TRACKING_ID]',
        parameterAllowlist: ['gclid', 'utm_source'],
        parameterMap: { affiliate: 'aff' }
      };
      const trackingParams = {
        user_id: 'U123',
        affiliate: 'pzadvisors',
        gclid: 'G-333',
        utm_source: 'google',
        utm_medium: 'cpc', // não permitido no override
      };

      const url = await a.buildCheckoutUrl(offerData, trackingParams);
      expect(url).toContain('tid=U123');
      expect(url).toContain('gclid=G-333');      // permitido pelo allowlist do offer
      expect(url).toContain('utm_source=google'); // permitido pelo allowlist do offer
      expect(url).not.toContain('utm_medium');    // fora do allowlist do offer
      expect(url).toContain('aff=pzadvisors');    // alias do offer
    });
  });

  // ====== BUILD CHECKOUT (FALLBACK HEURÍSTICO SEM CSV) ======
  describe('buildCheckoutUrl — fallback heurístico quando CSV indisponível', () => {
    test('Propaga parâmetros heurísticos (gclid, UTMs, etc.) quando CSV não está disponível', async () => {
      // Força heurística por ENV e impede o loader de responder
      process.env.PZ_PARAMETER_FORCE_HEURISTIC = '1';
      jest.resetModules();
      jest.doMock('./ParamMapLoaderCsv', () => ({
        load: jest.fn().mockRejectedValue(new Error('forced csv error')),
      }));

      // Isola o require do adapter já sob mocks/ENV atualizados
      jest.isolateModules(() => {
        const A = require('./ClickbankAdapter');
        const a = new A();

        const offerData = {
          hoplink: 'https://12345.hop.clickbank.net/?tid=[TRACKING_ID]',
        };
        const trackingParams = {
          user_id: 'U123',
          gclid: 'G-111',
          utm_source: 'google',
          utm_medium: 'cpc',
          utm_campaign: 'camp',
          utm_content: 'ad1',
          utm_term: 'kw'
        };

        return a.buildCheckoutUrl(offerData, trackingParams).then((url) => {
          expect(url).toContain('tid=U123');           // sempre mapeado
          expect(url).toContain('gclid=G-111');        // heurístico
          expect(url).toContain('utm_source=google');  // heurístico
          expect(url).toContain('utm_medium=cpc');     // heurístico
          expect(url).toContain('utm_campaign=camp');  // heurístico
          expect(url).toContain('utm_content=ad1');    // heurístico
          expect(url).toContain('utm_term=kw');        // heurístico
        });
      });
    });
  });

  // ====== VERIFY WEBHOOK (HMAC + DECIFRAGEM + NORMALIZAÇÃO) ======
  describe('verifyWebhook — HMAC + decifragem + normalização', () => {
    const makeBody = (s) => Buffer.from(s || 'test-body');
    const makeIvB64 = () => Buffer.from('0000000000000000').toString('base64'); // 16 bytes zero
    const secret = process.env.CLICKBANK_WEBHOOK_SECRET_KEY;

    test('Aceita assinatura HEX e retorna payload normalizado (vendor tid_ tem prioridade; trackingCodes extraídos)', async () => {
      // Ajusta payload decryptado
      crypto.__setMockedDecryptedPayload({
        transactionType: 'SALE',
        receipt: 'RCPT123',
        transactionTime: '2025-10-26T00:00:00Z',
        currency: 'USD',
        totalOrderAmount: 49.99,
        vendorVariables: { tid_: 'TID_FROM_VENDOR' },
        trackingCodes: ['gclid_ABC', 'tid_USER_FROM_TC', 'fbclid_XYZ'],
        customer: { billing: { email: 'buyer@example.com' } },
        lineItems: [{ itemNo: 1, accountAmount: 49.99 }],
      });

      const a = new ClickbankAdapter();
      const body = makeBody('hex-ok-body');
      const hexSig = realCrypto.createHmac('sha256', secret).update(body).digest('hex');

      const data = await a.verifyWebhook(body, {
        'x-clickbank-signature': hexSig,
        'x-clickbank-cbsig-iv': makeIvB64(),
      });

      expect(data).not.toBeNull();
      expect(data.platform).toBe('clickbank');
      expect(data.status).toBe('paid');
      expect(data.orderId).toBe('RCPT123');
      expect(data.amount).toBe(49.99);
      // Prioriza vendorVariables.tid_
      expect(data.trackingId || data.userId).toBe('TID_FROM_VENDOR');
      expect(data.gclid).toBe('ABC');
      expect(data.fbclid).toBe('XYZ');
    });

    test('Aceita assinatura BASE64 (mesmos bytes do HEX) e valida com sucesso', async () => {
      const a = new ClickbankAdapter();
      const body = makeBody('b64-ok-body');
      const sigBuf = realCrypto.createHmac('sha256', secret).update(body).digest();
      const b64Sig = sigBuf.toString('base64');

      const out = await a.verifyWebhook(body, {
        'x-clickbank-signature': b64Sig,
        'x-clickbank-cbsig-iv': makeIvB64(),
      });

      expect(out).not.toBeNull();
      expect(out.status).toBe('paid');
    });

    test('Rejeita quando assinatura inválida (tamanho diferente) — timingSafeEqual não é executado', async () => {
      const a = new ClickbankAdapter();
      const body = makeBody('mismatch-size');
      // Assinatura curta (tamanho diferente)
      const shortHex = Buffer.from('aa', 'hex').toString('hex'); // 1 byte

      const out = await a.verifyWebhook(body, {
        'x-clickbank-signature': shortHex,
        'x-clickbank-cbsig-iv': makeIvB64(),
      });

      expect(out).toBeNull();
    });

    test('Retorna null sem IV ou sem assinatura', async () => {
      const a = new ClickbankAdapter();
      const body = makeBody();

      const noSig = await a.verifyWebhook(body, { 'x-clickbank-cbsig-iv': makeIvB64() });
      expect(noSig).toBeNull();

      const noIv = await a.verifyWebhook(body, { 'x-clickbank-signature': 'abc' });
      expect(noIv).toBeNull();
    });

    test('Retorna null com body vazio', async () => {
      const a = new ClickbankAdapter();
      const empty = Buffer.alloc(0);

      const out = await a.verifyWebhook(empty, {
        'x-clickbank-signature': 'abcd',
        'x-clickbank-cbsig-iv': makeIvB64(),
      });

      expect(out).toBeNull();
    });
  });
});