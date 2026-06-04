/**
 * Rastreabilidade — LF ERP
 * Controle de lotes e números de série por produto.
 *
 * Config:
 *   PUT  /rastreabilidade/produtos/:id/config   — define modo (none/lote/serie)
 *   GET  /rastreabilidade/produtos              — lista produtos com rastreabilidade ativa
 *
 * Lotes:
 *   GET    /rastreabilidade/lotes               — listar (filtros: produto_id, vencendo, vencido)
 *   POST   /rastreabilidade/lotes               — criar lote (entrada)
 *   GET    /rastreabilidade/lotes/:id           — detalhe + movimentos
 *   POST   /rastreabilidade/lotes/:id/saida     — registrar saída de estoque
 *   DELETE /rastreabilidade/lotes/:id           — excluir lote sem movimentos
 *
 * Séries:
 *   GET    /rastreabilidade/series              — listar (filtros: produto_id, status)
 *   POST   /rastreabilidade/series              — cadastrar número(s) de série
 *   PATCH  /rastreabilidade/series/:id/status   — atualizar status
 *
 * Rastreamento:
 *   GET    /rastreabilidade/rastrear?q=         — busca lote ou série, retorna histórico completo
 *   GET    /rastreabilidade/dashboard           — KPIs: lotes vencendo, series disponíveis, etc.
 */

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarInt, normalizarDataISO, hoje }) {
  const router = require('express').Router();

  function ok(res, dados = {})              { return res.json({ sucesso: true, ...dados }); }
  function erro(res, status = 500, msg = 'Erro interno') { return res.status(status).json({ sucesso: false, erro: msg }); }
  async function emp(req)                   { return validarAcessoEmpresa(req, null, req.empresa_id); }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  router.get('/dashboard', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const hojeStr = hoje();

      const [lotesResult, seriesResult, vencendoResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS total, COALESCE(SUM(quantidade_atual),0) AS qtd_total
           FROM lotes WHERE empresa_id = $1 AND quantidade_atual > 0`,
          [e.id]
        ),
        pool.query(
          `SELECT status, COUNT(*) AS total FROM numeros_serie WHERE empresa_id = $1 GROUP BY status`,
          [e.id]
        ),
        pool.query(
          `SELECT COUNT(*) AS vencendo, COUNT(*) FILTER (WHERE data_validade < $2) AS vencidos
           FROM lotes WHERE empresa_id = $1 AND data_validade IS NOT NULL AND quantidade_atual > 0
             AND data_validade <= ($2::date + INTERVAL '30 days')`,
          [e.id, hojeStr]
        )
      ]);

      const series = {};
      for (const row of seriesResult.rows) series[row.status] = Number(row.total);

      return ok(res, {
        lotes_ativos:     Number(lotesResult.rows[0].total),
        qtd_em_lotes:     Number(lotesResult.rows[0].qtd_total),
        lotes_vencendo:   Number(vencendoResult.rows[0].vencendo),
        lotes_vencidos:   Number(vencendoResult.rows[0].vencidos),
        series_disponivel: series.disponivel  || 0,
        series_vendido:    series.vendido     || 0,
        series_defeito:    series.defeito     || 0,
        series_devolvido:  series.devolvido   || 0
      });
    } catch (err) {
      console.error('[rastreabilidade] dashboard:', err.message);
      return erro(res, 500, 'Erro ao carregar dashboard');
    }
  });

  // ── Config por produto ────────────────────────────────────────────────────

  router.put('/produtos/:id/config', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { controla_rastreabilidade } = req.body;
      const modos = ['none', 'lote', 'serie'];
      if (!modos.includes(controla_rastreabilidade)) return erro(res, 400, `Modo inválido. Use: ${modos.join(', ')}`);

      const r = await pool.query(
        `UPDATE produtos SET controla_rastreabilidade = $1, atualizado_em = NOW()
         WHERE id = $2 AND empresa_id = $3 RETURNING id, nome, controla_rastreabilidade`,
        [controla_rastreabilidade, Number(req.params.id), e.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Produto não encontrado');
      return ok(res, { produto: r.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao configurar produto');
    }
  });

  router.get('/produtos', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT id, nome, controla_rastreabilidade, estoque, codigo_barras
         FROM produtos
         WHERE empresa_id = $1 AND controla_rastreabilidade != 'none' AND deletado_em IS NULL
         ORDER BY nome`,
        [e.id]
      );
      return ok(res, { produtos: result.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar produtos rastreados');
    }
  });

  // ── Lotes ─────────────────────────────────────────────────────────────────

  router.get('/lotes', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { produto_id, vencendo, vencido, incluir_zerados } = req.query;
      const hojeStr = hoje();

      const params = [e.id];
      let where = `WHERE l.empresa_id = $1`;
      if (produto_id)           { params.push(Number(produto_id)); where += ` AND l.produto_id = $${params.length}`; }
      if (!incluir_zerados)     where += ` AND l.quantidade_atual > 0`;
      if (vencido === 'true')   { params.push(hojeStr); where += ` AND l.data_validade < $${params.length}`; }
      if (vencendo === 'true')  { params.push(hojeStr); where += ` AND l.data_validade BETWEEN $${params.length}::date AND $${params.length}::date + INTERVAL '30 days'`; }

      const result = await pool.query(
        `SELECT l.*, p.nome AS produto_nome_atual,
                CASE WHEN l.data_validade IS NOT NULL AND l.data_validade < $${params.length + 1}::date THEN true ELSE false END AS vencido,
                CASE WHEN l.data_validade IS NOT NULL AND l.data_validade BETWEEN $${params.length + 1}::date AND $${params.length + 1}::date + INTERVAL '30 days' THEN true ELSE false END AS vencendo
         FROM lotes l
         LEFT JOIN produtos p ON p.id = l.produto_id
         ${where}
         ORDER BY l.data_validade NULLS LAST, l.criado_em DESC`,
        [...params, hojeStr]
      );

      return ok(res, { lotes: result.rows });
    } catch (err) {
      console.error('[rastreabilidade] GET lotes:', err.message);
      return erro(res, 500, 'Erro ao listar lotes');
    }
  });

  router.post('/lotes', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { produto_id, numero, data_fabricacao, data_validade, quantidade, compra_id, observacoes } = req.body;
      if (!produto_id || !numero?.trim()) return erro(res, 400, 'produto_id e numero são obrigatórios');
      const qtd = normalizarInt(quantidade) || 0;

      const prodResult = await pool.query(
        `SELECT id, nome FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [Number(produto_id), e.id]
      );
      if (prodResult.rowCount === 0) return erro(res, 404, 'Produto não encontrado');
      const produto = prodResult.rows[0];

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const loteResult = await client.query(
          `INSERT INTO lotes (empresa_id, produto_id, produto_nome, numero, data_fabricacao, data_validade,
                              quantidade_entrada, quantidade_atual, compra_id, observacoes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)
           ON CONFLICT (empresa_id, produto_id, numero) DO UPDATE
             SET quantidade_entrada = lotes.quantidade_entrada + $7,
                 quantidade_atual   = lotes.quantidade_atual   + $7,
                 atualizado_em      = NOW()
           RETURNING *`,
          [
            e.id, produto.id, produto.nome, numero.trim(),
            normalizarDataISO(data_fabricacao) || null,
            normalizarDataISO(data_validade)   || null,
            qtd,
            compra_id ? Number(compra_id) : null,
            observacoes?.trim() || null
          ]
        );
        const lote = loteResult.rows[0];

        // Registra movimento de entrada
        if (qtd > 0) {
          await client.query(
            `INSERT INTO rastreabilidade_movimentos
               (empresa_id, tipo, referencia_tipo, referencia_id, lote_id, produto_id, produto_nome, quantidade, observacao, usuario_id)
             VALUES ($1,'entrada',$2,$3,$4,$5,$6,$7,$8,$9)`,
            [e.id, compra_id ? 'compra' : 'manual', compra_id || null, lote.id, produto.id, produto.nome, qtd, observacoes?.trim() || null, req.user.id]
          );
        }

        await client.query('COMMIT');
        return res.status(201).json({ sucesso: true, lote });
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return erro(res, 409, 'Já existe um lote com este número para este produto');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[rastreabilidade] POST lote:', err.message);
      return erro(res, 500, err.message);
    }
  });

  router.get('/lotes/:id', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const [loteResult, movResult] = await Promise.all([
        pool.query(
          `SELECT l.*, p.nome AS produto_nome_atual
           FROM lotes l LEFT JOIN produtos p ON p.id = l.produto_id
           WHERE l.id = $1 AND l.empresa_id = $2`,
          [Number(req.params.id), e.id]
        ),
        pool.query(
          `SELECT m.*, v.cliente_nome, c.fornecedor_id
           FROM rastreabilidade_movimentos m
           LEFT JOIN vendas v ON v.id = m.referencia_id AND m.referencia_tipo = 'venda'
           LEFT JOIN compras c ON c.id = m.referencia_id AND m.referencia_tipo = 'compra'
           WHERE m.lote_id = $1
           ORDER BY m.criado_em DESC`,
          [Number(req.params.id)]
        )
      ]);

      if (loteResult.rowCount === 0) return erro(res, 404, 'Lote não encontrado');
      return ok(res, { lote: loteResult.rows[0], movimentos: movResult.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar lote');
    }
  });

  router.post('/lotes/:id/saida', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const loteId  = Number(req.params.id);
      const { quantidade, venda_id, observacao } = req.body;
      const qtd = normalizarInt(quantidade) || 1;

      const loteResult = await pool.query(
        `SELECT * FROM lotes WHERE id = $1 AND empresa_id = $2`,
        [loteId, e.id]
      );
      if (loteResult.rowCount === 0) return erro(res, 404, 'Lote não encontrado');
      const lote = loteResult.rows[0];

      if (lote.quantidade_atual < qtd) return erro(res, 400, `Saldo insuficiente. Disponível: ${lote.quantidade_atual}`);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `UPDATE lotes SET quantidade_atual = quantidade_atual - $1, atualizado_em = NOW() WHERE id = $2`,
          [qtd, loteId]
        );

        await client.query(
          `INSERT INTO rastreabilidade_movimentos
             (empresa_id, tipo, referencia_tipo, referencia_id, lote_id, produto_id, produto_nome, quantidade, observacao, usuario_id)
           VALUES ($1,'saida',$2,$3,$4,$5,$6,$7,$8,$9)`,
          [e.id, venda_id ? 'venda' : 'manual', venda_id || null, loteId, lote.produto_id, lote.produto_nome, qtd, observacao?.trim() || null, req.user.id]
        );

        await client.query('COMMIT');
        return ok(res, { mensagem: `${qtd} unidade(s) baixada(s) do lote ${lote.numero}` });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[rastreabilidade] POST saida lote:', err.message);
      return erro(res, 500, err.message);
    }
  });

  router.delete('/lotes/:id', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const movCount = await pool.query(
        `SELECT COUNT(*) FROM rastreabilidade_movimentos WHERE lote_id = $1`,
        [Number(req.params.id)]
      );
      if (Number(movCount.rows[0].count) > 0) return erro(res, 400, 'Não é possível excluir lote com movimentos registrados');

      const r = await pool.query(
        `DELETE FROM lotes WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), e.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Lote não encontrado');
      return ok(res, { mensagem: 'Lote excluído' });
    } catch (err) {
      return erro(res, 500, 'Erro ao excluir lote');
    }
  });

  // ── Números de série ──────────────────────────────────────────────────────

  router.get('/series', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { produto_id, status, busca } = req.query;
      const params = [e.id];
      let where = `WHERE empresa_id = $1`;
      if (produto_id) { params.push(Number(produto_id)); where += ` AND produto_id = $${params.length}`; }
      if (status)     { params.push(status);             where += ` AND status = $${params.length}`; }
      if (busca)      { params.push(`%${busca}%`);       where += ` AND numero ILIKE $${params.length}`; }

      const result = await pool.query(
        `SELECT * FROM numeros_serie ${where} ORDER BY criado_em DESC LIMIT 500`,
        params
      );
      return ok(res, { series: result.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar séries');
    }
  });

  router.post('/series', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { produto_id, numeros, compra_id } = req.body;
      if (!produto_id) return erro(res, 400, 'produto_id é obrigatório');

      const lista = Array.isArray(numeros) ? numeros : [numeros];
      const numerosValidos = lista.map((n) => String(n || '').trim()).filter(Boolean);
      if (numerosValidos.length === 0) return erro(res, 400, 'Informe ao menos um número de série');
      if (numerosValidos.length > 500) return erro(res, 400, 'Máximo de 500 séries por importação');

      const prodResult = await pool.query(
        `SELECT id, nome FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [Number(produto_id), e.id]
      );
      if (prodResult.rowCount === 0) return erro(res, 404, 'Produto não encontrado');
      const produto = prodResult.rows[0];

      let inseridos = 0;
      let duplicados = 0;

      for (const num of numerosValidos) {
        const r = await pool.query(
          `INSERT INTO numeros_serie (empresa_id, produto_id, produto_nome, numero, compra_id)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (empresa_id, numero) DO NOTHING`,
          [e.id, produto.id, produto.nome, num, compra_id ? Number(compra_id) : null]
        );
        if (r.rowCount > 0) inseridos++;
        else duplicados++;
      }

      return res.status(201).json({ sucesso: true, inseridos, duplicados, total: numerosValidos.length });
    } catch (err) {
      console.error('[rastreabilidade] POST series:', err.message);
      return erro(res, 500, err.message);
    }
  });

  router.patch('/series/:id/status', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { status, venda_id, observacao } = req.body;
      const statusValidos = ['disponivel', 'vendido', 'devolvido', 'defeito'];
      if (!statusValidos.includes(status)) return erro(res, 400, `Status inválido. Use: ${statusValidos.join(', ')}`);

      const r = await pool.query(
        `UPDATE numeros_serie SET status = $1, venda_id = COALESCE($2, venda_id), atualizado_em = NOW()
         WHERE id = $3 AND empresa_id = $4 RETURNING *`,
        [status, venda_id ? Number(venda_id) : null, Number(req.params.id), e.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Número de série não encontrado');

      // Registra movimento
      const s = r.rows[0];
      await pool.query(
        `INSERT INTO rastreabilidade_movimentos
           (empresa_id, tipo, referencia_tipo, referencia_id, serie_id, produto_id, produto_nome, quantidade, observacao, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)`,
        [
          e.id,
          status === 'vendido' ? 'saida' : (status === 'devolvido' ? 'entrada' : 'ajuste'),
          venda_id ? 'venda' : 'manual',
          venda_id || null,
          s.id, s.produto_id, s.produto_nome,
          observacao?.trim() || null,
          req.user.id
        ]
      );

      return ok(res, { serie: s });
    } catch (err) {
      return erro(res, 500, 'Erro ao atualizar status');
    }
  });

  // ── Rastrear ──────────────────────────────────────────────────────────────

  router.get('/rastrear', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const q = (req.query.q || '').trim();
      if (!q) return erro(res, 400, 'Informe o número de lote ou série');

      // Busca em lotes
      const lotesResult = await pool.query(
        `SELECT l.*, p.nome AS produto_nome_atual
         FROM lotes l LEFT JOIN produtos p ON p.id = l.produto_id
         WHERE l.empresa_id = $1 AND (l.numero ILIKE $2 OR l.produto_nome ILIKE $2)`,
        [e.id, `%${q}%`]
      );

      // Busca em números de série
      const seriesResult = await pool.query(
        `SELECT s.*, p.nome AS produto_nome_atual,
                v.data AS venda_data, v.cliente_nome,
                c.data AS compra_data
         FROM numeros_serie s
         LEFT JOIN produtos p ON p.id = s.produto_id
         LEFT JOIN vendas v ON v.id = s.venda_id
         LEFT JOIN compras c ON c.id = s.compra_id
         WHERE s.empresa_id = $1 AND s.numero ILIKE $2`,
        [e.id, `%${q}%`]
      );

      // Movimentos relacionados
      const loteIds  = lotesResult.rows.map((l) => l.id);
      const serieIds = seriesResult.rows.map((s) => s.id);
      let movimentos = [];

      if (loteIds.length > 0 || serieIds.length > 0) {
        const movResult = await pool.query(
          `SELECT m.*,
                  v.cliente_nome,
                  COALESCE(v.data::text, c.data) AS ref_data
           FROM rastreabilidade_movimentos m
           LEFT JOIN vendas  v ON v.id = m.referencia_id AND m.referencia_tipo = 'venda'
           LEFT JOIN compras c ON c.id = m.referencia_id AND m.referencia_tipo = 'compra'
           WHERE m.empresa_id = $1
             AND (m.lote_id = ANY($2::int[]) OR m.serie_id = ANY($3::int[]))
           ORDER BY m.criado_em DESC`,
          [e.id, loteIds.length > 0 ? loteIds : [0], serieIds.length > 0 ? serieIds : [0]]
        );
        movimentos = movResult.rows;
      }

      return ok(res, {
        query: q,
        lotes:      lotesResult.rows,
        series:     seriesResult.rows,
        movimentos
      });
    } catch (err) {
      console.error('[rastreabilidade] rastrear:', err.message);
      return erro(res, 500, 'Erro ao rastrear');
    }
  });

  return router;
};
