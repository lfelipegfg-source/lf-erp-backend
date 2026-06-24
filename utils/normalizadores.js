function hoje() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Fortaleza',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function normalizarDecimal(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function normalizarInt(valor) {
  const numero = parseInt(valor, 10);
  return Number.isFinite(numero) ? numero : 0;
}

const _fmtDiasFortaleza = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Fortaleza',
  year: 'numeric', month: '2-digit', day: '2-digit'
});

function addDias(dataBase, dias) {
  const data = new Date(`${dataBase}T12:00:00`);
  data.setDate(data.getDate() + Number(dias || 0));
  return _fmtDiasFortaleza.format(data);
}

const _fmtDataFortaleza = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Fortaleza',
  year: 'numeric', month: '2-digit', day: '2-digit'
});

function normalizarDataISO(valor) {
  if (!valor) return null;

  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) {
    return valor.trim();
  }

  const d = new Date(valor);

  if (Number.isNaN(d.getTime())) return null;

  return _fmtDataFortaleza.format(d);
}

// Valida itens de venda: produto_id e quantidade obrigatórios e positivos
function validarItensVenda(itens) {
  if (!Array.isArray(itens) || itens.length === 0) return false;

  for (const item of itens) {
    const produtoId = Number(item.produto_id);
    const quantidade = normalizarInt(item.quantidade);
    if (!produtoId || quantidade <= 0) return false;
  }

  return true;
}

// Valida itens de compra e retorna o total calculado (null se inválido)
function validarECalcularTotalItens(itens) {
  if (!Array.isArray(itens) || itens.length === 0) return null;

  let total = 0;

  for (const item of itens) {
    const produtoId = Number(item.produto_id);
    const quantidade = normalizarInt(item.quantidade);
    const custoUnitario = normalizarDecimal(
      item.custo_unitario || item.preco_unitario || item.custo
    );

    if (!produtoId || quantidade <= 0 || custoUnitario < 0) return null;

    total = Number((total + Number((quantidade * custoUnitario).toFixed(2))).toFixed(2));
  }

  return total;
}

module.exports = {
  hoje,
  normalizarDecimal,
  normalizarInt,
  addDias,
  normalizarDataISO,
  validarItensVenda,
  validarECalcularTotalItens
};
