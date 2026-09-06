'use strict';

const { emitirNfe, emitirNfce, consultarNfe, assertAmbienteEmissaoPermitido } = require('../utils/focusnfe');

const TOKEN = 'tok_test';
const REF   = 'nfe_test_001';
const PAYLOAD = { natureza_operacao: 'Venda' };

function mockFetch(impl) { global.fetch = jest.fn(impl); }
function okResponse(data) {
  return Promise.resolve({
    ok: true, status: 200,
    text: () => Promise.resolve(JSON.stringify(data))
  });
}
function errResponse(status, data) {
  return Promise.resolve({
    ok: false, status,
    text: () => Promise.resolve(JSON.stringify(data))
  });
}

afterEach(() => {
  delete global.fetch;
  delete process.env.LF_ERP_FISCAL_PRODUCTION_ENABLED;
  delete process.env.FOCUS_TIMEOUT_MS;
  jest.useRealTimers();
});

// ── assertAmbienteEmissaoPermitido ──────────────────────────────────────────

describe('assertAmbienteEmissaoPermitido', () => {
  test('permite homologação (ambiente=2) sem flag', () => {
    expect(() => assertAmbienteEmissaoPermitido(2)).not.toThrow();
  });

  test('bloqueia produção (ambiente=1) sem flag', () => {
    expect(() => assertAmbienteEmissaoPermitido(1)).toThrow(
      expect.objectContaining({ code: 'FISCAL_PROD_BLOCKED' })
    );
  });

  test('bloqueia produção com flag=false', () => {
    process.env.LF_ERP_FISCAL_PRODUCTION_ENABLED = 'false';
    expect(() => assertAmbienteEmissaoPermitido(1)).toThrow(
      expect.objectContaining({ code: 'FISCAL_PROD_BLOCKED' })
    );
  });

  test('permite produção com flag=true', () => {
    process.env.LF_ERP_FISCAL_PRODUCTION_ENABLED = 'true';
    expect(() => assertAmbienteEmissaoPermitido(1)).not.toThrow();
  });
});

// ── emitirNfe — proteção fiscal ─────────────────────────────────────────────

describe('emitirNfe — proteção de ambiente', () => {
  test('rejeita com FISCAL_PROD_BLOCKED ao tentar emitir em produção sem flag', async () => {
    await expect(emitirNfe(TOKEN, 1, REF, PAYLOAD)).rejects.toMatchObject({
      code: 'FISCAL_PROD_BLOCKED'
    });
  });

  test('emite em homologação (ambiente=2) mesmo sem flag', async () => {
    mockFetch(() => okResponse({ situacao: 'processando_autorizacao' }));
    const r = await emitirNfe(TOKEN, 2, REF, PAYLOAD);
    expect(r.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('emite em produção quando flag=true', async () => {
    process.env.LF_ERP_FISCAL_PRODUCTION_ENABLED = 'true';
    mockFetch(() => okResponse({ situacao: 'autorizado' }));
    const r = await emitirNfe(TOKEN, 1, REF, PAYLOAD);
    expect(r.ok).toBe(true);
  });
});

// ── emitirNfce — proteção fiscal ────────────────────────────────────────────

describe('emitirNfce — proteção de ambiente', () => {
  test('rejeita com FISCAL_PROD_BLOCKED em produção sem flag', async () => {
    await expect(emitirNfce(TOKEN, 1, REF, PAYLOAD)).rejects.toMatchObject({
      code: 'FISCAL_PROD_BLOCKED'
    });
  });

  test('emite em homologação sem flag', async () => {
    mockFetch(() => okResponse({ situacao: 'autorizado' }));
    const r = await emitirNfce(TOKEN, 2, REF, PAYLOAD);
    expect(r.ok).toBe(true);
  });
});

// ── focusFetch — timeout ─────────────────────────────────────────────────────

describe('focusFetch — timeout', () => {
  test('rejeita com FOCUS_TIMEOUT quando fetch não responde antes do prazo', async () => {
    jest.useFakeTimers();

    mockFetch((_url, opts) =>
      new Promise((_res, rej) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          rej(e);
        });
      })
    );

    const p = consultarNfe(TOKEN, 2, REF);
    jest.runAllTimers();

    await expect(p).rejects.toMatchObject({ code: 'FOCUS_TIMEOUT' });
  });

  test('rejeita com FOCUS_NETWORK_ERROR em falha de rede', async () => {
    mockFetch(() => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' })));

    await expect(consultarNfe(TOKEN, 2, REF)).rejects.toMatchObject({
      code: 'FOCUS_NETWORK_ERROR'
    });
  });

  test('retorna ok:false para resposta HTTP não-OK', async () => {
    mockFetch(() => errResponse(422, { erros: [{ codigo: 'nfe-invalida', mensagem: 'Campo obrigatório ausente' }] }));
    const r = await consultarNfe(TOKEN, 2, REF);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
  });

  test('sucesso — resolve com ok:true e data parseados', async () => {
    mockFetch(() => okResponse({ situacao: 'autorizado', chave_nfe: '1234' }));
    const r = await consultarNfe(TOKEN, 2, REF);
    expect(r.ok).toBe(true);
    expect(r.data.chave_nfe).toBe('1234');
  });
});
