/**
 * Portal do Cliente — LF ERP
 * Acesso externo para clientes consultarem seus títulos e histórico.
 *
 * Rotas públicas:
 *   POST /portal/login                — autenticar cliente (CPF/CNPJ + senha)
 *
 * Rotas protegidas (authCliente):
 *   GET  /portal/resumo               — saldo aberto, atrasados, último acesso
 *   GET  /portal/titulos              — contas a receber do cliente
 *   GET  /portal/vendas               — histórico de vendas do cliente
 *
 * Rotas admin (auth ERP):
 *   POST /portal/admin/clientes/:id/senha   — define/redefine senha do portal
 *   PATCH /portal/admin/clientes/:id/toggle — ativa ou desativa acesso ao portal
 */

const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');

const SECRET      = process.env.JWT_SECRET;
const SALT_ROUNDS = 10;

module.exports = ({ auth, pool }) => {
  const router = require('express').Router();

  function ok(res, dados = {}) {
    return res.status(200).json({ sucesso: true, ...dados });
  }
  function erro(res, status = 500, msg = 'Erro interno') {
    return res.status(status).json({ sucesso: false, erro: msg });
  }

  // ── Middleware exclusivo para tokens de cliente ───────────────────────────
  function authCliente(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!token) return erro(res, 403, 'Sem acesso');

    try {
      const decoded = jwt.verify(token, SECRET);
      if (decoded.tipo !== 'cliente') return erro(res, 403, 'Acesso não autorizado');
      req.cliente = decoded;
      next();
    } catch {
      return erro(res, 403, 'Token inválido ou expirado');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /portal/login
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/login', async (req, res) => {
    try {
      const { cpf_cnpj, senha } = req.body;
      if (!cpf_cnpj || !senha) return erro(res, 400, 'Informe CPF/CNPJ e senha');

      const cleanDoc = String(cpf_cnpj).replace(/\D/g, '');
      if (cleanDoc.length < 11) return erro(res, 400, 'CPF/CNPJ inválido');

      const result = await pool.query(
        `SELECT c.*, e.nome AS empresa_nome
         FROM clientes c
         JOIN empresas e ON e.id = c.empresa_id
         WHERE c.portal_ativo = true
           AND c.senha_portal IS NOT NULL
           AND REGEXP_REPLACE(COALESCE(c.cpf_cnpj, ''), '[^0-9]', '', 'g') = $1
         LIMIT 1`,
        [cleanDoc]
      );

      if (result.rowCount === 0) {
        return erro(res, 401, 'CPF/CNPJ não encontrado, portal inativo ou senha não configurada');
      }

      const cliente = result.rows[0];
      const senhaOk = await bcrypt.compare(senha, cliente.senha_portal);
      if (!senhaOk) return erro(res, 401, 'Senha incorreta');

      await pool.query(
        `UPDATE clientes SET portal_ultimo_acesso = NOW() WHERE id = $1`,
        [cliente.id]
      );

      const token = jwt.sign(
        {
          id:           cliente.id,
          tipo:         'cliente',
          nome:         cliente.nome,
          empresa_id:   cliente.empresa_id,
          empresa_nome: cliente.empresa_nome
        },
        SECRET,
        { expiresIn: '24h' }
      );

      return ok(res, {
        token,
        cliente: {
          id:      cliente.id,
          nome:    cliente.nome,
          empresa: cliente.empresa_nome
        }
      });
    } catch (err) {
      console.error('[portal] POST login:', err.message);
      return erro(res, 500, 'Erro ao autenticar');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /portal/resumo
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/resumo', authCliente, async (req, res) => {
    try {
      const { id: clienteId, empresa_id: empresaId } = req.cliente;

      const result = await pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN LOWER(status) IN ('pendente','parcial') THEN valor ELSE 0 END), 0)     AS total_aberto,
           COALESCE(SUM(CASE WHEN LOWER(status) IN ('atrasado','parcial_atrasado') THEN valor ELSE 0 END), 0) AS total_atrasado,
           COALESCE(SUM(CASE WHEN LOWER(status) = 'pago' THEN valor ELSE 0 END), 0)                      AS total_pago,
           COUNT(CASE WHEN LOWER(status) IN ('pendente','parcial','atrasado','parcial_atrasado') THEN 1 END) AS total_titulos_abertos
         FROM contas_receber
         WHERE cliente_id = $1 AND empresa_id = $2`,
        [clienteId, empresaId]
      );

      const totalVendas = await pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(total), 0) AS valor
         FROM vendas
         WHERE cliente_id = $1 AND empresa_id = $2`,
        [clienteId, empresaId]
      );

      const r = result.rows[0];
      const v = totalVendas.rows[0];

      return ok(res, {
        total_aberto:         Number(r.total_aberto   || 0),
        total_atrasado:       Number(r.total_atrasado || 0),
        total_pago:           Number(r.total_pago     || 0),
        total_titulos_abertos: Number(r.total_titulos_abertos || 0),
        total_compras:        Number(v.total || 0),
        valor_total_compras:  Number(v.valor || 0)
      });
    } catch (err) {
      console.error('[portal] GET resumo:', err.message);
      return erro(res, 500, 'Erro ao carregar resumo');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /portal/titulos
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/titulos', authCliente, async (req, res) => {
    try {
      const { id: clienteId, empresa_id: empresaId } = req.cliente;
      const { status } = req.query;

      const params = [clienteId, empresaId];
      let where = 'WHERE cr.cliente_id = $1 AND cr.empresa_id = $2';

      if (status) {
        where += ` AND LOWER(cr.status) = $3`;
        params.push(status.toLowerCase());
      }

      const result = await pool.query(
        `SELECT cr.id, cr.valor, cr.status, cr.data_vencimento, cr.data_pagamento,
                cr.parcela, cr.total_parcelas, cr.observacao, cr.forma_pagamento
         FROM contas_receber cr
         ${where}
         ORDER BY cr.data_vencimento ASC NULLS LAST`,
        params
      );

      return ok(res, { titulos: result.rows.map((r) => ({
        ...r,
        valor: Number(r.valor || 0)
      })) });
    } catch (err) {
      console.error('[portal] GET titulos:', err.message);
      return erro(res, 500, 'Erro ao carregar títulos');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /portal/vendas
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/vendas', authCliente, async (req, res) => {
    try {
      const { id: clienteId, empresa_id: empresaId } = req.cliente;

      const result = await pool.query(
        `SELECT v.id, v.data, v.total, v.pagamento, v.status_pagamento, v.observacao,
                COUNT(vi.id) AS total_itens
         FROM vendas v
         LEFT JOIN venda_itens vi ON vi.venda_id = v.id
         WHERE v.cliente_id = $1 AND v.empresa_id = $2
         GROUP BY v.id
         ORDER BY v.data DESC, v.id DESC
         LIMIT 50`,
        [clienteId, empresaId]
      );

      return ok(res, { vendas: result.rows.map((r) => ({
        ...r,
        total: Number(r.total || 0),
        total_itens: Number(r.total_itens || 0)
      })) });
    } catch (err) {
      console.error('[portal] GET vendas:', err.message);
      return erro(res, 500, 'Erro ao carregar vendas');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /portal/admin/clientes/:id/senha — define senha (ERP auth)
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/admin/clientes/:id/senha', auth, async (req, res) => {
    try {
      const clienteId = Number(req.params.id);
      const { senha } = req.body;

      if (!senha || String(senha).length < 4) {
        return erro(res, 400, 'A senha deve ter ao menos 4 caracteres');
      }

      const hash = await bcrypt.hash(String(senha), SALT_ROUNDS);

      const r = await pool.query(
        `UPDATE clientes SET senha_portal = $1, portal_ativo = true, atualizado_em = NOW()
         WHERE id = $2
         RETURNING id, nome, portal_ativo`,
        [hash, clienteId]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');

      return ok(res, { mensagem: 'Senha do portal configurada. Portal ativado.', cliente: r.rows[0] });
    } catch (err) {
      console.error('[portal] POST admin senha:', err.message);
      return erro(res, 500, 'Erro ao configurar senha do portal');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /portal/admin/clientes/:id/toggle — ativa/desativa portal (ERP auth)
  // ─────────────────────────────────────────────────────────────────────────
  router.patch('/admin/clientes/:id/toggle', auth, async (req, res) => {
    try {
      const clienteId = Number(req.params.id);

      const r = await pool.query(
        `UPDATE clientes
         SET portal_ativo = NOT portal_ativo, atualizado_em = NOW()
         WHERE id = $1
         RETURNING id, nome, portal_ativo`,
        [clienteId]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');

      const { nome, portal_ativo } = r.rows[0];
      return ok(res, {
        mensagem: `Portal ${portal_ativo ? 'ativado' : 'desativado'} para ${nome}`,
        portal_ativo
      });
    } catch (err) {
      console.error('[portal] PATCH toggle:', err.message);
      return erro(res, 500, 'Erro ao atualizar acesso ao portal');
    }
  });

  return router;
};
