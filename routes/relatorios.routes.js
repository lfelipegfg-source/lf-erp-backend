const express = require('express');
const router = express.Router();

const pool = require('../db');

const {
  obterPeriodo,
  adicionarFiltroPeriodo,
  adicionarFiltroPeriodoRange
} = require('../utils/periodoUtils');

module.exports = function ({
  auth,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa
}) {
  function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
    return res.status(status).json({
      sucesso: false,
      erro: mensagem
    });
  }

  router.get('/financeiro/resumo/:empresa', auth, async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);
      await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);

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
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) = 'pendente' THEN valor ELSE 0 END),0) AS pendente,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) = 'atrasado' THEN valor ELSE 0 END),0) AS atrasado
          FROM contas_receber
          ${whereReceber}
        `,
          paramsReceber
        ),

        pool.query(
          `
          SELECT
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN valor ELSE 0 END),0) AS pago,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) = 'pendente' THEN valor ELSE 0 END),0) AS pendente,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, 'pendente')) = 'atrasado' THEN valor ELSE 0 END),0) AS atrasado
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

  router.get('/financeiro/fluxo-caixa/:empresa', auth, async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);
      await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);

      const { dataInicial, dataFinal } = obterPeriodo(req);

      const paramsReceber = [];
      const paramsPagar = [];
      const paramsLanc = [];
      const paramsInvest = [];
      const paramsVendas = [];
      const paramsCompras = [];

      let whereReceber = `
        WHERE empresa = $1
          AND LOWER(COALESCE(status, 'pendente')) = 'pago'
          AND data_pagamento IS NOT NULL
      `;

      let wherePagar = `
        WHERE empresa = $1
          AND LOWER(COALESCE(status, 'pendente')) = 'pago'
          AND data_pagamento IS NOT NULL
      `;

      let whereLanc = `
        WHERE empresa = $1
          AND LOWER(COALESCE(status, 'pendente')) = 'pago'
          AND pagamento_data IS NOT NULL
      `;

      let whereInvest = `WHERE empresa = $1`;

      let whereVendas = `
        WHERE v.empresa = $1
          AND NOT EXISTS (
            SELECT 1
            FROM contas_receber cr
            WHERE cr.venda_id = v.id
              AND cr.empresa = v.empresa
          )
      `;

      let whereCompras = `
        WHERE c.empresa = $1
          AND LOWER(COALESCE(c.status, 'finalizada')) = 'finalizada'
          AND NOT EXISTS (
            SELECT 1
            FROM contas_pagar cp
            WHERE cp.compra_id = c.id
              AND cp.empresa = c.empresa
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
            valor,
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

      return res.json(movimentos);
    } catch (error) {
      console.error('Erro real ao gerar relatório de fluxo de caixa:', error);
      return erro(res, 500, 'Erro ao gerar relatório de fluxo de caixa');
    }
  });

  router.get('/financeiro/contas-receber/:empresa', auth, async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);

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

      sql += ` ORDER BY data_vencimento ASC NULLS LAST, id DESC`;

      const result = await pool.query(sql, params);

      return res.json(
        result.rows.map((row) => ({
          ...row,
          valor: Number(row.valor || 0),
          parcela: Number(row.parcela || 1),
          total_parcelas: Number(row.total_parcelas || 1)
        }))
      );
    } catch (error) {
      console.error('Erro real ao gerar relatório de contas a receber:', error);
      return erro(res, 500, 'Erro ao gerar relatório de contas a receber');
    }
  });

  router.get('/financeiro/contas-pagar/:empresa', auth, async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);

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

      sql += ` ORDER BY data_vencimento ASC NULLS LAST, id DESC`;

      const result = await pool.query(sql, params);

      return res.json(
        result.rows.map((row) => ({
          ...row,
          valor: Number(row.valor || 0),
          parcela: Number(row.parcela || 1),
          total_parcelas: Number(row.total_parcelas || 1)
        }))
      );
    } catch (error) {
      console.error('Erro real ao gerar relatório de contas a pagar:', error);
      return erro(res, 500, 'Erro ao gerar relatório de contas a pagar');
    }
  });

  return router;
};
