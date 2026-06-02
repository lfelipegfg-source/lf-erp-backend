/**
 * Comissões de Vendedores — LF ERP
 *
 * Montado em /comissoes pelo server.js.
 *
 * Rotas:
 *   GET    /comissoes/config                     — listar configs (1 por vendedor)
 *   POST   /comissoes/config                     — criar ou atualizar config de vendedor
 *   DELETE /comissoes/config/:id                 — remover config
 *
 *   POST   /comissoes/config/:id/produtos        — definir % por produto (override)
 *   DELETE /comissoes/config/:id/produtos/:pid   — remover override de produto
 *
 *   GET    /comissoes                            — listar comissões (filtros)
 *   GET    /comissoes/resumo                     — resumo por vendedor no período
 *   POST   /comissoes/:id/pagar                  — marca comissão como paga
 *   POST   /comissoes/:id/cancelar               — cancela comissão
 *   POST   /comissoes/recalcular/:vendaId        — recalcula comissão de uma venda
 */

const { calcularComissaoVenda } = require('../utils/comissoes');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarDataISO,
  obterPeriodo
}) => {
  const router = require('express').Router();

  function ok(res, dados = {}) { return res.status(200).json({ sucesso: true, ...dados }); }
  function erro(res, status = 500, msg = 'Erro interno') { return res.status(status).json({ sucesso: false, erro: msg }); }

  // ── Helper: verifica acesso e retorna empresa ─────────────────────────────
  async function empresa(req) {
    return validarAcessoEmpresa(req, req.query.empresa || req.body?.empresa, req.empresa_id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG — GET /comissoes/config
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/config', auth, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT cc.*,
                u.nome_completo AS vendedor_nome,
                u.usuario       AS vendedor_usuario,
                COUNT(c.id)     AS total_comissoes,
                COALESCE(SUM(c.valor_comissao) FILTER (WHERE c.status = 'pendente'), 0) AS pendente_total
         FROM comissoes_config cc
         JOIN usuarios u ON u.id = cc.usuario_id
         LEFT JOIN comissoes c ON c.usuario_id = cc.usuario_id AND c.empresa_id = cc.empresa_id
         WHERE cc.empresa_id = $1
         GROUP BY cc.id, u.nome_completo, u.usuario
         ORDER BY u.nome_completo`,
        [emp.id]
      );

      return ok(res, { configs: result.rows });
    } catch (err) {
      console.error('[comissoes] GET config:', err.message);
      return erro(res, 500, 'Erro ao listar configurações');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /comissoes/config — criar ou atualizar config de um vendedor
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/config', auth, writeRateLimiter, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { usuario_id, percentual, ativa = true } = req.body;
      if (!usuario_id) return erro(res, 400, 'usuario_id é obrigatório');
      if (percentual == null || percentual < 0 || percentual > 100) {
        return erro(res, 400, 'Percentual deve ser entre 0 e 100');
      }

      // Valida que usuário existe e pertence à empresa
      const usuario = await pool.query(
        `SELECT id, nome_completo, usuario FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR tipo = 'admin')`,
        [Number(usuario_id), emp.id]
      );
      if (usuario.rowCount === 0) return erro(res, 404, 'Usuário não encontrado');

      const result = await pool.query(
        `INSERT INTO comissoes_config (empresa_id, usuario_id, percentual, ativa)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (empresa_id, usuario_id)
         DO UPDATE SET percentual = $3, ativa = $4, atualizado_em = NOW()
         RETURNING *`,
        [emp.id, Number(usuario_id), normalizarDecimal(percentual), Boolean(ativa)]
      );

      return ok(res, {
        config: result.rows[0],
        vendedor: usuario.rows[0],
        mensagem: 'Configuração de comissão salva'
      });
    } catch (err) {
      console.error('[comissoes] POST config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /comissoes/config/:id
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/config/:id', auth, writeRateLimiter, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `DELETE FROM comissoes_config WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), emp.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Configuração não encontrada');
      return ok(res, { mensagem: 'Configuração removida' });
    } catch (err) {
      console.error('[comissoes] DELETE config:', err.message);
      return erro(res, 500, 'Erro ao remover configuração');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /comissoes/config/:id/produtos — override de % por produto
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/config/:id/produtos', auth, writeRateLimiter, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const configId = Number(req.params.id);
      const { produto_id, percentual } = req.body;
      if (!produto_id || percentual == null) return erro(res, 400, 'produto_id e percentual são obrigatórios');

      const cfg = await pool.query(`SELECT id FROM comissoes_config WHERE id = $1 AND empresa_id = $2`, [configId, emp.id]);
      if (cfg.rowCount === 0) return erro(res, 404, 'Configuração não encontrada');

      const result = await pool.query(
        `INSERT INTO comissoes_config_produtos (config_id, empresa_id, produto_id, percentual)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (config_id, produto_id) DO UPDATE SET percentual = $4
         RETURNING *`,
        [configId, emp.id, Number(produto_id), normalizarDecimal(percentual)]
      );

      return ok(res, { override: result.rows[0] });
    } catch (err) {
      console.error('[comissoes] POST config produtos:', err.message);
      return erro(res, 500, 'Erro ao salvar override');
    }
  });

  // DELETE /comissoes/config/:id/produtos/:pid
  router.delete('/config/:id/produtos/:pid', auth, writeRateLimiter, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      await pool.query(
        `DELETE FROM comissoes_config_produtos WHERE config_id = $1 AND produto_id = $2 AND empresa_id = $3`,
        [Number(req.params.id), Number(req.params.pid), emp.id]
      );
      return ok(res, { mensagem: 'Override removido' });
    } catch (err) {
      console.error('[comissoes] DELETE config produto:', err.message);
      return erro(res, 500, 'Erro ao remover override');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /comissoes — listar comissões
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/', auth, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { usuario_id, status, periodo } = req.query;
      const params = [emp.id];
      let where = 'WHERE c.empresa_id = $1';
      let idx = 2;

      if (usuario_id) { where += ` AND c.usuario_id = $${idx++}`; params.push(Number(usuario_id)); }
      if (status)     { where += ` AND c.status = $${idx++}`;     params.push(status); }
      if (periodo) {
        const { dataInicio, dataFim } = obterPeriodo(periodo, req.query.data_inicio, req.query.data_fim);
        where += ` AND c.criado_em >= $${idx++} AND c.criado_em <= $${idx++}`;
        params.push(dataInicio, dataFim);
      }

      const result = await pool.query(
        `SELECT c.*,
                u.nome_completo AS vendedor_nome,
                u.usuario       AS vendedor_usuario,
                v.data          AS data_venda,
                v.cliente_nome
         FROM comissoes c
         JOIN usuarios u ON u.id = c.usuario_id
         LEFT JOIN vendas v ON v.id = c.venda_id
         ${where}
         ORDER BY c.criado_em DESC
         LIMIT 500`,
        params
      );

      return ok(res, { comissoes: result.rows });
    } catch (err) {
      console.error('[comissoes] GET lista:', err.message);
      return erro(res, 500, 'Erro ao listar comissões');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /comissoes/resumo — totais por vendedor no período
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/resumo', auth, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { periodo } = req.query;
      const params = [emp.id];
      let filtro = '';

      if (periodo) {
        const { dataInicio, dataFim } = obterPeriodo(periodo, req.query.data_inicio, req.query.data_fim);
        filtro = ` AND c.criado_em >= $2 AND c.criado_em <= $3`;
        params.push(dataInicio, dataFim);
      }

      const result = await pool.query(
        `SELECT
           u.id              AS usuario_id,
           u.nome_completo   AS vendedor_nome,
           u.usuario         AS vendedor_usuario,
           COUNT(c.id)       AS total_vendas,
           SUM(c.valor_venda)     AS total_vendas_valor,
           SUM(c.valor_comissao)  AS total_comissao,
           SUM(c.valor_comissao) FILTER (WHERE c.status = 'pendente') AS pendente,
           SUM(c.valor_comissao) FILTER (WHERE c.status = 'pago')     AS pago,
           AVG(c.percentual) AS percentual_medio
         FROM comissoes c
         JOIN usuarios u ON u.id = c.usuario_id
         WHERE c.empresa_id = $1 ${filtro} AND c.status != 'cancelado'
         GROUP BY u.id, u.nome_completo, u.usuario
         ORDER BY total_comissao DESC`,
        params
      );

      return ok(res, { resumo: result.rows });
    } catch (err) {
      console.error('[comissoes] GET resumo:', err.message);
      return erro(res, 500, 'Erro ao gerar resumo');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /comissoes/:id/pagar — marca comissão como paga
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/pagar', auth, writeRateLimiter, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const { data_pagamento, forma_pagamento, observacao } = req.body;
      const id = Number(req.params.id);

      const atual = await pool.query(`SELECT status FROM comissoes WHERE id = $1 AND empresa_id = $2`, [id, emp.id]);
      if (atual.rowCount === 0) return erro(res, 404, 'Comissão não encontrada');
      if (atual.rows[0].status !== 'pendente') return erro(res, 400, `Comissão no status "${atual.rows[0].status}" não pode ser paga`);

      const r = await pool.query(
        `UPDATE comissoes SET
           status          = 'pago',
           data_pagamento  = $1,
           forma_pagamento = $2,
           observacao      = COALESCE($3, observacao),
           atualizado_em   = NOW()
         WHERE id = $4
         RETURNING *`,
        [
          data_pagamento ? normalizarDataISO(data_pagamento) : new Date().toISOString().slice(0, 10),
          forma_pagamento || 'Dinheiro',
          observacao || null,
          id
        ]
      );

      return ok(res, { comissao: r.rows[0], mensagem: 'Comissão marcada como paga' });
    } catch (err) {
      console.error('[comissoes] POST pagar:', err.message);
      return erro(res, 500, 'Erro ao pagar comissão');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /comissoes/:id/cancelar
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/:id/cancelar', auth, writeRateLimiter, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `UPDATE comissoes SET status = 'cancelado', atualizado_em = NOW()
         WHERE id = $1 AND empresa_id = $2 AND status = 'pendente'
         RETURNING *`,
        [Number(req.params.id), emp.id]
      );
      if (r.rowCount === 0) return erro(res, 404, 'Comissão não encontrada ou já finalizada');
      return ok(res, { comissao: r.rows[0] });
    } catch (err) {
      console.error('[comissoes] POST cancelar:', err.message);
      return erro(res, 500, 'Erro ao cancelar comissão');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /comissoes/recalcular/:vendaId — recalcula manualmente
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/recalcular/:vendaId', auth, writeRateLimiter, async (req, res) => {
    try {
      const emp = await empresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const vendaId = Number(req.params.vendaId);
      const venda = await pool.query(`SELECT * FROM vendas WHERE id = $1 AND empresa_id = $2`, [vendaId, emp.id]);
      if (venda.rowCount === 0) return erro(res, 404, 'Venda não encontrada');

      // Remove comissão anterior pendente (se existir)
      await pool.query(
        `DELETE FROM comissoes WHERE venda_id = $1 AND empresa_id = $2 AND status = 'pendente'`,
        [vendaId, emp.id]
      );

      const v = venda.rows[0];
      await calcularComissaoVenda(pool, {
        vendaId,
        usuarioId: v.criado_por || req.user.id,
        empresaId: emp.id
      });

      const nova = await pool.query(`SELECT * FROM comissoes WHERE venda_id = $1 AND empresa_id = $2`, [vendaId, emp.id]);
      return ok(res, { comissao: nova.rows[0] || null, mensagem: 'Comissão recalculada' });
    } catch (err) {
      console.error('[comissoes] POST recalcular:', err.message);
      return erro(res, 500, 'Erro ao recalcular comissão');
    }
  });

  return router;
};
