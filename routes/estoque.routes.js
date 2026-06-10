const { requirePermissao } = require('../utils/permissoes');

module.exports = ({
  auth,
  writeRateLimiter,
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

  router.get('/movimentacoes/:empresa', auth, requirePermissao(pool, 'estoque', 'ver'), async (req, res) => {
    try {
      const empresa = req.params.empresa;

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const produtoId = normalizarInt(req.query.produto_id || 0);
      const tipo = (req.query.tipo || '').trim();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [];
      let idx = 1;

      const filtroEmpresa = adicionarFiltroEmpresaSaaS({
        alias: 'm',
        params,
        empresaResolvida
      });

      idx = params.length + 1;

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
${filtroEmpresa}
      `;

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

      sql += ` ORDER BY m.id DESC LIMIT 2000`;

      const result = await pool.query(sql, params);
      const truncado = result.rows.length === 2000;

      return res.json({ sucesso: true, dados: result.rows.map(normalizarMov), truncado });
    } catch (error) {
      console.error('Erro real ao buscar movimentações:', error);
      return erro(res, 500, 'Erro ao buscar movimentações de estoque');
    }
  });

  router.post('/ajuste', auth, writeRateLimiter, requirePermissao(pool, 'estoque', 'editar'), async (req, res) => {
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
        `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
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

  // ── Sugestão automática de compra ────────────────────────────────────────────
  router.get('/sugestao-compra', auth, requirePermissao(pool, 'estoque', 'ver'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa, req.empresa_id);
      if (!empresaResolvida) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const result = await pool.query(
        `SELECT
           p.id,
           p.nome,
           p.categoria,
           p.codigo_barras,
           p.estoque         AS estoque_atual,
           p.estoque_minimo,
           p.custo_medio,
           p.custo,
           GREATEST(p.estoque_minimo * 2 - p.estoque, p.estoque_minimo - p.estoque) AS qtd_sugerida,
           f.nome AS fornecedor_preferencial
         FROM produtos p
         LEFT JOIN fornecedores f ON f.id = p.fornecedor_id AND f.empresa_id = p.empresa_id
         WHERE (p.empresa_id = $1 OR (p.empresa_id IS NULL AND p.empresa = $2))
           AND p.deletado_em IS NULL
           AND p.estoque_minimo > 0
           AND p.estoque < p.estoque_minimo
         ORDER BY (p.estoque_minimo - p.estoque) DESC, p.nome`,
        [empresaResolvida.id, empresaResolvida.nome]
      );

      const itens = result.rows.map((r) => ({
        id:                     Number(r.id),
        nome:                   r.nome,
        categoria:              r.categoria || '',
        codigo_barras:          r.codigo_barras || '',
        estoque_atual:          Number(r.estoque_atual  || 0),
        estoque_minimo:         Number(r.estoque_minimo || 0),
        qtd_sugerida:           Math.max(1, Number(r.qtd_sugerida || 1)),
        custo_estimado:         Number(r.custo_medio || r.custo || 0),
        fornecedor_preferencial: r.fornecedor_preferencial || null
      }));

      const total_estimado = itens.reduce(
        (acc, i) => acc + i.qtd_sugerida * i.custo_estimado, 0
      );

      return res.json({
        sucesso: true,
        total_itens: itens.length,
        total_estimado: Number(total_estimado.toFixed(2)),
        itens
      });
    } catch (err) {
      console.error('[estoque] sugestao-compra:', err.message);
      return res.status(500).json({ sucesso: false, erro: 'Erro ao gerar sugestão de compra' });
    }
  });

  return router;
};
