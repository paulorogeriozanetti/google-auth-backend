test('CSV vazio retorna plataformas conhecidas com mapas vazios', () => {
  const fs = require('fs');

  // Mock dos métodos do fs para simular um CSV vazio e um mtime qualquer
  const spyStat = jest.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: 123 });
  const spyRead = jest.spyOn(fs, 'readFileSync').mockReturnValue('');

  // Importa após aplicar os mocks
  const loader = require('./ParamMapLoaderCsv');
  const { loadParamMapCsv, __resetCache } = loader;

  try {
    const map = loadParamMapCsv({ csvPath: '/path/empty.csv' });

    // byPzKey deve estar vazio
    expect(map.byPzKey).toEqual({});

    // platforms deve conter as plataformas conhecidas como objetos vazios
    const expectedPlatforms = {
      digistore24: {},
      clickbank: {},
      clickgenius: {},
      buygoods: {},
      maxweb: {},
      nutriprofits: {},
      amazon: {},
    };
    expect(map.platforms).toEqual(expectedPlatforms);

    // garantia extra: todos realmente vazios
    expect(Object.values(map.platforms).every(obj => Object.keys(obj).length === 0)).toBe(true);
  } finally {
    // limpeza
    spyRead.mockRestore();
    spyStat.mockRestore();
    if (typeof __resetCache === 'function') __resetCache();
  }
});