// server.integration.test.js (v1.2.2 - Corrige expect no /api/version)

// ==== INÍCIO PATCH: Define Variáveis de Ambiente ANTES de importar './server' ====
process.env.NODE_ENV = 'test'; // Essencial para server.js exportar 'app'
// Chave do .env ou do link S2S
process.env.DIGISTORE_AUTH_KEY = process.env.DIGISTORE_AUTH_KEY || 'ds2s_auth_pz_kyvD7wwnTvWN8AkgxlJnnQ';
// Chave usada nos testes de regressão
process.env.TRACK_OPEN = 'false'; // Estado padrão para a maioria dos testes
process.env.TRACK_TOKEN = 'secret_token'; // Token para testes /api/track
// JSON FALSO da Service Account para permitir que initAdmin() (mockado ou real) passe
// sem falhar por falta de credenciais, permitindo que getDB() funcione.
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: "service_account",
  project_id: "mock-project-id",
  private_key_id: "mock_key_id",
  private_key: "-----BEGIN PRIVATE KEY-----\nMOCK_PRIVATE_KEY\n-----END PRIVATE KEY-----\n",
  client_email: "mock-sa@mock-project-id.iam.gserviceaccount.com",
  client_id: "mock_client_id",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/mock-sa%40mock-project-id.iam.gserviceaccount.com",
  universe_domain: "googleapis.com"
});
// ==== FIM PATCH ====

// 1) Supertest + app exportado
const request = require('supertest');
// Presume que server.js (v5.0.5+) exporta 'app' quando NODE_ENV='test'
const app = require('./server');

// 2) Mock firebase-admin (API mínima compatível - Corrigido duplo check 2)
jest.mock('firebase-admin', () => {
  const mockDb = {
    collection: jest.fn().mockReturnThis(),
    doc: jest.fn().mockReturnThis(),
    // Mock inicial para /api/send-guide (busca user)
    get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ email: 'mock@example.com', name: 'Mock User' }) }),
    set: jest.fn().mockResolvedValue(), // Mock para upsert (seed) e logAffiliateTransaction (novo)
    update: jest.fn().mockResolvedValue(), // Mock para upsert (update) e logAffiliateTransaction (update)
  };
  // Função firestore com propriedade FieldValue anexada
  const firestoreFn = jest.fn(() => mockDb);
  firestoreFn.FieldValue = {
    serverTimestamp: jest.fn(() => new Date().toISOString()), // Simula timestamp
    // PATCH A: Corrigido .elements para ...elements
    arrayUnion: jest.fn((...elements) => ({ _type: 'arrayUnion', elements })), // Simula operador
    increment: jest.fn((value) => ({ _type: 'increment', value })), // Simula operador
  };
  return {
    initializeApp: jest.fn(), // Mock initializeApp
    credential: { cert: jest.fn(() => ({})) }, // Mock credential.cert
    firestore: firestoreFn,                     // Mock admin.firestore() e FieldValue
  };
});

// 3) Mock PlatformAdapterBase (usa sid3 para userId do Digistore - Ajustado Mock Clickbank)
jest.mock('./PlatformAdapterBase', () => ({
  getInstance: jest.fn().mockImplementation((platform) => {
    if (platform === 'digistore24') {
      return {
        buildCheckoutUrl: jest.fn().mockResolvedValue('https://mock.dg.com/checkout'),
        verifyWebhook: jest.fn().mockImplementation(async (q) => (
          // Simula validação de chave e retorna dados normalizados mockados
          q.auth_key === process.env.DIGISTORE_AUTH_KEY
            ? { platform: 'digistore24', transactionId: q.transaction_id || 'dsm_mock', status: 'paid', userId: q.sid3 || null }
            : null // Retorna null se a chave for inválida
        )),
        safeLog: jest.fn((d) => d), // Mock simples
      };
    }
    if (platform === 'clickbank') {
      return {
        buildCheckoutUrl: jest.fn().mockResolvedValue('https://mock.cb.com/checkout'),
        // PATCH: Exige IV para retornar sucesso
        verifyWebhook: jest.fn().mockImplementation(async (_body, headers) => {
          const sig = headers['x-clickbank-signature'] || headers['x-cb-signature'];
          const iv  = headers['x-clickbank-iv'] || headers['x-cb-iv']; // Verifica IV
          // Só retorna dados mockados se assinatura for válida E IV estiver presente
          return (sig === 'valid_mock_signature' && iv)
            ? { platform: 'clickbank', transactionId: 'cbm_mock', status: 'paid', userId: 'cbu_mock' }
            : null;
        }),
        safeLog: jest.fn((d) => d), // Mock simples
      };
    }
    // Lança erro se a plataforma não for mockada
    throw new Error(`Plataforma mock não suportada: ${platform}`);
  }),
}));

// 4) Mock mínimo do marketingAutomator (usado pelo stub no server.js)
jest.mock('./marketingAutomator', () => ({
  addSubscriberToFunnel: jest.fn().mockResolvedValue({ ok: true, message: 'mocked_subscriber_added' }),
}), { virtual: true }); // virtual: true permite mockar mesmo que o arquivo não exista

// 5) Mock Google OAuth (usado pela rota /auth/google)
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: jest.fn().mockResolvedValue({
      getPayload: jest.fn().mockReturnValue({ // Retorna um payload mockado
        sub: 'google_sub_123',
        email: 'test@example.com',
        name: 'Test User Regress',
        picture: 'http://pic.url',
        email_verified: true,
      }),
    }),
  })),
}));

// --- Início da Suíte de Testes ---
describe('API Integração - server.js v5.0.4+', () => {
  let firestoreMocks; // Referência para mocks do Firestore
  let marketingAutomatorMock; // Referência para mock do Marketing Automator

  beforeAll(() => {
    // Variáveis de ambiente já definidas no topo do arquivo
    // Tenta inicializar o Admin SDK (mockado) uma vez
    try { require('firebase-admin').initializeApp(); } catch (e) {}
  });

  beforeEach(() => {
    // Obtém referências aos mocks antes de cada teste
    firestoreMocks = require('firebase-admin').firestore();
    try { marketingAutomatorMock = require('./marketingAutomator'); } catch {}
    // Limpa o histórico de chamadas dos mocks
    jest.clearAllMocks();
  });

  // --- Testes das Rotas ---

  // GET /api/version (Teste Básico de Conectividade)
  describe('GET /api/version', () => {
    test('Deve retornar 200 OK e dados da versão incluindo adapters carregados', async () => {
      const res = await request(app).get('/api/version');
      expect(res.statusCode).toBe(200);
      expect(res.body.version).toMatch(/5\.0\.\d+/); // Verifica se a versão é 5.0.x
      // CORREÇÃO v1.2.2: Chave correta é 'adapters_loaded' no server.js v5.0.5+
      expect(res.body.adapters_loaded).toBe(true);
    });
  });

  // POST /api/checkout
  describe('POST /api/checkout', () => {
    // Dados de teste válidos mínimos
    const dData = { offerData: { affiliate_platform: 'digistore24', offer_name: 'dg-offer' }, trackingParams: { user_id: 'u1' } };
    const cData = { offerData: { affiliate_platform: 'clickbank',   offer_name: 'cb-offer' }, trackingParams: { user_id: 'u1' } };

    test('Deve retornar 200 OK para Digistore24', async () => {
      const res = await request(app).post('/api/checkout').send(dData);
      expect(res.statusCode).toBe(200); expect(res.body.ok).toBe(true); expect(res.body.finalCheckoutUrl).toBe('https://mock.dg.com/checkout');
    });
    test('Deve retornar 200 OK para Clickbank', async () => {
      const res = await request(app).post('/api/checkout').send(cData);
      expect(res.statusCode).toBe(200); expect(res.body.ok).toBe(true); expect(res.body.finalCheckoutUrl).toBe('https://mock.cb.com/checkout');
    });
    test('Deve retornar 400 se faltar offerData', async () => {
      const res = await request(app).post('/api/checkout').send({ trackingParams: dData.trackingParams });
      expect(res.statusCode).toBe(400); expect(res.body.error).toBe('missing_offerData');
    });
     test('Deve retornar 400 se faltar trackingParams', async () => {
         const res = await request(app).post('/api/checkout').send({ offerData: dData.offerData });
         expect(res.statusCode).toBe(400); expect(res.body.error).toBe('missing_trackingParams');
     });
    test('Deve retornar 500 se plataforma inválida', async () => {
      const res = await request(app).post('/api/checkout').send({ offerData: { affiliate_platform: 'invalida' }, trackingParams: dData.trackingParams });
      expect(res.statusCode).toBe(500); expect(res.body.error).toBe('checkout_url_generation_failed');
    });
  });

  // GET /webhook/digistore24
  describe('GET /webhook/digistore24', () => {
    const validAuthKey = process.env.DIGISTORE_AUTH_KEY; // Usa a chave definida no topo
    const invalidAuthKey = 'invalid';

    test('Deve retornar 200 OK com auth_key válido e chamar set/update no Firestore', async () => {
      const res = await request(app).get(`/webhook/digistore24?auth_key=${validAuthKey}&transaction_id=dg_ok_1&sid3=user_ok_1&status=completed`);
      expect(res.statusCode).toBe(200); expect(res.text).toBe('OK');
      // PATCH B: Simplificado - Apenas verifica se Firestore foi chamado
      const called = firestoreMocks.set.mock.calls.length > 0 || firestoreMocks.update.mock.calls.length > 0;
      expect(called).toBe(true);
      // Opcional: Validar conteúdo básico da chamada
      const lastCallArgs = (firestoreMocks.set.mock.calls.at(-1) || firestoreMocks.update.mock.calls.at(-1) || [])[0] || {};
      expect(lastCallArgs).toEqual(expect.objectContaining({ platform: 'digistore24', userId: 'user_ok_1' }));
    });
    test('Deve retornar 400 com auth_key inválido e NÃO chamar Firestore', async () => {
      const res = await request(app).get(`/webhook/digistore24?auth_key=${invalidAuthKey}`);
      expect(res.statusCode).toBe(400); expect(res.text).toBe('Webhook verification failed.');
      expect(firestoreMocks.set).not.toHaveBeenCalled(); expect(firestoreMocks.update).not.toHaveBeenCalled();
    });
  });

  // POST /webhook/clickbank
  describe('POST /webhook/clickbank', () => {
     const validSig = 'valid_mock_signature'; const invalidSig = 'invalid'; const iv = 'iv_header_mock'; const body = Buffer.from('encrypted_mock');

    test('Deve retornar 200 OK com assinatura e IV válidos e chamar Firestore', async () => {
      const res = await request(app).post('/webhook/clickbank').set('X-Clickbank-Signature', validSig).set('X-Clickbank-Iv', iv).set('Content-Type', 'application/octet-stream').send(body);
      expect(res.statusCode).toBe(200); expect(res.text).toBe('OK');
      // PATCH B: Simplificado
      const called = firestoreMocks.set.mock.calls.length > 0 || firestoreMocks.update.mock.calls.length > 0;
      expect(called).toBe(true);
      // Opcional: Validar conteúdo básico
      const lastCallArgs = (firestoreMocks.set.mock.calls.at(-1) || firestoreMocks.update.mock.calls.at(-1) || [])[0] || {};
      expect(lastCallArgs).toEqual(expect.objectContaining({ platform: 'clickbank', transactionId: 'cbm_mock' }));
    });
    test('Deve retornar 400 com assinatura inválida e NÃO chamar Firestore', async () => {
         const res = await request(app).post('/webhook/clickbank').set('X-Clickbank-Signature', invalidSig).set('X-Clickbank-Iv', iv).set('Content-Type', 'application/octet-stream').send(body);
         expect(res.statusCode).toBe(400); expect(res.text).toBe('Webhook verification failed.');
         expect(firestoreMocks.set).not.toHaveBeenCalled(); expect(firestoreMocks.update).not.toHaveBeenCalled();
    });
    // Teste ajustado: O mock do adapter agora exige IV
    test('Deve retornar 400 se faltar header IV e NÃO chamar Firestore', async () => {
         const res = await request(app).post('/webhook/clickbank').set('X-Clickbank-Signature', validSig).set('Content-Type', 'application/octet-stream').send(body); // Sem IV
         expect(res.statusCode).toBe(400); // Espera 400 porque o mock exige IV
         expect(res.text).toBe('Webhook verification failed.');
         expect(firestoreMocks.set).not.toHaveBeenCalled(); expect(firestoreMocks.update).not.toHaveBeenCalled();
    });
     // Teste ajustado: Mensagem esperada corrigida
     test('Deve retornar 400 se corpo for Buffer vazio e NÃO chamar Firestore', async () => {
         const res = await request(app).post('/webhook/clickbank').set('X-Clickbank-Signature', validSig).set('X-Clickbank-Iv', iv).set('Content-Type', 'application/octet-stream').send(Buffer.from(''));
         expect(res.statusCode).toBe(400);
         expect(res.text).toBe('Invalid request body.'); // Mensagem do server.js v5.0.4+
         expect(firestoreMocks.set).not.toHaveBeenCalled(); expect(firestoreMocks.update).not.toHaveBeenCalled();
     });
  });

  // Regressão (Rotas Existentes)
  describe('Regressão', () => {

    test('/auth/google deve retornar 200 OK com credential válido e chamar Firestore', async () => {
      const res = await request(app).post('/auth/google').send({ credential: 'mock_cred' });
      expect(res.statusCode).toBe(200);
      expect(res.body.user_id).toBe('google_sub_123'); // Do mock da google-auth-library
      // Verifica se tentou fazer upsert do user
      expect(firestoreMocks.set).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'google_sub_123' }), { merge: true });
      // Verifica se tentou fazer upsert do evento 'auth_google_success'
      const dailyFactSet = firestoreMocks.set.mock.calls.some(call => call[0].events?.[0]?.event === 'auth_google_success');
      const dailyFactUpdate = firestoreMocks.update.mock.calls.some(call => call[0].events?.elements?.[0]?.event === 'auth_google_success');
      expect(dailyFactSet || dailyFactUpdate).toBe(true);
    });

    test('/api/send-guide deve retornar 200 OK com user_id válido, chamar ConvertKit e Firestore', async () => {
      // Configura mock do Firestore.get para retornar um user válido para este teste
      firestoreMocks.get.mockResolvedValueOnce({ exists: true, data: () => ({ email: 'real@user.com', name: 'Real User Guide' }) });

      const res = await request(app).post('/api/send-guide').send({ user_id: 'google_sub_123', anon_id: 'anon_sg_test' });
      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe('subscriber_added_to_funnel');
      // Verifica chamada ao marketingAutomator (mock ou stub)
      expect(marketingAutomatorMock.addSubscriberToFunnel).toHaveBeenCalledWith(expect.objectContaining({ email: 'real@user.com' }));
      // Verifica chamada ao Firestore para logar evento 'convertkit_subscribe_success'
      const dailyFactSet = firestoreMocks.set.mock.calls.some(call => call[0].events?.[0]?.event === 'convertkit_subscribe_success');
      const dailyFactUpdate = firestoreMocks.update.mock.calls.some(call => call[0].events?.elements?.[0]?.event === 'convertkit_subscribe_success');
      expect(dailyFactSet || dailyFactUpdate).toBe(true);
    });

    test('/api/track deve retornar 403 sem token (quando TRACK_OPEN=false)', async () => {
         // O process.env.TRACK_OPEN já foi definido como 'false' no topo
         const res = await request(app).post('/api/track').send({ event: 'test_track_forbidden' });
         expect(res.statusCode).toBe(403);
         expect(res.body.error).toBe('forbidden');
    });

    test('/api/track deve retornar 200 com token válido (quando TRACK_OPEN=false)', async () => {
         // O process.env.TRACK_TOKEN já foi definido como 'secret_token' no topo
         const res = await request(app).post('/api/track').set('X-Api-Token', 'secret_token').send({ event: 'test_track_ok', payload: { data: 1 } });
         expect(res.statusCode).toBe(200);
         expect(res.body.ok).toBe(true);
         // Verifica se upsertDailyFact foi chamado
         const dailyFactSet = firestoreMocks.set.mock.calls.some(call => call[0].events?.[0]?.event === 'test_track_ok');
         const dailyFactUpdate = firestoreMocks.update.mock.calls.some(call => call[0].events?.elements?.[0]?.event === 'test_track_ok');
         expect(dailyFactSet || dailyFactUpdate).toBe(true);
    });

    // Teste opcional usando jest.isolateModules (mantido da v1.2.0)
    test('/api/track deve retornar 200 sem token (quando TRACK_OPEN=true, app isolado)', async () => {
      const originalTrackOpen = process.env.TRACK_OPEN; // Guarda valor original
      let isolatedApp;
      let isolatedRequest;
      try {
        process.env.TRACK_OPEN = 'true'; // Define para este teste
        jest.isolateModules(() => {
          isolatedApp = require('./server');
        });
        isolatedRequest = require('supertest');

        const res = await isolatedRequest(isolatedApp).post('/api/track').send({ event: 'test_track_open', payload: { data: 2 } });
        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        // Verificar chamadas a mocks dentro de isolateModules é complexo, focamos no resultado
      } finally {
        process.env.TRACK_OPEN = originalTrackOpen; // Restaura valor original
      }
    });

  });
});