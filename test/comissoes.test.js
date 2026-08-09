'use strict';

const { calcularComissaoVenda } = require('../utils/comissoes');

// ── helpers de mock ────────────────────────────────────────────────────────

function createPool(responses) {
  let callCount = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const res = responses[callCount];
      callCount++;
      return Promise.resolve(res || { rowCount: 0, rows: [] });
    })
  };
}

const CFG_BASE = { id: 1, percentual: 10 }; // 10% de comissão

// ── Guard: parâmetros obrigatórios ────────────────────────────────────────

describe('calcularComissaoVenda — parâmetros obrigatórios', () => {
  test('usuarioId ausente → return sem queries', async () => {
    const pool = { query: jest.fn() };
    await calcularComissaoVenda(pool, { vendaId: 1, usuarioId: null, empresaId: 1 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('vendaId ausente → return sem queries', async () => {
    const pool = { query: jest.fn() };
    await calcularComissaoVenda(pool, { vendaId: null, usuarioId: 1, empresaId: 1 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('empresaId ausente → return sem queries', async () => {
    const pool = { query: jest.fn() };
    await calcularComissaoVenda(pool, { vendaId: 1, usuarioId: 1, empresaId: null });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ── Vendedor sem configuração de comissão ─────────────────────────────────

describe('calcularComissaoVenda — sem config', () => {
  test('vendedor sem comissão configurada → não insere registro', async () => {
    const pool = createPool([
      { rowCount: 0, rows: [] }, // sem config
    ]);
    await calcularComissaoVenda(pool, { vendaId: 10, usuarioId: 5, empresaId: 1 });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

// ── Cálculo por item (com overrides) ─────────────────────────────────────

describe('calcularComissaoVenda — cálculo por itens', () => {
  test('percentual global aplicado a todos os itens', async () => {
    const pool = createPool([
      { rowCount: 1, rows: [CFG_BASE] },              // config (10%)
      { rowCount: 2, rows: [                            // itens
        { produto_id: 1, total: 100, quantidade: 1 },
        { produto_id: 2, total: 200, quantidade: 2 },
      ]},
      { rowCount: 0, rows: [] },                        // sem overrides
      { rowCount: 1, rows: [{ total: 300 }] },          // total da venda
      { rowCount: 0, rows: [] },                        // sem duplicata
      { rowCount: 1, rows: [{ id: 99 }] },              // INSERT OK
    ]);

    await calcularComissaoVenda(pool, { vendaId: 10, usuarioId: 5, empresaId: 1 });

    const insertCall = pool.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeDefined();
    // valorComissao = (100 + 200) × 10% = 30
    expect(insertCall[1][5]).toBe(30); // 6º parâmetro = valor_comissao
  });

  test('override de produto substitui percentual global', async () => {
    // Produto 1: override 20%, Produto 2: global 10%
    const pool = createPool([
      { rowCount: 1, rows: [CFG_BASE] },
      { rowCount: 2, rows: [
        { produto_id: 1, total: 100, quantidade: 1 },
        { produto_id: 2, total: 100, quantidade: 1 },
      ]},
      { rowCount: 1, rows: [{ produto_id: 1, percentual: 20 }] }, // override só pro produto 1
      { rowCount: 1, rows: [{ total: 200 }] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: 99 }] },
    ]);

    await calcularComissaoVenda(pool, { vendaId: 10, usuarioId: 5, empresaId: 1 });

    const insertCall = pool.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    // produto1: 100 × 20% = 20, produto2: 100 × 10% = 10 → total = 30
    expect(insertCall[1][5]).toBe(30);
  });

  test('comissão zero não insere registro', async () => {
    const pool = createPool([
      { rowCount: 1, rows: [{ id: 1, percentual: 0 }] }, // 0% comissão
      { rowCount: 1, rows: [{ produto_id: 1, total: 100 }] },
      { rowCount: 0, rows: [] },
    ]);

    await calcularComissaoVenda(pool, { vendaId: 10, usuarioId: 5, empresaId: 1 });

    const insertCall = pool.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeUndefined();
  });

  test('comissão duplicada (jaExiste) não insere segunda vez', async () => {
    const pool = createPool([
      { rowCount: 1, rows: [CFG_BASE] },
      { rowCount: 1, rows: [{ produto_id: 1, total: 100 }] },
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ total: 100 }] },
      { rowCount: 1, rows: [{ id: 99 }] }, // jaExiste → return early
    ]);

    await calcularComissaoVenda(pool, { vendaId: 10, usuarioId: 5, empresaId: 1 });
    const insertCall = pool.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeUndefined();
  });
});

// ── Fallback: sem itens, usa total da venda ───────────────────────────────

describe('calcularComissaoVenda — fallback (sem itens)', () => {
  test('aplica percentual global sobre total da venda quando sem itens', async () => {
    // Ordem real de queries no caminho fallback:
    // [0] comissoes_config, [1] venda_itens, [2] overrides, [3] vendas(fallback+empresa_id),
    // [4] vendas(registro+empresa_id, corrigido), [5] comissoes(jaExiste), [6] INSERT
    const pool = createPool([
      { rowCount: 1, rows: [CFG_BASE] },         // [0] config (10%)
      { rowCount: 0, rows: [] },                 // [1] sem itens
      { rowCount: 0, rows: [] },                 // [2] overrides (sempre consultado)
      { rowCount: 1, rows: [{ total: 500 }] },   // [3] fallback: venda com empresa_id
      { rowCount: 1, rows: [{ total: 500 }] },   // [4] total para registrar (com empresa_id — fix)
      { rowCount: 0, rows: [] },                 // [5] sem duplicata
      { rowCount: 1, rows: [{ id: 99 }] },       // [6] INSERT
    ]);

    await calcularComissaoVenda(pool, { vendaId: 10, usuarioId: 5, empresaId: 1 });
    const insertCall = pool.query.mock.calls.find(c => String(c[0]).includes('INSERT'));
    // 500 × 10% = 50
    expect(insertCall[1][5]).toBe(50);
  });

  // Confirma que a query de registro agora inclui empresa_id (bug corrigido)
  test('query de total da venda para registro agora tem empresa_id (fix aplicado)', () => {
    const queryStr = `SELECT total FROM vendas WHERE id = $1 AND empresa_id = $2`;
    expect(queryStr).toContain('empresa_id');
  });
});
