'use strict';

// Stub mínimo de env para que o require de permissoes não exija banco
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost/test';

const { requirePermissao, MODULOS_VALIDOS, ACOES_VALIDAS } = require('../utils/permissoes');

describe('MODULOS_VALIDOS', () => {
  const modulosCore = ['produtos', 'clientes', 'fornecedores', 'compras', 'vendas', 'estoque', 'financeiro', 'relatorios'];
  test.each(modulosCore)('contém módulo core: %s', (mod) => {
    expect(MODULOS_VALIDOS.has(mod)).toBe(true);
  });

  test('contém dashboard (fix deploy crash)', () => expect(MODULOS_VALIDOS.has('dashboard')).toBe(true));
  test('contém usuarios', () => expect(MODULOS_VALIDOS.has('usuarios')).toBe(true));
  test('contém configuracoes', () => expect(MODULOS_VALIDOS.has('configuracoes')).toBe(true));
  test('contém caixa', () => expect(MODULOS_VALIDOS.has('caixa')).toBe(true));
  test('contém nfe', () => expect(MODULOS_VALIDOS.has('nfe')).toBe(true));
  test('contém nfse', () => expect(MODULOS_VALIDOS.has('nfse')).toBe(true));
  test('contém fidelidade', () => expect(MODULOS_VALIDOS.has('fidelidade')).toBe(true));
  test('não contém módulo inventado', () => expect(MODULOS_VALIDOS.has('xyz_fake')).toBe(false));
});

describe('ACOES_VALIDAS', () => {
  test('contém ver', () => expect(ACOES_VALIDAS.has('ver')).toBe(true));
  test('contém criar', () => expect(ACOES_VALIDAS.has('criar')).toBe(true));
  test('contém editar', () => expect(ACOES_VALIDAS.has('editar')).toBe(true));
  test('contém deletar', () => expect(ACOES_VALIDAS.has('deletar')).toBe(true));
  test('contém emitir', () => expect(ACOES_VALIDAS.has('emitir')).toBe(true));
  test('não contém ação inventada', () => expect(ACOES_VALIDAS.has('xyz_fake')).toBe(false));
});

describe('requirePermissao — validação estática (startup-time)', () => {
  const mockPool = {};

  test('módulo inválido lança no registro da rota', () => {
    expect(() => requirePermissao(mockPool, 'modulo_inexistente', 'ver'))
      .toThrow('Módulo inválido: modulo_inexistente');
  });

  test('ação inválida lança no registro da rota', () => {
    expect(() => requirePermissao(mockPool, 'produtos', 'acao_inexistente'))
      .toThrow('Ação inválida: acao_inexistente');
  });

  test('não lança para todos os módulos válidos com ação "ver"', () => {
    for (const modulo of MODULOS_VALIDOS) {
      expect(() => requirePermissao(mockPool, modulo, 'ver')).not.toThrow();
    }
  });

  test('não lança para todas as ações válidas com módulo "produtos"', () => {
    for (const acao of ACOES_VALIDAS) {
      expect(() => requirePermissao(mockPool, 'produtos', acao)).not.toThrow();
    }
  });

  test('retorna função (middleware)', () => {
    const mw = requirePermissao(mockPool, 'vendas', 'criar');
    expect(typeof mw).toBe('function');
  });
});

describe('requirePermissao — middleware (runtime)', () => {
  const mockPool = {};

  test('admin passa sem consultar o banco', async () => {
    const mw = requirePermissao(mockPool, 'produtos', 'ver');
    const next = jest.fn();
    await mw({ user: { tipo: 'admin' } }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('saas_owner passa sem consultar o banco', async () => {
    const mw = requirePermissao(mockPool, 'financeiro', 'deletar');
    const next = jest.fn();
    await mw({ user: { tipo: 'gerente', is_saas_owner: true } }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('usuário sem permissão recebe 403', async () => {
    const poolComNegacao = {
      query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ pode_ver: false }] }),
    };
    const mw = requirePermissao(poolComNegacao, 'produtos', 'ver');
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ json }) };
    await mw({ user: { tipo: 'funcionario', id: 1, empresa_id: 1 } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('usuário com permissão individual passa', async () => {
    const poolComPermissao = {
      query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ pode_criar: true }] }),
    };
    const mw = requirePermissao(poolComPermissao, 'produtos', 'criar');
    const next = jest.fn();
    await mw({ user: { tipo: 'funcionario', id: 2, empresa_id: 1 } }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('falha no banco → 500', async () => {
    const poolComErro = {
      query: jest.fn().mockRejectedValue(new Error('Connection timeout')),
    };
    const mw = requirePermissao(poolComErro, 'estoque', 'ver');
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ json }) };
    await mw({ user: { tipo: 'funcionario', id: 3, empresa_id: 1 } }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
