'use strict';

const { normalizarDecimal, normalizarInt } = require('./normalizadores');

function normalizarTexto(valor) {
  return String(valor || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function deveGerarFinanceiroVenda({ conta_receber, pagamento, status_pagamento, parcelas }) {
  const pagamentoNormalizado = normalizarTexto(pagamento);
  const statusPagamentoNormalizado = normalizarTexto(status_pagamento);

  return (
    Boolean(conta_receber) ||
    pagamentoNormalizado === 'promissoria' ||
    pagamentoNormalizado === 'boleto' ||
    statusPagamentoNormalizado === 'pendente' ||
    normalizarInt(parcelas || 1) > 1
  );
}

const FORMAS_PAGAMENTO_VALIDAS = new Set([
  'dinheiro', 'pix', 'cartao', 'cartao_credito', 'cartao_debito',
  'boleto', 'promissoria', 'transferencia', 'cheque', 'crediario',
  'outros', 'dinheiro_troco'
]);

function sanitizarFormaPagamento(f) {
  const s = String(f || '').trim().toLowerCase();
  return FORMAS_PAGAMENTO_VALIDAS.has(s) ? String(f).trim() : 'Dinheiro';
}

// Normaliza array de pagamentos do split.
// Retorna { pagamentosArray, pagamentoPrincipal, totalPromissoria, statusPagamento }
function normalizarPagamentosSplit({ pagamentos, pagamento, total, status_pagamento, parcelas }) {
  const FORMAS_PENDENTES = ['promissoria', 'boleto'];

  let pagamentosArray;

  if (Array.isArray(pagamentos) && pagamentos.length > 0) {
    pagamentosArray = pagamentos.map((p) => ({
      forma: sanitizarFormaPagamento(p.forma),
      valor: normalizarDecimal(p.valor),
      parcelas: normalizarInt(p.parcelas) || 1,
      vencimento: p.vencimento || null
    }));
  } else {
    pagamentosArray = [{
      forma: sanitizarFormaPagamento(pagamento),
      valor: normalizarDecimal(total),
      parcelas: normalizarInt(parcelas) || 1,
      vencimento: null
    }];
  }

  const pagamentoPrincipal = pagamentosArray[0]?.forma || 'Dinheiro';

  const totalPromissoria = pagamentosArray
    .filter((p) => FORMAS_PENDENTES.includes(normalizarTexto(p.forma)))
    .reduce((acc, p) => acc + p.valor, 0);

  const STATUS_PAGAMENTO_VALIDOS = ['pendente', 'atrasado', 'pago', 'parcial', 'parcial_atrasado'];
  const statusInformado = STATUS_PAGAMENTO_VALIDOS.includes(status_pagamento) ? status_pagamento : 'pago';
  const statusFinal = totalPromissoria > 0 ? 'pendente' : statusInformado;

  return {
    pagamentosArray,
    pagamentoPrincipal,
    totalPromissoria: Number(totalPromissoria.toFixed(2)),
    statusPagamento: statusFinal
  };
}

module.exports = {
  normalizarTexto,
  deveGerarFinanceiroVenda,
  FORMAS_PAGAMENTO_VALIDAS,
  sanitizarFormaPagamento,
  normalizarPagamentosSplit
};
