'use strict';
const express = require('express');
const { normalizarDecimal, normalizarDataISO, hoje } = require('../utils/normalizadores');
const { obterPeriodo, adicionarFiltroPeriodo, adicionarFiltroPeriodoRange } = require('../utils/periodoUtils');
const { requirePermissao } = require('../utils/permissoes');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function fluxoCaixaRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  podeGerenciarFinanceiro,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
}) {
  const router = express.Router();
router.post('/investimentos', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const { empresa, tipo_investimento, descricao, valor, data, forma_pagamento, observacao } =
      req.body;

    if (!empresa || !tipo_investimento || !descricao || !data) {
      return jsonErro(res, 400, 'Dados do investimento incompletos');
    }

    const TIPOS_INVESTIMENTO_VALIDOS = [
      'CDB', 'LCI', 'LCA', 'Tesouro Direto', 'Ações', 'FII', 'Poupança', 'Outro'
    ];
    if (!TIPOS_INVESTIMENTO_VALIDOS.includes(tipo_investimento)) {
      return jsonErro(res, 400, 'tipo_investimento inválido');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const valorN = normalizarDecimal(valor);
    if (!valorN || valorN <= 0) return jsonErro(res, 400, 'Valor do investimento deve ser positivo');

    const result = await pool.query(
      `INSERT INTO investimentos
        (empresa, empresa_id, tipo_investimento, descricao, valor, data, forma_pagamento, observacao, criado_por, criado_em, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
        RETURNING *`,
      [
        empresaResolvida.nome,
        empresaResolvida.id,
        tipo_investimento,
        descricao,
        valorN,
        normalizarDataISO(data) || data,
        forma_pagamento || '',
        observacao || '',
        req.user.id
      ]
    );

    res.json({
      sucesso: true,
      item: {
        ...result.rows[0],
        valor: Number(result.rows[0].valor || 0)
      }
    });
  } catch (error) {
    console.error('Erro ao cadastrar investimento:', error);
    jsonErro(res, 500, 'Erro ao cadastrar investimento');
  }
});

router.get('/investimentos/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const tipo = (req.query.tipo_investimento || '').trim();
    const busca = (req.query.busca || '').trim().toLowerCase();
    const { dataInicial, dataFinal } = obterPeriodo(req);

    const params = [];
    let sql = `SELECT * FROM investimentos WHERE 1=1`;
    sql += adicionarFiltroEmpresaSaaS({ params, empresaResolvida });
    let idx = params.length + 1;

    if (tipo) {
      sql += ` AND tipo_investimento = $${idx}`;
      params.push(tipo);
      idx++;
    }

    if (busca) {
      const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
      sql += `
          AND (
            LOWER(COALESCE(descricao, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(tipo_investimento, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(observacao, '')) LIKE $${idx} ESCAPE '\\'
          )
        `;
      params.push(`%${buscaEsc}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'data',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    sql += ` ORDER BY id DESC LIMIT 500`;

    const result = await pool.query(sql, params);

    res.json(
      result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar investimentos:', error);
    jsonErro(res, 500, 'Erro ao buscar investimentos');
  }
});

// GET /financeiro/auditoria — histórico de operações financeiras da empresa
router.get('/financeiro/auditoria', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const { tipo, entidade, busca } = req.query;

    const params = [empresaResolvida.id, empresaResolvida.nome];
    let where = `WHERE (fl.empresa_id = $1 OR (fl.empresa_id IS NULL AND fl.empresa = $2))`;

    if (tipo)    { params.push(tipo);    where += ` AND fl.tipo = $${params.length}`; }
    if (entidade){ params.push(entidade); where += ` AND fl.entidade = $${params.length}`; }
    if (busca)   { const buscaEsc = busca.replace(/[%_\\]/g, '\\$&'); params.push(`%${buscaEsc}%`); where += ` AND fl.descricao ILIKE $${params.length} ESCAPE '\\'`; }

    where += adicionarFiltroPeriodo({ campo: 'fl.criado_em', params, dataInicial, dataFinal });

    const result = await pool.query(
      `SELECT
         fl.id,
         fl.tipo,
         fl.entidade,
         fl.entidade_id,
         fl.descricao,
         fl.valor,
         fl.criado_em,
         COALESCE(u.nome_completo, u.usuario, 'Sistema') AS usuario_nome
       FROM financeiro_logs fl
       LEFT JOIN usuarios u ON u.id = fl.usuario_id
       ${where}
       ORDER BY fl.criado_em DESC
       LIMIT 500`,
      params
    );

    const total = result.rowCount;
    const truncado = total >= 500;

    res.json({ sucesso: true, logs: result.rows, total, truncado });
  } catch (err) {
    console.error('[auditoria financeira]', err.message);
    jsonErro(res, 500, 'Erro ao buscar auditoria financeira');
  }
});

router.get('/financeiro/fluxo-caixa/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[fluxo-caixa-legacy] status-cr:', e.message); }
    try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[fluxo-caixa-legacy] status-cp:', e.message); }

    const { dataInicial, dataFinal } = obterPeriodo(req);

    const paramsReceber = [empresaResolvida.id, empresaResolvida.nome];
    const paramsPagar = [empresaResolvida.id, empresaResolvida.nome];
    const paramsLanc = [empresaResolvida.nome, empresaResolvida.id];
    const paramsInvest = [empresaResolvida.id, empresaResolvida.nome];
    const paramsVendas = [empresaResolvida.id, empresaResolvida.nome];
    const paramsCompras = [empresaResolvida.id, empresaResolvida.nome];

    let whereReceber = `
      WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
    `;

    let wherePagar = `
      WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
    `;

    let whereLanc = `
  WHERE (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $1))
    AND LOWER(COALESCE(status, 'pendente')) = 'pago'
    AND pagamento_data IS NOT NULL
`;

    let whereInvest = `
      WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
    `;

    let whereVendas = `
      WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))
        AND NOT EXISTS (
          SELECT 1 FROM contas_receber cr
          WHERE cr.venda_id = v.id
            AND (cr.empresa_id = v.empresa_id OR (cr.empresa_id IS NULL AND cr.empresa = v.empresa))
        )
    `;

    let whereCompras = `
      WHERE (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))
        AND LOWER(COALESCE(c.status, 'finalizada')) = 'finalizada'
        AND NOT EXISTS (
          SELECT 1
          FROM contas_pagar cp
          WHERE cp.compra_id = c.id
            AND (cp.empresa_id = c.empresa_id OR (cp.empresa_id IS NULL AND cp.empresa = c.empresa))
        )
    `;

    whereReceber += adicionarFiltroPeriodo({
      campo: 'data_pagamento',
      params: paramsReceber,
      dataInicial,
      dataFinal,
      castDate: false
    });

    wherePagar += adicionarFiltroPeriodo({
      campo: 'data_pagamento',
      params: paramsPagar,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereLanc += adicionarFiltroPeriodo({
      campo: 'pagamento_data',
      params: paramsLanc,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereInvest += adicionarFiltroPeriodo({
      campo: 'data',
      params: paramsInvest,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereVendas += adicionarFiltroPeriodo({
      campo: 'v.data',
      params: paramsVendas,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereCompras += adicionarFiltroPeriodo({
      campo: 'c.data',
      params: paramsCompras,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const [
      receitasResult,
      despesasResult,
      lancamentosResult,
      investimentosResult,
      vendasDiretasResult,
      comprasDiretasResult,
      movimentosReceberResult,
      movimentosPagarResult,
      movimentosLancamentosResult,
      movimentosInvestimentosResult,
      movimentosVendasResult,
      movimentosComprasResult
    ] = await Promise.all([
      // 1
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM contas_receber ${whereReceber}`,
        paramsReceber
      ),

      // 2
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM contas_pagar ${wherePagar}`,
        paramsPagar
      ),

      // 3
      pool.query(
        `
    SELECT tipo, COALESCE(SUM(valor), 0) AS total
    FROM lancamentos_financeiros
    ${whereLanc}
    GROUP BY tipo
  `,
        paramsLanc
      ),

      // 4
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM investimentos ${whereInvest}`,
        paramsInvest
      ),

      // 5 🔥 vendas diretas
      pool.query(
        `
    SELECT COALESCE(SUM(v.total), 0) AS total
    FROM vendas v
    ${whereVendas}
  `,
        paramsVendas
      ),

      // 6 🔥 compras diretas (AQUI!)
      pool.query(
        `
    SELECT COALESCE(SUM(c.total), 0) AS total
    FROM compras c
    ${whereCompras}
  `,
        paramsCompras
      ),

      // 7
      pool.query(
        `
    SELECT id, 'conta_receber' AS origem, 'entrada' AS tipo,
    COALESCE(cliente_nome, 'Cliente') AS descricao,
    valor, data_pagamento AS data_movimento,
    venda_id AS referencia_id, observacao
    FROM contas_receber
    ${whereReceber}
  `,
        paramsReceber
      ),

      // 8
      pool.query(
        `
    SELECT id, 'conta_pagar' AS origem, 'saida' AS tipo,
    COALESCE(descricao, fornecedor_nome) AS descricao,
    valor, data_pagamento AS data_movimento,
    compra_id AS referencia_id, observacao
    FROM contas_pagar
    ${wherePagar}
  `,
        paramsPagar
      ),

      // 9
      pool.query(
        `
    SELECT id, 'lancamento_financeiro' AS origem,
    CASE WHEN LOWER(tipo) = 'receita' THEN 'entrada' ELSE 'saida' END AS tipo,
    descricao, valor, pagamento_data AS data_movimento,
    NULL AS referencia_id, NULL AS forma_pagamento, observacao
    FROM lancamentos_financeiros
    ${whereLanc}
  `,
        paramsLanc
      ),

      // 10
      pool.query(
        `
    SELECT id, 'investimento' AS origem, 'saida' AS tipo,
    descricao, valor, data AS data_movimento,
    NULL AS referencia_id, NULL AS forma_pagamento, observacao
    FROM investimentos
    ${whereInvest}
  `,
        paramsInvest
      ),

      // 11 🔥 movimentos vendas
      pool.query(
        `
    SELECT v.id, 'venda_direta' AS origem, 'entrada' AS tipo,
    v.cliente_nome AS descricao,
    v.total AS valor,
    v.data AS data_movimento,
    v.pagamento AS forma_pagamento,
    v.id AS referencia_id,
    NULL AS observacao
    FROM vendas v
    ${whereVendas}
  `,
        paramsVendas
      ),

      // 12 🔥 movimentos compras
      pool.query(
        `
    SELECT c.id, 'compra_direta' AS origem, 'saida' AS tipo,
    COALESCE(f.nome, 'Compra') AS descricao,
    c.total AS valor,
    c.data AS data_movimento,
    c.pagamento AS forma_pagamento,
    c.id AS referencia_id,
    c.observacao
    FROM compras c
    LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
    ${whereCompras}
  `,
        paramsCompras
      )
    ]);

    const totalReceitasRecebidas = Number(receitasResult.rows[0].total || 0);
    const totalDespesasPagas = Number(despesasResult.rows[0].total || 0);
    const totalInvestimentos = Number(investimentosResult.rows[0].total || 0);
    const totalVendasDiretas = Number(vendasDiretasResult.rows[0].total || 0);
    const totalComprasDiretas = Number(comprasDiretasResult?.rows?.[0]?.total || 0);

    const totaisLancamentos = lancamentosResult.rows.reduce(
      (acc, row) => {
        const tipo = String(row.tipo || '').toLowerCase();
        const valor = Number(row.total || 0);

        if (tipo === 'receita') acc.receitas += valor;
        if (tipo === 'despesa') acc.despesas += valor;

        return acc;
      },
      { receitas: 0, despesas: 0 }
    );

    const entradas = Number(
      (totalReceitasRecebidas + totalVendasDiretas + totaisLancamentos.receitas).toFixed(2)
    );

    const saidas = Number(
      (
        totalDespesasPagas +
        totalComprasDiretas +
        totaisLancamentos.despesas +
        totalInvestimentos
      ).toFixed(2)
    );

    const saldo = Number((entradas - saidas).toFixed(2));

    const movimentos = [
      ...movimentosReceberResult.rows,
      ...movimentosPagarResult.rows,
      ...movimentosLancamentosResult.rows,
      ...movimentosInvestimentosResult.rows,
      ...movimentosVendasResult.rows,
      ...movimentosComprasResult.rows
    ]
      .map((item) => ({
        ...item,
        valor: Number(item.valor || 0)
      }))
      .sort((a, b) => {
        const dataA = new Date(`${a.data_movimento || '1970-01-01'}T00:00:00`).getTime();
        const dataB = new Date(`${b.data_movimento || '1970-01-01'}T00:00:00`).getTime();
        return dataB - dataA;
      });

    const resumoFormasPagamento = movimentos.reduce((acc, movimento) => {
      const forma = normalizarFormaPagamentoFluxo(movimento.forma_pagamento);
      const tipo = String(movimento.tipo || '').toLowerCase();
      const valor = Number(movimento.valor || 0);

      if (!acc[forma]) {
        acc[forma] = {
          forma_pagamento: forma,
          entradas: 0,
          saidas: 0,
          saldo: 0
        };
      }

      if (tipo === 'entrada') {
        acc[forma].entradas += valor;
        acc[forma].saldo += valor;
      }

      if (tipo === 'saida') {
        acc[forma].saidas += valor;
        acc[forma].saldo -= valor;
      }

      return acc;
    }, {});

    res.json({
      entradas,
      saidas,
      saldo,
      movimentos,
      resumo_formas_pagamento: Object.values(resumoFormasPagamento).map((item) => ({
        ...item,
        entradas: Number(item.entradas.toFixed(2)),
        saidas: Number(item.saidas.toFixed(2)),
        saldo: Number(item.saldo.toFixed(2))
      }))
    });
  } catch (error) {
    console.error('Erro ao calcular fluxo de caixa:', error);
    jsonErro(res, 500, 'Erro ao calcular fluxo de caixa');
  }
});

// Endpoint de debug removido da produção (expunha schema do banco)


  return router;
};
