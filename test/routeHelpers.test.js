'use strict';

const { erro, ok } = require('../utils/routeHelpers');

function mockRes() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json, _json: json };
}

describe('erro()', () => {
  test('status 400 + mensagem customizada', () => {
    const res = mockRes();
    erro(res, 400, 'Campo inválido');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.status().json).toHaveBeenCalledWith({ sucesso: false, erro: 'Campo inválido' });
  });

  test('status 404 padrão', () => {
    const res = mockRes();
    erro(res, 404, 'Não encontrado');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('status 500 padrão quando não informado', () => {
    const res = mockRes();
    erro(res, undefined, 'Erro interno');
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('status inválido (negativo) cai para 500', () => {
    const res = mockRes();
    erro(res, -1, 'msg');
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('status inválido (600) cai para 500', () => {
    const res = mockRes();
    erro(res, 600, 'msg');
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('status inválido (0) cai para 500', () => {
    const res = mockRes();
    erro(res, 0, 'msg');
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('status 599 (limite superior) é aceito', () => {
    const res = mockRes();
    erro(res, 599, 'msg');
    expect(res.status).toHaveBeenCalledWith(599);
  });

  test('status 100 (limite inferior) é aceito', () => {
    const res = mockRes();
    erro(res, 100, 'msg');
    expect(res.status).toHaveBeenCalledWith(100);
  });

  test('mensagem padrão quando não informada', () => {
    const res = mockRes();
    erro(res, 500);
    expect(res.status().json).toHaveBeenCalledWith({ sucesso: false, erro: 'Erro interno do servidor' });
  });

  test('sempre inclui sucesso: false', () => {
    const res = mockRes();
    erro(res, 422, 'Dados inválidos');
    expect(res.status().json).toHaveBeenCalledWith(expect.objectContaining({ sucesso: false }));
  });

  test('status float (1.5) cai para 500 (não é integer)', () => {
    const res = mockRes();
    erro(res, 1.5, 'msg');
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('status string ("404") cai para 500 (não é integer)', () => {
    const res = mockRes();
    erro(res, '404', 'msg');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('ok()', () => {
  test('status 200 padrão com dados', () => {
    const res = mockRes();
    ok(res, { nome: 'Felipe' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.status().json).toHaveBeenCalledWith({ nome: 'Felipe', sucesso: true });
  });

  test('status 201 para criação', () => {
    const res = mockRes();
    ok(res, { id: 42 }, 201);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.status().json).toHaveBeenCalledWith({ id: 42, sucesso: true });
  });

  test('sem dados retorna só sucesso: true', () => {
    const res = mockRes();
    ok(res);
    expect(res.status().json).toHaveBeenCalledWith({ sucesso: true });
  });

  test('dados mesclam corretamente com sucesso: true', () => {
    const res = mockRes();
    ok(res, { sucesso: false, dados: [1, 2, 3] }); // sucesso:false nos dados é sobrescrito
    expect(res.status().json).toHaveBeenCalledWith({ sucesso: true, dados: [1, 2, 3] });
  });
});
