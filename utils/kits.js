/**
 * Utilitários de Kits — LF ERP
 *
 * calcularEstoqueKit: retorna quantas unidades do kit podem ser montadas
 *   com base no estoque atual de cada componente.
 *
 * sincronizarEstoqueKit: atualiza produtos.estoque do kit com o valor
 *   calculado, mantendo consistência com consultas de estoque existentes.
 *
 * validarEstoqueKit: lança erro detalhado se algum componente não tem
 *   estoque suficiente para a quantidade de kits desejada.
 *
 * baixarComponentesKit: debita o estoque de cada componente e registra
 *   movimentações. Deve ser chamado dentro de uma transaction (client).
 *
 * estornarComponentesKit: restaura estoque dos componentes ao estornar venda.
 */

async function calcularEstoqueKit(db, kitId, empresaId) {
  const r = await db.query(
    `SELECT kc.quantidade AS qtd_por_kit, p.estoque, p.nome
     FROM kit_componentes kc
     JOIN produtos p ON p.id = kc.componente_id AND p.empresa_id = kc.empresa_id
     WHERE kc.kit_id = $1 AND kc.empresa_id = $2`,
    [kitId, empresaId]
  );

  if (r.rowCount === 0) return 0;

  let minKits = Infinity;
  for (const row of r.rows) {
    const estoque      = Number(row.estoque || 0);
    const qtdPorKit    = Number(row.qtd_por_kit || 1);
    const kitsPosiveis = qtdPorKit > 0 ? Math.floor(estoque / qtdPorKit) : 0;
    if (kitsPosiveis < minKits) minKits = kitsPosiveis;
  }

  return minKits === Infinity ? 0 : minKits;
}

// Aceita pool ou client (importante: usar client dentro de transações)
async function sincronizarEstoqueKit(db, kitId, empresaId) {
  const estoque = await calcularEstoqueKit(db, kitId, empresaId);
  await db.query(
    `UPDATE produtos SET estoque = $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`,
    [estoque, kitId, empresaId]
  );
  return estoque;
}

async function validarEstoqueKit(client, kitId, empresaId, qtdKits) {
  const r = await client.query(
    `SELECT kc.quantidade AS qtd_por_kit, p.estoque, p.nome
     FROM kit_componentes kc
     JOIN produtos p ON p.id = kc.componente_id AND p.empresa_id = kc.empresa_id
     WHERE kc.kit_id = $1 AND kc.empresa_id = $2
     FOR UPDATE`,
    [kitId, empresaId]
  );

  if (r.rowCount === 0) {
    throw new Error('Kit sem componentes cadastrados. Adicione ao menos um componente antes de vender.');
  }

  for (const row of r.rows) {
    const necessario = Number(row.qtd_por_kit) * qtdKits;
    if (Number(row.estoque) < necessario) {
      throw new Error(
        `Estoque insuficiente do componente "${row.nome}". ` +
        `Necessário: ${necessario}, Disponível: ${row.estoque}.`
      );
    }
  }
}

async function baixarComponentesKit({ client, kitId, empresaId, qtdKits, vendaId, usuarioId, registrarMovimentacaoEstoque }) {
  const r = await client.query(
    `SELECT kc.*, p.nome AS componente_nome, p.empresa
     FROM kit_componentes kc
     JOIN produtos p ON p.id = kc.componente_id AND p.empresa_id = kc.empresa_id
     WHERE kc.kit_id = $1 AND kc.empresa_id = $2`,
    [kitId, empresaId]
  );

  for (const comp of r.rows) {
    const qtdBaixar = Number(comp.quantidade) * qtdKits;

    await client.query(
      `UPDATE produtos SET estoque = estoque - $1, atualizado_em = NOW()
       WHERE id = $2 AND empresa_id = $3`,
      [qtdBaixar, comp.componente_id, empresaId]
    );

    await registrarMovimentacaoEstoque({
      empresa: comp.empresa,
      empresa_id: empresaId,
      produto_id: comp.componente_id,
      tipo: 'saida_kit',
      quantidade: qtdBaixar,
      observacao: `Consumo de kit #${kitId} — venda #${vendaId}`,
      referencia_tipo: 'venda',
      referencia_id: vendaId,
      usuario_id: usuarioId,
      client
    });
  }
}

async function estornarComponentesKit({ client, kitId, empresaId, qtdKits, vendaId, usuarioId, registrarMovimentacaoEstoque }) {
  const r = await client.query(
    `SELECT kc.*, p.nome AS componente_nome, p.empresa
     FROM kit_componentes kc
     JOIN produtos p ON p.id = kc.componente_id AND p.empresa_id = kc.empresa_id
     WHERE kc.kit_id = $1 AND kc.empresa_id = $2`,
    [kitId, empresaId]
  );

  for (const comp of r.rows) {
    const qtdRestaurar = Number(comp.quantidade) * qtdKits;

    await client.query(
      `UPDATE produtos SET estoque = estoque + $1, atualizado_em = NOW()
       WHERE id = $2 AND empresa_id = $3`,
      [qtdRestaurar, comp.componente_id, empresaId]
    );

    await registrarMovimentacaoEstoque({
      empresa: comp.empresa,
      empresa_id: empresaId,
      produto_id: comp.componente_id,
      tipo: 'estorno_kit',
      quantidade: qtdRestaurar,
      observacao: `Estorno de kit #${kitId} — venda #${vendaId}`,
      referencia_tipo: 'venda_estornada',
      referencia_id: vendaId,
      usuario_id: usuarioId,
      client
    });
  }
}

module.exports = {
  calcularEstoqueKit,
  sincronizarEstoqueKit,
  validarEstoqueKit,
  baixarComponentesKit,
  estornarComponentesKit
};
