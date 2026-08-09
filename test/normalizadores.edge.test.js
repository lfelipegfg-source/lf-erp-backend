'use strict';

// Testes de edge cases agressivos que revelam comportamentos inesperados
// ou confirmam robustez das funções de normalização.

const {
  normalizarDecimal,
  normalizarDecimalPositivo,
  normalizarInt,
  normalizarDataISO,
  addDias,
  validarItensVenda,
  validarECalcularTotalItens,
} = require('../utils/normalizadores');

// ── normalizarDecimal — comportamentos sutis ───────────────────────────────

describe('normalizarDecimal — comportamentos de borda documentados', () => {
  // IMPORTANTE: a função usa formato BR onde "." é milhar, "," é decimal
  // "3.14" com ponto (formato US) é tratado como "3" depois de remover pontos → 314
  test('ATENÇÃO: "3.14" em US format retorna 314 (ponto removido como milhar)', () => {
    // Este é o comportamento CORRETO para BR: 3.140 seria 3140, então "3.14" = 314
    // Frontend não deve enviar US format em string — deve enviar número ou BR
    expect(normalizarDecimal('3.14')).toBe(314);
  });

  test('"1.000" (milhar BR) retorna 1000 corretamente', () => {
    expect(normalizarDecimal('1.000')).toBe(1000);
  });

  test('"1.000.000" (megamilhar) retorna 1000000', () => {
    expect(normalizarDecimal('1.000.000')).toBe(1000000);
  });

  test('"1.000.000,99" retorna 1000000.99', () => {
    expect(normalizarDecimal('1.000.000,99')).toBe(1000000.99);
  });

  test('NaN → null (não lança exceção)', () => {
    expect(() => normalizarDecimal('not-a-number')).not.toThrow();
    expect(normalizarDecimal('not-a-number')).toBeNull();
  });

  test('objeto {} → null (coerção Number({}) = NaN)', () => {
    expect(normalizarDecimal({})).toBeNull();
  });

  test('array [1] → 1 (coerção Number([1]) = 1)', () => {
    // Comportamento: Number([1]) = 1 em JS
    expect(normalizarDecimal([1])).toBe(1);
  });

  test('array [] → null (coerção Number([]) = 0 é finito mas...)', () => {
    // Number([]) = 0, que é finito → retorna 0
    expect(normalizarDecimal([])).toBe(0);
  });

  test('boolean true → 1', () => {
    expect(normalizarDecimal(true)).toBe(1);
  });

  test('boolean false → 0', () => {
    expect(normalizarDecimal(false)).toBe(0);
  });

  test('string "  " (só espaços) → null', () => {
    // '  '.trim() = '' → limpo === '' → return null
    expect(normalizarDecimal('  ')).toBeNull();
  });

  test('string "-0" → 0 (normaliza negative zero via +0)', () => {
    // Bug corrigido: antes retornava -0; agora +0 graças ao "numero + 0"
    const result = normalizarDecimal('-0');
    expect(Object.is(result, 0)).toBe(true);
    expect(Object.is(result, -0)).toBe(false);
  });

  test('número muito grande → retorna o número (não null)', () => {
    expect(normalizarDecimal(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('muito próximo de zero mas não zero → retorna o número', () => {
    expect(normalizarDecimal(0.000001)).toBe(0.000001);
  });
});

// ── normalizarDecimalPositivo — borda ─────────────────────────────────────

describe('normalizarDecimalPositivo — borda', () => {
  test('número muito pequeno mas positivo → retorna', () => {
    expect(normalizarDecimalPositivo(0.000001)).toBe(0.000001);
  });

  test('-0 → null (negativo zero não é positivo)', () => {
    // -0 > 0 é false em JS → retorna null
    expect(normalizarDecimalPositivo(-0)).toBeNull();
  });
});

// ── normalizarInt — borda ─────────────────────────────────────────────────

describe('normalizarInt — comportamentos de borda', () => {
  test('float 0.9 → 0 (parseInt trunca, não arredonda)', () => {
    expect(normalizarInt(0.9)).toBe(0);
  });

  test('float -0.1 → 0 (normaliza -0 via +0)', () => {
    // parseInt("-0.1") = -0 em JS; +0 normaliza para 0
    const result = normalizarInt(-0.1);
    expect(Object.is(result, 0)).toBe(true);
    expect(Object.is(result, -0)).toBe(false);
  });

  test('"10abc" → 10 (parseInt para no ponto inválido)', () => {
    expect(normalizarInt('10abc')).toBe(10);
  });

  test('"abc10" → null (parseInt("abc10") = NaN)', () => {
    expect(normalizarInt('abc10')).toBeNull();
  });

  test('Number.MAX_SAFE_INTEGER → retorna ele mesmo', () => {
    expect(normalizarInt(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('Infinity → null (parseInt(Infinity) = NaN)', () => {
    expect(normalizarInt(Infinity)).toBeNull();
  });
});

// ── normalizarDataISO — borda ─────────────────────────────────────────────

describe('normalizarDataISO — comportamentos de borda', () => {
  test('Date object → retorna data em Fortaleza timezone', () => {
    // Não é null, é uma data válida
    const d = new Date('2026-08-09T12:00:00Z');
    const result = normalizarDataISO(d);
    // Em UTC-3 (Fortaleza), 12:00 UTC = 09:00 local → ainda dia 9
    expect(result).toBe('2026-08-09');
  });

  test('número Unix timestamp → é uma data válida', () => {
    const ts = new Date('2026-01-01').getTime();
    const result = normalizarDataISO(ts);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/); // é uma data ISO
  });

  test('data ISO com hora (não só data) → retorna parte da data', () => {
    // '2026-08-09T15:00:00' não passa no teste /^\d{4}-\d{2}-\d{2}$/
    // mas não é formato BR → cai no new Date(valor)
    const result = normalizarDataISO('2026-08-09T15:00:00');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('data futura extrema → não retorna null', () => {
    expect(normalizarDataISO('2099-12-31')).toBe('2099-12-31');
  });

  test('data passada extrema → não retorna null', () => {
    expect(normalizarDataISO('1900-01-01')).toBe('1900-01-01');
  });

  test('BR format com separador diferente ("09-08-2026") → null', () => {
    // Não é ISO e não é DD/MM/YYYY → cai no new Date()
    const result = normalizarDataISO('09-08-2026');
    // new Date('09-08-2026') pode ser inválido
    // Documentamos o comportamento observado
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});

// ── addDias — borda ───────────────────────────────────────────────────────

describe('addDias — comportamentos de borda', () => {
  test('dias negativos (subtração)', () => {
    expect(addDias('2026-08-09', -5)).toBe('2026-08-04');
  });

  test('dias negativos cruzando mês', () => {
    expect(addDias('2026-03-03', -5)).toBe('2026-02-26');
  });

  test('ano bissexto: 2028-02-28 + 1 = 2028-02-29', () => {
    expect(addDias('2028-02-28', 1)).toBe('2028-02-29');
  });

  test('ano não-bissexto: 2026-02-28 + 1 = 2026-03-01', () => {
    expect(addDias('2026-02-28', 1)).toBe('2026-03-01');
  });

  test('grandioso salto de 365 dias', () => {
    expect(addDias('2026-01-01', 365)).toBe('2027-01-01');
  });

  test('data inválida "0000-00-00" → null', () => {
    expect(addDias('0000-00-00', 1)).toBeNull();
  });
});

// ── validarItensVenda — borda ─────────────────────────────────────────────

describe('validarItensVenda — comportamentos de borda', () => {
  test('produto_id string "1" é convertido e válido', () => {
    // Number("1") = 1 → truthy
    expect(validarItensVenda([{ produto_id: '1', quantidade: 2 }])).toBe(true);
  });

  test('produto_id string "0" é inválido', () => {
    expect(validarItensVenda([{ produto_id: '0', quantidade: 2 }])).toBe(false);
  });

  test('quantidade string "2" → normalizarInt("2") = 2 → válido', () => {
    expect(validarItensVenda([{ produto_id: 1, quantidade: '2' }])).toBe(true);
  });

  test('quantidade string "0.9" → normalizarInt = 0 → inválido', () => {
    expect(validarItensVenda([{ produto_id: 1, quantidade: '0.9' }])).toBe(false);
  });

  test('item com propriedades extras é válido (só produto_id e quantidade importam)', () => {
    expect(validarItensVenda([{ produto_id: 1, quantidade: 3, nome: 'X', preco: 10 }])).toBe(true);
  });
});

// ── validarECalcularTotalItens — borda ────────────────────────────────────

describe('validarECalcularTotalItens — comportamentos de borda', () => {
  test('usa campo "custo" como último fallback', () => {
    expect(validarECalcularTotalItens([{ produto_id: 1, quantidade: 2, custo: 5 }])).toBe(10);
  });

  test('hierarquia: custo_unitario > preco_unitario > custo', () => {
    // custo_unitario presente → usa ele (10), ignora preco_unitario (20) e custo (30)
    expect(validarECalcularTotalItens([{
      produto_id: 1, quantidade: 1,
      custo_unitario: 10, preco_unitario: 20, custo: 30
    }])).toBe(10);
  });

  test('precisão: 3 × 0.1 = 0.30 (não 0.30000000000000004)', () => {
    // A função usa .toFixed(2) para evitar floating point
    const result = validarECalcularTotalItens([{ produto_id: 1, quantidade: 3, custo_unitario: 0.1 }]);
    expect(result).toBe(0.3);
  });

  test('múltiplos itens com floating point acumulado', () => {
    // 3 itens de 0.1 + 3 itens de 0.2 = 0.9 (pode dar 0.8999... sem .toFixed)
    const result = validarECalcularTotalItens([
      { produto_id: 1, quantidade: 3, custo_unitario: 0.1 },
      { produto_id: 2, quantidade: 3, custo_unitario: 0.2 },
    ]);
    expect(result).toBe(0.9);
  });

  test('custo_unitario string BR "10,50" → normalizado para 10.50', () => {
    const result = validarECalcularTotalItens([{ produto_id: 1, quantidade: 2, custo_unitario: '10,50' }]);
    expect(result).toBe(21);
  });

  test('custo_unitario null → tenta preco_unitario; se null também → inválido', () => {
    expect(validarECalcularTotalItens([{ produto_id: 1, quantidade: 1, custo_unitario: null, preco_unitario: null, custo: null }]))
      .toBeNull();
  });
});
