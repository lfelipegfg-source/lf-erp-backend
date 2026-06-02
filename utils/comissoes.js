/**
 * Utilitário de Comissões — LF ERP
 *
 * calcularComissaoVenda:
 *   1. Busca a config de comissão do vendedor (usuario_id)
 *   2. Para cada item da venda, verifica se há override de % por produto
 *   3. Calcula o valor da comissão e insere em `comissoes`
 *   4. Não bloqueia a criação da venda — chamado de forma assíncrona (fire-and-forget)
 *
 * Hierarquia de percentual:
 *   override por produto > percentual global do vendedor
 */

async function calcularComissaoVenda(pool, { vendaId, usuarioId, empresaId }) {
  if (!usuarioId || !vendaId || !empresaId) return;

  const config = await pool.query(
    `SELECT * FROM comissoes_config WHERE usuario_id = $1 AND empresa_id = $2 AND ativa = true`,
    [usuarioId, empresaId]
  );
  if (config.rowCount === 0) return; // vendedor sem comissão configurada

  const cfg = config.rows[0];

  // Busca itens da venda
  const itens = await pool.query(
    `SELECT vi.produto_id, vi.total, vi.quantidade
     FROM venda_itens vi
     WHERE vi.venda_id = $1`,
    [vendaId]
  );

  // Busca overrides por produto
  const overrides = await pool.query(
    `SELECT produto_id, percentual FROM comissoes_config_produtos WHERE config_id = $1`,
    [cfg.id]
  );
  const overrideMap = Object.fromEntries(overrides.rows.map((r) => [r.produto_id, Number(r.percentual)]));

  // Calcula valor total da comissão somando item a item
  let valorComissao = 0;
  let percentualMedio = Number(cfg.percentual);

  if (itens.rowCount > 0) {
    let totalVendaComputado = 0;
    let comissaoComputada   = 0;

    for (const item of itens.rows) {
      const totalItem = Number(item.total || 0);
      const pct = overrideMap[item.produto_id] !== undefined
        ? overrideMap[item.produto_id]
        : Number(cfg.percentual);
      comissaoComputada   += totalItem * pct / 100;
      totalVendaComputado += totalItem;
    }

    valorComissao = Number(comissaoComputada.toFixed(2));
    if (totalVendaComputado > 0) {
      percentualMedio = Number(((comissaoComputada / totalVendaComputado) * 100).toFixed(2));
    }
  } else {
    // Fallback: aplica % global sobre o total da venda
    const venda = await pool.query(`SELECT total FROM vendas WHERE id = $1`, [vendaId]);
    if (venda.rowCount > 0) {
      const totalVenda = Number(venda.rows[0].total || 0);
      valorComissao = Number((totalVenda * Number(cfg.percentual) / 100).toFixed(2));
    }
  }

  if (valorComissao <= 0) return;

  // Busca total da venda para registrar
  const venda = await pool.query(`SELECT total FROM vendas WHERE id = $1`, [vendaId]);
  const valorVenda = venda.rowCount > 0 ? Number(venda.rows[0].total || 0) : 0;

  // Evita duplicata se já existe comissão para essa venda+usuario
  const jaExiste = await pool.query(
    `SELECT id FROM comissoes WHERE venda_id = $1 AND usuario_id = $2 AND empresa_id = $3`,
    [vendaId, usuarioId, empresaId]
  );
  if (jaExiste.rowCount > 0) return;

  await pool.query(
    `INSERT INTO comissoes (empresa_id, usuario_id, venda_id, valor_venda, percentual, valor_comissao)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [empresaId, usuarioId, vendaId, valorVenda, percentualMedio, valorComissao]
  );
}

module.exports = { calcularComissaoVenda };
