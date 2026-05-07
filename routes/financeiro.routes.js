const express = require('express');
const router = express.Router();

const pool = require('../db');

const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');

const { normalizarFormaPagamentoFluxo } = require('../utils/financeiroUtils');

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

  // ================= FLUXO DE CAIXA =================

  router.get('/fluxo-caixa/:empresa', auth, async (req, res) => {
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
        WHERE 1=1
        ${adicionarFiltroEmpresaSaaS({
          params: paramsReceber,
          empresaResolvida
        })}
        AND LOWER(COALESCE(status,'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
      `;

      let wherePagar = `
        WHERE 1=1
        ${adicionarFiltroEmpresaSaaS({
          params: paramsPagar,
          empresaResolvida
        })}
        AND LOWER(COALESCE(status,'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
      `;

      let whereLanc = `
        WHERE 1=1
        ${adicionarFiltroEmpresaSaaS({
          params: paramsLanc,
          empresaResolvida
        })}
        AND LOWER(COALESCE(status,'pendente')) = 'pago'
        AND pagamento_data IS NOT NULL
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
          SELECT 1 FROM contas_receber cr
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
        AND LOWER(COALESCE(c.status,'finalizada')) = 'finalizada'
        AND NOT EXISTS (
          SELECT 1 FROM contas_pagar cp
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

      const [movReceber, movPagar, movLanc, movInvest, movVendas, movCompras] = await Promise.all([
        pool.query(
          `
          SELECT id,'conta_receber' origem,'entrada' tipo,
          COALESCE(cliente_nome,'Cliente') descricao,
          valor,data_pagamento data_movimento,forma_pagamento,
          venda_id referencia_id,observacao
          FROM contas_receber
          ${whereReceber}
        `,
          paramsReceber
        ),

        pool.query(
          `
          SELECT id,'conta_pagar' origem,'saida' tipo,
          COALESCE(descricao,fornecedor_nome,'Conta') descricao,
          valor,data_pagamento data_movimento,forma_pagamento,
          compra_id referencia_id,observacao
          FROM contas_pagar
          ${wherePagar}
        `,
          paramsPagar
        ),

        pool.query(
          `
          SELECT id,'lancamento' origem,
          CASE WHEN tipo='receita' THEN 'entrada' ELSE 'saida' END tipo,
          descricao,valor,pagamento_data data_movimento,
          NULL forma_pagamento,NULL referencia_id,observacao
          FROM lancamentos_financeiros
          ${whereLanc}
        `,
          paramsLanc
        ),

        pool.query(
          `
          SELECT id,'investimento' origem,'saida' tipo,
          descricao,valor,data data_movimento,
          NULL forma_pagamento,NULL referencia_id,observacao
          FROM investimentos
          ${whereInvest}
        `,
          paramsInvest
        ),

        pool.query(
          `
          SELECT v.id,'venda_direta' origem,'entrada' tipo,
          COALESCE(v.cliente_nome,'Venda') descricao,
          v.total valor,v.data data_movimento,
          v.pagamento forma_pagamento,
          v.id referencia_id,NULL observacao
          FROM vendas v
          ${whereVendas}
        `,
          paramsVendas
        ),

        pool.query(
          `
          SELECT c.id,'compra_direta' origem,'saida' tipo,
          COALESCE(f.nome,'Compra') descricao,
          c.total valor,c.data data_movimento,
          c.pagamento forma_pagamento,
          c.id referencia_id,c.observacao
          FROM compras c
          LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
          ${whereCompras}
        `,
          paramsCompras
        )
      ]);

      const movimentos = [
        ...movReceber.rows,
        ...movPagar.rows,
        ...movLanc.rows,
        ...movInvest.rows,
        ...movVendas.rows,
        ...movCompras.rows
      ].map((m) => ({
        ...m,
        valor: Number(m.valor || 0),
        forma_pagamento: normalizarFormaPagamentoFluxo(m.forma_pagamento)
      }));

      const entradas = movimentos
        .filter((m) => m.tipo === 'entrada')
        .reduce((acc, m) => acc + m.valor, 0);

      const saidas = movimentos
        .filter((m) => m.tipo === 'saida')
        .reduce((acc, m) => acc + m.valor, 0);

      return res.json({
        entradas,
        saidas,
        saldo: entradas - saidas,
        movimentos
      });
    } catch (error) {
      console.error('Erro real no fluxo de caixa:', error);
      return erro(res, 500, 'Erro no fluxo de caixa');
    }
  });

  return router;
};
