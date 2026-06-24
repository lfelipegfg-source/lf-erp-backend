/**
 * Controle de Caixa — LF ERP
 * Montado em /caixa.
 *
 * Rotas:
 *   GET  /caixa/sessao-ativa   — sessão aberta atual (ou null)
 *   POST /caixa/abrir          — abre o caixa com saldo inicial
 *   POST /caixa/sangria        — registra retirada
 *   POST /caixa/suprimento     — registra reforço
 *   POST /caixa/fechar         — fecha o caixa com contagem final
 *   GET  /caixa/historico      — últimas sessões fechadas
 */

const { requirePermissao } = require('../utils/permissoes');

module.exports = ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal }) => {
  const router = require('express').Router();

  function ok(res, d = {}) { return res.status(200).json({ sucesso: true, ...d }); }
  function erro(res, s = 500, m = 'Erro interno') { return res.status(s).json({ sucesso: false, erro: m }); }

  async function getEmpresa(req) {
    return validarAcessoEmpresa(req, req.query.empresa || req.body?.empresa, req.empresa_id);
  }

  async function getSessaoAberta(empresaId) {
    const r = await pool.query(
      `SELECT * FROM caixa_sessoes WHERE empresa_id = $1 AND status = 'aberto' ORDER BY aberto_em DESC LIMIT 1`,
      [empresaId]
    );
    return r.rows[0] || null;
  }

  async function getMovimentos(sessaoId) {
    const r = await pool.query(
      `SELECT * FROM caixa_movimentos WHERE sessao_id = $1 ORDER BY criado_em ASC`,
      [sessaoId]
    );
    return r.rows.map((m) => ({ ...m, valor: Number(m.valor) }));
  }

  async function calcularSaldo(sessaoId) {
    const r = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS saldo FROM caixa_movimentos WHERE sessao_id = $1`,
      [sessaoId]
    );
    return Number(r.rows[0].saldo || 0);
  }

  // ── GET /caixa/sessao-ativa ───────────────────────────────────────────────
  router.get('/sessao-ativa', auth, requirePermissao(pool, 'caixa', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const sessao = await getSessaoAberta(emp.id);
      if (!sessao) return ok(res, { sessao: null });

      const movimentos     = await getMovimentos(sessao.id);
      const saldo_calculado = await calcularSaldo(sessao.id);

      // Vendas em dinheiro/pix no período para exibição (não modifica saldo)
      const vendasResult = await pool.query(
        `SELECT COALESCE(SUM(total), 0) AS total_vendas, COUNT(*) AS qtd_vendas
         FROM vendas
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3))
           AND data >= $2::date
           AND LOWER(pagamento) IN ('dinheiro','pix')`,
        [emp.id, new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date(sessao.aberto_em)), emp.nome]
      );
      const vendas = vendasResult.rows[0];

      return ok(res, {
        sessao: { ...sessao, saldo_abertura: Number(sessao.saldo_abertura) },
        movimentos,
        saldo_calculado: +saldo_calculado.toFixed(2),
        vendas_dinheiro_pix: {
          total:    Number(vendas.total_vendas || 0),
          quantidade: Number(vendas.qtd_vendas || 0)
        }
      });
    } catch (err) {
      console.error('[caixa] GET sessao-ativa:', err.message);
      return erro(res, 500, 'Erro ao buscar sessão de caixa');
    }
  });

  // ── POST /caixa/abrir ────────────────────────────────────────────────────
  router.post('/abrir', auth, requirePermissao(pool, 'caixa', 'criar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const jaAberto = await getSessaoAberta(emp.id);
      if (jaAberto) return erro(res, 400, 'Já existe um caixa aberto. Feche o caixa atual antes de abrir um novo.');

      const { saldo_inicial = 0, observacao } = req.body;
      const saldoInicial = normalizarDecimal(saldo_inicial);

      const sessaoRes = await pool.query(
        `INSERT INTO caixa_sessoes (empresa_id, usuario_id, usuario_nome, saldo_abertura, observacao)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [emp.id, req.user.id, req.user.nome || req.user.usuario || null, saldoInicial, observacao || null]
      );
      const sessao = sessaoRes.rows[0];

      // Registra movimento de abertura
      await pool.query(
        `INSERT INTO caixa_movimentos (sessao_id, empresa_id, tipo, valor, descricao)
         VALUES ($1,$2,'abertura',$3,'Saldo de abertura')`,
        [sessao.id, emp.id, saldoInicial]
      );

      return ok(res, { sessao, mensagem: 'Caixa aberto com sucesso' });
    } catch (err) {
      console.error('[caixa] POST abrir:', err.message);
      return erro(res, 500, 'Erro ao abrir caixa');
    }
  });

  // ── POST /caixa/sangria ──────────────────────────────────────────────────
  router.post('/sangria', auth, requirePermissao(pool, 'caixa', 'criar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const sessao = await getSessaoAberta(emp.id);
      if (!sessao) return erro(res, 400, 'Nenhum caixa aberto');

      const { valor, descricao } = req.body;
      const v = normalizarDecimal(valor);
      if (!v || v <= 0) return erro(res, 400, 'Informe um valor positivo para a sangria');

      await pool.query(
        `INSERT INTO caixa_movimentos (sessao_id, empresa_id, tipo, valor, descricao)
         VALUES ($1,$2,'sangria',$3,$4)`,
        [sessao.id, emp.id, -Math.abs(v), descricao || 'Sangria de caixa']
      );

      const novoSaldo = await calcularSaldo(sessao.id);
      return ok(res, { saldo_atual: +novoSaldo.toFixed(2), mensagem: 'Sangria registrada' });
    } catch (err) {
      console.error('[caixa] POST sangria:', err.message);
      return erro(res, 500, 'Erro ao registrar sangria');
    }
  });

  // ── POST /caixa/suprimento ───────────────────────────────────────────────
  router.post('/suprimento', auth, requirePermissao(pool, 'caixa', 'criar'), writeRateLimiter, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const sessao = await getSessaoAberta(emp.id);
      if (!sessao) return erro(res, 400, 'Nenhum caixa aberto');

      const { valor, descricao } = req.body;
      const v = normalizarDecimal(valor);
      if (!v || v <= 0) return erro(res, 400, 'Informe um valor positivo para o suprimento');

      await pool.query(
        `INSERT INTO caixa_movimentos (sessao_id, empresa_id, tipo, valor, descricao)
         VALUES ($1,$2,'suprimento',$3,$4)`,
        [sessao.id, emp.id, Math.abs(v), descricao || 'Suprimento de caixa']
      );

      const novoSaldo = await calcularSaldo(sessao.id);
      return ok(res, { saldo_atual: +novoSaldo.toFixed(2), mensagem: 'Suprimento registrado' });
    } catch (err) {
      console.error('[caixa] POST suprimento:', err.message);
      return erro(res, 500, 'Erro ao registrar suprimento');
    }
  });

  // ── POST /caixa/fechar ───────────────────────────────────────────────────
  router.post('/fechar', auth, requirePermissao(pool, 'caixa', 'criar'), writeRateLimiter, async (req, res) => {
    const emp = await getEmpresa(req);
    if (!emp) return erro(res, 403, 'Sem acesso');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // FOR UPDATE trava a sessão para evitar que dois fechamentos concorrentes
      // dupliquem o movimento de fechamento ou apliquem saldo_calculado divergente.
      const sessaoResult = await client.query(
        `SELECT * FROM caixa_sessoes WHERE empresa_id = $1 AND status = 'aberto' ORDER BY aberto_em DESC LIMIT 1 FOR UPDATE`,
        [emp.id]
      );
      const sessao = sessaoResult.rows[0];
      if (!sessao) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Nenhum caixa aberto');
      }

      const { saldo_contado, observacao } = req.body;
      const saldoContado  = normalizarDecimal(saldo_contado ?? 0);
      const saldoCalculadoResult = await client.query(
        `SELECT COALESCE(SUM(valor), 0) AS saldo FROM caixa_movimentos WHERE sessao_id = $1`,
        [sessao.id]
      );
      const saldoCalculado = Number(saldoCalculadoResult.rows[0].saldo || 0);
      const diferenca = +(saldoContado - saldoCalculado).toFixed(2);

      await client.query(
        `UPDATE caixa_sessoes SET
           status            = 'fechado',
           saldo_fechamento  = $1,
           saldo_calculado   = $2,
           diferenca         = $3,
           observacao        = COALESCE($4, observacao),
           fechado_em        = NOW()
         WHERE id = $5`,
        [saldoContado, +saldoCalculado.toFixed(2), diferenca, observacao || null, sessao.id]
      );

      // Registra movimento de fechamento
      await client.query(
        `INSERT INTO caixa_movimentos (sessao_id, empresa_id, tipo, valor, descricao)
         VALUES ($1,$2,'fechamento',0,'Fechamento do caixa')`,
        [sessao.id, emp.id]
      );

      await client.query('COMMIT');

      return ok(res, {
        sessao_id:       sessao.id,
        saldo_calculado: +saldoCalculado.toFixed(2),
        saldo_contado:   saldoContado,
        diferenca,
        mensagem: 'Caixa fechado com sucesso'
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[caixa] POST fechar:', err.message);
      return erro(res, 500, 'Erro ao fechar caixa');
    } finally {
      client.release();
    }
  });

  // ── GET /caixa/historico ─────────────────────────────────────────────────
  router.get('/historico', auth, requirePermissao(pool, 'caixa', 'ver'), async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT * FROM caixa_sessoes
         WHERE empresa_id = $1
         ORDER BY aberto_em DESC
         LIMIT 30`,
        [emp.id]
      );

      return ok(res, {
        sessoes: result.rows.map((s) => ({
          ...s,
          saldo_abertura:   Number(s.saldo_abertura   || 0),
          saldo_fechamento: Number(s.saldo_fechamento || 0),
          saldo_calculado:  Number(s.saldo_calculado  || 0),
          diferenca:        Number(s.diferenca        || 0)
        }))
      });
    } catch (err) {
      console.error('[caixa] GET historico:', err.message);
      return erro(res, 500, 'Erro ao buscar histórico de caixa');
    }
  });

  return router;
};
