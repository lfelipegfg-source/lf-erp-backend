/**
 * Programa de Fidelidade — LF ERP
 * Pontos por compra, resgate como desconto, ranking e extrato por cliente.
 *
 * GET    /fidelidade/config              — regras do programa
 * PUT    /fidelidade/config              — salvar regras
 * GET    /fidelidade/dashboard           — KPIs
 * GET    /fidelidade/clientes            — ranking de clientes por pontos
 * GET    /fidelidade/clientes/:id/extrato — extrato de pontos do cliente
 * POST   /fidelidade/acumular            — acumular pontos manualmente
 * POST   /fidelidade/resgatar            — resgatar pontos (retorna valor de desconto)
 * POST   /fidelidade/ajustar             — ajuste manual (admin)
 * POST   /fidelidade/expirar             — expira pontos vencidos (processar expiração)
 */

const { acumularPontosFidelidade } = require('../utils/fidelidade');

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, hoje }) {
  const router = require('express').Router();

  function ok(res, d = {})              { return res.json({ sucesso: true, ...d }); }
  function erro(res, s = 500, m = 'Erro interno') { return res.status(s).json({ sucesso: false, erro: m }); }
  async function emp(req)               { return validarAcessoEmpresa(req, null, req.empresa_id); }

  async function getCfg(empresaId) {
    const r = await pool.query(`SELECT * FROM fidelidade_config WHERE empresa_id = $1`, [empresaId]);
    return r.rows[0] || null;
  }

  // ── Config ────────────────────────────────────────────────────────────────

  router.get('/config', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');
      const cfg = await getCfg(e.id);
      return ok(res, {
        config: cfg || {
          ativo: false, nome_programa: 'Programa de Fidelidade',
          pontos_por_real: 1, reais_por_ponto: 0.05, validade_dias: 365, minimo_resgate: 100
        }
      });
    } catch (err) { return erro(res, 500, 'Erro ao buscar configuração'); }
  });

  router.put('/config', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { ativo, nome_programa, pontos_por_real, reais_por_ponto, validade_dias, minimo_resgate } = req.body;

      await pool.query(
        `INSERT INTO fidelidade_config
           (empresa_id, ativo, nome_programa, pontos_por_real, reais_por_ponto, validade_dias, minimo_resgate, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (empresa_id) DO UPDATE SET
           ativo           = $2,
           nome_programa   = COALESCE(NULLIF($3,''), fidelidade_config.nome_programa),
           pontos_por_real = COALESCE($4, fidelidade_config.pontos_por_real),
           reais_por_ponto = COALESCE($5, fidelidade_config.reais_por_ponto),
           validade_dias   = COALESCE($6, fidelidade_config.validade_dias),
           minimo_resgate  = COALESCE($7, fidelidade_config.minimo_resgate),
           atualizado_em   = NOW()`,
        [
          e.id,
          ativo !== false,
          nome_programa?.trim() || null,
          pontos_por_real != null ? normalizarDecimal(pontos_por_real) : null,
          reais_por_ponto != null ? normalizarDecimal(reais_por_ponto) : null,
          validade_dias   != null ? normalizarInt(validade_dias)       : null,
          minimo_resgate  != null ? normalizarInt(minimo_resgate)      : null
        ]
      );

      return ok(res, { mensagem: 'Configuração salva' });
    } catch (err) {
      console.error('[fidelidade] PUT config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração');
    }
  });

  // ── Dashboard ─────────────────────────────────────────────────────────────

  router.get('/dashboard', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const [statsResult, topResult, movMesResult] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE pontos_fidelidade > 0)          AS clientes_com_pontos,
             COALESCE(SUM(pontos_fidelidade), 0)                    AS total_pontos_circulacao,
             COUNT(*) FILTER (WHERE pontos_fidelidade >= 100)       AS clientes_prontos_resgatar
           FROM clientes WHERE empresa_id = $1 AND deletado_em IS NULL`,
          [e.id]
        ),
        pool.query(
          `SELECT nome, pontos_fidelidade FROM clientes
           WHERE empresa_id = $1 AND pontos_fidelidade > 0 AND deletado_em IS NULL
           ORDER BY pontos_fidelidade DESC LIMIT 5`,
          [e.id]
        ),
        pool.query(
          `SELECT tipo, COUNT(*) AS total, COALESCE(SUM(ABS(pontos)),0) AS pontos_total
           FROM fidelidade_movimentos
           WHERE empresa_id = $1 AND DATE_TRUNC('month', criado_em) = DATE_TRUNC('month', NOW())
           GROUP BY tipo`,
          [e.id]
        )
      ]);

      const movMes = {};
      for (const row of movMesResult.rows) movMes[row.tipo] = { total: Number(row.total), pontos: Number(row.pontos_total) };

      return ok(res, {
        clientes_com_pontos:      Number(statsResult.rows[0].clientes_com_pontos),
        total_pontos_circulacao:  Number(statsResult.rows[0].total_pontos_circulacao),
        clientes_prontos_resgatar: Number(statsResult.rows[0].clientes_prontos_resgatar),
        top_clientes:  topResult.rows,
        movimentos_mes: movMes
      });
    } catch (err) {
      console.error('[fidelidade] dashboard:', err.message);
      return erro(res, 500, 'Erro ao carregar dashboard');
    }
  });

  // ── Ranking de clientes ───────────────────────────────────────────────────

  router.get('/clientes', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { busca } = req.query;
      const params = [e.id];
      let where = `WHERE empresa_id = $1 AND pontos_fidelidade > 0 AND deletado_em IS NULL`;
      if (busca) { params.push(`%${busca}%`); where += ` AND nome ILIKE $${params.length}`; }

      const result = await pool.query(
        `SELECT id, nome, telefone, email, pontos_fidelidade
         FROM clientes ${where}
         ORDER BY pontos_fidelidade DESC LIMIT 200`,
        params
      );
      return ok(res, { clientes: result.rows });
    } catch (err) { return erro(res, 500, 'Erro ao listar clientes'); }
  });

  // ── Extrato do cliente ────────────────────────────────────────────────────

  router.get('/clientes/:id/extrato', auth, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const clienteId = Number(req.params.id);

      const [cliResult, movResult, cfgResult] = await Promise.all([
        pool.query(
          `SELECT id, nome, telefone, email, pontos_fidelidade FROM clientes WHERE id = $1 AND empresa_id = $2`,
          [clienteId, e.id]
        ),
        pool.query(
          `SELECT * FROM fidelidade_movimentos WHERE empresa_id = $1 AND cliente_id = $2 ORDER BY criado_em DESC LIMIT 100`,
          [e.id, clienteId]
        ),
        getCfg(e.id)
      ]);

      if (cliResult.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');

      const cli = cliResult.rows[0];
      const valorResgate = cfgResult
        ? Number((cli.pontos_fidelidade * Number(cfgResult.reais_por_ponto)).toFixed(2))
        : 0;

      return ok(res, {
        cliente: cli,
        valor_resgate: valorResgate,
        movimentos: movResult.rows
      });
    } catch (err) { return erro(res, 500, 'Erro ao buscar extrato'); }
  });

  // ── Acumular manualmente ──────────────────────────────────────────────────

  router.post('/acumular', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { cliente_id, pontos, descricao, venda_id } = req.body;
      if (!cliente_id || !pontos) return erro(res, 400, 'cliente_id e pontos são obrigatórios');
      const qtd = normalizarInt(pontos);
      if (qtd <= 0) return erro(res, 400, 'Pontos deve ser positivo');

      await acumularPontosFidelidade(pool, {
        empresaId: e.id,
        clienteId: Number(cliente_id),
        vendaId:   venda_id || null,
        totalVenda: qtd / ((await getCfg(e.id))?.pontos_por_real || 1)
      });

      return ok(res, { mensagem: `${qtd} pontos acumulados` });
    } catch (err) {
      console.error('[fidelidade] POST acumular:', err.message);
      return erro(res, 500, err.message);
    }
  });

  // ── Resgatar pontos ───────────────────────────────────────────────────────

  router.post('/resgatar', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { cliente_id, pontos, venda_id } = req.body;
      if (!cliente_id || !pontos) return erro(res, 400, 'cliente_id e pontos são obrigatórios');

      const cfg = await getCfg(e.id);
      if (!cfg?.ativo) return erro(res, 400, 'Programa de fidelidade não está ativo');

      const qtd = normalizarInt(pontos);
      if (qtd < cfg.minimo_resgate) return erro(res, 400, `Mínimo de ${cfg.minimo_resgate} pontos para resgatar`);

      const cliResult = await pool.query(
        `SELECT id, nome, pontos_fidelidade FROM clientes WHERE id = $1 AND empresa_id = $2`,
        [Number(cliente_id), e.id]
      );
      if (cliResult.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');

      const cli = cliResult.rows[0];
      if (cli.pontos_fidelidade < qtd) return erro(res, 400, `Saldo insuficiente. Disponível: ${cli.pontos_fidelidade} pontos`);

      const valorDesconto = Number((qtd * Number(cfg.reais_por_ponto)).toFixed(2));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `UPDATE clientes SET pontos_fidelidade = pontos_fidelidade - $1, atualizado_em = NOW() WHERE id = $2`,
          [qtd, cli.id]
        );

        const novoSaldo = cli.pontos_fidelidade - qtd;

        await client.query(
          `INSERT INTO fidelidade_movimentos
             (empresa_id, cliente_id, tipo, pontos, saldo_apos, descricao, referencia_tipo, referencia_id)
           VALUES ($1,$2,'debito',$3,$4,$5,'resgate',$6)`,
          [e.id, cli.id, -qtd, novoSaldo, `-${qtd} pontos resgatados = R$ ${valorDesconto.toFixed(2)} de desconto`, venda_id || null]
        );

        await client.query('COMMIT');
        return ok(res, {
          pontos_resgatados: qtd,
          valor_desconto:    valorDesconto,
          saldo_restante:    novoSaldo,
          mensagem: `${qtd} pontos resgatados = R$ ${valorDesconto.toFixed(2)} de desconto`
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[fidelidade] POST resgatar:', err.message);
      return erro(res, 500, err.message);
    }
  });

  // ── Ajuste manual ─────────────────────────────────────────────────────────

  router.post('/ajustar', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const { cliente_id, pontos, descricao } = req.body;
      if (!cliente_id || pontos == null) return erro(res, 400, 'cliente_id e pontos são obrigatórios');

      const qtd = normalizarInt(pontos);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `UPDATE clientes SET pontos_fidelidade = GREATEST(0, COALESCE(pontos_fidelidade,0) + $1), atualizado_em = NOW()
           WHERE id = $2 AND empresa_id = $3`,
          [qtd, Number(cliente_id), e.id]
        );

        const saldoRes = await client.query(`SELECT pontos_fidelidade FROM clientes WHERE id = $1`, [Number(cliente_id)]);
        const saldo = saldoRes.rows[0]?.pontos_fidelidade || 0;

        await client.query(
          `INSERT INTO fidelidade_movimentos
             (empresa_id, cliente_id, tipo, pontos, saldo_apos, descricao, referencia_tipo)
           VALUES ($1,$2,'ajuste',$3,$4,$5,'ajuste')`,
          [e.id, Number(cliente_id), qtd, saldo, descricao?.trim() || `Ajuste manual: ${qtd > 0 ? '+' : ''}${qtd} pontos`]
        );

        await client.query('COMMIT');
        return ok(res, { novo_saldo: saldo, mensagem: 'Ajuste realizado' });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) { return erro(res, 500, err.message); }
  });

  // ── Processar expiração ───────────────────────────────────────────────────

  router.post('/expirar', auth, writeRateLimiter, async (req, res) => {
    try {
      const e = await emp(req);
      if (!e) return erro(res, 403, 'Sem acesso');

      const hojeStr = hoje();

      // Pontos expirados hoje ou antes, que ainda não foram processados
      const vencidosResult = await pool.query(
        `SELECT cliente_id, SUM(pontos) AS pontos_a_expirar
         FROM fidelidade_movimentos
         WHERE empresa_id = $1 AND tipo = 'credito' AND expira_em <= $2
           AND NOT EXISTS (
             SELECT 1 FROM fidelidade_movimentos e2
             WHERE e2.empresa_id = $1 AND e2.cliente_id = fidelidade_movimentos.cliente_id
               AND e2.tipo = 'expiracao' AND e2.referencia_id = fidelidade_movimentos.id
           )
         GROUP BY cliente_id`,
        [e.id, hojeStr]
      );

      let expirados = 0;
      for (const row of vencidosResult.rows) {
        const pontosBaixar = Math.min(Number(row.pontos_a_expirar), (await pool.query(`SELECT COALESCE(pontos_fidelidade,0) AS p FROM clientes WHERE id=$1`, [row.cliente_id])).rows[0]?.p || 0);
        if (pontosBaixar <= 0) continue;

        await pool.query(
          `UPDATE clientes SET pontos_fidelidade = GREATEST(0, pontos_fidelidade - $1), atualizado_em = NOW() WHERE id = $2`,
          [pontosBaixar, row.cliente_id]
        );

        const saldo = (await pool.query(`SELECT COALESCE(pontos_fidelidade,0) AS p FROM clientes WHERE id=$1`, [row.cliente_id])).rows[0]?.p || 0;

        await pool.query(
          `INSERT INTO fidelidade_movimentos (empresa_id, cliente_id, tipo, pontos, saldo_apos, descricao, referencia_tipo)
           VALUES ($1,$2,'expiracao',$3,$4,'Pontos expirados por prazo de validade','expiracao')`,
          [e.id, row.cliente_id, -pontosBaixar, saldo]
        );
        expirados++;
      }

      return ok(res, { clientes_processados: expirados, mensagem: `${expirados} cliente(s) com pontos expirados processados` });
    } catch (err) {
      console.error('[fidelidade] POST expirar:', err.message);
      return erro(res, 500, err.message);
    }
  });

  return router;
};
