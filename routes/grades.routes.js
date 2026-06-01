/**
 * Grades de Produto — LF ERP
 * Gerencia variações (tamanho/cor) com estoque próprio por grade.
 *
 * Montado em /grades pelo server.js.
 * Rotas:
 *   GET    /grades/produto/:produtoId          — listar grades do produto
 *   POST   /grades/produto/:produtoId          — criar grade
 *   PUT    /grades/:gradeId                    — editar grade
 *   DELETE /grades/:gradeId                    — deletar grade (se sem vendas)
 *   PATCH  /grades/produto/:produtoId/toggle   — ativar/desativar modo grade no produto
 *
 *   GET    /grades/atributos                   — listar atributos da empresa
 *   POST   /grades/atributos                   — criar atributo
 *   PUT    /grades/atributos/:id               — editar atributo
 *   DELETE /grades/atributos/:id               — deletar atributo
 */

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarInt,
  registrarMovimentacaoEstoque
}) => {
  const router = require('express').Router();

  function ok(res, dados = {}) {
    return res.status(200).json({ sucesso: true, ...dados });
  }

  function erro(res, status = 500, mensagem = 'Erro interno') {
    return res.status(status).json({ sucesso: false, erro: mensagem });
  }

  function normalizarGrade(row) {
    return {
      ...row,
      id: Number(row.id),
      produto_id: Number(row.produto_id),
      empresa_id: Number(row.empresa_id),
      preco: row.preco != null ? Number(row.preco) : null,
      custo: row.custo != null ? Number(row.custo) : null,
      estoque: Number(row.estoque || 0),
      estoque_minimo: Number(row.estoque_minimo || 0),
      ativo: Boolean(row.ativo)
    };
  }

  // ─────────────────────────────────────────────
  // GRADES DE UM PRODUTO
  // ─────────────────────────────────────────────

  // GET /grades/produto/:produtoId
  router.get('/produto/:produtoId', auth, async (req, res) => {
    try {
      const produtoId = Number(req.params.produtoId);
      if (!produtoId) return erro(res, 400, 'ID de produto inválido');

      const produto = await pool.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [produtoId, req.empresa_id]
      );
      if (produto.rowCount === 0) return erro(res, 404, 'Produto não encontrado');

      const empresaResolvida = await validarAcessoEmpresa(req, produto.rows[0].empresa, produto.rows[0].empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT * FROM produto_grades
         WHERE produto_id = $1 AND empresa_id = $2
         ORDER BY atributo1, atributo2`,
        [produtoId, empresaResolvida.id]
      );

      return ok(res, { grades: result.rows.map(normalizarGrade) });
    } catch (err) {
      console.error('[grades] GET produto grades:', err.message);
      return erro(res, 500, 'Erro ao buscar grades');
    }
  });

  // POST /grades/produto/:produtoId
  router.post('/produto/:produtoId', auth, writeRateLimiter, async (req, res) => {
    try {
      const produtoId = Number(req.params.produtoId);
      if (!produtoId) return erro(res, 400, 'ID de produto inválido');

      const { atributo1, atributo2, sku, gtin, preco, custo, estoque, estoque_minimo } = req.body;

      if (!atributo1) return erro(res, 400, 'Informe ao menos o atributo1 (ex: tamanho)');

      const prodResult = await pool.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [produtoId, req.empresa_id]
      );
      if (prodResult.rowCount === 0) return erro(res, 404, 'Produto não encontrado');

      const produto = prodResult.rows[0];
      const empresaResolvida = await validarAcessoEmpresa(req, produto.empresa, produto.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      // Garante que o produto está em modo grade
      if (!produto.tem_grade) {
        await pool.query(
          `UPDATE produtos SET tem_grade = true, atualizado_em = NOW() WHERE id = $1`,
          [produtoId]
        );
      }

      const estoqueInicial = normalizarInt(estoque);

      const result = await pool.query(
        `INSERT INTO produto_grades
          (produto_id, empresa_id, atributo1, atributo2, sku, gtin, preco, custo, estoque, estoque_minimo, ativo, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,NOW(),NOW())
         RETURNING *`,
        [
          produtoId,
          empresaResolvida.id,
          atributo1,
          atributo2 || null,
          sku || null,
          gtin || null,
          preco != null ? normalizarDecimal(preco) : null,
          custo != null ? normalizarDecimal(custo) : null,
          estoqueInicial,
          normalizarInt(estoque_minimo)
        ]
      );

      const grade = result.rows[0];

      // Registra movimentação se houver estoque inicial
      if (estoqueInicial > 0) {
        await registrarMovimentacaoEstoque({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          produto_id: produtoId,
          grade_id: grade.id,
          tipo: 'cadastro_inicial',
          quantidade: estoqueInicial,
          observacao: `Estoque inicial da grade ${atributo1}${atributo2 ? ' / ' + atributo2 : ''}`,
          referencia_tipo: 'grade',
          referencia_id: grade.id,
          usuario_id: req.user?.id
        });
      }

      // Sincroniza estoque do produto-pai como soma das grades
      await sincronizarEstoqueProduto(pool, produtoId, empresaResolvida.id);

      return ok(res, { grade: normalizarGrade(grade) });
    } catch (err) {
      console.error('[grades] POST grade:', err.message);
      return erro(res, 500, 'Erro ao criar grade');
    }
  });

  // PUT /grades/:gradeId
  router.put('/:gradeId', auth, writeRateLimiter, async (req, res) => {
    try {
      const gradeId = Number(req.params.gradeId);
      if (!gradeId) return erro(res, 400, 'ID de grade inválido');

      const gradeResult = await pool.query(
        `SELECT pg.*, p.empresa, p.empresa_id AS prod_empresa_id
         FROM produto_grades pg
         JOIN produtos p ON p.id = pg.produto_id
         WHERE pg.id = $1`,
        [gradeId]
      );
      if (gradeResult.rowCount === 0) return erro(res, 404, 'Grade não encontrada');

      const grade = gradeResult.rows[0];
      const empresaResolvida = await validarAcessoEmpresa(req, grade.empresa, grade.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { atributo1, atributo2, sku, gtin, preco, custo, estoque, estoque_minimo, ativo } = req.body;

      const estoqueAnterior = normalizarInt(grade.estoque);
      const estoqueNovo = estoque != null ? normalizarInt(estoque) : estoqueAnterior;

      const updated = await pool.query(
        `UPDATE produto_grades SET
           atributo1     = COALESCE($1, atributo1),
           atributo2     = COALESCE($2, atributo2),
           sku           = COALESCE($3, sku),
           gtin          = COALESCE($4, gtin),
           preco         = COALESCE($5, preco),
           custo         = COALESCE($6, custo),
           estoque       = $7,
           estoque_minimo = COALESCE($8, estoque_minimo),
           ativo         = COALESCE($9, ativo),
           atualizado_em = NOW()
         WHERE id = $10
         RETURNING *`,
        [
          atributo1 || null,
          atributo2 || null,
          sku || null,
          gtin || null,
          preco != null ? normalizarDecimal(preco) : null,
          custo != null ? normalizarDecimal(custo) : null,
          estoqueNovo,
          estoque_minimo != null ? normalizarInt(estoque_minimo) : null,
          ativo != null ? Boolean(ativo) : null,
          gradeId
        ]
      );

      // Movimentação se estoque mudou manualmente
      if (estoqueNovo !== estoqueAnterior) {
        const diff = estoqueNovo - estoqueAnterior;
        await registrarMovimentacaoEstoque({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          produto_id: grade.produto_id,
          grade_id: gradeId,
          tipo: diff > 0 ? 'ajuste_entrada' : 'ajuste_saida',
          quantidade: Math.abs(diff),
          observacao: 'Ajuste manual de estoque na grade',
          referencia_tipo: 'grade',
          referencia_id: gradeId,
          usuario_id: req.user?.id
        });

        await sincronizarEstoqueProduto(pool, grade.produto_id, empresaResolvida.id);
      }

      return ok(res, { grade: normalizarGrade(updated.rows[0]) });
    } catch (err) {
      console.error('[grades] PUT grade:', err.message);
      return erro(res, 500, 'Erro ao editar grade');
    }
  });

  // DELETE /grades/:gradeId
  router.delete('/:gradeId', auth, writeRateLimiter, async (req, res) => {
    try {
      const gradeId = Number(req.params.gradeId);
      if (!gradeId) return erro(res, 400, 'ID de grade inválido');

      const gradeResult = await pool.query(
        `SELECT pg.*, p.empresa, p.empresa_id AS prod_empresa_id
         FROM produto_grades pg
         JOIN produtos p ON p.id = pg.produto_id
         WHERE pg.id = $1`,
        [gradeId]
      );
      if (gradeResult.rowCount === 0) return erro(res, 404, 'Grade não encontrada');

      const grade = gradeResult.rows[0];
      const empresaResolvida = await validarAcessoEmpresa(req, grade.empresa, grade.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      // Bloqueia deleção se há vendas com esta grade
      const vendas = await pool.query(
        `SELECT COUNT(*) AS total FROM venda_itens WHERE grade_id = $1`,
        [gradeId]
      );
      if (Number(vendas.rows[0].total) > 0) {
        return erro(res, 400, 'Não é possível excluir grade com vendas registradas. Inative-a em vez de excluir.');
      }

      await pool.query(`DELETE FROM produto_grades WHERE id = $1`, [gradeId]);
      await sincronizarEstoqueProduto(pool, grade.produto_id, empresaResolvida.id);

      return ok(res, { mensagem: 'Grade excluída com sucesso' });
    } catch (err) {
      console.error('[grades] DELETE grade:', err.message);
      return erro(res, 500, 'Erro ao excluir grade');
    }
  });

  // PATCH /grades/produto/:produtoId/toggle — ativa/desativa modo grade
  router.patch('/produto/:produtoId/toggle', auth, writeRateLimiter, async (req, res) => {
    try {
      const produtoId = Number(req.params.produtoId);
      if (!produtoId) return erro(res, 400, 'ID inválido');

      const prodResult = await pool.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [produtoId, req.empresa_id]
      );
      if (prodResult.rowCount === 0) return erro(res, 404, 'Produto não encontrado');

      const produto = prodResult.rows[0];
      const empresaResolvida = await validarAcessoEmpresa(req, produto.empresa, produto.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const novoValor = !Boolean(produto.tem_grade);

      // Não permite desativar grade se houver grades cadastradas com estoque
      if (!novoValor) {
        const grades = await pool.query(
          `SELECT COUNT(*) AS total FROM produto_grades WHERE produto_id = $1 AND estoque > 0`,
          [produtoId]
        );
        if (Number(grades.rows[0].total) > 0) {
          return erro(res, 400, 'Zere o estoque de todas as grades antes de desativar o modo grade.');
        }
      }

      await pool.query(
        `UPDATE produtos SET tem_grade = $1, atualizado_em = NOW() WHERE id = $2`,
        [novoValor, produtoId]
      );

      return ok(res, { tem_grade: novoValor });
    } catch (err) {
      console.error('[grades] PATCH toggle:', err.message);
      return erro(res, 500, 'Erro ao alterar modo grade');
    }
  });

  // ─────────────────────────────────────────────
  // ATRIBUTOS
  // ─────────────────────────────────────────────

  // GET /grades/atributos
  router.get('/atributos', auth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM produto_atributos WHERE empresa_id = $1 ORDER BY nome`,
        [req.empresa_id]
      );
      return ok(res, { atributos: result.rows });
    } catch (err) {
      console.error('[grades] GET atributos:', err.message);
      return erro(res, 500, 'Erro ao buscar atributos');
    }
  });

  // POST /grades/atributos
  router.post('/atributos', auth, writeRateLimiter, async (req, res) => {
    try {
      const { nome, valores } = req.body;
      if (!nome) return erro(res, 400, 'Informe o nome do atributo');
      if (!Array.isArray(valores) || valores.length === 0) {
        return erro(res, 400, 'Informe os valores do atributo (array)');
      }

      const result = await pool.query(
        `INSERT INTO produto_atributos (empresa_id, nome, valores)
         VALUES ($1, $2, $3)
         ON CONFLICT (empresa_id, nome) DO UPDATE SET valores = $3
         RETURNING *`,
        [req.empresa_id, nome.trim(), valores]
      );

      return ok(res, { atributo: result.rows[0] });
    } catch (err) {
      console.error('[grades] POST atributo:', err.message);
      return erro(res, 500, 'Erro ao criar atributo');
    }
  });

  // PUT /grades/atributos/:id
  router.put('/atributos/:id', auth, writeRateLimiter, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { nome, valores } = req.body;

      const result = await pool.query(
        `UPDATE produto_atributos
         SET nome   = COALESCE($1, nome),
             valores = COALESCE($2, valores)
         WHERE id = $3 AND empresa_id = $4
         RETURNING *`,
        [nome || null, valores || null, id, req.empresa_id]
      );

      if (result.rowCount === 0) return erro(res, 404, 'Atributo não encontrado');
      return ok(res, { atributo: result.rows[0] });
    } catch (err) {
      console.error('[grades] PUT atributo:', err.message);
      return erro(res, 500, 'Erro ao editar atributo');
    }
  });

  // DELETE /grades/atributos/:id
  router.delete('/atributos/:id', auth, writeRateLimiter, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await pool.query(
        `DELETE FROM produto_atributos WHERE id = $1 AND empresa_id = $2`,
        [id, req.empresa_id]
      );
      if (result.rowCount === 0) return erro(res, 404, 'Atributo não encontrado');
      return ok(res, { mensagem: 'Atributo excluído' });
    } catch (err) {
      console.error('[grades] DELETE atributo:', err.message);
      return erro(res, 500, 'Erro ao excluir atributo');
    }
  });

  return router;
};

// ─────────────────────────────────────────────
// Helper: sincroniza produtos.estoque com SUM das grades
// ─────────────────────────────────────────────
async function sincronizarEstoqueProduto(pool, produtoId, empresaId) {
  await pool.query(
    `UPDATE produtos
     SET estoque = (
       SELECT COALESCE(SUM(estoque), 0)
       FROM produto_grades
       WHERE produto_id = $1 AND empresa_id = $2 AND ativo = true
     ),
     atualizado_em = NOW()
     WHERE id = $1 AND empresa_id = $2`,
    [produtoId, empresaId]
  );
}
