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
  // Preço padrão como fallback (produto pode ter grade com preco próprio)
  let precoPadrao = null;

  if (gradeId) {
    const g = await pool.query(
      `SELECT COALESCE(preco, 0) AS preco FROM produto_grades WHERE id = $1 AND produto_id = $2`,
      [gradeId, produtoId]
    );
    if (g.rowCount > 0 && Number(g.rows[0].preco) > 0) precoPadrao = Number(g.rows[0].preco);
  }

  if (!precoPadrao) {
    const p = await pool.query(
      `SELECT preco FROM produtos WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
      [produtoId, empresaId]
    );
    if (p.rowCount === 0) return null;
    precoPadrao = Number(p.rows[0].preco || 0);
  }

  // Sem cliente → preço padrão
  if (!clienteId) return precoPadrao;

  // Busca tabela_preco_id do cliente
  const cli = await pool.query(
    `SELECT tabela_preco_id FROM clientes WHERE id = $1 AND empresa_id = $2`,
    [clienteId, empresaId]
  );
  if (cli.rowCount === 0 || !cli.rows[0].tabela_preco_id) return precoPadrao;

  const tabelaId = cli.rows[0].tabela_preco_id;

  // Busca configuração da tabela
  const tab = await pool.query(
    `SELECT * FROM tabelas_preco WHERE id = $1 AND empresa_id = $2 AND ativa = true`,
    [tabelaId, empresaId]
  );
  if (tab.rowCount === 0) return precoPadrao;

  const tabela = tab.rows[0];

  // 1 e 2 — Preço fixo por produto (com ou sem grade), respeitando quantidade mínima
  const itemResult = await pool.query(
    `SELECT preco
     FROM tabela_preco_itens
     WHERE tabela_id = $1
       AND produto_id = $2
       AND (grade_id = $3 OR grade_id IS NULL)
       AND quantidade_minima <= $4
     ORDER BY
       -- Prefere o item mais específico (com grade) e a maior quantidade_minima aplicável
       (CASE WHEN grade_id = $3 THEN 0 ELSE 1 END),
       quantidade_minima DESC
     LIMIT 1`,
    [tabelaId, produtoId, gradeId, quantidade]
  );

  if (itemResult.rowCount > 0) {
    return Number(itemResult.rows[0].preco);
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
