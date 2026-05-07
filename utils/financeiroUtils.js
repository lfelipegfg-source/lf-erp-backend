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
    boleto: 'Boleto',
    promissoria: 'Promissória',
    promissória: 'Promissória'
  };

  return mapa[forma] || 'Não informado';
}

module.exports = {
  normalizarFormaPagamentoFluxo
};
