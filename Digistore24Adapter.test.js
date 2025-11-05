/**
 * PZ Advisors - Digistore24 Adapter - Testes
 * Versão do teste: v1.2.0 (cobre ParamMap CSV + Fallback + legado)
 * Data: 2025-11-05
 *
 * O que validamos:
 * 1) Montagem de URL por product_id e por checkout_url.
 * 2) Afixação de aff (affiliate_id).
 * 3) Leitura data-driven via ParamMapLoaderCsv (mapTrackingToPlatform).
 * 4) Fallback hardcoded quando o CSV não traz chaves (ou está ausente).
 * 5) Sanitização de valores e presença apenas de chaves com valor.
 * 6) Webhook verification com DIGISTORE_AUTH_KEY (ok/erro) e normalização de payload.
 */

const path = require('path');
const originalEnv = { ...process.env };

const buildAdapterFresh = async () => {
  jest.resetModules();
  return require('./Digistore24Adapter');
};

// Helper para ler params da URL
function paramsFromUrl(u) {
  const url = new URL(u);
  const out = {};
  url.searchParams.forEach((v, k) => (out[k] = v));
  return out;
}

describe('Digistore24Adapter - ParamMap CSV + Fallback', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test('buildCheckoutUrl com product_id + ParamMap (CSV presente): mapeia user_id/gclid/utm_source e seta aff', async () => {
    // Mock ParamMapLoaderCsv com dados do CSV (ativos)
    jest.doMock('./ParamMapLoaderCsv', () => {
      const fakePM = {
        // Ex.: CSV mapeia user_id->sid1, gclid->sid2, utm_source->utm_source
        mapTrackingToPlatform: (tracking, platform) => {
          if (platform !== 'digistore24') return {};
          const out = {};
          if (tracking.user_id) out.sid1 = tracking.user_id;
          if (tracking.gclid) out.sid2 = tracking.gclid;
          if (tracking.utm_source) out.utm_source = tracking.utm_source;
          return out;
        },
        getInstance: () => fakePM,
      };
      return fakePM;
    });

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = {
      product_id: '568660',
      affiliate_id: 'pzadvisors',
    };

    const trackingParams = {
      user_id: 'SUB_107',
      gclid: 'GCLID_XXX',
      utm_source: 'google',
      utm_medium: '', // vazio -> não deve ser enviado
    };

    const url = await adapter.buildCheckoutUrl(offerData, trackingParams);
    expect(url).toBeTruthy();
    expect(url.startsWith('https://www.digistore24.com/product/568660?')).toBe(true);

    const qp = paramsFromUrl(url);
    expect(qp.aff).toBe('pzadvisors');
    expect(qp.sid1).toBe('SUB_107');
    expect(qp.sid2).toBe('GCLID_XXX');
    expect(qp.utm_source).toBe('google');
    expect(qp.utm_medium).toBeUndefined(); // não foi enviado por estar vazio
  });

  test('buildCheckoutUrl com checkout_url direto + ParamMap: respeita URL base e adiciona qs', async () => {
    jest.doMock('./ParamMapLoaderCsv', () => {
      const fakePM = {
        mapTrackingToPlatform: (tracking, platform) => {
          if (platform !== 'digistore24') return {};
          const out = {};
          if (tracking.user_id) out.sid1 = tracking.user_id;
          if (tracking.fbclid) out.sid3 = tracking.fbclid;
          if (tracking.campaignkey) out.campaignkey = tracking.campaignkey;
          return out;
        },
        getInstance: () => fakePM,
      };
      return fakePM;
    });

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = {
      checkout_url: 'https://www.digistore24.com/product/568660?prefill=1',
      affiliate_id: 'pzadvisors',
    };

    const trackingParams = {
      user_id: 'SUB_999',
      fbclid: 'FB_TEST',
      campaignkey: 'Q4META2025',
    };

    const url = await adapter.buildCheckoutUrl(offerData, trackingParams);
    expect(url).toBeTruthy();
    expect(url.startsWith('https://www.digistore24.com/product/568660?')).toBe(true);

    const qp = paramsFromUrl(url);
    // mantém prefill=1
    expect(qp.prefill).toBe('1');
    // seta aff
    expect(qp.aff).toBe('pzadvisors');
    // adiciona mapeamentos via CSV
    expect(qp.sid1).toBe('SUB_999');
    expect(qp.sid3).toBe('FB_TEST');
    expect(qp.campaignkey).toBe('Q4META2025');
  });

  test('buildCheckoutUrl (CSV vazio/ausente) aplica fallback hardcoded (sid1/sid2/sid3/sid4/cid/campaignkey)', async () => {
    // Mock ParamMapLoaderCsv retornando {} para forçar fallback
    jest.doMock('./ParamMapLoaderCsv', () => {
      const fakePM = {
        mapTrackingToPlatform: () => ({}),
        getInstance: () => fakePM,
      };
      return fakePM;
    });

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = {
      product_id: '568660',
      affiliate_id: 'pzadvisors',
    };

    const trackingParams = {
      user_id: 'SUB_FALL',
      gclid: 'G_FALL',
      fbclid: 'FB_FALL',
      anon_id: 'ANON_FALL',
      cid: 'CID_FALL',
      campaignkey: 'CK_FALL',
      utm_source: 'google', // no fallback hardcoded não mapeia utms (mantém legado)
    };

    const url = await adapter.buildCheckoutUrl(offerData, trackingParams);
    const qp = paramsFromUrl(url);

    expect(qp.aff).toBe('pzadvisors');
    expect(qp.sid1).toBe('SUB_FALL');
    expect(qp.sid2).toBe('G_FALL');
    expect(qp.sid3).toBe('FB_FALL');
    expect(qp.sid4).toBe('ANON_FALL');
    expect(qp.cid).toBe('CID_FALL');
    expect(qp.campaignkey).toBe('CK_FALL');
    expect(qp.utm_source).toBeUndefined();
  });

  test('buildCheckoutUrl retorna null quando base inválida', async () => {
    // ParamMap presente não importa — base ruim deve falhar antes
    jest.doMock('./ParamMapLoaderCsv', () => {
      const fakePM = {
        mapTrackingToPlatform: () => ({ sid1: 'X' }),
        getInstance: () => fakePM,
      };
      return fakePM;
    });

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = { checkout_url: 'https://exemplo.com/qualquer' }; // domínio inválido para DS24
    const url = await adapter.buildCheckoutUrl(offerData, { user_id: 'SUB' });
    expect(url).toBeNull();
  });

  test('buildCheckoutUrl sanitiza valores e ignora vazios', async () => {
    jest.doMock('./ParamMapLoaderCsv', () => {
      const fakePM = {
        mapTrackingToPlatform: (tracking, platform) => {
          if (platform !== 'digistore24') return {};
          // Força valores "sujos" para testar sanitização
          return {
            sid1: tracking.user_id ?? '',
            sid2: 'inválido espaço & símbolo!',
            utm_source: '', // vazio -> omitido
          };
        },
        getInstance: () => fakePM,
      };
      return fakePM;
    });

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = { product_id: '568660', affiliate_id: 'aff_x' };
    const trackingParams = { user_id: '  SUB  ' };

    const url = await adapter.buildCheckoutUrl(offerData, trackingParams);
    const qp = paramsFromUrl(url);

    expect(qp.aff).toBe('aff_x');
    expect(qp.sid1).toBe('SUB'); // trim aplicado
    // caractere inválido -> substituído por "_"
    expect(qp.sid2).toBe('inv_lido_espa_o___s_mbolo_');
    // utm_source vazio não aparece
    expect(qp.utm_source).toBeUndefined();
  });

  describe('Webhook verification + normalização', () => {
    test('verifyWebhook OK com auth_key válida e normaliza payload', async () => {
      process.env.DIGISTORE_AUTH_KEY = 'SECRET_X';

      const Digistore24Adapter = await buildAdapterFresh();
      const adapter = new Digistore24Adapter();

      const payload = {
        auth_key: 'SECRET_X',
        event: 'completed',
        order_id: 'O123',
        product_id: 'P1',
        amount: '69.00',
        currency: 'USD',
        timestamp: '2025-11-05 12:34:56',
        customer_email: 'user@example.com',
        sid1: 'SUB_123',
        sid2: 'GCLID_ABC',
        sid3: 'FB_ABC',
        sid4: 'ANON_ABC',
        cid: 'CID_ABC',
        campaignkey: 'CK_ABC',
      };

      const out = await adapter.verifyWebhook(payload, {}, 'TRACE-1');
      expect(out).toBeTruthy();
      expect(out.platform).toBe('digistore24');
      expect(out.orderId).toBe('O123');
      expect(out.trackingId).toBe('SUB_123');
      expect(out.sid2).toBe('GCLID_ABC');
      expect(out.campaignkey).toBe('CK_ABC');
      expect(out.status).toBe('paid'); // completed -> paid
      expect(out.trace_id).toBe('TRACE-1');
    });

    test('verifyWebhook retorna null quando auth_key inválida', async () => {
      process.env.DIGISTORE_AUTH_KEY = 'SECRET_X';

      const Digistore24Adapter = await buildAdapterFresh();
      const adapter = new Digistore24Adapter();

      const payload = { auth_key: 'WRONG', event: 'completed', order_id: 'O1' };
      const out = await adapter.verifyWebhook(payload, {}, 'TRACE-2');
      expect(out).toBeNull();
    });

    test('verifyWebhook retorna null quando auth_key ausente', async () => {
      process.env.DIGISTORE_AUTH_KEY = 'SECRET_X';

      const Digistore24Adapter = await buildAdapterFresh();
      const adapter = new Digistore24Adapter();

      const payload = { event: 'completed', order_id: 'O1' };
      const out = await adapter.verifyWebhook(payload, {}, 'TRACE-3');
      expect(out).toBeNull();
    });

    test('verifyWebhook retorna null quando DIGISTORE_AUTH_KEY não está configurada no ambiente', async () => {
      delete process.env.DIGISTORE_AUTH_KEY;

      const Digistore24Adapter = await buildAdapterFresh();
      const adapter = new Digistore24Adapter();

      const payload = { auth_key: 'X', event: 'completed', order_id: 'O1' };
      const out = await adapter.verifyWebhook(payload, {}, 'TRACE-4');
      expect(out).toBeNull();
    });
  });
});