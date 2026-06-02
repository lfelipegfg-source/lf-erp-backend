/**
 * Tabelas de Preço — LF ERP
 * Preços diferenciados por cliente, com regra percentual ou preços fixos por produto.
 *
 * Montado em /tabelas-preco pelo server.js.
 *
 * Rotas:
 *   GET    /tabelas-preco                              — listar tabelas da empresa
 *   POST   /tabelas-preco                              — criar tabela
 *   GET    /tabelas-preco/:id                          — detalhe + itens
 *   PUT    /tabelas-preco/:id                          — editar tabela
 *   DELETE /tabelas-preco/:id                          — excluir tabela
 *
 *   GET    /tabelas-preco/:id/itens                    — listar itens da tabela
 *   POST   /tabelas-preco/:id/itens                    — adicionar produto à tabela
 *   PUT    /tabelas-preco/:id/itens/:itemId            — editar preço de item
 *   DELETE /tabelas-preco/:id/itens/:itemId            — remover item
 *
 *   GET    /tabelas-preco/resolver?produto_id=&cliente_id=&quantidade= — resolve preço
 *   PUT    /tabelas-preco/clientes/:clienteId/tabela   — vincula/desvincula cliente
 */

const { resolverPreco } = require('../utils/resolverPreco');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarInt
}) => {
  const router = require('express').Router();

  function ok(res, dados = {}) {
    return res.status(200).json({ sucesso: true, ...dados });
  }
  function erro(res, status = 500, msg = 'Erro interno') {
    return res.status(status).json({ sucesso: false, erro: msg });
  }

  function normTab(row) {
    return {
      ...row,
      desconto_percentual: Number(row.desconto_percentual || 0),
      markup_percentual:   Number(row.markup_percentual   || 0),
      ativa: Boolean(row.ativa)
    };
  }

  function normItem(row) {
    return {
      ...row,
      preco: Number(row.preco || 0),
      quantidade_minima: Number(row.quantidade_minima || 1)
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function obterTabela(id, empresaId) {
    const r = await pool.query(
      `SELECT * FROM tabelas_preco WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId]
    );
    return r.rows[0] || null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /tabelas-preco/resolver  (antes das rotas /:id para não colidir)
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/resolver', auth, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const produtoId  = Number(req.query.produto_id);
      const clienteId  = req.query.cliente_id ? Number(req.query.cliente_id) : null;
      const gradeId    = req.query.grade_id    ? Number(req.query.grade_id)   : null;
      const quantidade = req.query.quantidade  ? Number(req.query.quantidade)  : 1;

      if (!produtoId) return erro(res, 400, 'produto_id é obrigatório');

      const preco = await resolverPreco({
        pool,
        produtoId,
        gradeId,
        clienteId,
        empresaId: empresaResolvida.id,
        quantidade
      });

      if (preco === null) return erro(res, 404, 'Produto não encontrado');

      return ok(res, { preco });
    } catch (err) {
      console.error('[tabelas-preco] GET resolver:', err.message);
      return erro(res, 500, 'Erro ao resolver preço');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /tabelas-preco/dashboard — resumo para o painel gerencial
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/dashboard', auth, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const [statsResult, tabelasResult] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(DISTINCT t.id) AS total_tabelas,
             COUNT(DISTINCT c.id) AS total_clientes
           FROM tabelas_preco t
           LEFT JOIN clientes c
             ON c.tabela_preco_id = t.id AND c.empresa_id = t.empresa_id
           WHERE t.empresa_id = $1 AND t.ativa = true`,
          [empresaResolvida.id]
        ),
        pool.query(
          `SELECT t.id, t.nome, t.tipo,
                  t.desconto_percentual, t.markup_percentual,
                  COUNT(c.id) AS total_clientes
           FROM tabelas_preco t
           LEFT JOIN clientes c
             ON c.tabela_preco_id = t.id AND c.empresa_id = t.empresa_id
           WHERE t.empresa_id = $1 AND t.ativa = true
           GROUP BY t.id
           ORDER BY total_clientes DESC, t.nome
           LIMIT 10`,
          [empresaResolvida.id]
        )
      ]);

      const stats = statsResult.rows[0];

      return ok(res, {
        total_tabelas:  Number(stats.total_tabelas  || 0),
        total_clientes: Number(stats.total_clientes || 0),
        tabelas: tabelasResult.rows.map((t) => ({
          id:                    t.id,
          nome:                  t.nome,
          tipo:                  t.tipo,
          desconto_percentual:   Number(t.desconto_percentual || 0),
          markup_percentual:     Number(t.markup_percentual   || 0),
          total_clientes:        Number(t.total_clientes      || 0)
        }))
      });
    } catch (err) {
      console.error('[tabelas-preco] GET dashboard:', err.message);
      return erro(res, 500, 'Erro ao carregar resumo de tabelas de preço');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /tabelas-preco
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/', auth, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT t.*,
                COUNT(ti.id) AS total_itens,
                COUNT(c.id)  AS total_clientes
         FROM tabelas_preco t
         LEFT JOIN tabela_preco_itens ti ON ti.tabela_id = t.id
         LEFT JOIN clientes c ON c.tabela_preco_id = t.id AND c.empresa_id = t.empresa_id
         WHERE t.empresa_id = $1
         GROUP BY t.id
         ORDER BY t.nome`,
        [empresaResolvida.id]
      );

      return ok(res, { tabelas: result.rows.map(normTab) });
    } catch (err) {
      console.error('[tabelas-preco] GET lista:', err.message);
      return erro(res, 500, 'Erro ao listar tabelas de preço');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /tabelas-preco
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/', auth, writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { nome, descricao, tipo, desconto_percentual, markup_percentual } = req.body;
      if (!nome) return erro(res, 400, 'Nome da tabela é obrigatório');

      const tipoFinal = ['percentual', 'fixo'].includes(tipo) ? tipo : 'percentual';

      const result = await pool.query(
        `INSERT INTO tabelas_preco
           (empresa_id, nome, descricao, tipo, desconto_percentual, markup_percentual)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          empresaResolvida.id,
          nome.trim(),
          descricao || null,
          tipoFinal,
          normalizarDecimal(desconto_percentual),
          normalizarDecimal(markup_percentual)
        ]
      );

      return ok(res, { tabela: normTab(result.rows[0]) });
    } catch (err) {
      if (err.code === '23505') return erro(res, 409, 'Já existe uma tabela com este nome');
      console.error('[tabelas-preco] POST:', err.message);
      return erro(res, 500, 'Erro ao criar tabela de preço');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /tabelas-preco/:id  — detalhe com itens
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const tabela = await obterTabela(id, empresaResolvida.id);
      if (!tabela) return erro(res, 404, 'Tabela não encontrada');

      const itens = await pool.query(
        `SELECT ti.*, p.nome AS produto_nome, p.preco AS preco_padrao,
                pg.atributo1, pg.atributo2
         FROM tabela_preco_itens ti
         JOIN produtos p ON p.id = ti.produto_id
         LEFT JOIN produto_grades pg ON pg.id = ti.grade_id
         WHERE ti.tabela_id = $1
         ORDER BY p.nome, ti.quantidade_minima`,
        [id]
      );

      const clientes = await pool.query(
        `SELECT id, nome FROM clientes WHERE tabela_preco_id = $1 AND empresa_id = $2 ORDER BY nome`,
        [id, empresaResolvida.id]
      );

      return ok(res, {
        tabela: normTab(tabela),
        itens: itens.rows.map(normItem),
        clientes: clientes.rows
      });
    } catch (err) {
      console.error('[tabelas-preco] GET :id:', err.message);
      return erro(res, 500, 'Erro ao buscar tabela');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /tabelas-preco/:id
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/:id', auth, writeRateLimiter, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      if (!await obterTabela(id, empresaResolvida.id)) return erro(res, 404, 'Tabela não encontrada');

      const { nome, descricao, tipo, desconto_percentual, markup_percentual, ativa } = req.body;

      const result = await pool.query(
        `UPDATE tabelas_preco SET
           nome                = COALESCE($1, nome),
           descricao           = COALESCE($2, descricao),
           tipo                = COALESCE($3, tipo),
           desconto_percentual = COALESCE($4, desconto_percentual),
           markup_percentual   = COALESCE($5, markup_percentual),
           ativa               = COALESCE($6, ativa),
           atualizado_em       = NOW()
         WHERE id = $7 AND empresa_id = $8
         RETURNING *`,
        [
          nome?.trim() || null,
          descricao !== undefined ? descricao : null,
          tipo || null,
          desconto_percentual != null ? normalizarDecimal(desconto_percentual) : null,
          markup_percentual   != null ? normalizarDecimal(markup_percentual)   : null,
          ativa != null ? Boolean(ativa) : null,
          id,
          empresaResolvida.id
        ]
      );

      return ok(res, { tabela: normTab(result.rows[0]) });
    } catch (err) {
      console.error('[tabelas-preco] PUT:', err.message);
      return erro(res, 500, 'Erro ao editar tabela');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /tabelas-preco/:id
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/:id', auth, writeRateLimiter, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      // Desvincula clientes antes de deletar
      await pool.query(
        `UPDATE clientes SET tabela_preco_id = NULL WHERE tabela_preco_id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      const r = await pool.query(
        `DELETE FROM tabelas_preco WHERE id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Tabela não encontrada');
      return ok(res, { mensagem: 'Tabela excluída com sucesso' });
    } catch (err) {
      console.error('[tabelas-preco] DELETE:', err.message);
      return erro(res, 500, 'Erro ao excluir tabela');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ITENS — POST /tabelas-preco/:id/itens
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/itens', auth, writeRateLimiter, async (req, res) => {
    try {
      const tabelaId = Number(req.params.id);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      if (!await obterTabela(tabelaId, empresaResolvida.id)) return erro(res, 404, 'Tabela não encontrada');

      const { produto_id, grade_id, preco, quantidade_minima } = req.body;
      if (!produto_id || preco == null) return erro(res, 400, 'produto_id e preco são obrigatórios');

      const result = await pool.query(
        `INSERT INTO tabela_preco_itens
           (tabela_id, produto_id, empresa_id, grade_id, preco, quantidade_minima)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT ON CONSTRAINT idx_tpi_unique
         DO UPDATE SET preco = $5, atualizado_em = NOW()
         RETURNING *`,
        [
          tabelaId,
          Number(produto_id),
          empresaResolvida.id,
          grade_id ? Number(grade_id) : null,
          normalizarDecimal(preco),
          normalizarInt(quantidade_minima) || 1
        ]
      );

      return ok(res, { item: normItem(result.rows[0]) });
    } catch (err) {
      console.error('[tabelas-preco] POST item:', err.message);
      return erro(res, 500, 'Erro ao adicionar produto à tabela');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /tabelas-preco/:id/itens/:itemId
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/:id/itens/:itemId', auth, writeRateLimiter, async (req, res) => {
    try {
      const tabelaId = Number(req.params.id);
      const itemId   = Number(req.params.itemId);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { preco, quantidade_minima } = req.body;

      const result = await pool.query(
        `UPDATE tabela_preco_itens SET
           preco             = COALESCE($1, preco),
           quantidade_minima = COALESCE($2, quantidade_minima),
           atualizado_em     = NOW()
         WHERE id = $3 AND tabela_id = $4 AND empresa_id = $5
         RETURNING *`,
        [
          preco != null ? normalizarDecimal(preco) : null,
          quantidade_minima != null ? normalizarInt(quantidade_minima) : null,
          itemId, tabelaId, empresaResolvida.id
        ]
      );

      if (result.rowCount === 0) return erro(res, 404, 'Item não encontrado');
      return ok(res, { item: normItem(result.rows[0]) });
    } catch (err) {
      console.error('[tabelas-preco] PUT item:', err.message);
      return erro(res, 500, 'Erro ao editar item');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /tabelas-preco/:id/itens/:itemId
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/:id/itens/:itemId', auth, writeRateLimiter, async (req, res) => {
    try {
      const tabelaId = Number(req.params.id);
      const itemId   = Number(req.params.itemId);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `DELETE FROM tabela_preco_itens WHERE id = $1 AND tabela_id = $2 AND empresa_id = $3`,
        [itemId, tabelaId, empresaResolvida.id]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Item não encontrado');
      return ok(res, { mensagem: 'Item removido da tabela' });
    } catch (err) {
      console.error('[tabelas-preco] DELETE item:', err.message);
      return erro(res, 500, 'Erro ao remover item');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /tabelas-preco/clientes/:clienteId/tabela — vincula/desvincula cliente
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/clientes/:clienteId/tabela', auth, writeRateLimiter, async (req, res) => {
    try {
      const clienteId = Number(req.params.clienteId);
      const { tabela_preco_id } = req.body; // null para desvincular
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      // Valida tabela se informada
      if (tabela_preco_id) {
        const tab = await obterTabela(Number(tabela_preco_id), empresaResolvida.id);
        if (!tab) return erro(res, 404, 'Tabela de preço não encontrada');
        if (!tab.ativa) return erro(res, 400, 'Tabela de preço está inativa');
      }

      const r = await pool.query(
        `UPDATE clientes SET tabela_preco_id = $1, atualizado_em = NOW()
         WHERE id = $2 AND empresa_id = $3
         RETURNING id, nome, tabela_preco_id`,
        [tabela_preco_id || null, clienteId, empresaResolvida.id]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');
      return ok(res, {
        cliente: r.rows[0],
        mensagem: tabela_preco_id ? 'Tabela de preço vinculada' : 'Tabela de preço removida do cliente'
      });
    } catch (err) {
      console.error('[tabelas-preco] PUT cliente tabela:', err.message);
      return erro(res, 500, 'Erro ao vincular tabela ao cliente');
    }
  });

  return router;
};
