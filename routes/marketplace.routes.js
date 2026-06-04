/**
 * Marketplace — LF ERP
 * Integração com Mercado Livre e Shopee.
 * Sincroniza estoque de produtos e recebe pedidos.
 *
 * Rotas:
 *   GET    /marketplace/config          — configurações das plataformas
 *   PUT    /marketplace/config          — salvar App ID / Secret
 *   GET    /marketplace/oauth/callback  — recebe code OAuth2 (ML/Shopee)
 *   GET    /marketplace/oauth/url       — gera URL de autorização
 *   POST   /marketplace/sync-estoque    — sincroniza estoque de um produto
 *   GET    /marketplace/produtos         — lista produtos vinculados
 *   POST   /marketplace/vincular        — vincula produto LF ERP ↔ listing
 *   DELETE /marketplace/vincular/:id    — remove vínculo
 *   POST   /marketplace/webhook/:plataforma — recebe notificações (pedidos)
 */

const https = require('https');

module.exports = function ({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje, registrarMovimentacaoEstoque, criarParcelasContasReceber }) {
  const router = require('express').Router();

  function ok(res, dados = {}) { return res.json({ sucesso: true, ...dados }); }
  function erro(res, status = 500, msg = 'Erro interno') { return res.status(status).json({ sucesso: false, erro: msg }); }

  const ML_BASE = 'https://api.mercadolibre.com';
  const ML_AUTH = 'https://auth.mercadolivre.com.br/authorization';
  const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';

  async function apiGet(url, token) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const opts = {
        hostname: u.hostname, path: u.pathname + u.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      };
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ ok: false, status: res.statusCode, data }); } });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function apiPost(url, token, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const bodyStr = JSON.stringify(body);
      const opts = {
        hostname: u.hostname, path: u.pathname + u.search,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
      };
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) }); } catch { resolve({ ok: false, status: res.statusCode, data }); } });
      });
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
  }

  async function getConfig(empresaId, plataforma) {
    const r = await pool.query(
      `SELECT * FROM marketplace_config WHERE empresa_id = $1 AND plataforma = $2`,
      [empresaId, plataforma]
    );
    return r.rows[0] || null;
  }

  async function refreshMlToken(cfg, empresaId) {
    if (!cfg.refresh_token || !cfg.app_id || !cfg.client_secret) return null;
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: cfg.app_id,
        client_secret: cfg.client_secret,
        refresh_token: cfg.refresh_token
      });
      const res = await fetch(ML_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const data = await res.json();
      if (!res.ok || !data.access_token) return null;

      await pool.query(
        `UPDATE marketplace_config SET
           access_token = $1, refresh_token = $2,
           token_expires_at = NOW() + INTERVAL '6 hours',
           atualizado_em = NOW()
         WHERE empresa_id = $3 AND plataforma = 'mercadolivre'`,
        [data.access_token, data.refresh_token || cfg.refresh_token, empresaId]
      );
      return data.access_token;
    } catch { return null; }
  }

  async function getMlToken(empresaId) {
    const cfg = await getConfig(empresaId, 'mercadolivre');
    if (!cfg?.access_token) return null;

    // Se expirado, tenta renovar
    if (cfg.token_expires_at && new Date(cfg.token_expires_at) < new Date()) {
      return refreshMlToken(cfg, empresaId);
    }
    return cfg.access_token;
  }

  // ── Processar pedido ML ────────────────────────────────────────────────────
  // Cria uma venda no LF ERP a partir de um pedido do Mercado Livre.
  // Idempotente: pedidos já processados são ignorados silenciosamente.
  async function processarPedidoML({ orderId, empresaId, empresaNome, token }) {
    // 1. Idempotência
    const jaProcessado = await pool.query(
      `SELECT id, venda_id FROM marketplace_pedidos WHERE plataforma = 'mercadolivre' AND pedido_externo = $1`,
      [String(orderId)]
    );
    if (jaProcessado.rowCount > 0) {
      return { jaProcessado: true, vendaId: jaProcessado.rows[0].venda_id };
    }

    // 2. Buscar pedido completo na ML API
    const mlRes = await apiGet(`${ML_BASE}/orders/${orderId}`, token);
    if (!mlRes.ok) throw new Error(`ML API /orders/${orderId}: ${JSON.stringify(mlRes.data)}`);
    const order = mlRes.data;

    // Só processa pedidos efetivamente pagos
    const STATUS_PROCESSAVEIS = ['paid', 'confirmed'];
    if (!STATUS_PROCESSAVEIS.includes(order.status)) {
      console.log(`[marketplace] pedido ML #${orderId} status="${order.status}" — aguardando pagamento`);
      return { aguardando: true, status: order.status };
    }

    // 3. Mapear itens do ML → produtos LF ERP
    const itensVenda = [];
    for (const oi of (order.order_items || [])) {
      const listingId = oi.item?.id;
      if (!listingId) continue;

      const vinculo = await pool.query(
        `SELECT produto_id FROM marketplace_produtos WHERE listing_id = $1 AND empresa_id = $2`,
        [listingId, empresaId]
      );
      if (vinculo.rowCount === 0) {
        console.warn(`[marketplace] listing ${listingId} não mapeado para empresa ${empresaId} — item ignorado`);
        continue;
      }

      itensVenda.push({
        produto_id: vinculo.rows[0].produto_id,
        quantidade: normalizarInt(oi.quantity) || 1,
        preco_unitario: normalizarDecimal(oi.unit_price)
      });
    }

    if (itensVenda.length === 0) {
      await pool.query(
        `INSERT INTO marketplace_pedidos (empresa_id, plataforma, pedido_externo, status, dados_raw)
         VALUES ($1, 'mercadolivre', $2, 'sem_produtos', $3)
         ON CONFLICT (plataforma, pedido_externo) DO NOTHING`,
        [empresaId, String(orderId), JSON.stringify(order)]
      );
      return { semProdutos: true };
    }

    // 4. Resolver cliente
    const buyer = order.buyer || {};
    const buyerNome = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() || buyer.nickname || 'ML Cliente';

    let clienteId = null;
    if (buyer.email) {
      const cr = await pool.query(
        `SELECT id FROM clientes WHERE email = $1 AND empresa_id = $2 AND deletado_em IS NULL LIMIT 1`,
        [buyer.email, empresaId]
      );
      if (cr.rowCount > 0) clienteId = cr.rows[0].id;
    }

    // 5. Preparar dados da venda
    const totalVenda   = normalizarDecimal(order.total_amount);
    const dataVenda    = normalizarDataISO((order.date_created || '').substring(0, 10)) || hoje();
    const observacao   = `Pedido ML #${orderId}`;
    const pagamentoStr = 'Mercado Livre';
    const pagamentosJson = JSON.stringify([{ forma: pagamentoStr, valor: totalVenda, parcelas: 1 }]);

    // 6. Transação
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Buscar nome do cliente se vinculado
      let clienteNomeFinal = buyerNome;
      if (clienteId) {
        const cNome = await client.query(`SELECT nome FROM clientes WHERE id = $1`, [clienteId]);
        if (cNome.rowCount > 0) clienteNomeFinal = cNome.rows[0].nome;
      }

      // INSERT venda
      const vendaResult = await client.query(
        `INSERT INTO vendas
           (empresa, empresa_id, cliente_id, cliente_nome, subtotal, desconto, acrescimo, total,
            pagamento, pagamentos, parcelas, status_pagamento, data, observacao, criado_em, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,0,0,$5,$6,$7,1,'pago',$8,$9,NOW(),NOW())
         RETURNING *`,
        [empresaNome, empresaId, clienteId, clienteNomeFinal,
         totalVenda, pagamentoStr, pagamentosJson, dataVenda, observacao]
      );
      const venda = vendaResult.rows[0];

      // INSERT itens + baixa de estoque
      for (const item of itensVenda) {
        const prodResult = await client.query(
          `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
          [item.produto_id, empresaId]
        );
        if (prodResult.rowCount === 0) continue;

        const produto     = prodResult.rows[0];
        const qtd         = item.quantidade;
        const precoUnit   = normalizarDecimal(item.preco_unitario || produto.preco);
        const custoUnit   = normalizarDecimal(produto.custo || 0);
        const totalItem   = Number((qtd * precoUnit).toFixed(2));

        await client.query(
          `INSERT INTO venda_itens
             (venda_id, empresa, empresa_id, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [venda.id, empresaNome, empresaId, produto.id, produto.nome, qtd, precoUnit, custoUnit, totalItem]
        );

        await client.query(
          `UPDATE produtos SET estoque = GREATEST(0, estoque - $1), atualizado_em = NOW()
           WHERE id = $2 AND empresa_id = $3`,
          [qtd, produto.id, empresaId]
        );

        await registrarMovimentacaoEstoque({
          client,
          empresa: empresaNome,
          empresa_id: empresaId,
          produto_id: produto.id,
          tipo: 'saida',
          quantidade: qtd,
          observacao,
          referencia_tipo: 'venda',
          referencia_id: venda.id,
          usuario_id: null
        });
      }

      // Registro de idempotência
      await client.query(
        `INSERT INTO marketplace_pedidos (empresa_id, plataforma, pedido_externo, status, venda_id, dados_raw)
         VALUES ($1, 'mercadolivre', $2, 'processado', $3, $4)
         ON CONFLICT (plataforma, pedido_externo) DO UPDATE SET status = 'processado', venda_id = $3`,
        [empresaId, String(orderId), venda.id, JSON.stringify(order)]
      );

      await client.query('COMMIT');
      return { vendaId: venda.id };
    } catch (err) {
      await client.query('ROLLBACK');
      // Registra erro para diagnóstico
      await pool.query(
        `INSERT INTO marketplace_pedidos (empresa_id, plataforma, pedido_externo, status, erro_msg, dados_raw)
         VALUES ($1, 'mercadolivre', $2, 'erro', $3, $4)
         ON CONFLICT (plataforma, pedido_externo) DO UPDATE SET status = 'erro', erro_msg = $3`,
        [empresaId, String(orderId), err.message, JSON.stringify(order)]
      ).catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  router.get('/config', auth, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT plataforma, seller_id, app_id,
                CASE WHEN access_token IS NOT NULL THEN 'conectado' ELSE 'desconectado' END AS status_conexao,
                token_expires_at, ativo, atualizado_em
         FROM marketplace_config WHERE empresa_id = $1`,
        [empresaResolvida.id]
      );

      return ok(res, { plataformas: result.rows });
    } catch (err) {
      console.error('[marketplace] GET config:', err.message);
      return erro(res, 500, 'Erro ao buscar configuração');
    }
  });

  router.put('/config', auth, writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { plataforma, app_id, client_secret } = req.body;
      if (!plataforma || !app_id) return erro(res, 400, 'plataforma e app_id são obrigatórios');

      await pool.query(
        `INSERT INTO marketplace_config (empresa_id, plataforma, app_id, client_secret)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (empresa_id, plataforma) DO UPDATE
         SET app_id = $3, client_secret = COALESCE(NULLIF($4,'***'), marketplace_config.client_secret),
             atualizado_em = NOW()`,
        [empresaResolvida.id, plataforma, app_id, client_secret || null]
      );

      return ok(res, { mensagem: 'Configuração salva. Agora faça a autorização OAuth.' });
    } catch (err) {
      console.error('[marketplace] PUT config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração');
    }
  });

  // ── OAuth ──────────────────────────────────────────────────────────────────

  router.get('/oauth/url', auth, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { plataforma } = req.query;
      const cfg = await getConfig(empresaResolvida.id, plataforma);
      if (!cfg?.app_id) return erro(res, 400, 'Configure o App ID antes de autorizar');

      const redirectUri = process.env.MARKETPLACE_REDIRECT_URI || `${process.env.BACKEND_URL || ''}/marketplace/oauth/callback`;
      const state = Buffer.from(JSON.stringify({ empresa_id: empresaResolvida.id, plataforma })).toString('base64');

      let url;
      if (plataforma === 'mercadolivre') {
        url = `${ML_AUTH}?response_type=code&client_id=${cfg.app_id}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      } else {
        return erro(res, 400, `Plataforma '${plataforma}' não suportada ainda`);
      }

      return ok(res, { url });
    } catch (err) {
      console.error('[marketplace] GET oauth/url:', err.message);
      return erro(res, 500, 'Erro ao gerar URL OAuth');
    }
  });

  router.get('/oauth/callback', async (req, res) => {
    try {
      const { code, state } = req.query;
      if (!code || !state) return res.send('<h3>Parâmetros inválidos</h3>');

      const { empresa_id, plataforma } = JSON.parse(Buffer.from(state, 'base64').toString());
      const cfg = await getConfig(empresa_id, plataforma);
      if (!cfg) return res.send('<h3>Configuração não encontrada</h3>');

      const redirectUri = process.env.MARKETPLACE_REDIRECT_URI || `${process.env.BACKEND_URL || ''}/marketplace/oauth/callback`;

      let accessToken, refreshToken, sellerId;

      if (plataforma === 'mercadolivre') {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: cfg.app_id,
          client_secret: cfg.client_secret,
          code,
          redirect_uri: redirectUri
        });
        const tokenRes = await fetch(ML_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return res.send(`<h3>Erro na autenticação: ${JSON.stringify(tokenData)}</h3>`);
        }
        accessToken  = tokenData.access_token;
        refreshToken = tokenData.refresh_token;
        sellerId     = String(tokenData.user_id || '');
      }

      await pool.query(
        `UPDATE marketplace_config
         SET access_token = $1, refresh_token = $2, seller_id = $3,
             token_expires_at = NOW() + INTERVAL '6 hours', atualizado_em = NOW()
         WHERE empresa_id = $4 AND plataforma = $5`,
        [accessToken, refreshToken, sellerId, empresa_id, plataforma]
      );

      res.send(`<h3>✅ Autorização concluída!</h3><p>Feche esta janela e volte ao LF ERP.</p><script>window.close();</script>`);
    } catch (err) {
      console.error('[marketplace] oauth callback:', err.message);
      res.send(`<h3>Erro: ${err.message}</h3>`);
    }
  });

  // ── Sync estoque ───────────────────────────────────────────────────────────

  router.post('/sync-estoque', auth, writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { produto_id, plataforma } = req.body;
      if (!produto_id || !plataforma) return erro(res, 400, 'produto_id e plataforma são obrigatórios');

      // Busca vínculo
      const vinculo = await pool.query(
        `SELECT * FROM marketplace_produtos WHERE empresa_id = $1 AND produto_id = $2 AND plataforma = $3`,
        [empresaResolvida.id, produto_id, plataforma]
      );
      if (vinculo.rowCount === 0) return erro(res, 404, 'Produto não vinculado a esta plataforma');

      const link = vinculo.rows[0];

      // Busca estoque atual do produto
      const prodResult = await pool.query(
        `SELECT estoque FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [produto_id, empresaResolvida.id]
      );
      if (prodResult.rowCount === 0) return erro(res, 404, 'Produto não encontrado');

      const estoqueAtual = normalizarInt(prodResult.rows[0].estoque);

      if (plataforma === 'mercadolivre') {
        const token = await getMlToken(empresaResolvida.id);
        if (!token) return erro(res, 400, 'Token ML expirado. Reautorize a integração.');

        const mlRes = await apiPost(
          `${ML_BASE}/items/${link.listing_id}`,
          token,
          { available_quantity: Math.max(0, estoqueAtual) }
        );

        if (!mlRes.ok) {
          return erro(res, 400, `Erro ML: ${JSON.stringify(mlRes.data)}`);
        }
      }

      // Atualiza sync local
      await pool.query(
        `UPDATE marketplace_produtos SET estoque_publicado = $1, ultimo_sync = NOW() WHERE id = $2`,
        [estoqueAtual, link.id]
      );

      return ok(res, { mensagem: `Estoque sincronizado: ${estoqueAtual} unidades`, listing_id: link.listing_id });
    } catch (err) {
      console.error('[marketplace] sync-estoque:', err.message);
      return erro(res, 500, `Erro ao sincronizar: ${err.message}`);
    }
  });

  // ── Produtos vinculados ────────────────────────────────────────────────────

  router.get('/produtos', auth, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT mp.*, p.nome AS produto_nome, p.estoque AS estoque_lferp
         FROM marketplace_produtos mp
         JOIN produtos p ON p.id = mp.produto_id
         WHERE mp.empresa_id = $1
         ORDER BY mp.plataforma, p.nome`,
        [empresaResolvida.id]
      );

      return ok(res, { produtos: result.rows });
    } catch (err) {
      return erro(res, 500, 'Erro ao listar produtos');
    }
  });

  router.post('/vincular', auth, writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { produto_id, plataforma, listing_id, titulo } = req.body;
      if (!produto_id || !plataforma || !listing_id) {
        return erro(res, 400, 'produto_id, plataforma e listing_id são obrigatórios');
      }

      const result = await pool.query(
        `INSERT INTO marketplace_produtos
           (empresa_id, produto_id, plataforma, listing_id, titulo, ultimo_sync)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (empresa_id, produto_id, plataforma) DO UPDATE
         SET listing_id = $4, titulo = $5, ultimo_sync = NOW()
         RETURNING *`,
        [empresaResolvida.id, produto_id, plataforma, listing_id, titulo || null]
      );

      return res.status(201).json({ sucesso: true, vinculo: result.rows[0] });
    } catch (err) {
      return erro(res, 500, 'Erro ao vincular produto');
    }
  });

  router.delete('/vincular/:id', auth, writeRateLimiter, async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      await pool.query(
        `DELETE FROM marketplace_produtos WHERE id = $1 AND empresa_id = $2`,
        [Number(req.params.id), empresaResolvida.id]
      );
      return ok(res, { mensagem: 'Vínculo removido' });
    } catch (err) {
      return erro(res, 500, 'Erro ao remover vínculo');
    }
  });

  // ── Webhook (notificações de pedidos) ─────────────────────────────────────

  router.post('/webhook/:plataforma', async (req, res) => {
    // Responde 200 imediatamente — ML considera falha se demorar > 5s
    res.status(200).json({ ok: true });

    try {
      const { plataforma } = req.params;
      const payload = req.body;

      console.log(`[marketplace] webhook ${plataforma}:`, JSON.stringify(payload).slice(0, 300));

      if (plataforma === 'mercadolivre' && payload.topic === 'orders_v2') {
        const match = String(payload.resource || '').match(/\/orders\/(\d+)/);
        if (!match) return;

        const orderId  = match[1];
        const sellerId = String(payload.user_id || '');

        // Encontrar qual empresa pertence a este seller
        const cfgResult = await pool.query(
          `SELECT mc.empresa_id, e.nome AS empresa_nome
           FROM marketplace_config mc
           JOIN empresas e ON e.id = mc.empresa_id
           WHERE mc.seller_id = $1 AND mc.plataforma = 'mercadolivre' AND mc.ativo = true
           LIMIT 1`,
          [sellerId]
        );

        if (cfgResult.rowCount === 0) {
          console.warn(`[marketplace] webhook ML: seller_id "${sellerId}" não encontrado`);
          return;
        }

        const { empresa_id: empresaId, empresa_nome: empresaNome } = cfgResult.rows[0];

        const token = await getMlToken(empresaId);
        if (!token) {
          console.warn(`[marketplace] webhook ML: token expirado para empresa ${empresaId} — pedido #${orderId} não processado`);
          return;
        }

        const resultado = await processarPedidoML({ orderId, empresaId, empresaNome, token });
        console.log(`[marketplace] pedido ML #${orderId}:`, resultado);
      }
    } catch (err) {
      console.error('[marketplace] webhook erro:', err.message);
    }
  });

  return router;
};
