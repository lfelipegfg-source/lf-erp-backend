'use strict';

const {
  obterPeriodo,
  adicionarFiltroPeriodo,
  adicionarFiltroPeriodoRange,
} = require('../utils/periodoUtils');

describe('obterPeriodo', () => {
  test('sem parâmetros → datas null', () => {
    const { dataInicial, dataFinal } = obterPeriodo({ query: {} });
    expect(dataInicial).toBeNull();
    expect(dataFinal).toBeNull();
  });

  test('data_inicial + data_final válidos', () => {
    const { dataInicial, dataFinal } = obterPeriodo({
      query: { data_inicial: '2026-01-01', data_final: '2026-12-31' },
    });
    expect(dataInicial).toBe('2026-01-01');
    expect(dataFinal).toBe('2026-12-31');
  });

  test('aliases inicio/fim aceitos', () => {
    const { dataInicial, dataFinal } = obterPeriodo({
      query: { inicio: '2026-03-01', fim: '2026-03-31' },
    });
    expect(dataInicial).toBe('2026-03-01');
    expect(dataFinal).toBe('2026-03-31');
  });

  test('só data_inicial (sem fim) é válido', () => {
    const { dataInicial, dataFinal } = obterPeriodo({
      query: { data_inicial: '2026-06-01' },
    });
    expect(dataInicial).toBe('2026-06-01');
    expect(dataFinal).toBeNull();
  });

  test('datas iguais são válidas', () => {
    const { dataInicial, dataFinal } = obterPeriodo({
      query: { data_inicial: '2026-08-09', data_final: '2026-08-09' },
    });
    expect(dataInicial).toBe('2026-08-09');
    expect(dataFinal).toBe('2026-08-09');
  });

  test('início após fim → lança Período inválido', () => {
    expect(() =>
      obterPeriodo({ query: { data_inicial: '2026-12-31', data_final: '2026-01-01' } })
    ).toThrow('Período inválido');
  });

  test('formato BR "01/01/2026" é aceito via normalizarDataISO', () => {
    const { dataInicial } = obterPeriodo({ query: { data_inicial: '01/01/2026' } });
    expect(dataInicial).toBe('2026-01-01');
  });
});

describe('adicionarFiltroPeriodo', () => {
  test('sem datas → SQL vazio, params inalterados', () => {
    const params = [];
    const sql = adicionarFiltroPeriodo({ campo: 'criado_em', params, dataInicial: null, dataFinal: null });
    expect(sql).toBe('');
    expect(params).toHaveLength(0);
  });

  test('só dataInicial', () => {
    const params = ['empresa1'];
    const sql = adicionarFiltroPeriodo({ campo: 'criado_em', params, dataInicial: '2026-01-01', dataFinal: null });
    expect(sql).toContain('>= $2');
    expect(params[1]).toBe('2026-01-01');
    expect(params).toHaveLength(2);
  });

  test('só dataFinal', () => {
    const params = [];
    const sql = adicionarFiltroPeriodo({ campo: 'data_vencimento', params, dataInicial: null, dataFinal: '2026-12-31' });
    expect(sql).toContain('<= $1');
    expect(params[0]).toBe('2026-12-31');
  });

  test('ambas as datas', () => {
    const params = [];
    const sql = adicionarFiltroPeriodo({
      campo: 'criado_em',
      params,
      dataInicial: '2026-01-01',
      dataFinal: '2026-12-31',
    });
    expect(sql).toContain('>= $1');
    expect(sql).toContain('<= $2');
    expect(params).toEqual(['2026-01-01', '2026-12-31']);
  });

  test('castDate=true envolve o campo em DATE(...)', () => {
    const params = [];
    const sql = adicionarFiltroPeriodo({ campo: 'criado_em', params, dataInicial: '2026-01-01', dataFinal: null, castDate: true });
    expect(sql).toContain('DATE(criado_em)');
  });

  test('castDate=false não envolve em DATE(...)', () => {
    const params = [];
    const sql = adicionarFiltroPeriodo({ campo: 'data_vencimento', params, dataInicial: '2026-01-01', dataFinal: null, castDate: false });
    expect(sql).not.toContain('DATE(');
    expect(sql).toContain('data_vencimento');
  });

  test('campo inválido lança erro (SQL injection guard)', () => {
    const params = [];
    expect(() =>
      adicionarFiltroPeriodo({ campo: 'invalido; DROP TABLE vendas', params, dataInicial: '2026-01-01', dataFinal: null })
    ).toThrow('Campo de período inválido');
  });

  test('campo não-whitelistado lança erro', () => {
    const params = [];
    expect(() =>
      adicionarFiltroPeriodo({ campo: 'email', params, dataInicial: '2026-01-01', dataFinal: null })
    ).toThrow('Campo de período inválido');
  });

  test('preserva params existentes e incrementa índice', () => {
    const params = ['empresa_id_valor', 'outro_valor'];
    const sql = adicionarFiltroPeriodo({
      campo: 'criado_em',
      params,
      dataInicial: '2026-06-01',
      dataFinal: '2026-06-30',
    });
    expect(sql).toContain('>= $3');
    expect(sql).toContain('<= $4');
    expect(params).toHaveLength(4);
  });
});

describe('adicionarFiltroPeriodoRange', () => {
  test('sem datas → SQL vazio', () => {
    const params = [];
    const sql = adicionarFiltroPeriodoRange({
      campoInicial: 'data',
      campoFinal: 'data_vencimento',
      params,
      dataInicial: null,
      dataFinal: null,
    });
    expect(sql).toBe('');
  });

  test('campos inválidos lançam erro', () => {
    const params = [];
    expect(() =>
      adicionarFiltroPeriodoRange({
        campoInicial: 'injected',
        campoFinal: 'data_vencimento',
        params,
        dataInicial: '2026-01-01',
        dataFinal: null,
      })
    ).toThrow('Campo de período inválido');
  });

  test('com ambas as datas gera SQL com COALESCE', () => {
    const params = [];
    const sql = adicionarFiltroPeriodoRange({
      campoInicial: 'data',
      campoFinal: 'data_vencimento',
      params,
      dataInicial: '2026-01-01',
      dataFinal: '2026-12-31',
    });
    expect(sql).toContain('COALESCE');
    expect(params).toEqual(['2026-01-01', '2026-12-31']);
  });
});
