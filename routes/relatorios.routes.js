const express = require('express');
const router = express.Router();

const {
  obterPeriodo,
  adicionarFiltroPeriodo,
  adicionarFiltroPeriodoRange
} = require('../utils/periodoUtils');

const { requirePermissao } = require('../utils/permissoes');

module.exports = function ({
  auth,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
  podeGerenciarFinanceiro
}) {
  function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
    return res.status(status).json({
      sucesso: false,
      erro: mensagem
    });
  }

  function checkFinanceiro(req, res) {
    if (typeof podeGerenciarFinanceiro === 'function' && !podeGerenciarFinanceiro(req)) {
      erro(res, 403, 'Acesso restrito a administradores e gerentes');
      return false;
    }
    return true;
  }

  router.get('/financeiro/resumo/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cr:', e.message); }
      try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cp:', e.message); }

      const { dataInicial, dataFinal } = obterPeriodo(req);

      const paramsReceber = [];
      const paramsPagar = [];
      const paramsLanc = [];
      const paramsFluxoReceber = [];
      const paramsFluxoPagar = [];
      const paramsInvest = [];
      const paramsVendas = [];
      const paramsCompras = [];

      let whereReceber = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsReceber,
    empresaResolvida
  })}
`;

      let wherePagar = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsPagar,
    empresaResolvida
  })}
`;

      let whereLanc = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsLanc,
    empresaResolvida
  })}
`;

      let whereFluxoReceber = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsFluxoReceber,
    empresaResolvida
  })}
  AND LOWER(COALESCE(status, 'pendente')) = 'pago'
`;

      let whereFluxoPagar = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsFluxoPagar,
    empresaResolvida
  })}
  AND LOWER(COALESCE(status, 'pendente')) = 'pago'
`;

      let whereInvest = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: paramsInvest,
    empresaResolvida
  })}
`;
      let whereVendas = `
  WHERE 1=1
    ${adicionarFiltroEmpresaSaaS({
      alias: 'v',
      params: paramsVendas,
      empresaResolvida
    })}
    AND NOT EXISTS (
      SELECT 1
      FROM contas_receber cr
      WHERE cr.venda_id = v.id
        AND (
          cr.empresa_id = v.empresa_id
          OR (
            cr.empresa_id IS NULL
            AND cr.empresa = v.empresa
          )
        )
    )
`;

      let whereCompras = `
  WHERE 1=1
    ${adicionarFiltroEmpresaSaaS({
      alias: 'c',
      params: paramsCompras,
      empresaResolvida
    })}
    AND LOWER(COALESCE(c.status, 'finalizada')) = 'finalizada'
    AND NOT EXISTS (
      SELECT 1
      FROM contas_pagar cp
      WHERE cp.compra_id = c.id
        AND (
          cp.empresa_id = c.empresa_id
          OR (
            cp.empresa_id IS NULL
            AND cp.empresa = c.empresa
          )
        )
    )
`;

      whereReceber += adicionarFiltroPeriodo({
        campo: 'data_vencimento',
        params: paramsReceber,
        dataInicial,
        dataFinal,
        castDate: false
      });
      wherePagar += adicionarFiltroPeriodo({
        campo: 'data_vencimento',
        params: paramsPagar,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereLanc += adicionarFiltroPeriodoRange({
        campoInicial: 'vencimento',
        campoFinal: 'pagamento_data',
        params: paramsLanc,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereFluxoReceber += adicionarFiltroPeriodo({
        campo: 'data_pagamento',
        params: paramsFluxoReceber,
        dataInicial,
        dataFinal,
        castDate: false
      });
      whereFluxoPagar += adicionarFiltroPeriodo({
        campo: 'data_pagamento',
        params: paramsFluxoPagar,
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
        receberResult,
        pagarResult,
        lancResult,
        fluxoReceberResult,
        fluxoPagarResult,
        investimentosResult,
        vendasDiretasResult,
        comprasDiretasResult
      ] = await Promise.all([
        pool.query(
          `
          SELECT
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN valor ELSE 0 END),0) AS pago,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) IN ('pendente','parcial') THEN COALESCE(valor_atualizado, valor) ELSE 0 END),0) AS pendente,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) IN ('atrasado','parcial_atrasado') THEN COALESCE(valor_atualizado, valor) ELSE 0 END),0) AS atrasado
          FROM contas_receber
          ${whereReceber}
        `,
          paramsReceber
        ),

        pool.query(
          `
          SELECT
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN valor ELSE 0 END),0) AS pago,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) IN ('pendente','parcial') THEN valor ELSE 0 END),0) AS pendente,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) IN ('atrasado','parcial_atrasado') THEN valor ELSE 0 END),0) AS atrasado
          FROM contas_pagar
          ${wherePagar}
        `,
          paramsPagar
        ),

        pool.query(
          `
          SELECT
            COALESCE(SUM(CASE WHEN LOWER(tipo) = 'receita' THEN valor ELSE 0 END),0) AS receitas,
            COALESCE(SUM(CASE WHEN LOWER(tipo) = 'despesa' THEN valor ELSE 0 END),0) AS despesas,
            COALESCE(SUM(CASE WHEN LOWER(tipo) = 'receita' AND LOWER(COALESCE(status, 'pendente')) = 'pago' THEN valor ELSE 0 END),0) AS receitas_pagas,
            COALESCE(SUM(CASE WHEN LOWER(tipo) = 'despesa' AND LOWER(COALESCE(status, 'pendente')) = 'pago' THEN valor ELSE 0 END),0) AS despesas_pagas
          FROM lancamentos_financeiros
          ${whereLanc}
        `,
          paramsLanc
        ),

        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total FROM contas_receber ${whereFluxoReceber}`,
          paramsFluxoReceber
        ),
        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar ${whereFluxoPagar}`,
          paramsFluxoPagar
        ),
        pool.query(
          `SELECT COALESCE(SUM(valor),0) AS total FROM investimentos ${whereInvest}`,
          paramsInvest
        ),
        pool.query(
          `SELECT COALESCE(SUM(v.total),0) AS total FROM vendas v ${whereVendas}`,
          paramsVendas
        ),
        pool.query(
          `SELECT COALESCE(SUM(c.total),0) AS total FROM compras c ${whereCompras}`,
          paramsCompras
        )
      ]);

      const receber = receberResult.rows[0];
      const pagar = pagarResult.rows[0];
      const lanc = lancResult.rows[0];

      const entradas =
        Number(fluxoReceberResult.rows[0].total || 0) +
        Number(vendasDiretasResult.rows[0].total || 0) +
        Number(lanc.receitas_pagas || 0);

      const saidas =
        Number(fluxoPagarResult.rows[0].total || 0) +
        Number(comprasDiretasResult.rows[0].total || 0) +
        Number(lanc.despesas_pagas || 0) +
        Number(investimentosResult.rows[0].total || 0);

      return res.json({
        sucesso: true,
        contas_receber: {
          pago: Number(receber.pago || 0),
          pendente: Number(receber.pendente || 0),
          atrasado: Number(receber.atrasado || 0)
        },
        contas_pagar: {
          pago: Number(pagar.pago || 0),
          pendente: Number(pagar.pendente || 0),
          atrasado: Number(pagar.atrasado || 0)
        },
        lancamentos: {
          receitas: Number(lanc.receitas || 0),
          despesas: Number(lanc.despesas || 0),
          receitas_pagas: Number(lanc.receitas_pagas || 0),
          despesas_pagas: Number(lanc.despesas_pagas || 0)
        },
        fluxo: {
          entradas: Number(entradas.toFixed(2)),
          saidas: Number(saidas.toFixed(2)),
          saldo: Number((entradas - saidas).toFixed(2))
        }
      });
    } catch (error) {
      console.error('Erro real ao gerar resumo financeiro:', error);
      return erro(res, 500, 'Erro ao gerar resumo financeiro');
    }
  });

  router.get('/financeiro/fluxo-caixa/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cr:', e.message); }
      try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cp:', e.message); }

      const { dataInicial, dataFinal } = obterPeriodo(req);

      const paramsReceber = [empresaResolvida.id, empresaResolvida.nome];
      const paramsPagar = [empresaResolvida.id, empresaResolvida.nome];
      const paramsLanc = [empresaResolvida.id, empresaResolvida.nome];
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
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
          AND LOWER(COALESCE(status, 'pendente')) = 'pago'
          AND pagamento_data IS NOT NULL
      `;

      let whereInvest = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;

      let whereVendas = `
        WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))
          AND NOT EXISTS (
            SELECT 1
            FROM contas_receber cr
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
        movimentosReceberResult,
        movimentosPagarResult,
        movimentosLancamentosResult,
        movimentosInvestimentosResult,
        movimentosVendasResult,
        movimentosComprasResult
      ] = await Promise.all([
        pool.query(
          `
          SELECT
            id,
            'conta_receber' AS origem,
            'entrada' AS tipo,
            COALESCE(cliente_nome, 'Cliente não informado') AS descricao,
            COALESCE(valor_atualizado, valor) AS valor,
            data_pagamento AS data_movimento,
            forma_pagamento,
            venda_id AS referencia_id,
            observacao
          FROM contas_receber
          ${whereReceber}
        `,
          paramsReceber
        ),

        pool.query(
          `
          SELECT
            id,
            'conta_pagar' AS origem,
            'saida' AS tipo,
            COALESCE(descricao, fornecedor_nome, 'Conta a pagar') AS descricao,
            valor,
            data_pagamento AS data_movimento,
            forma_pagamento,
            compra_id AS referencia_id,
            observacao
          FROM contas_pagar
          ${wherePagar}
        `,
          paramsPagar
        ),

        pool.query(
          `
          SELECT
            id,
            'lancamento_financeiro' AS origem,
            CASE WHEN LOWER(tipo) = 'receita' THEN 'entrada' ELSE 'saida' END AS tipo,
            COALESCE(descricao, categoria, 'Lançamento financeiro') AS descricao,
            valor,
            pagamento_data AS data_movimento,
            NULL AS forma_pagamento,
            NULL AS referencia_id,
            observacao
          FROM lancamentos_financeiros
          ${whereLanc}
        `,
          paramsLanc
        ),

        pool.query(
          `
          SELECT
            id,
            'investimento' AS origem,
            'saida' AS tipo,
            COALESCE(descricao, tipo_investimento, 'Investimento') AS descricao,
            valor,
            data AS data_movimento,
            NULL AS forma_pagamento,
            NULL AS referencia_id,
            observacao
          FROM investimentos
          ${whereInvest}
        `,
          paramsInvest
        ),

        pool.query(
          `
          SELECT
            v.id,
            'venda_direta' AS origem,
            'entrada' AS tipo,
            COALESCE(v.cliente_nome, 'Venda direta') AS descricao,
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

        pool.query(
          `
          SELECT
            c.id,
            'compra_direta' AS origem,
            'saida' AS tipo,
            COALESCE(f.nome, 'Compra direta') AS descricao,
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

      const movimentos = [
        ...movimentosReceberResult.rows,
        ...movimentosPagarResult.rows,
        ...movimentosLancamentosResult.rows,
        ...movimentosInvestimentosResult.rows,
        ...movimentosVendasResult.rows,
        ...movimentosComprasResult.rows
      ]
        .map((row) => ({
          ...row,
          valor: Number(row.valor || 0)
        }))
        .sort((a, b) => {
          const da = new Date(`${a.data_movimento || '1970-01-01'}T00:00:00`).getTime();
          const db = new Date(`${b.data_movimento || '1970-01-01'}T00:00:00`).getTime();
          return db - da;
        });

      return res.json({ sucesso: true, dados: movimentos });
    } catch (error) {
      console.error('Erro real ao gerar relatório de fluxo de caixa:', error);
      return erro(res, 500, 'Erro ao gerar relatório de fluxo de caixa');
    }
  });

  router.get('/financeiro/contas-receber/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cr:', e.message); }

      const status = (req.query.status || '').trim().toLowerCase();
      const busca = (req.query.busca || '').trim().toLowerCase();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [];

      let sql = `
  SELECT *
  FROM contas_receber
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params,
    empresaResolvida
  })}
`;

      let idx = params.length + 1;

      if (status) {
        sql += ` AND LOWER(COALESCE(status, 'pendente')) = $${idx}`;
        params.push(status);
        idx++;
      }

      if (busca) {
        sql += `
          AND (
            LOWER(COALESCE(cliente_nome, '')) LIKE $${idx}
            OR LOWER(COALESCE(observacao, '')) LIKE $${idx}
            OR CAST(id AS TEXT) LIKE $${idx}
          )
        `;
        params.push(`%${busca}%`);
        idx++;
      }

      sql += adicionarFiltroPeriodo({
        campo: 'data_vencimento',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      sql += ` ORDER BY data_vencimento ASC NULLS LAST, id DESC LIMIT 1000`;

      const result = await pool.query(sql, params);
      const truncado = result.rows.length === 1000;

      return res.json({ sucesso: true, truncado, dados: result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0),
        parcela: Number(row.parcela || 1),
        total_parcelas: Number(row.total_parcelas || 1)
      })) });
    } catch (error) {
      console.error('Erro real ao gerar relatório de contas a receber:', error);
      return erro(res, 500, 'Erro ao gerar relatório de contas a receber');
    }
  });

  router.get('/financeiro/contas-pagar/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cp:', e.message); }

      const status = (req.query.status || '').trim().toLowerCase();
      const busca = (req.query.busca || '').trim().toLowerCase();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [];

      let sql = `
  SELECT *
  FROM contas_pagar
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params,
    empresaResolvida
  })}
`;

      let idx = params.length + 1;

      if (status) {
        sql += ` AND LOWER(COALESCE(status, 'pendente')) = $${idx}`;
        params.push(status);
        idx++;
      }

      if (busca) {
        sql += `
          AND (
            LOWER(COALESCE(fornecedor_nome, '')) LIKE $${idx}
            OR LOWER(COALESCE(descricao, '')) LIKE $${idx}
            OR LOWER(COALESCE(observacao, '')) LIKE $${idx}
            OR CAST(id AS TEXT) LIKE $${idx}
          )
        `;
        params.push(`%${busca}%`);
        idx++;
      }

      sql += adicionarFiltroPeriodo({
        campo: 'data_vencimento',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      sql += ` ORDER BY data_vencimento ASC NULLS LAST, id DESC LIMIT 1000`;

      const result = await pool.query(sql, params);
      const truncado = result.rows.length === 1000;

      return res.json({ sucesso: true, truncado, dados: result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0),
        parcela: Number(row.parcela || 1),
        total_parcelas: Number(row.total_parcelas || 1)
      })) });
    } catch (error) {
      console.error('Erro real ao gerar relatório de contas a pagar:', error);
      return erro(res, 500, 'Erro ao gerar relatório de contas a pagar');
    }
  });

  router.get('/financeiro/lucratividade/:empresa', auth, requirePermissao(pool, 'lucratividade', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [];

      let where = `
      WHERE 1=1
      ${adicionarFiltroEmpresaSaaS({
        alias: 'vi',
        params,
        empresaResolvida
      })}
    `;

      where += adicionarFiltroPeriodo({
        campo: 'v.data',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const result = await pool.query(
        `
      SELECT
        vi.produto_id,
        vi.produto_nome,

        COALESCE(SUM(vi.quantidade), 0) AS quantidade_vendida,

        COALESCE(SUM(vi.total), 0) AS faturamento_total,

        COALESCE(MAX(p.custo_medio), 0) AS custo_medio,

        COALESCE(MAX(p.lucro_unitario), 0) AS lucro_unitario,

        COALESCE(MAX(p.margem_lucro), 0) AS margem_lucro,

        COALESCE(SUM(
          vi.quantidade * p.custo_medio
        ), 0) AS custo_total,

        COALESCE(SUM(
          vi.quantidade * p.lucro_unitario
        ), 0) AS lucro_total,

        COALESCE(MAX(p.estoque), 0) AS estoque_atual,

        COALESCE(MAX(
          p.estoque * p.custo_medio
        ), 0) AS estoque_investido,

        COALESCE(MAX(
  p.estoque * p.lucro_unitario
), 0) AS lucro_potencial,

COALESCE(MAX(p.estoque), 0) AS estoque_parado,

COALESCE(MAX(
  p.estoque * p.custo_medio
), 0) AS capital_parado,

MAX(v.data) AS ultima_venda

      FROM venda_itens vi

      INNER JOIN vendas v
        ON v.id = vi.venda_id
        AND (
          v.empresa_id = vi.empresa_id
          OR (
            vi.empresa_id IS NULL
            AND v.empresa = vi.empresa
          )
        )

      LEFT JOIN produtos p
        ON p.id = vi.produto_id
        AND (
          p.empresa_id = vi.empresa_id
          OR (
            p.empresa_id IS NULL
            AND p.empresa = vi.empresa
          )
        )

      ${where}

      GROUP BY
        vi.produto_id,
        vi.produto_nome

      ORDER BY lucro_total DESC, faturamento_total DESC
      `,
        params
      );

      const linhas = result.rows.map((row) => ({
        produto_id: row.produto_id,
        produto_nome: row.produto_nome,

        quantidade_vendida: Number(row.quantidade_vendida || 0),

        faturamento_total: Number(row.faturamento_total || 0),

        custo_medio: Number(row.custo_medio || 0),

        lucro_unitario: Number(row.lucro_unitario || 0),

        margem_lucro: Number(row.margem_lucro || 0),

        custo_total: Number(row.custo_total || 0),

        lucro_total: Number(row.lucro_total || 0),

        estoque_atual: Number(row.estoque_atual || 0),

        estoque_investido: Number(row.estoque_investido || 0),

        lucro_potencial: Number(row.lucro_potencial || 0),

        estoque_parado: Number(row.estoque_parado || 0),

        capital_parado: Number(row.capital_parado || 0),

        ultima_venda: row.ultima_venda || null
      }));

      const totalLucroGeral = linhas.reduce((acc, item) => acc + Number(item.lucro_total || 0), 0);

      let acumulado = 0;

      const linhasComAbc = linhas.map((item) => {
        const participacao =
          totalLucroGeral > 0 ? (Number(item.lucro_total || 0) / totalLucroGeral) * 100 : 0;

        acumulado += participacao;

        let classeAbc = 'C';

        if (acumulado <= 80) {
          classeAbc = 'A';
        } else if (acumulado <= 95) {
          classeAbc = 'B';
        }

        return {
          ...item,
          participacao_lucro: Number(participacao.toFixed(2)),
          participacao_acumulada: Number(acumulado.toFixed(2)),
          classe_abc: classeAbc
        };
      });

      return res.json({ sucesso: true, dados: linhasComAbc });
    } catch (error) {
      console.error('Erro real ao gerar relatório de lucratividade:', error);

      return erro(res, 500, 'Erro ao gerar relatório de lucratividade');
    }
  });

  // ── INADIMPLÊNCIA ─────────────────────────────────────────────────────────
  router.get('/inadimplencia/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      // Atualiza status antes de consultar
      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[relatorios] status-cr:', e.message); }

      const params = [];
      let whereBase = `
        WHERE 1=1
        ${adicionarFiltroEmpresaSaaS({ params, empresaResolvida })}
        AND data_vencimento IS NOT NULL
        AND LOWER(COALESCE(status, 'pendente')) NOT IN ('pago')
        AND data_vencimento::date < CURRENT_DATE
      `;

      const INADIMPLENCIA_LIMIT = 500;

      // ── Contagem total (para saber se há mais que o limite) ──────────────
      const countParams = [...params];
      const countResult = await pool.query(`
        SELECT COUNT(DISTINCT COALESCE(cliente_id::text, 'sem_cadastro')) AS total
        FROM contas_receber
        ${whereBase}
      `, countParams);
      const totalClientesInadimplentes = Number(countResult.rows[0]?.total || 0);

      // ── Por cliente ──────────────────────────────────────────────────────
      const clientesResult = await pool.query(`
        SELECT
          COALESCE(cliente_id::text, 'sem_cadastro') AS cliente_key,
          COALESCE(cliente_nome, 'Consumidor Final')  AS cliente_nome,
          COUNT(*)                                    AS total_titulos,
          COALESCE(SUM(valor), 0)                     AS valor_total,
          MAX(CURRENT_DATE - data_vencimento::date)   AS max_dias_atraso,
          COALESCE(SUM(CASE WHEN CURRENT_DATE - data_vencimento::date BETWEEN 1  AND 30  THEN valor ELSE 0 END), 0) AS faixa_1_30,
          COALESCE(SUM(CASE WHEN CURRENT_DATE - data_vencimento::date BETWEEN 31 AND 60  THEN valor ELSE 0 END), 0) AS faixa_31_60,
          COALESCE(SUM(CASE WHEN CURRENT_DATE - data_vencimento::date BETWEEN 61 AND 90  THEN valor ELSE 0 END), 0) AS faixa_61_90,
          COALESCE(SUM(CASE WHEN CURRENT_DATE - data_vencimento::date > 90              THEN valor ELSE 0 END), 0) AS faixa_90plus
        FROM contas_receber
        ${whereBase}
        GROUP BY cliente_key, cliente_nome
        ORDER BY valor_total DESC
        LIMIT ${INADIMPLENCIA_LIMIT}
      `, params);

      const clientes = clientesResult.rows.map((r) => ({
        cliente_key:       r.cliente_key,
        cliente_nome:      r.cliente_nome,
        total_titulos:     Number(r.total_titulos   || 0),
        valor_total:       Number(r.valor_total      || 0),
        max_dias_atraso:   Number(r.max_dias_atraso  || 0),
        faixa_1_30:        Number(r.faixa_1_30       || 0),
        faixa_31_60:       Number(r.faixa_31_60      || 0),
        faixa_61_90:       Number(r.faixa_61_90      || 0),
        faixa_90plus:      Number(r.faixa_90plus     || 0)
      }));

      // ── Totais ──────────────────────────────────────────────────────────
      const totValor    = clientes.reduce((s, c) => s + c.valor_total,  0);
      const totTitulos  = clientes.reduce((s, c) => s + c.total_titulos, 0);
      const aging = {
        faixa_1_30:  clientes.reduce((s, c) => s + c.faixa_1_30,  0),
        faixa_31_60: clientes.reduce((s, c) => s + c.faixa_31_60, 0),
        faixa_61_90: clientes.reduce((s, c) => s + c.faixa_61_90, 0),
        faixa_90plus: clientes.reduce((s, c) => s + c.faixa_90plus, 0)
      };

      return res.json({
        sucesso: true,
        total_clientes:            clientes.length,
        total_clientes_base:       totalClientesInadimplentes,
        truncado:                  totalClientesInadimplentes > INADIMPLENCIA_LIMIT,
        total_titulos:             totTitulos,
        total_valor:               +totValor.toFixed(2),
        aging,
        clientes
      });
    } catch (error) {
      console.error('Erro real ao gerar relatório de inadimplência:', error);
      return erro(res, 500, 'Erro ao gerar relatório de inadimplência');
    }
  });

  // ── DRE — DEMONSTRATIVO DE RESULTADO DO EXERCÍCIO ────────────────────────
  router.get('/dre/:empresa', auth, requirePermissao(pool, 'dre', 'ver'), async (req, res) => {
    try {
      if (!checkFinanceiro(req, res)) return;
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const eId   = empresaResolvida.id;
      const eNome = empresaResolvida.nome;

      // ── 1. Vendas + CMV por mês ──────────────────────────────────────────
      const vendaParams = [eId, eNome];
      let vendaWhere = `WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))`;
      vendaWhere += adicionarFiltroPeriodo({ campo: 'v.data', params: vendaParams, dataInicial, dataFinal, castDate: false });

      const vendasResult = await pool.query(`
        SELECT
          TO_CHAR(v.data::date, 'YYYY-MM')        AS periodo,
          COALESCE(SUM(v.total), 0)               AS receita,
          COALESCE(SUM(vi_cmv.cmv), 0)            AS cmv
        FROM vendas v
        LEFT JOIN (
          SELECT venda_id,
                 SUM(quantidade * COALESCE(custo_unitario, 0)) AS cmv
          FROM venda_itens
          WHERE empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)
          GROUP BY venda_id
        ) vi_cmv ON vi_cmv.venda_id = v.id
        ${vendaWhere}
        GROUP BY TO_CHAR(v.data::date, 'YYYY-MM')
        ORDER BY 1
      `, vendaParams);

      // ── 2. Despesas de lançamentos por mês ───────────────────────────────
      const lancParams = [eId, eNome];
      let lancWhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND LOWER(tipo) = 'despesa'`;
      lancWhere += adicionarFiltroPeriodo({
        campo: `COALESCE(pagamento_data, vencimento)`,
        params: lancParams, dataInicial, dataFinal, castDate: false
      });

      const lancResult = await pool.query(`
        SELECT
          TO_CHAR(COALESCE(pagamento_data, vencimento)::date, 'YYYY-MM') AS periodo,
          COALESCE(SUM(valor), 0) AS despesas
        FROM lancamentos_financeiros
        ${lancWhere}
        GROUP BY 1
        ORDER BY 1
      `, lancParams);

      // ── 3. Contas a pagar pagas por mês ──────────────────────────────────
      const cpParams = [eId, eNome];
      let cpWhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
                      AND LOWER(COALESCE(status,'pendente')) = 'pago' AND data_pagamento IS NOT NULL
                      AND compra_id IS NULL`;
      cpWhere += adicionarFiltroPeriodo({ campo: 'data_pagamento', params: cpParams, dataInicial, dataFinal, castDate: false });

      const cpResult = await pool.query(`
        SELECT
          TO_CHAR(data_pagamento::date, 'YYYY-MM') AS periodo,
          COALESCE(SUM(valor), 0) AS despesas
        FROM contas_pagar
        ${cpWhere}
        GROUP BY 1
        ORDER BY 1
      `, cpParams);

      // ── Merge mensal ─────────────────────────────────────────────────────
      const periodos = new Set([
        ...vendasResult.rows.map(r => r.periodo),
        ...lancResult.rows.map(r => r.periodo),
        ...cpResult.rows.map(r => r.periodo)
      ]);

      const lancMap = Object.fromEntries(lancResult.rows.map(r => [r.periodo, Number(r.despesas)]));
      const cpMap   = Object.fromEntries(cpResult.rows.map(r => [r.periodo, Number(r.despesas)]));

      const mensal = Array.from(periodos).sort().map(p => {
        const vRow = vendasResult.rows.find(r => r.periodo === p) || { receita: 0, cmv: 0 };
        const receita   = Number(vRow.receita || 0);
        const cmv       = Number(vRow.cmv     || 0);
        const despesas  = Number(lancMap[p] || 0) + Number(cpMap[p] || 0);
        const lucro_bruto     = receita - cmv;
        const resultado       = lucro_bruto - despesas;
        const margem_bruta    = receita > 0 ? +((lucro_bruto / receita) * 100).toFixed(2) : 0;
        const margem_oper     = receita > 0 ? +((resultado   / receita) * 100).toFixed(2) : 0;
        const [ano, mes]      = p.split('-');
        const nomesMes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        const label = `${nomesMes[Number(mes) - 1]}/${ano}`;
        return { periodo: p, label, receita, cmv, lucro_bruto, despesas, resultado, margem_bruta, margem_oper };
      });

      // ── Totais do período ────────────────────────────────────────────────
      const totReceita  = mensal.reduce((s, m) => s + m.receita,    0);
      const totCmv      = mensal.reduce((s, m) => s + m.cmv,        0);
      const totDespesas = mensal.reduce((s, m) => s + m.despesas,    0);
      const totLucro    = totReceita - totCmv;
      const totResult   = totLucro - totDespesas;

      return res.json({
        sucesso: true,
        periodo_inicio: dataInicial,
        periodo_fim:    dataFinal,
        receita_bruta:          +totReceita.toFixed(2),
        cmv:                    +totCmv.toFixed(2),
        lucro_bruto:            +totLucro.toFixed(2),
        margem_bruta:           totReceita > 0 ? +((totLucro  / totReceita) * 100).toFixed(2) : 0,
        despesas_operacionais:  +totDespesas.toFixed(2),
        resultado_operacional:  +totResult.toFixed(2),
        margem_operacional:     totReceita > 0 ? +((totResult / totReceita) * 100).toFixed(2) : 0,
        mensal
      });
    } catch (error) {
      console.error('Erro real ao gerar DRE:', error);
      return erro(res, 500, 'Erro ao gerar DRE');
    }
  });

  // ── VENDAS POR VARIAÇÃO DE GRADE ─────────────────────────────────────────
  router.get('/vendas/por-grade/:empresa', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [];

      let where = `
        WHERE vi.grade_id IS NOT NULL
        ${adicionarFiltroEmpresaSaaS({ alias: 'vi', params, empresaResolvida })}
      `;

      where += adicionarFiltroPeriodo({
        campo: 'v.data',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const result = await pool.query(
        `
        SELECT
          vi.produto_id,
          vi.produto_nome,
          vi.grade_id,
          pg.atributo1,
          pg.atributo2,
          COALESCE(SUM(vi.quantidade), 0)                                             AS quantidade_vendida,
          COALESCE(SUM(vi.total), 0)                                                  AS faturamento_total,
          COALESCE(MAX(pg.preco), MAX(p.preco), 0)                                    AS preco_atual,
          COALESCE(MAX(pg.custo), MAX(p.custo_medio), 0)                              AS custo_atual,
          COALESCE(SUM(vi.quantidade * COALESCE(pg.custo, p.custo_medio, 0)), 0)      AS custo_total,
          COALESCE(SUM(vi.total), 0)
            - COALESCE(SUM(vi.quantidade * COALESCE(pg.custo, p.custo_medio, 0)), 0) AS lucro_total,
          COALESCE(MAX(pg.estoque), 0)                                                AS estoque_atual,
          MAX(v.data)                                                                 AS ultima_venda
        FROM venda_itens vi
        JOIN vendas v
          ON v.id = vi.venda_id
          AND (v.empresa_id = vi.empresa_id OR (vi.empresa_id IS NULL AND v.empresa = vi.empresa))
        LEFT JOIN produtos p
          ON p.id = vi.produto_id
          AND (p.empresa_id = $1 OR (p.empresa_id IS NULL AND p.empresa = $2))
        LEFT JOIN produto_grades pg
          ON pg.id = vi.grade_id
          AND (pg.empresa_id = $1 OR (pg.empresa_id IS NULL AND pg.empresa = $2))
        ${where}
        GROUP BY vi.produto_id, vi.produto_nome, vi.grade_id, pg.atributo1, pg.atributo2
        ORDER BY faturamento_total DESC, vi.produto_nome ASC
        `,
        params
      );

      return res.json({ sucesso: true, dados: result.rows.map((row) => ({
        produto_id: row.produto_id,
        produto_nome: row.produto_nome,
        grade_id: row.grade_id,
        atributo1: row.atributo1 || '',
        atributo2: row.atributo2 || '',
        variacao: row.atributo2
          ? `${row.atributo1} / ${row.atributo2}`
          : row.atributo1 || `Grade #${row.grade_id}`,
        quantidade_vendida: Number(row.quantidade_vendida || 0),
        faturamento_total: Number(row.faturamento_total || 0),
        preco_atual: Number(row.preco_atual || 0),
        custo_atual: Number(row.custo_atual || 0),
        custo_total: Number(row.custo_total || 0),
        lucro_total: Number(row.lucro_total || 0),
        estoque_atual: Number(row.estoque_atual || 0),
        ultima_venda: row.ultima_venda || null
      })) });
    } catch (error) {
      console.error('Erro real ao gerar relatório por grade:', error);
      return erro(res, 500, 'Erro ao gerar relatório por variação');
    }
  });

  return router;
};
