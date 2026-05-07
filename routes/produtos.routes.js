module.exports = ({
  auth,
  apenasAdmin,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  validarLimitePlano,
  normalizarDecimal,
  normalizarInt,
  registrarMovimentacaoEstoque,
  registrarAuditoria,
  obterPeriodo,
  adicionarFiltroPeriodo
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

  function normalizarProduto(row) {
    return {
      ...row,
      id: Number(row.id || 0),
      empresa_id: row.empresa_id ? Number(row.empresa_id) : null,
      preco: Number(row.preco || 0),
      custo: Number(row.custo || 0),
      custo_unitario: Number(row.custo_unitario || row.custo || 0),
      custo_medio: Number(row.custo_medio || row.custo || 0),
      lucro_unitario: Number(row.lucro_unitario || 0),
      margem_lucro: Number(row.margem_lucro || 0),
      preco_promocional: Number(row.preco_promocional || 0),
      promocao_ativa: Boolean(row.promocao_ativa),
      estoque: Number(row.estoque || 0),
      estoque_minimo: Number(row.estoque_minimo || 0),
      alerta_estoque: Boolean(row.alerta_estoque)
    };
  }

  // ================= PRODUTOS =================

  router.post('/', auth, async (req, res) => {
    try {
      const {
        empresa,
        nome,
        preco,
        custo,
        custo_unitario,
        custo_medio,
        preco_promocional,
        promocao_ativa,
        estoque,
        estoque_minimo,
        codigo_barras,
        categoria
      } = req.body;
      req.body;

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do produto');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const limitePlano = await validarLimitePlano({
        empresaResolvida,
        recurso: 'produtos'
      });

      if (!limitePlano.permitido) {
        return erro(res, 403, limitePlano.mensagem);
      }

      const precoFinal = normalizarDecimal(preco);
      const custoBase = normalizarDecimal(custo_unitario || custo);
      const custoMedioFinal = normalizarDecimal(custo_medio || custoBase);
      const lucroUnitario = Number((precoFinal - custoMedioFinal).toFixed(2));
      const margemLucro =
        custoMedioFinal > 0 ? Number(((lucroUnitario / custoMedioFinal) * 100).toFixed(2)) : 0;

      const result = await pool.query(
        `INSERT INTO produtos
        (empresa, empresa_id, nome, preco, custo, custo_unitario, custo_medio, lucro_unitario, margem_lucro, preco_promocional, promocao_ativa, estoque, estoque_minimo, codigo_barras, categoria, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
        RETURNING id`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          nome,
          precoFinal,
          custoBase,
          custoBase,
          custoMedioFinal,
          lucroUnitario,
          margemLucro,
          normalizarDecimal(preco_promocional),
          Boolean(promocao_ativa),
          normalizarInt(estoque),
          normalizarInt(estoque_minimo),
          codigo_barras || '',
          categoria || ''
        ]
      );

      const produtoId = result.rows[0].id;

      if (normalizarInt(estoque) > 0) {
        await registrarMovimentacaoEstoque({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          produto_id: produtoId,
          tipo: 'cadastro_inicial',
          quantidade: normalizarInt(estoque),
          observacao: 'Estoque inicial do cadastro',
          referencia_tipo: 'produto',
          referencia_id: produtoId,
          usuario_id: req.user.id
        });
      }

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'produtos',
        acao: 'cadastro',
        referencia_id: produtoId,
        dados_novos: {
          nome,
          preco,
          custo,
          estoque,
          estoque_minimo,
          codigo_barras,
          categoria
        },
        req
      });

      return ok(res, {
        id: produtoId,
        dados: {
          id: produtoId
        }
      });
    } catch (error) {
      console.error('Erro real ao cadastrar produto:', error);
      return erro(res, 500, 'Erro ao cadastrar produto');
    }
  });

  router.get('/:empresa', auth, async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const busca = (req.query.busca || '').trim().toLowerCase();

      const params = [];

      let sql = `
  SELECT *,
        CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN TRUE ELSE FALSE END AS alerta_estoque
  FROM produtos
  WHERE deletado_em IS NULL
${adicionarFiltroEmpresaSaaS({
  params,
  empresaResolvida
})}
`;

      let idx = params.length + 1;

      if (busca) {
        sql += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${idx}
            OR LOWER(COALESCE(categoria, '')) LIKE $${idx}
            OR LOWER(COALESCE(codigo_barras, '')) LIKE $${idx}
          )
        `;
        params.push(`%${busca}%`);
        idx++;
      }

      sql += ` ORDER BY nome ASC`;

      const result = await pool.query(sql, params);

      return res.json(result.rows.map(normalizarProduto));
    } catch (error) {
      console.error('Erro real ao buscar produtos:', error);
      return erro(res, 500, 'Erro ao buscar produtos');
    }
  });

  router.get('/admin/lista', auth, apenasAdmin, async (req, res) => {
    try {
      const params = [];
      let where = `WHERE deletado_em IS NULL`;

      const empresa = req.query.empresa || '';
      const busca = (req.query.busca || '').trim().toLowerCase();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      if (empresa) {
        const empresaResolvida = await validarAcessoEmpresa(req, empresa);

        if (!empresaResolvida) {
          return erro(res, 403, 'Sem acesso');
        }

        params.push(empresaResolvida.id);
        where += ` AND empresa_id = $${params.length}`;
      }

      if (busca) {
        params.push(`%${busca}%`);
        where += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${params.length}
            OR LOWER(COALESCE(categoria, '')) LIKE $${params.length}
            OR LOWER(COALESCE(codigo_barras, '')) LIKE $${params.length}
          )
        `;
      }

      where += adicionarFiltroPeriodo({
        campo: 'criado_em',
        params,
        dataInicial,
        dataFinal
      });

      const result = await pool.query(
        `SELECT *,
                CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN TRUE ELSE FALSE END AS alerta_estoque
        FROM produtos
        ${where}
        ORDER BY empresa ASC, nome ASC`,
        params
      );

      return res.json(result.rows.map(normalizarProduto));
    } catch (error) {
      console.error('Erro real ao buscar produtos admin:', error);
      return erro(res, 500, 'Erro ao buscar produtos');
    }
  });

  router.put('/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);

      const {
        empresa,
        nome,
        preco,
        custo,
        custo_unitario,
        custo_medio,
        preco_promocional,
        promocao_ativa,
        estoque,
        estoque_minimo,
        codigo_barras,
        categoria
      } = req.body;
      req.body;

      if (!id) {
        return erro(res, 400, 'Produto inválido');
      }

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do produto');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const atualResult = await pool.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      if (atualResult.rowCount === 0) {
        return erro(res, 404, 'Produto não encontrado');
      }

      const atual = atualResult.rows[0];

      const precoFinal = normalizarDecimal(preco);
      const custoBase = normalizarDecimal(custo_unitario || custo || atual.custo || 0);
      const custoMedioFinal = normalizarDecimal(custo_medio || custoBase);
      const lucroUnitario = Number((precoFinal - custoMedioFinal).toFixed(2));
      const margemLucro =
        custoMedioFinal > 0 ? Number(((lucroUnitario / custoMedioFinal) * 100).toFixed(2)) : 0;

      const estoqueAtual = normalizarInt(atual.estoque);
      const estoqueNovo = normalizarInt(estoque);
      const diferenca = estoqueNovo - estoqueAtual;

      await pool.query(
        `UPDATE produtos
        SET nome = $1,
          preco = $2,
          custo = $3,
          custo_unitario = $4,
          custo_medio = $5,
          lucro_unitario = $6,
          margem_lucro = $7,
          preco_promocional = $8,
          promocao_ativa = $9,
          estoque = $10,
          estoque_minimo = $11,
          codigo_barras = $12,
          categoria = $13,
          atualizado_em = NOW()
        WHERE id = $14 AND empresa_id = $15`,
        [
          nome,
          precoFinal,
          custoBase,
          custoBase,
          custoMedioFinal,
          lucroUnitario,
          margemLucro,
          normalizarDecimal(preco_promocional),
          Boolean(promocao_ativa),
          estoqueNovo,
          normalizarInt(estoque_minimo),
          codigo_barras || '',
          categoria || '',
          id,
          empresaResolvida.id
        ]
      );

      if (diferenca !== 0) {
        await registrarMovimentacaoEstoque({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          produto_id: id,
          tipo: diferenca > 0 ? 'ajuste_entrada' : 'ajuste_saida',
          quantidade: Math.abs(diferenca),
          observacao: 'Ajuste manual na edição do produto',
          referencia_tipo: 'produto',
          referencia_id: id,
          usuario_id: req.user.id
        });
      }

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'produtos',
        acao: 'edicao',
        referencia_id: id,
        dados_anteriores: atual,
        dados_novos: {
          nome,
          preco: precoFinal,
          custo: custoBase,
          custo_unitario: custoBase,
          custo_medio: custoMedioFinal,
          lucro_unitario: lucroUnitario,
          margem_lucro: margemLucro,
          preco_promocional: normalizarDecimal(preco_promocional),
          promocao_ativa: Boolean(promocao_ativa),
          estoque: estoqueNovo,
          estoque_minimo,
          codigo_barras,
          categoria
        },
        req
      });

      return ok(res, {
        mensagem: 'Produto atualizado com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao atualizar produto:', error);
      return erro(res, 500, 'Erro ao atualizar produto');
    }
  });

  router.delete('/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresa = req.query.empresa || req.body.empresa || null;

      if (!id) {
        return erro(res, 400, 'Produto inválido');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const produtoResult = await pool.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      if (produtoResult.rowCount === 0) {
        return erro(res, 404, 'Produto não encontrado');
      }

      const vendaItemResult = await pool.query(
        `SELECT COUNT(*) AS total
   FROM venda_itens
   WHERE produto_id = $1
   AND (
     empresa_id = $2
     OR (
       empresa_id IS NULL
       AND empresa = $3
     )
   )`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      const compraItemResult = await pool.query(
        `SELECT COUNT(*) AS total
   FROM compra_itens
   WHERE produto_id = $1
   AND (
     empresa_id = $2
     OR (
       empresa_id IS NULL
       AND empresa = $3
     )
   )`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      if (
        Number(vendaItemResult.rows[0].total || 0) > 0 ||
        Number(compraItemResult.rows[0].total || 0) > 0
      ) {
        return erro(res, 400, 'Produto já possui movimentações e não pode ser excluído');
      }

      await pool.query(
        `DELETE FROM movimentacoes_estoque
WHERE produto_id = $1
AND (
  empresa_id = $2
  OR (
    empresa_id IS NULL
    AND empresa = $3
  )
)`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      await pool.query(
        `UPDATE produtos
   SET deletado_em = NOW(),
       atualizado_em = NOW()
   WHERE id = $1
   AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'produtos',
        acao: 'soft_delete',
        referencia_id: id,
        dados_anteriores: produtoResult.rows[0],
        dados_novos: {
          deletado_em: new Date()
        },
        req
      });

      return ok(res, {
        mensagem: 'Produto excluído com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao excluir produto:', error);
      return erro(res, 500, 'Erro ao excluir produto');
    }
  });

  return router;
};
