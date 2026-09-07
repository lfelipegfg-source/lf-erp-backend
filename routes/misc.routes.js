'use strict';
const express = require('express');
const { requirePermissao }   = require('../utils/permissoes');
const { normalizarDecimal, normalizarInt, normalizarDataISO, hoje, addDias } = require('../utils/normalizadores');
const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');

module.exports = function miscRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  podeGerenciarFinanceiro, atualizarStatusContasPagarPorEmpresa,
  jsonErro
}) {
  const router = express.Router();
// ================= COMPRAS =================

router.get('/compras/:empresa', auth, requirePermissao(pool, 'compras', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const busca = (req.query.busca || '').trim().toLowerCase();
    const fornecedorId = normalizarInt(req.query.fornecedor_id || 0);
    const { dataInicial, dataFinal } = obterPeriodo(req);

    const params = [];
    let sql = `
        SELECT
          c.*,
          f.nome AS fornecedor_nome
        FROM compras c
        LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
        WHERE 1=1
      `;
    sql += adicionarFiltroEmpresaSaaS({ alias: 'c', params, empresaResolvida });
    let idx = params.length + 1;

    if (fornecedorId > 0) {
      sql += ` AND c.fornecedor_id = $${idx} `;
      params.push(fornecedorId);
      idx++;
    }

    if (busca) {
      const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
      sql += `
          AND (
            LOWER(COALESCE(f.nome, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(c.observacao, '')) LIKE $${idx} ESCAPE '\\'
            OR CAST(c.id AS TEXT) LIKE $${idx} ESCAPE '\\'
          )
        `;
      params.push(`%${buscaEsc}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'c.data',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const paginaC = Math.max(1, normalizarInt(req.query.page || 1));
    const limiteC = Math.min(normalizarInt(req.query.limit || 100), 500);
    const offsetC = (paginaC - 1) * limiteC;
    sql += ` ORDER BY c.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limiteC, offsetC);

    const result = await pool.query(sql, params);
    res.json(
      result.rows.map((row) => ({
        ...row,
        total: Number(row.total || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar compras:', error);
    jsonErro(res, 500, 'Erro ao buscar compras');
  }
});

router.delete('/compras/:id', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'deletar'), async (req, res) => {
  if (!podeGerenciarCompras(req)) {
    return jsonErro(res, 403, 'Sem permissÃ£o para excluir compras');
  }

  const id = Number(req.params.id);
  if (!id) return jsonErro(res, 400, 'Compra invÃ¡lida');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const empresa = req.query.empresa || req.body.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      await client.query('ROLLBACK');
      return jsonErro(res, 403, 'Sem acesso');
    }

    const compraResult = await client.query(
      `SELECT * FROM compras
       WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
       FOR UPDATE`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    if (compraResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return jsonErro(res, 404, 'Compra nÃ£o encontrada');
    }

    const itensResult = await client.query(
      `
      SELECT *
      FROM compra_itens
      WHERE compra_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      ORDER BY id ASC
      FOR UPDATE
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    for (const item of itensResult.rows) {
      await client.query(
        `UPDATE produtos SET estoque = GREATEST(0, estoque - $1), atualizado_em = NOW()
         WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
        [normalizarInt(item.quantidade), item.produto_id, empresaResolvida.id, empresaResolvida.nome]
      );
    }

    await client.query(
      `
      DELETE FROM movimentacoes_estoque
      WHERE referencia_tipo = 'compra'
        AND referencia_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM contas_pagar
      WHERE compra_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM compra_itens
      WHERE compra_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM compras
      WHERE id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query('COMMIT');
    try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[del-compra] status-cp:', e.message); }

    res.json({ sucesso: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro real ao excluir compra:', error);
    jsonErro(res, 500, 'Erro ao excluir compra');
  } finally {
    client.release();
  }
});

router.get('/compras-detalhe/:id', auth, requirePermissao(pool, 'compras', 'ver'), async (req, res) => {
  try {
    const id = Number(req.params.id);

    const empresaResolvida = await validarAcessoEmpresa(req, req.user.empresa || null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const compraResult = await pool.query(
      `
      SELECT
        c.*,
        f.nome AS fornecedor_nome
      FROM compras c
      LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
      WHERE c.id = $1
        AND (c.empresa_id = $2 OR (c.empresa_id IS NULL AND c.empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    if (compraResult.rowCount === 0) {
      return jsonErro(res, 404, 'Compra nÃ£o encontrada');
    }

    const compra = compraResult.rows[0];

    const itensResult = await pool.query(
      `SELECT * FROM compra_itens WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) ORDER BY id ASC`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    const contasPagarResult = await pool.query(
      `SELECT * FROM contas_pagar WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) ORDER BY parcela ASC, id ASC`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    res.json({
      ...compra,
      total: Number(compra.total || 0),
      parcelas: Number(contasPagarResult.rows[0]?.total_parcelas || 1),
      itens: itensResult.rows.map((item) => ({
        ...item,
        quantidade: Number(item.quantidade || 0),
        custo_unitario: Number(item.custo_unitario || 0),
        subtotal: Number(item.subtotal || 0)
      })),
      contas_pagar: contasPagarResult.rows.map((cp) => ({
        ...cp,
        parcela: Number(cp.parcela || 1),
        total_parcelas: Number(cp.total_parcelas || 1),
        valor: Number(cp.valor || 0)
      }))
    });
  } catch (error) {
    console.error('Erro real ao buscar compra:', error);
    jsonErro(res, 500, 'Erro ao buscar compra');
  }
});

// ================= LISTAGENS OPERACIONAIS AUXILIARES =================
router.get('/estoque/resumo/:empresa', auth, requirePermissao(pool, 'estoque', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const params = [];
    const filtro = adicionarFiltroEmpresaSaaS({ params, empresaResolvida });

    const result = await pool.query(
      `
        SELECT
          COUNT(*) AS total_produtos,
          COALESCE(SUM(estoque), 0) AS total_unidades,
          COALESCE(SUM(estoque * custo), 0) AS valor_total_estoque,
          COALESCE(SUM(CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN 1 ELSE 0 END), 0) AS produtos_alerta
        FROM produtos
        WHERE deletado_em IS NULL
        ${filtro}
        `,
      params
    );

    res.json({
      total_produtos: Number(result.rows[0].total_produtos || 0),
      total_unidades: Number(result.rows[0].total_unidades || 0),
      valor_total_estoque: Number(result.rows[0].valor_total_estoque || 0),
      produtos_alerta: Number(result.rows[0].produtos_alerta || 0)
    });
  } catch (error) {
    console.error('Erro ao buscar resumo de estoque:', error);
    jsonErro(res, 500, 'Erro ao buscar resumo de estoque');
  }
});

router.get('/compras-fornecedores/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          f.id,
          f.nome,
          COUNT(c.id) AS total_compras,
          COALESCE(SUM(c.total), 0) AS valor_total
        FROM fornecedores f
        LEFT JOIN compras c ON c.fornecedor_id = f.id AND (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))
        WHERE (f.empresa_id = $1 OR (f.empresa_id IS NULL AND f.empresa = $2))
        GROUP BY f.id, f.nome
        ORDER BY valor_total DESC, f.nome ASC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(
      result.rows.map((row) => ({
        ...row,
        total_compras: Number(row.total_compras || 0),
        valor_total: Number(row.valor_total || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar resumo de compras por fornecedor:', error);
    jsonErro(res, 500, 'Erro ao buscar resumo de compras por fornecedor');
  }
});

router.get('/vendas-clientes/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          COALESCE(cliente_nome, 'Sem cliente') AS cliente,
          COUNT(*) AS total_vendas,
          COALESCE(SUM(total), 0) AS valor_total
        FROM vendas
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
        GROUP BY COALESCE(cliente_nome, 'Sem cliente')
        ORDER BY valor_total DESC, cliente ASC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(
      result.rows.map((row) => ({
        ...row,
        total_vendas: Number(row.total_vendas || 0),
        valor_total: Number(row.valor_total || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar resumo de vendas por cliente:', error);
    jsonErro(res, 500, 'Erro ao buscar resumo de vendas por cliente');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason, promise);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});



// â”€â”€ Metas de vendas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /metas-vendas?periodo=YYYY-MM â€” lista metas com progresso real
router.get('/metas-vendas', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const periodo = req.query.periodo || hoje().slice(0, 7); // default: mÃªs atual

    // Calcula intervalo de datas do perÃ­odo
    let dataInicio, dataFim;
    if (/^\d{4}-\d{2}$/.test(periodo)) {
      // Mensal: YYYY-MM
      dataInicio = `${periodo}-01`;
      const [y, m] = periodo.split('-').map(Number);
      const fim = new Date(y, m, 0); // Ãºltimo dia do mÃªs
      dataFim = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(fim);
    } else {
      dataInicio = hoje().slice(0, 8) + '01';
      dataFim = hoje();
    }

    const metasResult = await pool.query(
      `SELECT m.*, u.nome_completo AS vendedor_nome, u.usuario AS vendedor_usuario
       FROM metas_vendas m
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.empresa_id = $1 AND m.periodo = $2
       ORDER BY m.usuario_id NULLS FIRST, m.id`,
      [empresaResolvida.id, periodo]
    );

    // Calcula progresso real via vendas do perÃ­odo â€” query Ãºnica com GROUP BY (evita N+1)
    const realizadoResult = await pool.query(
      `SELECT criado_por AS usuario_id, COALESCE(SUM(total), 0) AS realizado
       FROM vendas
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $4)) AND data >= $2 AND data <= $3
       GROUP BY criado_por`,
      [empresaResolvida.id, dataInicio, dataFim, empresaResolvida.nome || '']
    );
    const realizadoMap = {};
    let realizadoTotal = 0;
    for (const r of realizadoResult.rows) {
      const v = Number(r.realizado || 0);
      realizadoMap[r.usuario_id] = v;
      realizadoTotal += v;
    }
    const metasComProgresso = metasResult.rows.map((meta) => {
      // Meta por usuÃ¡rio â†’ apenas vendas daquele usuÃ¡rio; meta geral â†’ todas as vendas
      const realizado = meta.usuario_id ? (realizadoMap[meta.usuario_id] || 0) : realizadoTotal;
      const meta_valor = Number(meta.valor_meta || 0);
      const percentual = meta_valor > 0 ? Math.min(100, Math.round((realizado / meta_valor) * 100)) : 0;
      return { ...meta, realizado, percentual, faltando: Math.max(0, meta_valor - realizado) };
    });

    res.json({ sucesso: true, periodo, data_inicio: dataInicio, data_fim: dataFim, metas: metasComProgresso });
  } catch (err) {
    console.error('[metas] GET:', err.message);
    jsonErro(res, 500, 'Erro ao carregar metas');
  }
});

// POST /metas-vendas â€” criar ou atualizar meta
router.post('/metas-vendas', auth, writeRateLimiter, requirePermissao(pool, 'relatorios', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { usuario_id, periodo, valor_meta, descricao } = req.body;
    if (!periodo || !valor_meta) return jsonErro(res, 400, 'periodo e valor_meta sÃ£o obrigatÃ³rios');
    if (!/^\d{4}-\d{2}$/.test(periodo)) return jsonErro(res, 400, 'periodo deve ser YYYY-MM');

    if (usuario_id) {
      const uCheck = await pool.query(
        `SELECT 1 FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
        [Number(usuario_id), empresaResolvida.id, empresaResolvida.nome || '']
      );
      if (uCheck.rowCount === 0) return jsonErro(res, 400, 'UsuÃ¡rio nÃ£o pertence Ã  empresa');
    }

    const result = await pool.query(
      `INSERT INTO metas_vendas (empresa_id, usuario_id, periodo, valor_meta, descricao)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (empresa_id, usuario_id, periodo) DO UPDATE
       SET valor_meta = $4, descricao = $5, atualizado_em = NOW()
       RETURNING *`,
      [empresaResolvida.id, usuario_id || null, periodo,
       normalizarDecimal(valor_meta), descricao || null]
    );

    res.status(201).json({ sucesso: true, meta: result.rows[0] });
  } catch (err) {
    console.error('[metas] POST:', err.message);
    jsonErro(res, 500, 'Erro ao salvar meta');
  }
});

// DELETE /metas-vendas/:id
router.delete('/metas-vendas/:id', auth, writeRateLimiter, requirePermissao(pool, 'relatorios', 'deletar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const r = await pool.query(
      `DELETE FROM metas_vendas WHERE id = $1 AND empresa_id = $2`,
      [Number(req.params.id), empresaResolvida.id]
    );
    if (r.rowCount === 0) return jsonErro(res, 404, 'Meta nÃ£o encontrada');
    res.json({ sucesso: true });
  } catch (err) {
    console.error('[metas] DELETE:', err.message);
    jsonErro(res, 500, 'Erro ao excluir meta');
  }
});


// â”€â”€ Multi-depÃ³sito â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /depositos â€” lista depÃ³sitos da empresa
router.get('/depositos', auth, requirePermissao(pool, 'estoque', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const result = await pool.query(
      `SELECT d.*,
              COUNT(ped.produto_id) AS total_produtos,
              COALESCE(SUM(ped.estoque), 0) AS total_unidades
       FROM depositos d
       LEFT JOIN produto_estoque_deposito ped ON ped.deposito_id = d.id
       WHERE d.empresa_id = $1
       GROUP BY d.id
       ORDER BY d.principal DESC, d.nome`,
      [empresaResolvida.id]
    );

    res.json({ sucesso: true, depositos: result.rows });
  } catch (err) {
    console.error('[depositos] GET lista:', err.message);
    jsonErro(res, 500, 'Erro ao listar depÃ³sitos');
  }
});

// POST /depositos â€” criar depÃ³sito
router.post('/depositos', auth, writeRateLimiter, requirePermissao(pool, 'estoque', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { nome, descricao } = req.body;
    if (!nome) return jsonErro(res, 400, 'Nome do depÃ³sito Ã© obrigatÃ³rio');

    const result = await pool.query(
      `INSERT INTO depositos (empresa_id, nome, descricao, ativo, principal)
       VALUES ($1, $2, $3, true, false)
       RETURNING *`,
      [empresaResolvida.id, nome.trim(), descricao || null]
    );

    res.status(201).json({ sucesso: true, deposito: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return jsonErro(res, 409, 'JÃ¡ existe um depÃ³sito com esse nome');
    console.error('[depositos] POST:', err.message);
    jsonErro(res, 500, 'Erro ao criar depÃ³sito');
  }
});

// PUT /depositos/:id â€” editar depÃ³sito
router.put('/depositos/:id', auth, writeRateLimiter, requirePermissao(pool, 'estoque', 'editar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = Number(req.params.id);
    const { nome, descricao, ativo } = req.body;

    const result = await pool.query(
      `UPDATE depositos
       SET nome = COALESCE($1, nome),
           descricao = COALESCE($2, descricao),
           ativo = COALESCE($3, ativo),
           atualizado_em = NOW()
       WHERE id = $4 AND empresa_id = $5
       RETURNING *`,
      [nome?.trim() || null, descricao !== undefined ? descricao : null,
       ativo != null ? Boolean(ativo) : null, id, empresaResolvida.id]
    );

    if (result.rowCount === 0) return jsonErro(res, 404, 'DepÃ³sito nÃ£o encontrado');
    res.json({ sucesso: true, deposito: result.rows[0] });
  } catch (err) {
    console.error('[depositos] PUT:', err.message);
    jsonErro(res, 500, 'Erro ao editar depÃ³sito');
  }
});

// DELETE /depositos/:id â€” remover depÃ³sito (sÃ³ se sem estoque)
router.delete('/depositos/:id', auth, writeRateLimiter, requirePermissao(pool, 'estoque', 'deletar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = Number(req.params.id);

    // Verifica ownership antes de qualquer outra check (evita info leak)
    const deposito = await pool.query(
      `SELECT principal FROM depositos WHERE id = $1 AND empresa_id = $2`,
      [id, empresaResolvida.id]
    );
    if (deposito.rowCount === 0) return jsonErro(res, 404, 'DepÃ³sito nÃ£o encontrado');
    if (deposito.rows[0].principal) return jsonErro(res, 400, 'O depÃ³sito principal nÃ£o pode ser excluÃ­do');

    // Verifica se tem estoque (apenas apÃ³s confirmar ownership)
    const temEstoque = await pool.query(
      `SELECT 1 FROM produto_estoque_deposito WHERE deposito_id = $1 AND estoque > 0 LIMIT 1`,
      [id]
    );
    if (temEstoque.rowCount > 0) {
      return jsonErro(res, 400, 'NÃ£o Ã© possÃ­vel excluir um depÃ³sito com estoque. Transfira ou zere o estoque primeiro.');
    }

    await pool.query(`DELETE FROM depositos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]);
    res.json({ sucesso: true, mensagem: 'DepÃ³sito excluÃ­do' });
  } catch (err) {
    console.error('[depositos] DELETE:', err.message);
    jsonErro(res, 500, 'Erro ao excluir depÃ³sito');
  }
});

// GET /depositos/:id/estoque â€” estoque de um depÃ³sito
router.get('/depositos/:id/estoque', auth, requirePermissao(pool, 'estoque', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = Number(req.params.id);

    // Verifica que o depÃ³sito pertence Ã  empresa antes de expor o estoque
    const ownerCheck = await pool.query(
      `SELECT 1 FROM depositos WHERE id = $1 AND empresa_id = $2 LIMIT 1`,
      [id, empresaResolvida.id]
    );
    if (ownerCheck.rowCount === 0) return jsonErro(res, 404, 'DepÃ³sito nÃ£o encontrado');

    const busca = (req.query.busca || '').trim().toLowerCase();

    let sql = `
      SELECT ped.produto_id, p.nome AS produto_nome, p.categoria,
             p.codigo_barras, ped.grade_id,
             pg.atributo1, pg.atributo2,
             ped.estoque, ped.atualizado_em
      FROM produto_estoque_deposito ped
      JOIN produtos p ON p.id = ped.produto_id AND p.empresa_id = $1
      LEFT JOIN produto_grades pg ON pg.id = ped.grade_id
      WHERE ped.deposito_id = $2`;

    const params = [empresaResolvida.id, id];

    if (busca) {
      const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
      sql += ` AND (LOWER(p.nome) LIKE $3 OR LOWER(COALESCE(p.categoria,'')) LIKE $3)`;
      params.push(`%${buscaEsc}%`);
    }

    sql += ` ORDER BY p.nome, pg.atributo1`;

    const result = await pool.query(sql, params);
    res.json({ sucesso: true, itens: result.rows });
  } catch (err) {
    console.error('[depositos] GET estoque:', err.message);
    jsonErro(res, 500, 'Erro ao buscar estoque do depÃ³sito');
  }
});

// POST /depositos/transferir â€” mover estoque entre depÃ³sitos
router.post('/depositos/transferir', auth, writeRateLimiter, requirePermissao(pool, 'estoque', 'editar'), async (req, res) => {
  const client = await pool.connect();
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { deposito_origem_id, deposito_destino_id, produto_id, grade_id, quantidade } = req.body;
    const qtd = normalizarInt(quantidade);

    if (!deposito_origem_id || !deposito_destino_id || !produto_id || qtd <= 0) {
      return jsonErro(res, 400, 'Campos obrigatÃ³rios: deposito_origem_id, deposito_destino_id, produto_id, quantidade > 0');
    }
    if (deposito_origem_id === deposito_destino_id) {
      return jsonErro(res, 400, 'DepÃ³sito de origem e destino devem ser diferentes');
    }

    await client.query('BEGIN');

    // Verifica que ambos os depÃ³sitos pertencem Ã  empresa (anti-cross-tenant)
    const depositosCheck = await client.query(
      `SELECT id FROM depositos WHERE id = ANY($1::integer[]) AND empresa_id = $2`,
      [[Number(deposito_origem_id), Number(deposito_destino_id)], empresaResolvida.id]
    );
    if (depositosCheck.rowCount !== 2) {
      await client.query('ROLLBACK');
      return jsonErro(res, 403, 'DepÃ³sitos nÃ£o pertencem Ã  empresa');
    }

    // Verifica estoque na origem com FOR UPDATE
    const origem = await client.query(
      `SELECT estoque FROM produto_estoque_deposito
       WHERE deposito_id = $1 AND produto_id = $2 AND (grade_id = $3 OR ($3::INTEGER IS NULL AND grade_id IS NULL))
       FOR UPDATE`,
      [deposito_origem_id, produto_id, grade_id || null]
    );

    if (origem.rowCount === 0 || Number(origem.rows[0].estoque) < qtd) {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, `Estoque insuficiente no depÃ³sito de origem. DisponÃ­vel: ${origem.rows[0]?.estoque || 0}`);
    }

    // Debita na origem
    await client.query(
      `UPDATE produto_estoque_deposito
       SET estoque = estoque - $1, atualizado_em = NOW()
       WHERE deposito_id = $2 AND produto_id = $3
         AND (grade_id = $4 OR ($4::INTEGER IS NULL AND grade_id IS NULL))`,
      [qtd, deposito_origem_id, produto_id, grade_id || null]
    );

    // Credita no destino (upsert)
    await client.query(
      `INSERT INTO produto_estoque_deposito (empresa_id, produto_id, grade_id, deposito_id, estoque)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (produto_id, grade_id, deposito_id) DO UPDATE
       SET estoque = produto_estoque_deposito.estoque + $5, atualizado_em = NOW()`,
      [empresaResolvida.id, produto_id, grade_id || null, deposito_destino_id, qtd]
    );

    await client.query('COMMIT');

    res.json({ sucesso: true, mensagem: `${qtd} unidade(s) transferida(s) com sucesso` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[depositos] transferir:', err.message);
    jsonErro(res, 500, 'Erro ao transferir estoque');
  } finally {
    client.release();
  }
});

// Inicializa depÃ³sito principal para empresas sem depÃ³sito
async function garantirDepositoPrincipal(empresaId, empresaNome, client) {
  const executor = client || pool;
  const existente = await executor.query(
    `SELECT id FROM depositos WHERE empresa_id = $1 LIMIT 1`,
    [empresaId]
  );
  if (existente.rowCount === 0) {
    await executor.query(
      `INSERT INTO depositos (empresa_id, nome, principal, ativo)
       VALUES ($1, 'DepÃ³sito Principal', true, true)
       ON CONFLICT (empresa_id, nome) DO NOTHING`,
      [empresaId]
    );
  }
}


// â”€â”€ LGPD â€” exportaÃ§Ã£o de dados da prÃ³pria empresa â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/empresa/exportar-dados', auth, writeRateLimiter, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = empresaResolvida.id;
    const nome = empresaResolvida.nome;

    const [
      clientesResult, produtosResult, vendasResult,
      venda_itensResult, comprasResult, compra_itensResult,
      crResult, cpResult, movimResult, lancamentosResult
    ] = await Promise.all([
      pool.query(`SELECT id,nome,telefone,email,cpf,cpf_cnpj,endereco,criado_em FROM clientes WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, nome]),
      pool.query(`SELECT id,nome,categoria,preco,custo_medio,estoque,estoque_minimo,codigo_barras,criado_em FROM produtos WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, nome]),
      pool.query(`SELECT id,cliente_nome,subtotal,desconto,acrescimo,total,pagamento,status_pagamento,data,criado_em FROM vendas WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, nome]),
      pool.query(`SELECT vi.venda_id,vi.produto_nome,vi.quantidade,vi.preco_unitario,vi.total FROM venda_itens vi JOIN vendas v ON v.id=vi.venda_id WHERE (v.empresa_id=$1 OR (v.empresa_id IS NULL AND v.empresa=$2)) ORDER BY vi.venda_id,vi.id`, [id, nome]),
      pool.query(`SELECT id,fornecedor_id,data,total,pagamento,status,criado_em FROM compras WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, nome]),
      pool.query(`SELECT ci.compra_id,ci.produto_nome,ci.quantidade,ci.custo_unitario FROM compra_itens ci JOIN compras c ON c.id=ci.compra_id WHERE (c.empresa_id=$1 OR (c.empresa_id IS NULL AND c.empresa=$2)) ORDER BY ci.compra_id`, [id, nome]),
      pool.query(`SELECT id,cliente_nome,parcela,total_parcelas,valor,data_vencimento,data_pagamento,status,forma_pagamento FROM contas_receber WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, nome]),
      pool.query(`SELECT id,fornecedor_id,descricao,valor,data_vencimento,data_pagamento,status FROM contas_pagar WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, nome]),
      pool.query(`SELECT produto_id,tipo,quantidade,data_movimentacao FROM movimentacoes_estoque WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY data_movimentacao`, [id, nome]),
      pool.query(`SELECT id,tipo,descricao,valor,vencimento AS data,categoria FROM lancamentos_financeiros WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY vencimento`, [id, nome])
    ]);

    const payload = {
      exportacao: {
        empresa:      { id: empresaResolvida.id, nome: empresaResolvida.nome },
        gerado_em:    new Date().toISOString(),
        aviso_lgpd:   'ExportaÃ§Ã£o de dados pessoais conforme LGPD (Lei 13.709/2018).'
      },
      clientes:              clientesResult.rows,
      produtos:              produtosResult.rows,
      vendas:                vendasResult.rows,
      venda_itens:           venda_itensResult.rows,
      compras:               comprasResult.rows,
      compra_itens:          compra_itensResult.rows,
      contas_receber:        crResult.rows,
      contas_pagar:          cpResult.rows,
      movimentacoes_estoque: movimResult.rows,
      lancamentos_financeiros: lancamentosResult.rows
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const _nomeExport = empresaResolvida.nome.replace(/\s+/g,'_').replace(/[;="\\]/g,'_').replace(/[\r\n]/g,'');
    res.setHeader('Content-Disposition',
      `attachment; filename="lferp-dados-${_nomeExport}-${hoje()}.json"`
    );
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[lgpd] exportar-dados:', err.message);
    jsonErro(res, 500, 'Erro ao exportar dados');
  }
});


// â”€â”€ NotificaÃ§Ãµes in-app â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /notificacoes â€” retorna notificaÃ§Ãµes relevantes para a empresa logada
router.get('/notificacoes', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return res.json({ sucesso: true, notificacoes: [] });
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const dataHoje = hoje();
    const amanha   = addDias(dataHoje, 1);
    const em7dias  = addDias(dataHoje, 7);

    const [estoqueResult, crResult, cpResult, trialResult] = await Promise.all([
      // Produtos abaixo do estoque mÃ­nimo
      pool.query(
        `SELECT id, nome, estoque, estoque_minimo FROM produtos
         WHERE empresa_id = $1 AND deletado_em IS NULL
           AND estoque_minimo > 0 AND estoque < estoque_minimo
         ORDER BY (estoque_minimo - estoque) DESC LIMIT 10`,
        [empresaResolvida.id]
      ),
      // Contas a receber vencendo hoje ou jÃ¡ atrasadas
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(COALESCE(valor_atualizado, valor)), 0) AS valor_total
         FROM contas_receber
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3))
           AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago')
           AND data_vencimento <= $2`,
        [empresaResolvida.id, dataHoje, empresaResolvida.nome]
      ),
      // Contas a pagar vencendo hoje ou amanhÃ£
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(valor), 0) AS valor_total
         FROM contas_pagar
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3))
           AND LOWER(COALESCE(status,'pendente')) = 'pendente'
           AND data_vencimento <= $2`,
        [empresaResolvida.id, amanha, empresaResolvida.nome]
      ),
      // Trial expirando em atÃ© 7 dias
      pool.query(
        `SELECT trial_fim FROM empresas
         WHERE id = $1 AND assinatura_status = 'trial'
           AND trial_fim IS NOT NULL AND trial_fim <= $2`,
        [empresaResolvida.id, em7dias]
      )
    ]);

    const notifs = [];

    // Estoque baixo
    const prodAbaixo = estoqueResult.rows;
    if (prodAbaixo.length > 0) {
      notifs.push({
        tipo:   'estoque',
        icone:  'fa-boxes-stacked',
        cor:    '#d69e2e',
        titulo: `${prodAbaixo.length} produto(s) abaixo do estoque mÃ­nimo`,
        texto:  prodAbaixo.slice(0, 3).map((p) => `${p.nome} (${p.estoque}/${p.estoque_minimo})`).join(', ') + (prodAbaixo.length > 3 ? ` e mais ${prodAbaixo.length - 3}` : ''),
        link:   'estoque'
      });
    }

    // CR vencidas/vencendo
    const cr = crResult.rows[0];
    if (Number(cr.total) > 0) {
      notifs.push({
        tipo:   'contas_receber',
        icone:  'fa-money-bill-wave',
        cor:    '#e53e3e',
        titulo: `${cr.total} conta(s) a receber em atraso`,
        texto:  `Total: R$ ${Number(cr.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        link:   'contas-receber'
      });
    }

    // CP vencendo
    const cp = cpResult.rows[0];
    if (Number(cp.total) > 0) {
      notifs.push({
        tipo:   'contas_pagar',
        icone:  'fa-calendar-xmark',
        cor:    '#e53e3e',
        titulo: `${cp.total} conta(s) a pagar vencendo hoje/amanhÃ£`,
        texto:  `Total: R$ ${Number(cp.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        link:   'contas-pagar'
      });
    }

    // Trial expirando
    if (trialResult.rowCount > 0) {
      const tf = trialResult.rows[0].trial_fim;
      const diasRestantes = Math.ceil((new Date(tf) - new Date(dataHoje)) / 86400000);
      notifs.push({
        tipo:   'trial',
        icone:  'fa-clock',
        cor:    '#d69e2e',
        titulo: diasRestantes <= 0 ? 'Seu trial expirou' : `Trial expira em ${diasRestantes} dia(s)`,
        texto:  'Escolha um plano para continuar usando o sistema.',
        link:   'configuracoes'
      });
    }

    res.json({ sucesso: true, notificacoes: notifs, total: notifs.length });
  } catch (err) {
    console.error('[notificacoes]', err.message);
    jsonErro(res, 500, 'Erro ao carregar notificaÃ§Ãµes');
  }
});


// â”€â”€ SSE (Server-Sent Events) â€” notificaÃ§Ãµes em tempo real â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const _sseClients = new Map(); // empresaId â†’ Set<Response>

async function _sseQueryNotificacoes(empresaId) {
  const dataHoje = hoje();
  const amanha   = addDias(dataHoje, 1);
  const em7dias  = addDias(dataHoje, 7);

  const [estoqueResult, crResult, cpResult, trialResult] = await Promise.all([
    pool.query(
      `SELECT id, nome, estoque, estoque_minimo FROM produtos
       WHERE empresa_id = $1 AND deletado_em IS NULL
         AND estoque_minimo > 0 AND estoque < estoque_minimo
       ORDER BY (estoque_minimo - estoque) DESC LIMIT 10`,
      [empresaId]
    ),
    pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(COALESCE(valor_atualizado, valor)), 0) AS valor_total
       FROM contas_receber
       WHERE empresa_id = $1
         AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago')
         AND data_vencimento <= $2`,
      [empresaId, dataHoje]
    ),
    pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(valor), 0) AS valor_total
       FROM contas_pagar
       WHERE empresa_id = $1
         AND LOWER(COALESCE(status,'pendente')) = 'pendente'
         AND data_vencimento <= $2`,
      [empresaId, amanha]
    ),
    pool.query(
      `SELECT trial_fim FROM empresas
       WHERE id = $1 AND assinatura_status = 'trial'
         AND trial_fim IS NOT NULL AND trial_fim <= $2`,
      [empresaId, em7dias]
    )
  ]);

  const notifs = [];

  const prodAbaixo = estoqueResult.rows;
  if (prodAbaixo.length > 0) {
    notifs.push({
      tipo:   'estoque',
      icone:  'fa-boxes-stacked',
      cor:    '#d69e2e',
      titulo: `${prodAbaixo.length} produto(s) abaixo do estoque mÃ­nimo`,
      texto:  prodAbaixo.slice(0, 3).map(p => `${p.nome} (${p.estoque}/${p.estoque_minimo})`).join(', ') +
              (prodAbaixo.length > 3 ? ` e mais ${prodAbaixo.length - 3}` : ''),
      link:   'estoque'
    });
  }

  const cr = crResult.rows[0];
  if (Number(cr.total) > 0) {
    notifs.push({
      tipo:   'contas_receber',
      icone:  'fa-money-bill-wave',
      cor:    '#e53e3e',
      titulo: `${cr.total} conta(s) a receber em atraso`,
      texto:  `Total: R$ ${Number(cr.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      link:   'contas-receber'
    });
  }

  const cp = cpResult.rows[0];
  if (Number(cp.total) > 0) {
    notifs.push({
      tipo:   'contas_pagar',
      icone:  'fa-calendar-xmark',
      cor:    '#e53e3e',
      titulo: `${cp.total} conta(s) a pagar vencendo hoje/amanhÃ£`,
      texto:  `Total: R$ ${Number(cp.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      link:   'contas-pagar'
    });
  }

  if (trialResult.rowCount > 0) {
    const tf = trialResult.rows[0].trial_fim;
    const diasRestantes = Math.ceil((new Date(tf) - new Date(dataHoje)) / 86400000);
    notifs.push({
      tipo:   'trial',
      icone:  'fa-clock',
      cor:    '#d69e2e',
      titulo: diasRestantes <= 0 ? 'Seu trial expirou' : `Trial expira em ${diasRestantes} dia(s)`,
      texto:  'Escolha um plano para continuar usando o sistema.',
      link:   'configuracoes'
    });
  }

  return { notificacoes: notifs, total: notifs.length };
}

async function ssePush(res, empresaId) {
  try {
    const dados = await _sseQueryNotificacoes(empresaId);
    res.write(`event: notificacoes\ndata: ${JSON.stringify(dados)}\n\n`);
  } catch (err) {
    console.error('[SSE] ssePush:', err.message);
  }
}

function sseNotificarEmpresa(empresaId) {
  const clientes = _sseClients.get(empresaId);
  if (!clientes || clientes.size === 0) return;
  for (const res of [...clientes]) {
    ssePush(res, empresaId).catch(() => clientes.delete(res));
  }
}

// GET /sse-notificacoes â€” stream de eventos para o frontend
router.get('/sse-notificacoes', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const SSE_MAX_EMPRESAS = 1000;
    const empresaId = empresaResolvida.id;
    if (!_sseClients.has(empresaId)) {
      if (_sseClients.size >= SSE_MAX_EMPRESAS) {
        const [primeiraKey] = _sseClients.keys();
        const primeiroSet = _sseClients.get(primeiraKey);
        for (const r of primeiroSet) { try { r.end(); } catch {} }
        _sseClients.delete(primeiraKey);
      }
      _sseClients.set(empresaId, new Set());
    }
    const clientes = _sseClients.get(empresaId);
    if (clientes.size >= 30) {
      return jsonErro(res, 429, 'Limite de conexÃµes SSE atingido para esta empresa');
    }
    clientes.add(res);

    // Envio imediato
    await ssePush(res, empresaId);

    // Heartbeat a cada 25s (menor que timeout de proxy)
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);
    heartbeat.unref();

    // Refresh a cada 60s
    const refresh = setInterval(async () => {
      await ssePush(res, empresaId).catch(() => {});
    }, 60000);
    refresh.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(refresh);
      clientes.delete(res);
    });
  } catch (err) {
    console.error('[SSE] ConexÃ£o:', err.message);
    if (!res.headersSent) jsonErro(res, 500, 'Erro no SSE');
  }
});


  return router;
};