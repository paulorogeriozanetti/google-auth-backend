/**
 * PZ Advisors - Digistore24 Adapter - Testes
 * Versão do teste: v1.4.1-tests-DS7a (alinha com DR6e + fallback com UTMs)
 * Data: 2025-11-10
 *
 * Mandatórios cobertos:
 * - CSV (.load schema) é a "fonte única" quando disponível (data-driven).
 * - Offer override: parameterAllowlist é estrito (substitui base) e parameterMap tem prioridade.
 * - Fallback heurístico (quando CSV ausente) **inclui UTMs** para não perder rastreio.
 * - Precedência de affiliate: tracking affiliate só entra se permitido pela allowlist;
 *   caso contrário prevalece o affiliate_id do offer.
 * - Sanitização e manutenção de parâmetros preexistentes na URL.
 * - Webhook S2S com auth_key + normalização.
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

  test('buildCheckoutUrl (CSV schema via .load): mapeia user_id/gclid/utm_source e seta aff (offerData)', async () => {
    // Mock ParamMapLoaderCsv no formato DR6e (método .load retornando schema.parameters)
    jest.doMock('./ParamMapLoaderCsv', () => ({
      load: async () => ({
        parameters: {
          user_id: { include_in_checkout: 'true', alias: 'sid1' },
          gclid: { include_in_checkout: 'true', alias: 'sid2' },
          utm_source: { include_in_checkout: 'true', alias: 'utm_source' },
          utm_medium: { include_in_checkout: 'false', alias: '' },
        },
      }),
    }));

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = { product_id: '568660', affiliate_id: 'pzadvisors' };

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

  test('buildCheckoutUrl (CSV permite affiliate): tracking affiliate sobrescreve affiliate_id do offer', async () => {
    // CSV autoriza e mapeia affiliate -> aff
    jest.doMock('./ParamMapLoaderCsv', () => ({
      load: async () => ({
        parameters: {
          user_id: { include_in_checkout: 'true', alias: 'sid1' },
          affiliate: { include_in_checkout: 'true', alias: 'aff' },
        },
      }),
    }));

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = {
      product_id: '568660',
      affiliate_id: 'pzadvisors', // deve ser sobrescrito pelo tracking se CSV permitir
    };

    const trackingParams = { user_id: 'SUB_200', affiliate: 'pz_tracking' };

    const url = await adapter.buildCheckoutUrl(offerData, trackingParams);
    const qp = paramsFromUrl(url);

    expect(qp.aff).toBe('pz_tracking'); // tracking vence quando CSV permite
    expect(qp.sid1).toBe('SUB_200');
  });

  test('Offer override: parameterAllowlist substitui base; parameterMap aplica alias e bloqueia chaves fora da allowlist', async () => {
    // Força CSV neutro (para garantir que as regras venham do offer override)
    jest.doMock('./ParamMapLoaderCsv', () => ({
      load: async () => ({ parameters: {} }),
    }));

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = {
      product_id: '568660',
      affiliate_id: 'pzadvisors',
      // NÃO permitir affiliate no override: assim o aff final deve vir do offerData
      parameterAllowlist: ['user_id', 'gclid'],
      parameterMap: { user_id: 'sid1', gclid: 'sid2' },
    };

    const trackingParams = {
      user_id: 'SUB_OFFER',
      gclid: 'G-333',
      utm_source: 'google', // NÃO permitido pela allowlist do offer
      utm_medium: 'cpc',    // idem
      affiliate: 'pz_track_would_be_blocked', // bloqueado pelo allowlist
    };

    const url = await adapter.buildCheckoutUrl(offerData, trackingParams);
    const qp = paramsFromUrl(url);

    // QS final deve conter apenas o que está na allowlist (com alias do offer), aff vem do offerData
    expect(qp.sid1).toBe('SUB_OFFER');
    expect(qp.sid2).toBe('G-333');
    expect(qp.utm_source).toBeUndefined();
    expect(qp.utm_medium).toBeUndefined();
    expect(qp.aff).toBe('pzadvisors');
  });

  test('buildCheckoutUrl (CSV vazio/ausente) aplica fallback hardcoded/heurístico COM UTMs (data-driven resiliente)', async () => {
    // Mock ParamMapLoaderCsv retornando {} para forçar fallback
    jest.doMock('./ParamMapLoaderCsv', () => ({
      load: async () => ({ parameters: {} }),
    }));

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = { product_id: '568660', affiliate_id: 'pzadvisors' };

    const trackingParams = {
      user_id: 'SUB_FALL',
      gclid: 'G_FALL',
      fbclid: 'FB_FALL',
      anon_id: 'ANON_FALL',
      cid: 'CID_FALL',
      campaignkey: 'CK_FALL',
      utm_source: 'google', // Fallback **deve** propagar UTMs (mandatório data-driven)
      utm_medium: 'cpc',
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
    // Agora, por requisito, UTMs TAMBÉM aparecem no fallback
    expect(qp.utm_source).toBe('google');
    expect(qp.utm_medium).toBe('cpc');
  });

  test('buildCheckoutUrl retorna null quando base inválida', async () => {
    // CSV presente não importa — base ruim deve falhar antes
    jest.doMock('./ParamMapLoaderCsv', () => ({
      load: async () => ({ parameters: { user_id: { include_in_checkout: 'true', alias: 'sid1' } } }),
    }));

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = { checkout_url: 'https://exemplo.com/qualquer' }; // domínio inválido para DS24
    const url = await adapter.buildCheckoutUrl(offerData, { user_id: 'SUB' });
    expect(url).toBeNull();
  });

  test('buildCheckoutUrl sanitiza valores e ignora vazios (CSV mapeia gclid->sid2)', async () => {
    jest.doMock('./ParamMapLoaderCsv', () => ({
      load: async () => ({
        parameters: {
          user_id: { include_in_checkout: 'true', alias: 'sid1' },
          gclid: { include_in_checkout: 'true', alias: 'sid2' },
          utm_source: { include_in_checkout: 'false', alias: '' },
        },
      }),
    }));

    const Digistore24Adapter = await buildAdapterFresh();
    const adapter = new Digistore24Adapter();

    const offerData = { product_id: '568660', affiliate_id: 'aff_x' };
    const trackingParams = { user_id: '  SUB  ', gclid: 'inválido espaço & símbolo!', utm_source: '' };

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