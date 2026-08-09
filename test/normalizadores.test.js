'use strict';

const {
  normalizarDecimal,
  normalizarDecimalPositivo,
  normalizarInt,
  normalizarDataISO,
  addDias,
  validarItensVenda,
  validarECalcularTotalItens,
} = require('../utils/normalizadores');

describe('normalizarDecimal', () => {
  test('null → null', () => expect(normalizarDecimal(null)).toBeNull());
  test('undefined → null', () => expect(normalizarDecimal(undefined)).toBeNull());
  test('string vazia → null', () => expect(normalizarDecimal('')).toBeNull());
  test('NaN string → null', () => expect(normalizarDecimal('abc')).toBeNull());
  test('Infinity → null', () => expect(normalizarDecimal(Infinity)).toBeNull());
  test('-Infinity → null', () => expect(normalizarDecimal(-Infinity)).toBeNull());

  test('inteiro 0', () => expect(normalizarDecimal(0)).toBe(0));
  test('inteiro positivo', () => expect(normalizarDecimal(42)).toBe(42));
  test('negativo', () => expect(normalizarDecimal(-5.5)).toBe(-5.5));
  test('float positivo', () => expect(normalizarDecimal(3.14)).toBe(3.14));

  // Formato BR: vírgula como separador decimal
  test('string BR "3,14"', () => expect(normalizarDecimal('3,14')).toBe(3.14));
  test('string BR "1.234,56" (milhar + decimal)', () => expect(normalizarDecimal('1.234,56')).toBe(1234.56));
  test('string BR "0,99"', () => expect(normalizarDecimal('0,99')).toBe(0.99));
  test('string BR "-10,5"', () => expect(normalizarDecimal('-10,5')).toBe(-10.5));

  // Strings sem vírgula (o ponto é tratado como milhar e removido)
  test('string "1000"', () => expect(normalizarDecimal('1000')).toBe(1000));
  test('string "0"', () => expect(normalizarDecimal('0')).toBe(0));

  test('string com espaço é tratada via trim', () => expect(normalizarDecimal(' ')).toBeNull());
});

describe('normalizarDecimalPositivo', () => {
  test('null → null', () => expect(normalizarDecimalPositivo(null)).toBeNull());
  test('zero → null', () => expect(normalizarDecimalPositivo(0)).toBeNull());
  test('negativo → null', () => expect(normalizarDecimalPositivo(-1)).toBeNull());
  test('positivo retorna valor', () => expect(normalizarDecimalPositivo(5.5)).toBe(5.5));
  test('string BR positiva', () => expect(normalizarDecimalPositivo('2,50')).toBe(2.5));
});

describe('normalizarInt', () => {
  test('null → null', () => expect(normalizarInt(null)).toBeNull());
  test('undefined → null', () => expect(normalizarInt(undefined)).toBeNull());
  test('string vazia → null', () => expect(normalizarInt('')).toBeNull());
  test('NaN string → null', () => expect(normalizarInt('abc')).toBeNull());

  test('inteiro 5', () => expect(normalizarInt(5)).toBe(5));
  test('inteiro negativo', () => expect(normalizarInt(-3)).toBe(-3));
  test('zero', () => expect(normalizarInt(0)).toBe(0));
  test('string "10"', () => expect(normalizarInt('10')).toBe(10));
  test('float truncado (5.9 → 5)', () => expect(normalizarInt(5.9)).toBe(5));
  test('float string truncado', () => expect(normalizarInt('7.8')).toBe(7));
});

describe('normalizarDataISO', () => {
  test('null → null', () => expect(normalizarDataISO(null)).toBeNull());
  test('undefined → null', () => expect(normalizarDataISO(undefined)).toBeNull());
  test('string vazia → null', () => expect(normalizarDataISO('')).toBeNull());
  test('string inválida → null', () => expect(normalizarDataISO('nao-e-data')).toBeNull());

  test('ISO date passthrough', () => expect(normalizarDataISO('2026-08-09')).toBe('2026-08-09'));
  test('ISO date início ano', () => expect(normalizarDataISO('2026-01-01')).toBe('2026-01-01'));
  test('ISO date fim ano', () => expect(normalizarDataISO('2026-12-31')).toBe('2026-12-31'));

  // Formato BR DD/MM/YYYY → ISO
  test('BR "09/08/2026" → "2026-08-09"', () => expect(normalizarDataISO('09/08/2026')).toBe('2026-08-09'));
  test('BR "01/01/2026" → "2026-01-01"', () => expect(normalizarDataISO('01/01/2026')).toBe('2026-01-01'));
  test('BR "31/12/2025" → "2025-12-31"', () => expect(normalizarDataISO('31/12/2025')).toBe('2025-12-31'));
});

describe('addDias', () => {
  test('null base → null', () => expect(addDias(null, 5)).toBeNull());
  test('undefined base → null', () => expect(addDias(undefined, 5)).toBeNull());
  test('data inválida → null', () => expect(addDias('nao-e-data', 3)).toBeNull());

  test('adiciona 5 dias', () => expect(addDias('2026-08-01', 5)).toBe('2026-08-06'));
  test('adiciona 0 dias', () => expect(addDias('2026-08-09', 0)).toBe('2026-08-09'));
  test('cruza limite de mês', () => expect(addDias('2026-01-29', 3)).toBe('2026-02-01'));
  test('cruza limite de ano', () => expect(addDias('2025-12-30', 3)).toBe('2026-01-02'));
  test('adiciona 30 dias (mês cheio)', () => expect(addDias('2026-07-01', 30)).toBe('2026-07-31'));
});

describe('validarItensVenda', () => {
  test('array vazio → false', () => expect(validarItensVenda([])).toBe(false));
  test('null → false', () => expect(validarItensVenda(null)).toBe(false));
  test('undefined → false', () => expect(validarItensVenda(undefined)).toBe(false));
  test('string → false', () => expect(validarItensVenda('x')).toBe(false));

  test('item válido → true', () =>
    expect(validarItensVenda([{ produto_id: 1, quantidade: 2 }])).toBe(true));
  test('múltiplos itens válidos → true', () =>
    expect(validarItensVenda([
      { produto_id: 1, quantidade: 2 },
      { produto_id: 3, quantidade: 5 },
    ])).toBe(true));

  test('produto_id 0 → false', () =>
    expect(validarItensVenda([{ produto_id: 0, quantidade: 2 }])).toBe(false));
  test('produto_id ausente → false', () =>
    expect(validarItensVenda([{ quantidade: 2 }])).toBe(false));
  test('quantidade 0 → false', () =>
    expect(validarItensVenda([{ produto_id: 1, quantidade: 0 }])).toBe(false));
  test('quantidade negativa → false', () =>
    expect(validarItensVenda([{ produto_id: 1, quantidade: -1 }])).toBe(false));
  test('um item inválido no meio → false', () =>
    expect(validarItensVenda([
      { produto_id: 1, quantidade: 2 },
      { produto_id: 0, quantidade: 5 },
    ])).toBe(false));
});

describe('validarECalcularTotalItens', () => {
  test('array vazio → null', () => expect(validarECalcularTotalItens([])).toBeNull());
  test('null → null', () => expect(validarECalcularTotalItens(null)).toBeNull());

  test('item válido — total correto', () =>
    expect(validarECalcularTotalItens([{ produto_id: 1, quantidade: 2, custo_unitario: 10.5 }]))
      .toBe(21.0));
  test('múltiplos itens — soma correta', () =>
    expect(validarECalcularTotalItens([
      { produto_id: 1, quantidade: 3, custo_unitario: 10 },
      { produto_id: 2, quantidade: 2, custo_unitario: 5.5 },
    ])).toBe(41.0));
  test('custo zero é válido', () =>
    expect(validarECalcularTotalItens([{ produto_id: 1, quantidade: 1, custo_unitario: 0 }]))
      .toBe(0));
  test('custo negativo → null', () =>
    expect(validarECalcularTotalItens([{ produto_id: 1, quantidade: 1, custo_unitario: -1 }]))
      .toBeNull());
  test('usa preco_unitario como fallback', () =>
    expect(validarECalcularTotalItens([{ produto_id: 1, quantidade: 2, preco_unitario: 7 }]))
      .toBe(14));
  test('quantidade inválida → null', () =>
    expect(validarECalcularTotalItens([{ produto_id: 1, quantidade: 0, custo_unitario: 5 }]))
      .toBeNull());
  test('produto_id inválido → null', () =>
    expect(validarECalcularTotalItens([{ produto_id: 0, quantidade: 1, custo_unitario: 5 }]))
      .toBeNull());
});
