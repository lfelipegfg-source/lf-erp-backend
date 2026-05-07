const express = require('express');
const pool = require('../db');

const {
  normalizarDecimal,
  normalizarInt,
  normalizarDataISO,
  hoje,
  addDias
} = require('../utils/normalizadores');

module.exports = function ({
  auth,
  validarAcessoEmpresa,
  podeGerenciarCompras,
  registrarMovimentacaoEstoque,
  atualizarStatusContasPagarPorEmpresa,
  registrarAuditoria
}) {
  const router = express.Router();

  function ok(res, dados = {}, status = 200) {
    return res.status(status).json({
      sucesso: true,
      ...dados
    });
  }

  function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
    return res.status(status).json({
      sucesso: false,
      erro: mensagem
    });
  }

  router.post('/', auth, async (req, res) => {
    const client = await pool.connect();

    try {
      if (!podeGerenciarCompras(req)) {
        return erro(res, 403, 'Sem permissão para compras');
      }

      const {
        empresa,
        fornecedor_id,
        data,
        pagamento,
        parcelas,
        observacao,
        primeiro_vencimento,
        itens
      } = req.body;

      if (!fornecedor_id || !data || !pagamento || !Array.isArray(itens) || itens.length === 0) {
        return erro(res, 400, 'Dados da compra incompletos');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      await client.query('BEGIN');

      const fornecedorResult = await client.query(
        `SELECT * FROM fornecedores WHERE id = $1 AND empresa_id = $2`,
        [fornecedor_id, empresaResolvida.id]
      );

      if (fornecedorResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Fornecedor não encontrado');
      }

      const fornecedor = fornecedorResult.rows[0];

      let totalCalculado = 0;

      for (const item of itens) {
        const produtoId = Number(item.produto_id);
        const quantidade = normalizarInt(item.quantidade);
        const custoUnitario = normalizarDecimal(
          item.custo_unitario || item.preco_unitario || item.custo
        );
        const subtotal = Number((quantidade * custoUnitario).toFixed(2));

        if (!produtoId || quantidade <= 0 || custoUnitario < 0) {
          await client.query('ROLLBACK');
          return erro(res, 400, 'Itens da compra inválidos');
        }

        totalCalculado = Number((totalCalculado + subtotal).toFixed(2));
      }

      const pagamentoNormalizado = String(pagamento || '').toLowerCase();
      const geraContaPagar =
        pagamentoNormalizado === 'boleto' || pagamentoNormalizado === 'promissoria';
      const parcelasFinal = geraContaPagar ? Math.max(1, normalizarInt(parcelas || 1)) : 1;

      const compraResult = await client.query(
        `INSERT INTO compras
        (empresa, empresa_id, fornecedor_id, data, total, observacao, gerar_conta_pagar, pagamento, status, criado_por, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finalizada', $9, NOW(), NOW())
        RETURNING *`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          fornecedor_id,
          normalizarDataISO(data) || hoje(),
          totalCalculado,
          observacao || '',
          geraContaPagar,
          pagamentoNormalizado || 'dinheiro',
          req.user.id
        ]
      );

      const compra = compraResult.rows[0];

      for (const item of itens) {
        const produtoId = Number(item.produto_id);
        const quantidade = normalizarInt(item.quantidade);
        const custoUnitario = normalizarDecimal(
          item.custo_unitario || item.preco_unitario || item.custo
        );
        const subtotal = Number((quantidade * custoUnitario).toFixed(2));

        const produtoResult = await client.query(
          `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2`,
          [produtoId, empresaResolvida.id]
        );

        if (produtoResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 404, `Produto ${produtoId} não encontrado`);
        }

        const produto = produtoResult.rows[0];

        const estoqueAtual = normalizarInt(produto.estoque);
        const novoEstoque = estoqueAtual + quantidade;

        const custoAtual = normalizarDecimal(produto.custo_medio || produto.custo || 0);
        const valorEstoqueAtual = Number((estoqueAtual * custoAtual).toFixed(2));
        const valorNovaCompra = Number((quantidade * custoUnitario).toFixed(2));

        const novoCustoMedio =
          novoEstoque > 0
            ? Number(((valorEstoqueAtual + valorNovaCompra) / novoEstoque).toFixed(2))
            : custoUnitario;

        const precoProduto = normalizarDecimal(produto.preco || 0);
        const lucroUnitario = Number((precoProduto - novoCustoMedio).toFixed(2));
        const margemLucro =
          novoCustoMedio > 0 ? Number(((lucroUnitario / novoCustoMedio) * 100).toFixed(2)) : 0;

        await client.query(
          `INSERT INTO compra_itens
          (
            compra_id,
    empresa,
    empresa_id,
    produto_id,
    produto_nome,
    quantidade,
    custo_unitario,
    subtotal
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            compra.id,
            empresaResolvida.nome,
            empresaResolvida.id,
            produto.id,
            produto.nome,
            quantidade,
            custoUnitario,
            subtotal
          ]
        );

        await client.query(
          `UPDATE produtos
          SET estoque = $1,
              custo = $2,
              custo_unitario = $3,
              custo_medio = $4,
              lucro_unitario = $5,
              margem_lucro = $6,
              atualizado_em = NOW()
          WHERE id = $7 AND empresa_id = $8`,
          [
            novoEstoque,
            custoUnitario,
            custoUnitario,
            novoCustoMedio,
            lucroUnitario,
            margemLucro,
            produto.id,
            empresaResolvida.id
          ]
        );

        if (typeof registrarMovimentacaoEstoque === 'function') {
          await registrarMovimentacaoEstoque({
            empresa: empresaResolvida.nome,
            empresa_id: empresaResolvida.id,
            produto_id: produto.id,
            tipo: 'entrada_compra',
            quantidade,
            observacao: `Entrada por compra #${compra.id}`,
            referencia_tipo: 'compra',
            referencia_id: compra.id,
            usuario_id: req.user.id,
            client
          });
        }
      }

      if (geraContaPagar) {
        const dataPrimeiroVencimento =
          normalizarDataISO(primeiro_vencimento || data) || normalizarDataISO(data) || hoje();

        const intervaloDias = 30;
        const valorBase = Math.floor((totalCalculado / parcelasFinal) * 100) / 100;
        let acumulado = 0;

        for (let i = 1; i <= parcelasFinal; i++) {
          let valorParcela = valorBase;

          if (i === parcelasFinal) {
            valorParcela = Number((totalCalculado - acumulado).toFixed(2));
          }

          acumulado = Number((acumulado + valorParcela).toFixed(2));

          const vencimento =
            i === 1
              ? dataPrimeiroVencimento
              : addDias(dataPrimeiroVencimento, (i - 1) * intervaloDias);

          await client.query(
            `INSERT INTO contas_pagar
  (
    empresa,
    empresa_id,
    fornecedor_id,
    fornecedor_nome,
    compra_id,
    descricao,
    parcela,
    total_parcelas,
    valor,
    data_vencimento,
    data_pagamento,
    status,
    forma_pagamento,
    observacao,
    criado_por,
    criado_em,
    atualizado_em
  )
  VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    NULL,
    'pendente',
    $11,
    $12,
    $13,
    NOW(),
    NOW()
  )`,
            [
              empresaResolvida.nome,
              empresaResolvida.id,
              fornecedor.id,
              fornecedor.nome,
              compra.id,
              `Parcela ${i}/${parcelasFinal} - Compra #${compra.id}`,
              i,
              parcelasFinal,
              valorParcela,
              vencimento,
              pagamentoNormalizado || pagamento,
              observacao || '',
              req.user.id
            ]
          );
        }
      }

      await client.query('COMMIT');

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'compras',
        acao: 'cadastro',
        referencia_id: compra.id,
        dados_novos: {
          fornecedor_id,
          fornecedor_nome: fornecedor.nome,
          data,
          total: totalCalculado,
          pagamento: pagamentoNormalizado,
          parcelas: parcelasFinal,
          gerar_conta_pagar: geraContaPagar,
          itens: itens.map((i) => ({
            produto_id: i.produto_id,
            quantidade: i.quantidade,
            custo_unitario: i.custo_unitario || i.preco_unitario || i.custo
          }))
        },
        req
      });

      if (typeof atualizarStatusContasPagarPorEmpresa === 'function') {
        await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);
      }

      return ok(res, {
        compra_id: compra.id,
        dados: {
          compra_id: compra.id
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao criar compra:', error);
      return erro(res, 500, 'Erro ao criar compra');
    } finally {
      client.release();
    }
  });

  return router;
};
