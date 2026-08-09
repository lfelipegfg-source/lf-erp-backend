'use strict';

const {
  calcularEstoqueKit,
  validarEstoqueKit,
} = require('../utils/kits');

// ── helpers de mock ────────────────────────────────────────────────────────

function mockDbWithRows(rows) {
  return { query: jest.fn().mockResolvedValue({ rowCount: rows.length, rows }) };
}

// ── calcularEstoqueKit ─────────────────────────────────────────────────────

describe('calcularEstoqueKit', () => {
  test('sem componentes → 0', async () => {
    const db = mockDbWithRows([]);
    expect(await calcularEstoqueKit(db, 1, 1)).toBe(0);
  });

  test('1 componente, estoque suficiente', async () => {
    const db = mockDbWithRows([{ qtd_por_kit: 2, estoque: 10, nome: 'Comp A' }]);
    // 10 / 2 = 5 kits
    expect(await calcularEstoqueKit(db, 1, 1)).toBe(5);
  });

  test('1 componente, estoque zero → 0 kits', async () => {
    const db = mockDbWithRows([{ qtd_por_kit: 1, estoque: 0, nome: 'Comp A' }]);
    expect(await calcularEstoqueKit(db, 1, 1)).toBe(0);
  });

  test('1 componente, qtd_por_kit zero → 0 (sem divisão por zero)', async () => {
    const db = mockDbWithRows([{ qtd_por_kit: 0, estoque: 100, nome: 'Comp A' }]);
    expect(await calcularEstoqueKit(db, 1, 1)).toBe(0);
  });

  test('múltiplos componentes — retorna o mínimo (gargalo)', async () => {
    const db = mockDbWithRows([
      { qtd_por_kit: 1, estoque: 50, nome: 'Comp A' }, // 50 kits
      { qtd_por_kit: 2, estoque: 12, nome: 'Comp B' }, // 6 kits
      { qtd_por_kit: 3, estoque: 30, nome: 'Comp C' }, // 10 kits
    ]);
    expect(await calcularEstoqueKit(db, 1, 1)).toBe(6); // gargalo = Comp B
  });

  test('componente com estoque decimal — arredondado para baixo', async () => {
    const db = mockDbWithRows([{ qtd_por_kit: 3, estoque: 10, nome: 'Comp A' }]);
    // Math.floor(10 / 3) = 3
    expect(await calcularEstoqueKit(db, 1, 1)).toBe(3);
  });

  test('1 componente, 1 kit exato', async () => {
    const db = mockDbWithRows([{ qtd_por_kit: 5, estoque: 5, nome: 'Comp A' }]);
    expect(await calcularEstoqueKit(db, 1, 1)).toBe(1);
  });

  test('estoque null tratado como 0', async () => {
    const db = mockDbWithRows([{ qtd_por_kit: 1, estoque: null, nome: 'Comp A' }]);
    expect(await calcularEstoqueKit(db, 1, 1)).toBe(0);
  });

  test('qtd_por_kit null tratado como 1', async () => {
    const db = mockDbWithRows([{ qtd_por_kit: null, estoque: 5, nome: 'Comp A' }]);
    // Number(null || 1) = 1 → 5 / 1 = 5
    expect(await calcularEstoqueKit(db, 1, 1)).toBe(5);
  });
});

// ── validarEstoqueKit ──────────────────────────────────────────────────────

describe('validarEstoqueKit', () => {
  test('sem componentes → lança erro claro', async () => {
    const client = mockDbWithRows([]);
    await expect(validarEstoqueKit(client, 1, 1, 1))
      .rejects.toThrow('Kit sem componentes cadastrados');
  });

  test('estoque suficiente para todos os componentes → não lança', async () => {
    const client = mockDbWithRows([
      { qtd_por_kit: 2, estoque: 10, nome: 'Comp A' },
      { qtd_por_kit: 1, estoque: 5, nome: 'Comp B' },
    ]);
    await expect(validarEstoqueKit(client, 1, 1, 3)).resolves.toBeUndefined();
  });

  test('estoque insuficiente no primeiro componente → lança com nome', async () => {
    const client = mockDbWithRows([
      { qtd_por_kit: 5, estoque: 3, nome: 'Parafuso M8' },
    ]);
    await expect(validarEstoqueKit(client, 1, 1, 2))
      .rejects.toThrow('Estoque insuficiente do componente "Parafuso M8"');
  });

  test('estoque insuficiente no segundo componente → lança', async () => {
    const client = mockDbWithRows([
      { qtd_por_kit: 1, estoque: 100, nome: 'Comp A' },
      { qtd_por_kit: 3, estoque: 2, nome: 'Comp Gargalo' }, // precisa 3×2=6, tem 2
    ]);
    await expect(validarEstoqueKit(client, 1, 1, 2))
      .rejects.toThrow('Comp Gargalo');
  });

  test('estoque exato (sem folga) → não lança', async () => {
    const client = mockDbWithRows([
      { qtd_por_kit: 3, estoque: 9, nome: 'Comp A' }, // precisa 3×3=9, tem exatamente 9
    ]);
    await expect(validarEstoqueKit(client, 1, 1, 3)).resolves.toBeUndefined();
  });

  test('qtdKits=0 → sempre passa (0 necessário)', async () => {
    const client = mockDbWithRows([
      { qtd_por_kit: 5, estoque: 1, nome: 'Comp A' }, // 5×0=0 ≤ 1
    ]);
    await expect(validarEstoqueKit(client, 1, 1, 0)).resolves.toBeUndefined();
  });
});
