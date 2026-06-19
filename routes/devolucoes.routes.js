/**
 * Devoluções — LF ERP
 * Montado em /devolucoes.
 *
 * Rotas:
 *   GET  /devolucoes                — listar devoluções
 *   POST /devolucoes                — registrar devolução (restaura estoque)
 *   GET  /devolucoes/:id            — detalhe com itens
 *   GET  /devolucoes/venda/:vendaId — devoluções de uma venda específica
 */

const { estornarPontosFidelidade } = require('../utils/fidelidade');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarInt,
  registrarMovimentacaoEstoque
}) => {
  const router = require('express').Router();

  function ok(res, d = {}) { return res.status(200).json({ sucesso: true, ...d }); }
  function erro(res, s = 500, m = 'Erro') { return res.status(s).json({ sucesso: false, erro: m }); }

  async function getEmpresa(req) {
    return validarAcessoEmpresa(req, req.query.empresa || req.body?.empresa, req.empresa_id);
  }

  // ── GET /devolucoes/venda/:vendaId — deve vir ANTES de /:id ────────────────
  router.get('/venda/:vendaId', auth, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT d.*, COUNT(di.id) AS total_itens
         FROM devolucoes d
         LEFT JOIN devolucao_itens di ON di.devolucao_id = d.id
         WHERE d.empresa_id = $1 AND d.venda_id = $2
         GROUP BY d.id ORDER BY d.criado_em DESC`,
        [emp.id, Number(req.params.vendaId)]
      );

      return ok(res, { devolucoes: result.rows });
    } catch (err) {
      console.error('[devolucoes] GET venda:', err.message);
      return erro(res, 500, 'Erro ao buscar devoluções da venda');
    }
  });

  // ── GET /devolucoes ───────────────────────────────────────────────────────
  router.get('/', auth, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT d.*, COUNT(di.id) AS total_itens
         FROM devolucoes d
         LEFT JOIN devolucao_itens di ON di.devolucao_id = d.id
         WHERE d.empresa_id = $1
         GROUP BY d.id ORDER BY d.criado_em DESC
         LIMIT 200`,
        [emp.id]
      );

      return ok(res, {
        devolucoes: result.rows.map((r) => ({
          ...r,
          total_devolvido: Number(r.total_devolvido || 0),
          total_itens:     Number(r.total_itens     || 0)
        }))
      });
    } catch (err) {
      console.error('[devolucoes] GET lista:', err.message);
      return erro(res, 500, 'Erro ao listar devoluções');
    }
  });

  // ── POST /devolucoes ──────────────────────────────────────────────────────
  router.post('/', auth, writeRateLimiter, async (req, res) => {
    const { venda_id, motivo, itens = [] } = req.body;

    if (!venda_id) return erro(res, 400, 'venda_id é obrigatório');
    if (!Array.isArray(itens) || itens.length === 0) return erro(res, 400, 'Informe ao menos um item para devolver');

    const emp = await getEmpresa(req);
    if (!emp) return erro(res, 403, 'Sem acesso');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Carrega venda e seus itens originais
      const vendaRes = await client.query(
        `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [Number(venda_id), emp.id, emp.nome]
      );
      if (vendaRes.rowCount === 0) { await client.query('ROLLBACK'); return erro(res, 404, 'Venda não encontrada'); }
      const venda = vendaRes.rows[0];

      const itensVendaRes = await client.query(
        `SELECT vi.*, p.tem_grade FROM venda_itens vi
         LEFT JOIN produtos p ON p.id = vi.produto_id
         WHERE vi.venda_id = $1`,
        [Number(venda_id)]
      );
      const itensVendaMap = new Map(itensVendaRes.rows.map((i) => [i.id || `${i.produto_id}-${i.grade_id}`, i]));

      // Valida e prepara itens a devolver
      let totalDevolvido = 0;
      const itensValidados = [];

      for (const item of itens) {
        const produtoId = Number(item.produto_id);
        const gradeId   = item.grade_id ? Number(item.grade_id) : null;
        const qtd       = normalizarDecimal(item.quantidade);

        if (!produtoId || qtd <= 0) continue;

        // Encontra o item original na venda
        const original = itensVendaRes.rows.find(
          (i) => Number(i.produto_id) === produtoId && (gradeId ? Number(i.grade_id) === gradeId : !i.grade_id)
        );
        if (!original) { await client.query('ROLLBACK'); return erro(res, 400, `Produto ${produtoId} não encontrado na venda`); }
        if (qtd > Number(original.quantidade)) { await client.query('ROLLBACK'); return erro(res, 400, `Quantidade a devolver (${qtd}) maior que a vendida (${original.quantidade}) para ${original.produto_nome}`); }

        const preco = Number(original.preco_unitario || 0);
        const total = +(qtd * preco).toFixed(2);
        totalDevolvido += total;

        itensValidados.push({ produtoId, gradeId, qtd, preco, total, produto_nome: original.produto_nome, tem_grade: original.tem_grade });
      }

      if (itensValidados.length === 0) { await client.query('ROLLBACK'); return erro(res, 400, 'Nenhum item válido para devolução'); }

      // Próximo número de devolução — FOR UPDATE previne race condition em devoluções simultâneas
      const numRes = await client.query(
        `SELECT COALESCE(MAX(numero), 0) + 1 AS proximo FROM devolucoes WHERE empresa_id = $1 FOR UPDATE`,
        [emp.id]
      );
      const numero = numRes.rows[0].proximo;

      // Cria o registro de devolução
      const devRes = await client.query(
        `INSERT INTO devolucoes (empresa_id, venda_id, numero, cliente_id, cliente_nome, motivo, total_devolvido, criado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [emp.id, Number(venda_id), numero, venda.cliente_id || null, venda.cliente_nome || null,
         motivo || null, +totalDevolvido.toFixed(2), req.user.id]
      );
      const devolucao = devRes.rows[0];

      // Insere itens e restaura estoque
      for (const item of itensValidados) {
        await client.query(
          `INSERT INTO devolucao_itens (devolucao_id, empresa_id, produto_id, produto_nome, grade_id, quantidade, preco_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [devolucao.id, emp.id, item.produtoId, item.produto_nome, item.gradeId, item.qtd, item.preco, item.total]
        );

        // Restaura estoque do produto
        if (item.tem_grade && item.gradeId) {
          await client.query(
            `UPDATE produto_grades SET estoque = estoque + $1, atualizado_em = NOW() WHERE id = $2`,
            [item.qtd, item.gradeId]
          );
          await client.query(
            `UPDATE produtos SET estoque = (SELECT COALESCE(SUM(estoque),0) FROM produto_grades WHERE produto_id = $1 AND empresa_id = $2 AND ativo = true), atualizado_em = NOW()
             WHERE id = $1 AND empresa_id = $2`,
            [item.produtoId, emp.id]
          );
        } else {
          await client.query(
            `UPDATE produtos SET estoque = estoque + $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`,
            [item.qtd, item.produtoId, emp.id]
          );
        }
      }

      // Cria lançamento financeiro de devolução (despesa = saída de caixa para devolver ao cliente)
      if (totalDevolvido > 0) {
        await client.query(
          `INSERT INTO lancamentos_financeiros
             (empresa, empresa_id, tipo, descricao, valor, vencimento, status, categoria, observacao)
           VALUES ($1,$2,'despesa',$3,$4,NOW() + INTERVAL '3 days','pendente','Devoluções',$5)`,
          [
            emp.nome,
            emp.id,
            `Devolução #${numero} — ${venda.cliente_nome || 'Cliente'}`,
            +totalDevolvido.toFixed(2),
            motivo || null
          ]
        );
      }

      await client.query('COMMIT');

      // Estorna pontos de fidelidade em background (idempotente, não bloqueia a resposta)
      if (venda.cliente_id) {
        estornarPontosFidelidade(pool, {
          empresaId:      emp.id,
          clienteId:      venda.cliente_id,
          vendaId:        Number(venda_id),
          devolucaoId:    devolucao.id,
          totalDevolvido: +totalDevolvido.toFixed(2),
          vendaTotal:     Number(venda.total || 0)
        }).catch((e) => console.error(`[fidelidade] falha estorno devolucao=${devolucao.id}:`, e.message));
      }

      return ok(res, {
        devolucao: { ...devolucao, total_devolvido: +totalDevolvido.toFixed(2) },
        mensagem: `Devolução #${numero} registrada. Estoque restaurado.`
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[devolucoes] POST:', err.message);
      return erro(res, 500, 'Erro ao registrar devolução: ' + err.message);
    } finally {
      client.release();
    }
  });

  // ── GET /devolucoes/:id ───────────────────────────────────────────────────
  router.get('/:id', auth, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const [devRes, itensRes] = await Promise.all([
        pool.query(`SELECT * FROM devolucoes WHERE id = $1 AND empresa_id = $2`, [Number(req.params.id), emp.id]),
        pool.query(`SELECT * FROM devolucao_itens WHERE devolucao_id = $1 AND empresa_id = $2`, [Number(req.params.id), emp.id])
      ]);

      if (devRes.rowCount === 0) return erro(res, 404, 'Devolução não encontrada');

      return ok(res, { devolucao: { ...devRes.rows[0], itens: itensRes.rows } });
    } catch (err) {
      console.error('[devolucoes] GET :id:', err.message);
      return erro(res, 500, 'Erro ao buscar devolução');
    }
  });

  return router;
};
