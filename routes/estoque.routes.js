module.exports = ({
  auth,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  normalizarInt,
  obterPeriodo,
  adicionarFiltroPeriodo,
  registrarMovimentacaoEstoque
}) => {
  const router = require('express').Router();

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

  function normalizarMov(row) {
    return {
      ...row,
      quantidade: Number(row.quantidade || 0)
    };
  }

  // ================= MOVIMENTAÇÕES DE ESTOQUE =================

  router.get('/movimentacoes/:empresa', auth, async (req, res) => {
    try {
      const empresa = req.params.empresa;

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const produtoId = normalizarInt(req.query.produto_id || 0);
      const tipo = (req.query.tipo || '').trim();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      let sql = `
        SELECT
          m.*,
          p.nome AS produto_nome
        FROM movimentacoes_estoque m
        LEFT JOIN produtos p
  ON p.id = m.produto_id
  AND (
    p.empresa_id = m.empresa_id
    OR (
      m.empresa_id IS NULL
      AND p.empresa = m.empresa
    )
  )
        WHERE 1=1
${adicionarFiltroEmpresaSaaS({
  alias: 'm',
  params,
  empresaResolvida
})}
      `;

      const params = [];
      let idx = 1;

      if (produtoId > 0) {
        sql += ` AND m.produto_id = $${idx} `;
        params.push(produtoId);
        idx++;
      }

      if (tipo) {
        sql += ` AND m.tipo = $${idx} `;
        params.push(tipo);
        idx++;
      }

      sql += adicionarFiltroPeriodo({
        campo: 'm.data_movimentacao',
        params,
        dataInicial,
        dataFinal
      });

      sql += ` ORDER BY m.id DESC`;

      const result = await pool.query(sql, params);

      return res.json(result.rows.map(normalizarMov));
    } catch (error) {
      console.error('Erro real ao buscar movimentações:', error);
      return erro(res, 500, 'Erro ao buscar movimentações de estoque');
    }
  });

  router.post('/ajuste', auth, async (req, res) => {
    const client = await pool.connect();

    try {
      const { empresa, produto_id, tipo, quantidade, observacao } = req.body;

      if (!empresa || !produto_id || !tipo || !quantidade) {
        return erro(res, 400, 'Dados do ajuste incompletos');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const tiposPermitidos = ['ajuste_entrada', 'ajuste_saida', 'perda', 'avaria'];

      if (!tiposPermitidos.includes(tipo)) {
        return erro(res, 400, 'Tipo de ajuste inválido');
      }

      const qtd = normalizarInt(quantidade);

      if (qtd <= 0) {
        return erro(res, 400, 'Quantidade inválida');
      }

      await client.query('BEGIN');

      const produtoResult = await client.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2`,
        [produto_id, empresaResolvida.id]
      );

      if (produtoResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Produto não encontrado');
      }

      const produto = produtoResult.rows[0];
      const estoqueAtual = normalizarInt(produto.estoque);

      let novoEstoque = estoqueAtual;

      if (tipo === 'ajuste_entrada' || tipo === 'estorno_venda') {
        novoEstoque = estoqueAtual + qtd;
      } else {
        if (estoqueAtual < qtd) {
          await client.query('ROLLBACK');
          return erro(res, 400, 'Estoque insuficiente para saída');
        }
        novoEstoque = estoqueAtual - qtd;
      }

      await client.query(
        `UPDATE produtos
        SET estoque = $1, atualizado_em = NOW()
        WHERE id = $2 AND empresa_id = $3`,
        [novoEstoque, produto_id, empresaResolvida.id]
      );

      await registrarMovimentacaoEstoque({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        produto_id,
        tipo,
        quantidade: qtd,
        observacao: observacao || 'Ajuste manual de estoque',
        referencia_tipo: 'ajuste',
        referencia_id: null,
        usuario_id: req.user.id,
        client
      });

      await client.query('COMMIT');

      return ok(res, {
        estoque_atual: novoEstoque,
        mensagem: 'Ajuste realizado com sucesso'
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao ajustar estoque:', error);
      return erro(res, 500, 'Erro ao ajustar estoque');
    } finally {
      client.release();
    }
  });

  return router;
};
