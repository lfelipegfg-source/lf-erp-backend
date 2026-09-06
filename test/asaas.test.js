'use strict';

// Mock de https antes de importar o módulo
jest.mock('https', () => ({ request: jest.fn() }));

const https = require('https');
const { criarBoleto } = require('../utils/asaas');

const EventEmitter = require('events');
const API_KEY = 'aas_test_key';

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('asaasRequest — timeout', () => {
  test('rejeita quando req.destroy é chamado (simula timeout por req.setTimeout)', async () => {
    // Simula o ciclo de vida real: request criado, destroy chamado externamente (p.ex. pelo timer)
    const req = new EventEmitter();
    req.write   = jest.fn();
    req.end     = jest.fn();
    // destroy rejeita via 'error' — mesmo comportamento que o timer interno provocaria
    req.destroy = jest.fn((err) => setImmediate(() => req.emit('error', err || new Error('destroyed'))));

    https.request.mockReturnValueOnce(req);

    const p = criarBoleto(API_KEY, true, {
      customerId: 'cus_x', valor: 50, vencimento: '2099-01-01',
      descricao: 'Teste timeout', externalReference: 'ref-to'
    });

    // Simula o timer interno acionando destroy (sem depender do temporizador real)
    req.destroy(new Error('Asaas: timeout após 30000ms'));

    await expect(p).rejects.toThrow(/timeout/i);
  });
});

describe('asaasRequest — erro de rede', () => {
  test('rejeita com erro de conexão recusada', async () => {
    const req = new EventEmitter();
    req.write   = jest.fn();
    req.end     = jest.fn(() => setImmediate(() => req.emit('error', new Error('connect ECONNREFUSED'))));
    req.destroy = jest.fn();
    https.request.mockReturnValueOnce(req);

    await expect(criarBoleto(API_KEY, true, {
      customerId: 'cus_x', valor: 50, vencimento: '2099-01-01',
      descricao: 'Erro rede', externalReference: 'ref-net'
    })).rejects.toThrow('ECONNREFUSED');
  });
});

describe('criarBoleto — modo demo', () => {
  test('retorna demo:true quando apiKey é nula', async () => {
    const r = await criarBoleto(null, true, {
      customerId: null, valor: 10, vencimento: '2099-01-01',
      descricao: 'Demo', externalReference: 'ref-demo'
    });
    expect(r.demo).toBe(true);
    expect(r.id).toMatch(/^DEMO_/);
    expect(https.request).not.toHaveBeenCalled();
  });
});
