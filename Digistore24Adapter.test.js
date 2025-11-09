/**
 * PZ Advisors - Digistore24 Adapter - Testes
 * Versão do teste: v1.3.1-DR6f (CSV loader flexível + overrides + fallback + webhook)
 * Data: 2025-11-09
 *
 * Cobre:
 * 1) Montagem via product_id e via checkout_url.
 * 2) Afixação de aff (affiliate_id) e precedência do affiliate vindo do tracking quando permitido.
 * 3) Leitura data-driven via ParamMapLoaderCsv em dois formatos:
 *    3.1) Singleton com getInstance().mapTrackingToPlatform()
 *    3.2) Loader com load() que retorna schema { parameters }
 * 4) Offer overrides: parameterAllowlist substitui a base; parameterMap (alias) com prioridade.
 * 5) Fallback hardcoded quando o CSV não traz chaves (ou está ausente/vazio).
 * 6) Sanitização de valores e presença apenas de chaves com valor.
 * 7) Webhook verification com DIGISTORE_AUTH_KEY (ok/erro) e normalização de payload.
 */

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

describe('Digistore24Adapter - ParamMap CSV + Overrides + Fallback', () => {
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

  // =========================
  // 3.1) CSV como singleton
  // =========================
  test('buildCheckoutUrl (CSV singleton): mapeia user_id/gclid/utm_source e seta aff (offerData)', async () => {
    jest.doMock('./ParamMapLoaderCsv', () => {
      const fakePM = {
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
    expect(qp.utm_medium).toBeUndefined();
  });

  // =====================
  // 3.2) CSV via load()
  // =====================
  test('buildCheckoutUrl (CSV load() + schema parameters): respeita allowlist/alias do CSV e precedence do tracking affiliate quando permitido', async () => {
    jest.doMock('./ParamMapLoaderCsv', () => {
      // Simula módulo que exporta { load } (pode ser default ou named).
      return {
        load: async () => ({
          parameters: {
            user_id: { include_in_checkout: true, alias: 'sid1' },
            gclid: { include_in_checkout: true, alias: 'sid2' },
            utm_source: { include_in_checkout: true },
            affiliate: { include_in_checkout: true, alias: 'aff' },
          },
        }),
      };
    });

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = {
      product_id: '568660',
      affiliate_id: 'aff_offer', // deve ser ignorado se tracking trouxer affiliate permitido
    };

    const trackingParams = {
      user_id: 'SUB_200',
      gclid: 'G-200',
      utm_source: 'meta',
      affiliate: 'aff_tracking',
    };

    const url = await adapter.buildCheckoutUrl(offerData, trackingParams);
    const qp = paramsFromUrl(url);

    expect(qp.sid1).toBe('SUB_200');
    expect(qp.sid2).toBe('G-200');
    expect(qp.utm_source).toBe('meta');
    // CSV permite affiliate -> tracking affiliate tem precedência
    expect(qp.aff).toBe('aff_tracking');
  });

  // ==================================
  // Offer overrides (allowlist + map)
  // ==================================
  test('Offer override: parameterAllowlist substitui base; parameterMap aplica alias e bloqueia chaves fora da allowlist', async () => {
    jest.doMock('./ParamMapLoaderCsv', () => {
      const fakePM = {
        mapTrackingToPlatform: (tracking, platform) => {
          if (platform !== 'digistore24') return {};
          // Sem CSV efetivo: devolveremos vazio para forçar uso da allowlist/mapping do offer
          return {};
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
      parameterAllowlist: ['user_id', 'gclid', 'affiliate'],
      parameterMap: { affiliate: 'aff' },
    };

    const trackingParams = {
      user_id: 'SUB_OFFER',
      gclid: 'G-333',
      utm_source: 'google', // deve ser bloqueado por não estar na allowlist do offer
      affiliate: 'pz_override',
    };

    const url = await adapter.buildCheckoutUrl(offerData, trackingParams);
    const qp = paramsFromUrl(url);

    expect(qp.sid1 || qp.user_id).toBeUndefined(); // CSV vazio -> adapter usa fallback/offerMap; user_id deve virar sid1?
    // Nota: como estamos testando o comportamento de override/alias, validamos diretamente as chaves finais esperadas:
    expect(qp.sid1).toBe('SUB_OFFER');
    expect(qp.sid2).toBeUndefined();
    expect(qp.utm_source).toBeUndefined();
    expect(qp.aff).toBe('pz_override');
  });

  // ========================
  // Fallback hardcoded puro
  // ========================
  test('buildCheckoutUrl (CSV vazio/ausente) aplica fallback hardcoded (sid1/sid2/sid3/sid4/cid/campaignkey)', async () => {
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
      utm_source: 'google', // fallback hardcoded não mapeia utms
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
    jest.doMock('./ParamMapLoaderCsv', () => {
      const fakePM = { mapTrackingToPlatform: () => ({ sid1: 'X' }), getInstance: () => fakePM };
      return fakePM;
    });

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = { checkout_url: 'https://exemplo.com/qualquer' }; // domínio inválido DS24
    const url = await adapter.buildCheckoutUrl(offerData, { user_id: 'SUB' });
    expect(url).toBeNull();
  });

  test('buildCheckoutUrl sanitiza valores e ignora vazios', async () => {
    jest.doMock('./ParamMapLoaderCsv', () => {
      const fakePM = {
        mapTrackingToPlatform: (tracking, platform) => {
          if (platform !== 'digistore24') return {};
          return {
            sid1: tracking.user_id ?? '',
            sid2: 'inválido espaço & símbolo!',
            utm_source: '',
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
    expect(qp.sid1).toBe('SUB');
    expect(qp.sid2).toBe('inv_lido_espa_o___s_mbolo_');
    expect(qp.utm_source).toBeUndefined();
  });

  // =============================
  // Webhook verification + norma
  // =============================
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
      expect(out.status).toBe('paid');
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