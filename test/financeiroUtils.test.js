'use strict';

const { normalizarFormaPagamentoFluxo } = require('../utils/financeiroUtils');

describe('normalizarFormaPagamentoFluxo', () => {
  // Valores canônicos
  test('dinheiro', () => expect(normalizarFormaPagamentoFluxo('dinheiro')).toBe('Dinheiro'));
  test('pix minúsculo', () => expect(normalizarFormaPagamentoFluxo('pix')).toBe('Pix'));
  test('PIX maiúsculo (normaliza via toLowerCase)', () => expect(normalizarFormaPagamentoFluxo('PIX')).toBe('Pix'));
  test('boleto', () => expect(normalizarFormaPagamentoFluxo('boleto')).toBe('Boleto'));
  test('promissoria', () => expect(normalizarFormaPagamentoFluxo('promissoria')).toBe('Promissória'));
  test('promissória com acento', () => expect(normalizarFormaPagamentoFluxo('promissória')).toBe('Promissória'));

  // Cartão e variantes
  test('cartão com acento', () => expect(normalizarFormaPagamentoFluxo('cartão')).toBe('Cartão'));
  test('cartao sem acento', () => expect(normalizarFormaPagamentoFluxo('cartao')).toBe('Cartão'));
  test('credito → Cartão', () => expect(normalizarFormaPagamentoFluxo('credito')).toBe('Cartão'));
  test('crédito com acento → Cartão', () => expect(normalizarFormaPagamentoFluxo('crédito')).toBe('Cartão'));
  test('debito → Cartão', () => expect(normalizarFormaPagamentoFluxo('debito')).toBe('Cartão'));
  test('débito com acento → Cartão', () => expect(normalizarFormaPagamentoFluxo('débito')).toBe('Cartão'));

  // Desconhecido / ausente
  test('null → "Não informado"', () => expect(normalizarFormaPagamentoFluxo(null)).toBe('Não informado'));
  test('undefined → "Não informado"', () => expect(normalizarFormaPagamentoFluxo(undefined)).toBe('Não informado'));
  test('string vazia → "Não informado"', () => expect(normalizarFormaPagamentoFluxo('')).toBe('Não informado'));
  test('cheque → "Cheque"', () => expect(normalizarFormaPagamentoFluxo('cheque')).toBe('Cheque'));

  // Trim
  test('trim de espaços', () => expect(normalizarFormaPagamentoFluxo('  pix  ')).toBe('Pix'));
  test('trim + case', () => expect(normalizarFormaPagamentoFluxo('  DINHEIRO  ')).toBe('Dinheiro'));
});
