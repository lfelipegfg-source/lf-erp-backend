const { normalizarDataISO } = require('./normalizadores');

// Whitelist de campos permitidos para interpolação segura em SQL
const CAMPOS_PERIODO_PERMITIDOS = new Set([
  'criado_em', 'fl.criado_em', 'm.data_movimentacao',
  'data', 'v.data', 'c.data',
  'data_vencimento', 'cr.data_vencimento', 'cp.data_vencimento',
  'data_pagamento', 'pagamento_data',
  'data_emissao', 'vencimento',
  'COALESCE(pagamento_data, vencimento)',
  'COALESCE(pagamento_data,vencimento)'
]);

function _validarCampoPeriodo(campo) {
  if (!CAMPOS_PERIODO_PERMITIDOS.has(campo)) {
    throw new Error(`Campo de período inválido: ${campo}`);
  }
}

function obterPeriodo(req) {
  return {
    dataInicial: normalizarDataISO(req.query.data_inicial || req.query.inicio || ''),
    dataFinal: normalizarDataISO(req.query.data_final || req.query.fim || '')
  };
}

function adicionarFiltroPeriodo({ campo, params, dataInicial, dataFinal, castDate = true }) {
  _validarCampoPeriodo(campo);
  let sql = '';
  const campoSql = castDate ? `DATE(${campo})` : campo;

  if (dataInicial) {
    params.push(dataInicial);
    sql += ` AND ${campoSql} >= $${params.length}`;
  }

  if (dataFinal) {
    params.push(dataFinal);
    sql += ` AND ${campoSql} <= $${params.length}`;
  }

  return sql;
}

function adicionarFiltroPeriodoRange({
  campoInicial,
  campoFinal,
  params,
  dataInicial,
  dataFinal,
  castDate = true
}) {
  _validarCampoPeriodo(campoInicial);
  _validarCampoPeriodo(campoFinal);
  let sql = '';
  const inicioSql = castDate ? `DATE(${campoInicial})` : campoInicial;
  const fimSql = castDate ? `DATE(${campoFinal})` : campoFinal;

  if (dataInicial) {
    params.push(dataInicial);
    sql += ` AND COALESCE(${fimSql}, ${inicioSql}) >= $${params.length}`;
  }

  if (dataFinal) {
    params.push(dataFinal);
    sql += ` AND COALESCE(${fimSql}, ${inicioSql}) <= $${params.length}`;
  }

  return sql;
}

module.exports = {
  obterPeriodo,
  adicionarFiltroPeriodo,
  adicionarFiltroPeriodoRange
};
