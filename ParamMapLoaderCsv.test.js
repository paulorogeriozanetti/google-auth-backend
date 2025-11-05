/**
 * ParamMapLoaderCsv.test.js
 * Testes unitários para ParamMapLoaderCsv.js
 *
 * Cobre:
 * - Leitura/parse do CSV considerando apenas status=active
 * - mapParamsForPlatform para Digistore24 e ClickBank
 * - Omissão de parâmetros sem valor no payload
 * - Caching (mesmo caminho de CSV não relê arquivo)
 * - Plataforma desconhecida (falha graciosa)
 * - Limpeza de espaços/colchetes {sidX} nas células
 * - CSV vazio / sem cabeçalho válido
 */

const fs = require('fs');

// Mock do fs antes de carregar o módulo sob teste
jest.mock('fs');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

function buildCsvMinimal() {
  // Cabeçalho completo conforme especificação
  // Campos: pz_id_parameter;pz_name_parameter;category;status;explanation;example;digistore24_id_parameter;clickbank_id_parameter;clickgenius_id_parameter;buygoods_id_parameter;maxweb_id_parameter;nutriprofits_id_parameter;amazon_id_parameter
  return [
    'pz_id_parameter;pz_name_parameter;category;status;explanation;example;digistore24_id_parameter;clickbank_id_parameter;clickgenius_id_parameter;buygoods_id_parameter;maxweb_id_parameter;nutriprofits_id_parameter;amazon_id_parameter',
    // Ativos (tracking principais)
    'campaignkey;Campaign Key;Tracking;active;Identifier for the campaign.;campaignkey=Q4META2025;{campaignkey};{campaign};;;;;',
    'user_id;User ID;Tracking;active;Custom sub-ID.;sid1=adset;{sid1};{aff_sub1};;;;;',
    'gclid;Google Click ID;Tracking;active;GCLID.;sid2=feed;{sid2};{aff_sub2};gclid;;;;',
    'fbclid;Facebook Click ID;Tracking;active;FBCLID.;sid3=creative;{sid3};{fbclid};;;;;',
    'anon_id;Anonimous ID;Tracking;active;Anon.;sid4=variant;{sid4};{aff_sub4};;;;;',
    'dclid;Google Display Click ID;Tracking;active;DCLID.;sid5=retarget;{sid5};{aff_sub5};;;;;',
    'utm_source;UTM Source;Tracking;active;Origin.;utm_source=google;{utm_source};{traffic_source};;;;;',
    'utm_medium;UTM Medium;Tracking;active;Type.;utm_medium=cpc;{utm_medium};{traffic_type};;;;;',
    'utm_campaign;UTM Campaign;Tracking;active;Campaign.;utm_campaign=sale;{utm_campaign};{campaign};;;;;',
    'utm_term;UTM Term;Tracking;active;Keyword.;utm_term=kw;{utm_term};{adgroup};;;;;',
    'utm_content;UTM Content;Tracking;active;Creative.;utm_content=cv;{utm_content};{creative};;;;;',
    'click_timestamp;Click Timestamp;Tracking;active;Ts.;2023-10-02T12:34:20Z;{timestamp};{click_timestamp};;;;;',
    // Inativos (devem ser ignorados)
    'cid;Click ID;Tracking;inactive;Unique click id.;cid=abc;{cid};{click_id};;;;;'
  ].join('\n');
}

describe('ParamMapLoaderCsv', () => {
  test('carrega e parseia CSV, considerando apenas status=active', () => {
    fs.readFileSync.mockImplementation(() => buildCsvMinimal());
    const loader = require('./ParamMapLoaderCsv');

    const map = loader.loadParamMapCsv({ csvPath: '/path/pz_parameter_map.csv' });

    // Deve conter chaves ativas
    expect(map.byPzKey).toHaveProperty('user_id');
    expect(map.byPzKey).toHaveProperty('gclid');
    expect(map.byPzKey).toHaveProperty('utm_source');

    // Não deve conter inativos (cid)
    expect(map.byPzKey).not.toHaveProperty('cid');

    // Plataformas devem ter mapeamentos resolvidos (sem chaves vazias/inativas)
    expect(map.platforms.digistore24.user_id).toBe('sid1');
    expect(map.platforms.clickbank.user_id).toBe('aff_sub1');
  });

  test('mapParamsForPlatform monta objeto de query para Digistore24', () => {
    fs.readFileSync.mockImplementation(() => buildCsvMinimal());
    const loader = require('./ParamMapLoaderCsv');

    loader.loadParamMapCsv({ csvPath: '/path/pz_parameter_map.csv' });

    const payload = {
      user_id: 'SUB_107',
      gclid: 'GCLID_X',
      anon_id: 'anon_ABC',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'teste_final',
      utm_term: 'kw_blue',
      utm_content: 'creative_A',
      click_timestamp: '2025-11-04T19:31:37.533Z',
      // inativo não deveria entrar (mesmo que enviado)
      cid: 'should_be_ignored'
    };

    const out = loader.mapParamsForPlatform('digistore24', payload);
    expect(out).toEqual({
      // sub-ids
      sid1: 'SUB_107',
      sid2: 'GCLID_X',
      sid4: 'anon_ABC',
      // utms
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'teste_final',
      utm_term: 'kw_blue',
      utm_content: 'creative_A',
      // timestamp
      timestamp: '2025-11-04T19:31:37.533Z'
    });
  });

  test('mapParamsForPlatform monta objeto de query para ClickBank', () => {
    fs.readFileSync.mockImplementation(() => buildCsvMinimal());
    const loader = require('./ParamMapLoaderCsv');

    loader.loadParamMapCsv({ csvPath: '/path/pz_parameter_map.csv' });

    const payload = {
      user_id: 'SUB_107',
      gclid: 'GCLID_X',
      anon_id: 'anon_ABC',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'teste_final',
      utm_term: 'kw_blue',
      utm_content: 'creative_A',
      click_timestamp: '2025-11-04T19:31:37.533Z'
    };

    const out = loader.mapParamsForPlatform('clickbank', payload);
    // Segundo o CSV fornecido:
    // user_id -> aff_sub1
    // gclid   -> aff_sub2
    // anon_id -> aff_sub4
    // utm_source   -> traffic_source
    // utm_medium   -> traffic_type
    // utm_campaign -> campaign
    // utm_term     -> adgroup
    // utm_content  -> creative
    // click_timestamp -> click_timestamp
    expect(out).toEqual({
      aff_sub1: 'SUB_107',
      aff_sub2: 'GCLID_X',
      aff_sub4: 'anon_ABC',
      traffic_source: 'google',
      traffic_type: 'cpc',
      campaign: 'teste_final',
      adgroup: 'kw_blue',
      creative: 'creative_A',
      click_timestamp: '2025-11-04T19:31:37.533Z'
    });
  });

  test('parâmetros sem valor no payload são omitidos do resultado', () => {
    fs.readFileSync.mockImplementation(() => buildCsvMinimal());
    const loader = require('./ParamMapLoaderCsv');

    loader.loadParamMapCsv({ csvPath: '/path/pz_parameter_map.csv' });

    const payload = {
      user_id: 'SUB_107',
      gclid: '',               // vazio -> omitido
      anon_id: undefined,      // undefined -> omitido
      utm_source: 'google',
      utm_medium: null,        // null -> omitido
      utm_campaign: 'teste_final'
    };

    const out = loader.mapParamsForPlatform('digistore24', payload);
    expect(out).toEqual({
      sid1: 'SUB_107',
      utm_source: 'google',
      utm_campaign: 'teste_final'
      // sem sid2, sid4, utm_medium
    });
  });

  test('caching: não relê o arquivo na segunda chamada com o mesmo caminho', () => {
    fs.readFileSync.mockImplementation(() => buildCsvMinimal());
    const loader = require('./ParamMapLoaderCsv');

    loader.loadParamMapCsv({ csvPath: '/path/pz_parameter_map.csv' });
    loader.loadParamMapCsv({ csvPath: '/path/pz_parameter_map.csv' }); // mesma rota

    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    // Reset cache interno e tenta de novo (deverá reler)
    if (loader.__resetCache) loader.__resetCache();
    loader.loadParamMapCsv({ csvPath: '/path/pz_parameter_map.csv' });
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  test('mapParamsForPlatform falha graciosamente para plataforma desconhecida', () => {
    fs.readFileSync.mockImplementation(() => buildCsvMinimal());
    const loader = require('./ParamMapLoaderCsv');

    loader.loadParamMapCsv({ csvPath: '/path/pz_parameter_map.csv' });

    const payload = { user_id: 'SUB_107' };
    const out = loader.mapParamsForPlatform('plataforma_inexistente', payload);
    expect(out).toEqual({}); // Sem throw e vazio
  });

  test('loadParamMapCsv lida com espaços/colchetes nas células {sidX}', () => {
    const messyCsv = [
      'pz_id_parameter;pz_name_parameter;category;status;explanation;example;digistore24_id_parameter;clickbank_id_parameter;clickgenius_id_parameter;buygoods_id_parameter;maxweb_id_parameter;nutriprofits_id_parameter;amazon_id_parameter',
      'user_id;User ID;Tracking;active;.;.; {sid1} ; {aff_sub1} ;;;;;',
      'gclid;Google Click ID;Tracking;active;.;.;   {sid2}   ; {aff_sub2} ;;;;;',
      'anon_id;Anon;Tracking;active;.;.;{sid4};{aff_sub4};;;;;'
    ].join('\n');
    fs.readFileSync.mockImplementation(() => messyCsv);
    const loader = require('./ParamMapLoaderCsv');

    const map = loader.loadParamMapCsv({ csvPath: '/path/alt.csv' });

    expect(map.platforms.digistore24.user_id).toBe('sid1');
    expect(map.platforms.clickbank.user_id).toBe('aff_sub1');
    expect(map.platforms.digistore24.gclid).toBe('sid2');
    expect(map.platforms.clickbank.gclid).toBe('aff_sub2');
    expect(map.platforms.digistore24.anon_id).toBe('sid4');
    expect(map.platforms.clickbank.anon_id).toBe('aff_sub4');
  });

  test('quando CSV está vazio ou sem cabeçalho válido, retorna mapas vazios', () => {
    fs.readFileSync.mockImplementation(() => '');
    const loader = require('./ParamMapLoaderCsv');

    const map = loader.loadParamMapCsv({ csvPath: '/path/empty.csv' });

    expect(map.byPzKey).toEqual({});
    expect(map.platforms).toEqual({});
  });
});