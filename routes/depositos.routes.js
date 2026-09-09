'use strict';
const express = require('express');
const { requirePermissao } = require('../utils/permissoes');
const { normalizarInt } = require('../utils/normalizadores');
const { jsonErro } = require('../utils/routeHelpers');

module.exports = function depositosRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, podeGerenciarFinanceiro }) {
  const router = express.Router();


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

  return router;
};