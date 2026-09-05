function normalizarFormaPagamentoFluxo(value) {
  const forma = String(value || '')
    .trim()
    .toLowerCase();

  const mapa = {
    dinheiro: 'Dinheiro',
    pix: 'Pix',
    cartão: 'Cartão',
    cartao: 'Cartão',
    credito: 'Cartão',
    crédito: 'Cartão',
    debito: 'Cartão',
    débito: 'Cartão',
    cartao_credito: 'Cartão',
    cartao_debito: 'Cartão',
    boleto: 'Boleto',
    promissoria: 'Promissória',
    promissória: 'Promissória',
    transferencia: 'Transferência',
    transferência: 'Transferência',
    ted: 'Transferência',
    doc: 'Transferência',
    cheque: 'Cheque',
    crediario: 'Crediário',
    crediário: 'Crediário'
  };

  return mapa[forma] || 'Não informado';
}

module.exports = {
  normalizarFormaPagamentoFluxo
};
