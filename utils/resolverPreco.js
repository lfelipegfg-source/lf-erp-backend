/**
 * Resolver de preço por tabela — LF ERP
 *
 * Hierarquia de resolução (do mais específico ao mais genérico):
 *  1. Preço fixo na tabela para produto + grade + quantidade_minima ≤ qtd pedida
 *  2. Preço fixo na tabela para produto + sem grade, mesma lógica de qtd mínima
 *  3. Desconto/markup percentual da tabela aplicado sobre o preço padrão do produto
 *  4. Preço padrão do produto (sem tabela)
 *
 * Uso:
 *   const preco = await resolverPreco({ pool, produtoId, gradeId, clienteId, empresaId, quantidade });
 */

async function resolverPreco({ pool, produtoId, gradeId = null, clienteId = null, empresaId, quantidade = 1 }) {
  // Query 1: produto + grade em uma única round-trip
  const prodResult = await pool.query(
    `SELECT p.preco AS produto_preco,
            g.preco AS grade_preco
     FROM produtos p
     LEFT JOIN produto_grades g
       ON g.id = $2 AND g.produto_id = p.id
     WHERE p.id = $1 AND p.empresa_id = $3 AND p.deletado_em IS NULL`,
    [produtoId, gradeId || 0, empresaId]
  );

  if (prodResult.rowCount === 0) return null;

  const row = prodResult.rows[0];
  const gradePreco = gradeId ? Number(row.grade_preco || 0) : 0;
  const precoPadrao = gradeId && gradePreco > 0 ? gradePreco : Number(row.produto_preco || 0);

  // Sem cliente → preço padrão direto
  if (!clienteId) return precoPadrao;

  // Query 2: tabela do cliente + itens específicos em uma única round-trip
  const tabelaResult = await pool.query(
    `SELECT tp.tipo, tp.desconto_percentual, tp.markup_percentual,
            tpi.preco AS item_preco
     FROM clientes c
     JOIN tabelas_preco tp
       ON tp.id = c.tabela_preco_id AND tp.empresa_id = c.empresa_id AND tp.ativa = true
     LEFT JOIN LATERAL (
       SELECT preco
       FROM tabela_preco_itens
       WHERE tabela_id = tp.id
         AND produto_id = $2
         AND (grade_id = $3 OR grade_id IS NULL)
         AND quantidade_minima <= $4
       ORDER BY (CASE WHEN grade_id = $3 THEN 0 ELSE 1 END), quantidade_minima DESC
       LIMIT 1
     ) tpi ON true
     WHERE c.id = $1 AND c.empresa_id = $5`,
    [clienteId, produtoId, gradeId, quantidade, empresaId]
  );

  if (tabelaResult.rowCount === 0) return precoPadrao;

  const tabela = tabelaResult.rows[0];

  // 1/2 — Preço fixo encontrado na tabela
  if (tabela.item_preco !== null && tabela.item_preco !== undefined) {
    return Number(tabela.item_preco);
  }

  // 3 — Regra percentual global da tabela
  if (tabela.tipo === 'percentual') {
    const desconto = Number(tabela.desconto_percentual || 0);
    const markup   = Number(tabela.markup_percentual   || 0);
    let preco = precoPadrao;
    if (desconto > 0) preco = preco * (1 - desconto / 100);
    if (markup   > 0) preco = preco * (1 + markup   / 100);
    return Number(Math.max(0, preco).toFixed(2));
  }

  // 4 — Sem regra aplicável: preço padrão
  return precoPadrao;
}

module.exports = { resolverPreco };
