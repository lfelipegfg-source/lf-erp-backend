/**
 * API Pública — LF ERP v1
 * Autenticada via X-Api-Key (SHA-256 do token real armazenado em empresa_api_keys).
 *
 * GET  /api/v1/status                  — health check (sem auth)
 * GET  /api/v1/produtos                — listar produtos
 * GET  /api/v1/produtos/:id            — detalhe produto
 * GET  /api/v1/clientes                — listar clientes
 * GET  /api/v1/clientes/:id            — detalhe cliente
 * GET  /api/v1/vendas                  — listar vendas
 * POST /api/v1/vendas                  — criar venda (dispara webhook venda.criada)
 * GET  /api/v1/estoque                 — saldo de estoque
 *
 * Paginação via ?page=1&limit=50 (máximo 200).
 */

const crypto = require('crypto');
const { dispatchWebhook } = require('../utils/webhooks');

module.exports = function ({ pool, writeRateLimiter, normalizarDecimal, normalizarInt, hoje }) {
  const router = require('express').Router();

  const VERSAO = '1.0.0';

  function ok(res, dados = {})              { return res.json({ sucesso: true, versao: VERSAO, ...dados }); }
  function erro(res, status = 500, msg = 'Erro interno') { return res.status(status).json({ sucesso: false, erro: msg }); }

  function paginacao(req) {
    const page  = Math.max(1, normalizarInt(req.query.page)  || 1);
    const limit = Math.min(200, Math.max(1, normalizarInt(req.query.limit) || 50));
    return { page, limit, offset: (page - 1) * limit };
  }

  // ── Rate limiter por empresa (100 req/min) ────────────────────────────────

  const _apiRateBuckets = new Map();
  function apiRateLimiter(req, res, next) {
    const key = req.apiEmpresaId || req.ip;
    const now = Date.now();
    const bucket = _apiRateBuckets.get(key) || { count: 0, resetAt: now + 60_000 };
    if (now > bucket.resetAt) { bucket.count = 0; bucket.resetAt = now + 60_000; }
    bucket.count++;
    _apiRateBuckets.set(key, bucket);
    if (bucket.count > 100) return erro(res, 429, 'Limite de requisições atingido. Aguarde 1 minuto.');
    next();
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of _apiRateBuckets) { if (now > b.resetAt + 120_000) _apiRateBuckets.delete(k); }
  }, 5 * 60_000).unref();

  // ── Middleware de autenticação via API Key ────────────────────────────────

  async function authApiKey(req, res, next) {
    const raw = req.headers['x-api-key'];
    if (!raw) return erro(res, 401, 'X-Api-Key é obrigatório');

    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const result = await pool.query(
      `SELECT ak.empresa_id, e.nome AS empresa_nome
       FROM empresa_api_keys ak
       JOIN empresas e ON e.id = ak.empresa_id
       WHERE ak.key_hash = $1 AND ak.ativo = true`,
      [hash]
    ).catch(() => ({ rows: [] }));

    if (result.rows.length === 0) return erro(res, 401, 'API key inválida ou revogada');

    req.apiEmpresaId   = result.rows[0].empresa_id;
    req.apiEmpresaNome = result.rows[0].empresa_nome;
    pool.query(`UPDATE empresa_api_keys SET ultimo_uso = NOW() WHERE key_hash = $1`, [hash]).catch(() => {});
    next();
  }

  // ── GET /api/v1/status ────────────────────────────────────────────────────

  router.get('/status', (_req, res) => {
    res.json({ sucesso: true, versao: VERSAO, status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── GET /api/v1/produtos ──────────────────────────────────────────────────

  router.get('/produtos', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const { page, limit, offset } = paginacao(req);
      const { busca, categoria } = req.query;
      const eId = req.apiEmpresaId;

      const params = [eId];
      let where = `WHERE empresa_id = $1 AND deletado_em IS NULL`;
      if (busca)     { params.push(`%${busca}%`); where += ` AND (nome ILIKE $${params.length} OR codigo ILIKE $${params.length})`; }
      if (categoria) { params.push(categoria);    where += ` AND categoria = $${params.length}`; }

      const [data, count] = await Promise.all([
        pool.query(
          `SELECT id, nome, codigo, categoria, preco, estoque, estoque_minimo,
                  unidade, descricao, ativo, criado_em
           FROM produtos ${where}
           ORDER BY nome
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM produtos ${where}`, params)
      ]);

      return ok(res, {
        total: Number(count.rows[0].count),
        page, limit,
        produtos: data.rows
      });
    } catch (err) {
      console.error('[api-publica] GET produtos:', err.message);
      return erro(res, 500, 'Erro ao listar produtos');
    }
  });

  router.get('/produtos/:id', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT p.id, p.nome, p.codigo, p.categoria, p.preco, p.estoque, p.estoque_minimo,
                p.unidade, p.descricao, p.ativo, p.criado_em,
                COALESCE(json_agg(
                  json_build_object(
                    'id', pg.id,
                    'atributo1', pg.atributo1,
                    'atributo2', pg.atributo2,
                    'sku', pg.sku,
                    'gtin', pg.gtin,
                    'preco', pg.preco,
                    'estoque', pg.estoque,
                    'estoque_minimo', pg.estoque_minimo,
                    'ativo', pg.ativo
                  )
                ) FILTER (WHERE pg.id IS NOT NULL), '[]') AS grades
         FROM produtos p
         LEFT JOIN produto_grades pg ON pg.produto_id = p.id AND pg.ativo = true
         WHERE p.id = $1 AND p.empresa_id = $2 AND p.deletado_em IS NULL
         GROUP BY p.id`,
        [Number(req.params.id), req.apiEmpresaId]
      );
      if (result.rowCount === 0) return erro(res, 404, 'Produto não encontrado');
      return ok(res, { produto: result.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar produto');
    }
  });

  // ── GET /api/v1/clientes ──────────────────────────────────────────────────

  router.get('/clientes', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const { page, limit, offset } = paginacao(req);
      const { busca } = req.query;
      const eId = req.apiEmpresaId;

      const params = [eId];
      let where = `WHERE empresa_id = $1 AND deletado_em IS NULL`;
      if (busca) { params.push(`%${busca}%`); where += ` AND (nome ILIKE $${params.length} OR cpf_cnpj ILIKE $${params.length})`; }

      const [data, count] = await Promise.all([
        pool.query(
          `SELECT id, nome, cpf_cnpj, telefone, email, cidade, uf, criado_em
           FROM clientes ${where} ORDER BY nome
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM clientes ${where}`, params)
      ]);

      return ok(res, { total: Number(count.rows[0].count), page, limit, clientes: data.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar clientes');
    }
  });

  router.get('/clientes/:id', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT c.*,
                COALESCE(SUM(cr.valor) FILTER (WHERE cr.status NOT IN ('pago')), 0) AS saldo_aberto
         FROM clientes c
         LEFT JOIN contas_receber cr ON cr.cliente_id = c.id AND cr.empresa_id = c.empresa_id
         WHERE c.id = $1 AND c.empresa_id = $2 AND c.deletado_em IS NULL
         GROUP BY c.id`,
        [Number(req.params.id), req.apiEmpresaId]
      );
      if (result.rowCount === 0) return erro(res, 404, 'Cliente não encontrado');
      return ok(res, { cliente: result.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar cliente');
    }
  });

  // ── GET /api/v1/vendas ────────────────────────────────────────────────────

  router.get('/vendas', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const { page, limit, offset } = paginacao(req);
      const { inicio, fim, status } = req.query;
      const eId = req.apiEmpresaId;

      const params = [eId];
      let where = `WHERE empresa_id = $1`;
      if (inicio) { params.push(inicio); where += ` AND data >= $${params.length}`; }
      if (fim)    { params.push(fim);    where += ` AND data <= $${params.length}`; }
      if (status) { params.push(status); where += ` AND status_pagamento = $${params.length}`; }

      const [data, count] = await Promise.all([
        pool.query(
          `SELECT id, data, cliente_nome, total, pagamento, status_pagamento, parcelas, criado_em
           FROM vendas ${where} ORDER BY data DESC, id DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM vendas ${where}`, params)
      ]);

      return ok(res, { total: Number(count.rows[0].count), page, limit, vendas: data.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar vendas');
    }
  });

  // ── POST /api/v1/vendas ───────────────────────────────────────────────────

  router.post('/vendas', authApiKey, apiRateLimiter, writeRateLimiter, async (req, res) => {
    const client = await pool.connect();
    try {
      const eId   = req.apiEmpresaId;
      const eNome = req.apiEmpresaNome;
      const { cliente_id, cliente_nome, itens, pagamento, total, observacao } = req.body;

      if (!Array.isArray(itens) || itens.length === 0) return erro(res, 400, 'itens é obrigatório e não pode estar vazio');
      if (!total) return erro(res, 400, 'total é obrigatório');

      await client.query('BEGIN');

      const vendaResult = await client.query(
        `INSERT INTO vendas
           (empresa, empresa_id, cliente_id, cliente_nome, subtotal, desconto, acrescimo, total,
            pagamento, pagamentos, parcelas, status_pagamento, data, observacao, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,0,0,$5,$6,$7,1,'pago',$8,$9,NOW(),NOW()) RETURNING *`,
        [
          eNome, eId,
          cliente_id   ? Number(cliente_id)   : null,
          cliente_nome || null,
          normalizarDecimal(total),
          pagamento || 'API',
          JSON.stringify([{ forma: pagamento || 'API', valor: normalizarDecimal(total), parcelas: 1 }]),
          hoje(),
          observacao || 'Venda criada via API'
        ]
      );
      const venda = vendaResult.rows[0];

      for (const item of itens) {
        const prodResult = await client.query(
          `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
          [Number(item.produto_id), eId]
        );
        if (prodResult.rowCount === 0) throw new Error(`Produto ${item.produto_id} não encontrado`);

        const p   = prodResult.rows[0];
        const qtd = normalizarInt(item.quantidade) || 1;
        const preco = normalizarDecimal(item.preco_unitario || p.preco);

        await client.query(
          `INSERT INTO venda_itens (venda_id, empresa, empresa_id, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [venda.id, eNome, eId, p.id, p.nome, qtd, preco, p.custo || 0, Number((qtd * preco).toFixed(2))]
        );

        await client.query(
          `UPDATE produtos SET estoque = GREATEST(0, estoque - $1), atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`,
          [qtd, p.id, eId]
        );
      }

      await client.query('COMMIT');

      // Dispara webhook assincronamente
      dispatchWebhook({ pool, empresaId: eId, evento: 'venda.criada', payload: { id: venda.id, total: venda.total, cliente_nome: venda.cliente_nome, data: venda.data } }).catch(() => {});

      return res.status(201).json({ sucesso: true, versao: VERSAO, venda: { id: venda.id, total: venda.total } });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[api-publica] POST vendas:', err.message);
      return erro(res, err.message.includes('não encontrado') ? 400 : 500, err.message);
    } finally {
      client.release();
    }
  });

  // ── GET /api/v1/estoque ───────────────────────────────────────────────────

  router.get('/estoque', authApiKey, apiRateLimiter, async (req, res) => {
    try {
      const { page, limit, offset } = paginacao(req);
      const { abaixo_minimo } = req.query;
      const eId = req.apiEmpresaId;

      const params = [eId];
      let where = `WHERE empresa_id = $1 AND deletado_em IS NULL`;
      if (abaixo_minimo === 'true') where += ` AND estoque_minimo > 0 AND estoque < estoque_minimo`;

      const [data, count] = await Promise.all([
        pool.query(
          `SELECT id, nome, codigo, estoque, estoque_minimo, unidade
           FROM produtos ${where} ORDER BY nome
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(`SELECT COUNT(*) FROM produtos ${where}`, params)
      ]);

      return ok(res, { total: Number(count.rows[0].count), page, limit, estoque: data.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao buscar estoque');
    }
  });

  return router;
};
