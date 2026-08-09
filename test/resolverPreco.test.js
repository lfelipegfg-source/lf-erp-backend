'use strict';

const { resolverPreco } = require('../utils/resolverPreco');

// ── helpers de mock ────────────────────────────────────────────────────────

function mockPoolSequential(responses) {
  let call = 0;
  return {
    query: jest.fn().mockImplementation(() => Promise.resolve(responses[call++]))
  };
}

function produtoRow(preco, grade_preco = null) {
  return { rowCount: 1, rows: [{ produto_preco: preco, grade_preco }] };
}

function semCliente(preco, grade_preco = null) {
  // resolverPreco retorna precoPadrao diretamente se !clienteId
  return mockPoolSequential([produtoRow(preco, grade_preco)]);
}

// ── Produto não encontrado ─────────────────────────────────────────────────

describe('resolverPreco — produto não encontrado', () => {
  test('retorna null se produto não existe', async () => {
    const pool = mockPoolSequential([{ rowCount: 0, rows: [] }]);
    const result = await resolverPreco({ pool, produtoId: 999, empresaId: 1, quantidade: 1 });
    expect(result).toBeNull();
  });
});

// ── Sem cliente — preço padrão ─────────────────────────────────────────────

describe('resolverPreco — sem cliente', () => {
  test('retorna preço do produto quando não há gradeId nem clienteId', async () => {
    const pool = semCliente(50.0);
    expect(await resolverPreco({ pool, produtoId: 1, empresaId: 1, quantidade: 1 })).toBe(50.0);
  });

  test('preço zero retorna zero', async () => {
    const pool = semCliente(0);
    expect(await resolverPreco({ pool, produtoId: 1, empresaId: 1, quantidade: 1 })).toBe(0);
  });

  test('usa grade_preco quando gradeId fornecido e grade_preco > 0', async () => {
    const pool = semCliente(100, 75.0); // produto=100, grade=75
    expect(await resolverPreco({ pool, produtoId: 1, gradeId: 5, empresaId: 1 })).toBe(75.0);
  });

  test('usa produto_preco quando grade_preco é 0 mesmo com gradeId', async () => {
    const pool = semCliente(100, 0);
    expect(await resolverPreco({ pool, produtoId: 1, gradeId: 5, empresaId: 1 })).toBe(100);
  });

  test('usa produto_preco quando grade_preco é null com gradeId', async () => {
    const pool = semCliente(100, null);
    expect(await resolverPreco({ pool, produtoId: 1, gradeId: 5, empresaId: 1 })).toBe(100);
  });
});

// ── Com cliente — tabela de preços ─────────────────────────────────────────

describe('resolverPreco — com cliente', () => {
  test('retorna preço padrão quando cliente não tem tabela', async () => {
    const pool = mockPoolSequential([
      produtoRow(80),
      { rowCount: 0, rows: [] }, // sem tabela
    ]);
    expect(await resolverPreco({ pool, produtoId: 1, clienteId: 10, empresaId: 1 })).toBe(80);
  });

  test('retorna item_preco fixo da tabela quando disponível', async () => {
    const pool = mockPoolSequential([
      produtoRow(100),
      { rowCount: 1, rows: [{ tipo: 'fixo', desconto_percentual: null, markup_percentual: null, item_preco: 65 }] },
    ]);
    expect(await resolverPreco({ pool, produtoId: 1, clienteId: 10, empresaId: 1 })).toBe(65);
  });

  test('aplica desconto percentual (10%) sobre preço padrão', async () => {
    const pool = mockPoolSequential([
      produtoRow(200),
      { rowCount: 1, rows: [{ tipo: 'percentual', desconto_percentual: 10, markup_percentual: 0, item_preco: null }] },
    ]);
    // 200 × (1 - 0.10) = 180
    expect(await resolverPreco({ pool, produtoId: 1, clienteId: 10, empresaId: 1 })).toBe(180);
  });

  test('aplica markup percentual (20%) sobre preço padrão', async () => {
    const pool = mockPoolSequential([
      produtoRow(100),
      { rowCount: 1, rows: [{ tipo: 'percentual', desconto_percentual: 0, markup_percentual: 20, item_preco: null }] },
    ]);
    // 100 × (1 + 0.20) = 120
    expect(await resolverPreco({ pool, produtoId: 1, clienteId: 10, empresaId: 1 })).toBe(120);
  });

  test('ATENÇÃO: desconto e markup simultâneos — ambos aplicados em série', async () => {
    // desconto=10% depois markup=5%: 100 → 90 → 94.50
    // Comportamento atual: ambos aplicados. Documentar se intencional.
    const pool = mockPoolSequential([
      produtoRow(100),
      { rowCount: 1, rows: [{ tipo: 'percentual', desconto_percentual: 10, markup_percentual: 5, item_preco: null }] },
    ]);
    const result = await resolverPreco({ pool, produtoId: 1, clienteId: 10, empresaId: 1 });
    expect(result).toBe(94.5); // 100 × 0.90 × 1.05
  });

  test('desconto 100% → preço 0 (não negativo)', async () => {
    const pool = mockPoolSequential([
      produtoRow(100),
      { rowCount: 1, rows: [{ tipo: 'percentual', desconto_percentual: 100, markup_percentual: 0, item_preco: null }] },
    ]);
    expect(await resolverPreco({ pool, produtoId: 1, clienteId: 10, empresaId: 1 })).toBe(0);
  });

  test('desconto > 100% → Math.max(0, preco) garante que não vai negativo', async () => {
    const pool = mockPoolSequential([
      produtoRow(100),
      { rowCount: 1, rows: [{ tipo: 'percentual', desconto_percentual: 150, markup_percentual: 0, item_preco: null }] },
    ]);
    const result = await resolverPreco({ pool, produtoId: 1, clienteId: 10, empresaId: 1 });
    // 100 × (1 - 1.50) = -50 → Math.max(0, -50) = 0
    expect(result).toBe(0);
  });

  test('tabela tipo não-percentual sem item_preco → retorna preço padrão', async () => {
    const pool = mockPoolSequential([
      produtoRow(50),
      { rowCount: 1, rows: [{ tipo: 'outro', desconto_percentual: null, markup_percentual: null, item_preco: null }] },
    ]);
    expect(await resolverPreco({ pool, produtoId: 1, clienteId: 10, empresaId: 1 })).toBe(50);
  });

  test('item_preco zero é preço válido (≠ null)', async () => {
    const pool = mockPoolSequential([
      produtoRow(100),
      { rowCount: 1, rows: [{ tipo: 'fixo', desconto_percentual: null, markup_percentual: null, item_preco: 0 }] },
    ]);
    // item_preco é 0 — considerado presente (não null) → retorna 0
    // ATENÇÃO: isso pode ser um problema — item_preco=0 significa produto grátis na tabela?
    expect(await resolverPreco({ pool, produtoId: 1, clienteId: 10, empresaId: 1 })).toBe(0);
  });
});
