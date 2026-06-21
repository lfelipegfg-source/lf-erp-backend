/**
 * Kits / Composições — LF ERP
 * Gerencia produtos compostos e seus componentes.
 *
 * Montado em /kits pelo server.js.
 *
 * Rotas:
 *   GET    /kits/produto/:kitId/componentes        — listar componentes
 *   POST   /kits/produto/:kitId/componentes        — adicionar componente
 *   PUT    /kits/produto/:kitId/componentes/:compId — editar quantidade
 *   DELETE /kits/produto/:kitId/componentes/:compId — remover componente
 *   PATCH  /kits/produto/:kitId/toggle             — ativa/desativa modo kit
 *   GET    /kits/produto/:kitId/estoque            — estoque disponível calculado
 */

const { calcularEstoqueKit, sincronizarEstoqueKit } = require('../utils/kits');

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarDecimal,
  normalizarInt
}) => {
  const router = require('express').Router();

  function ok(res, dados = {}) {
    return res.status(200).json({ sucesso: true, ...dados });
  }
  function erro(res, status = 500, msg = 'Erro interno') {
    return res.status(status).json({ sucesso: false, erro: msg });
  }

  async function obterProduto(id, empresaId) {
    const r = await pool.query(
      `SELECT * FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
      [id, empresaId]
    );
    return r.rows[0] || null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /kits/produto/:kitId/componentes
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/produto/:kitId/componentes', auth, async (req, res) => {
    try {
      const kitId = Number(req.params.kitId);
      if (!kitId) return erro(res, 400, 'ID de kit inválido');

      const kit = await obterProduto(kitId, req.empresa_id);
      if (!kit) return erro(res, 404, 'Produto não encontrado');

      const empresaResolvida = await validarAcessoEmpresa(req, kit.empresa, kit.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT kc.*,
                p.nome   AS componente_nome,
                p.estoque AS estoque_componente,
                p.unidade AS unidade_componente,
                FLOOR(p.estoque / NULLIF(kc.quantidade, 0)) AS kits_possiveis
         FROM kit_componentes kc
         JOIN produtos p ON p.id = kc.componente_id AND p.empresa_id = kc.empresa_id
         WHERE kc.kit_id = $1 AND kc.empresa_id = $2
         ORDER BY p.nome`,
        [kitId, empresaResolvida.id]
      );

      const estoqueKit = await calcularEstoqueKit(pool, kitId, empresaResolvida.id);

      return ok(res, {
        componentes: result.rows.map((r) => ({
          ...r,
          quantidade: Number(r.quantidade),
          estoque_componente: Number(r.estoque_componente || 0),
          kits_possiveis: Number(r.kits_possiveis || 0)
        })),
        estoque_kit: estoqueKit
      });
    } catch (err) {
      console.error('[kits] GET componentes:', err.message);
      return erro(res, 500, 'Erro ao buscar componentes');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /kits/produto/:kitId/componentes
  // ─────────────────────────────────────────────────────────────────────────
  router.post('/produto/:kitId/componentes', auth, writeRateLimiter, async (req, res) => {
    try {
      const kitId = Number(req.params.kitId);
      if (!kitId) return erro(res, 400, 'ID de kit inválido');

      const { componente_id, quantidade } = req.body;
      if (!componente_id || !quantidade) return erro(res, 400, 'componente_id e quantidade são obrigatórios');

      const compId = Number(componente_id);
      if (compId === kitId) return erro(res, 400, 'Um kit não pode ser componente de si mesmo');

      const kit = await obterProduto(kitId, req.empresa_id);
      if (!kit) return erro(res, 404, 'Kit não encontrado');

      const empresaResolvida = await validarAcessoEmpresa(req, kit.empresa, kit.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      // Valida que o componente existe e pertence à mesma empresa
      const comp = await obterProduto(compId, empresaResolvida.id);
      if (!comp) return erro(res, 404, 'Produto componente não encontrado');

      // Bloqueia encadeamento de kits (componente não pode ser outro kit)
      if (comp.e_kit) {
        return erro(res, 400, `"${comp.nome}" é um kit. Componentes de kit devem ser produtos simples.`);
      }

      // Garante modo kit ativo
      if (!kit.e_kit) {
        await pool.query(`UPDATE produtos SET e_kit = true, atualizado_em = NOW() WHERE id = $1 AND empresa_id = $2`, [kitId, empresaResolvida.id]);
      }

      const qtd = normalizarDecimal(quantidade);
      if (qtd <= 0) return erro(res, 400, 'Quantidade deve ser maior que zero');

      const result = await pool.query(
        `INSERT INTO kit_componentes (kit_id, componente_id, empresa_id, quantidade)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (kit_id, componente_id) DO UPDATE SET quantidade = $4, atualizado_em = NOW()
         RETURNING *`,
        [kitId, compId, empresaResolvida.id, qtd]
      );

      // Sincroniza estoque do kit
      const estoqueKit = await sincronizarEstoqueKit(pool, kitId, empresaResolvida.id);

      return ok(res, {
        componente: { ...result.rows[0], quantidade: Number(result.rows[0].quantidade) },
        estoque_kit: estoqueKit
      });
    } catch (err) {
      console.error('[kits] POST componente:', err.message);
      return erro(res, 500, 'Erro ao adicionar componente');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /kits/produto/:kitId/componentes/:compId
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/produto/:kitId/componentes/:compId', auth, writeRateLimiter, async (req, res) => {
    try {
      const kitId  = Number(req.params.kitId);
      const compId = Number(req.params.compId);
      const { quantidade } = req.body;

      if (!quantidade) return erro(res, 400, 'Quantidade é obrigatória');

      const kit = await obterProduto(kitId, req.empresa_id);
      if (!kit) return erro(res, 404, 'Kit não encontrado');

      const empresaResolvida = await validarAcessoEmpresa(req, kit.empresa, kit.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const qtd = normalizarDecimal(quantidade);
      if (qtd <= 0) return erro(res, 400, 'Quantidade deve ser maior que zero');

      const result = await pool.query(
        `UPDATE kit_componentes SET quantidade = $1, atualizado_em = NOW()
         WHERE id = $2 AND kit_id = $3 AND empresa_id = $4
         RETURNING *`,
        [qtd, compId, kitId, empresaResolvida.id]
      );

      if (result.rowCount === 0) return erro(res, 404, 'Componente não encontrado');

      const estoqueKit = await sincronizarEstoqueKit(pool, kitId, empresaResolvida.id);

      return ok(res, {
        componente: { ...result.rows[0], quantidade: Number(result.rows[0].quantidade) },
        estoque_kit: estoqueKit
      });
    } catch (err) {
      console.error('[kits] PUT componente:', err.message);
      return erro(res, 500, 'Erro ao editar componente');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /kits/produto/:kitId/componentes/:compId
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/produto/:kitId/componentes/:compId', auth, writeRateLimiter, async (req, res) => {
    try {
      const kitId  = Number(req.params.kitId);
      const compId = Number(req.params.compId);

      const kit = await obterProduto(kitId, req.empresa_id);
      if (!kit) return erro(res, 404, 'Kit não encontrado');

      const empresaResolvida = await validarAcessoEmpresa(req, kit.empresa, kit.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const r = await pool.query(
        `DELETE FROM kit_componentes WHERE id = $1 AND kit_id = $2 AND empresa_id = $3`,
        [compId, kitId, empresaResolvida.id]
      );

      if (r.rowCount === 0) return erro(res, 404, 'Componente não encontrado');

      const estoqueKit = await sincronizarEstoqueKit(pool, kitId, empresaResolvida.id);

      return ok(res, { mensagem: 'Componente removido', estoque_kit: estoqueKit });
    } catch (err) {
      console.error('[kits] DELETE componente:', err.message);
      return erro(res, 500, 'Erro ao remover componente');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /kits/produto/:kitId/toggle — ativa/desativa modo kit
  // ─────────────────────────────────────────────────────────────────────────
  router.patch('/produto/:kitId/toggle', auth, writeRateLimiter, async (req, res) => {
    try {
      const kitId = Number(req.params.kitId);

      const kit = await obterProduto(kitId, req.empresa_id);
      if (!kit) return erro(res, 404, 'Produto não encontrado');

      const empresaResolvida = await validarAcessoEmpresa(req, kit.empresa, kit.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const novoValor = !Boolean(kit.e_kit);

      if (!novoValor) {
        // Ao desativar, remove todos os componentes
        await pool.query(`DELETE FROM kit_componentes WHERE kit_id = $1 AND empresa_id = $2`, [kitId, empresaResolvida.id]);
      }

      await pool.query(
        `UPDATE produtos SET e_kit = $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`,
        [novoValor, kitId, empresaResolvida.id]
      );

      return ok(res, { e_kit: novoValor, mensagem: novoValor ? 'Modo kit ativado' : 'Modo kit desativado. Componentes removidos.' });
    } catch (err) {
      console.error('[kits] PATCH toggle:', err.message);
      return erro(res, 500, 'Erro ao alterar modo kit');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /kits/produto/:kitId/estoque — estoque calculado em tempo real
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/produto/:kitId/estoque', auth, async (req, res) => {
    try {
      const kitId = Number(req.params.kitId);

      const kit = await obterProduto(kitId, req.empresa_id);
      if (!kit) return erro(res, 404, 'Produto não encontrado');

      const empresaResolvida = await validarAcessoEmpresa(req, kit.empresa, kit.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const estoque = await calcularEstoqueKit(pool, kitId, empresaResolvida.id);

      return ok(res, { kit_id: kitId, estoque_disponivel: estoque });
    } catch (err) {
      console.error('[kits] GET estoque:', err.message);
      return erro(res, 500, 'Erro ao calcular estoque do kit');
    }
  });

  return router;
};
