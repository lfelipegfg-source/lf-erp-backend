function hoje() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Fortaleza',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function normalizarDecimal(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'string') {
    // Suporta formato BR "1.234,56": remove pontos de milhar, troca vírgula por ponto
    const limpo = valor.trim().replace(/\./g, '').replace(',', '.');
    if (limpo === '') return null;
    const numero = Number(limpo);
    return Number.isFinite(numero) ? numero : null;
  }
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function normalizarInt(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = parseInt(valor, 10);
  return Number.isFinite(numero) ? numero : null;
}

const _fmtDiasFortaleza = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Fortaleza',
  year: 'numeric', month: '2-digit', day: '2-digit'
});

function addDias(dataBase, dias) {
  if (!dataBase) return null;
  const data = new Date(`${dataBase}T12:00:00`);
  if (isNaN(data.getTime())) return null;
  data.setDate(data.getDate() + Number(dias || 0));
  return _fmtDiasFortaleza.format(data);
}

const _fmtDataFortaleza = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Fortaleza',
  year: 'numeric', month: '2-digit', day: '2-digit'
});

function normalizarDataISO(valor) {
  if (!valor) return null;

  if (typeof valor === 'string') {
    const s = valor.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(s + 'T12:00:00');
      if (isNaN(d.getTime())) return null;
      return s;
    }
    // Suporte a DD/MM/YYYY (formato BR)
    const brMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (brMatch) {
      const iso = `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;
      const d = new Date(iso + 'T12:00:00');
      if (isNaN(d.getTime())) return null;
      return iso;
    }
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
      item.custo_unitario ?? item.preco_unitario ?? item.custo
    );

    if (!produtoId || quantidade <= 0 || custoUnitario < 0) return null;

    total = Number((total + Number((quantidade * custoUnitario).toFixed(2))).toFixed(2));
  }

  return total;
}

// Garante que o valor seja um decimal estritamente positivo.
// Usar em rotas onde o campo não aceita zero ou negativo (preços, quantidades, etc.).
function normalizarDecimalPositivo(valor) {
  const n = normalizarDecimal(valor);
  return (n !== null && n > 0) ? n : null;
}

module.exports = {
  hoje,
  normalizarDecimal,
  normalizarDecimalPositivo,
  normalizarInt,
  addDias,
  normalizarDataISO,
  validarItensVenda,
  validarECalcularTotalItens
};
