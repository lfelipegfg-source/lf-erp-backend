/**
 * Utilitários de Fidelidade — LF ERP
 * Acumulação e resgate de pontos por cliente.
 */

/**
 * Acumula pontos após uma venda finalizada.
 * Deve ser chamado fire-and-forget após o COMMIT da venda.
 */
async function acumularPontosFidelidade(pool, { empresaId, clienteId, vendaId, totalVenda }) {
  if (!clienteId || !empresaId || !vendaId || !totalVenda) return;

  const cfgResult = await pool.query(
    `SELECT * FROM fidelidade_config WHERE empresa_id = $1 AND ativo = true`,
    [empresaId]
  );
  if (cfgResult.rowCount === 0) return;

  const cfg    = cfgResult.rows[0];
  const pontos = Math.floor(Number(totalVenda) * Number(cfg.pontos_por_real));
  if (pontos <= 0) return;

  // Verifica se já acumulou pontos para esta venda (idempotência)
  const jaAcumulou = await pool.query(
    `SELECT id FROM fidelidade_movimentos WHERE referencia_tipo = 'venda' AND referencia_id = $1 AND empresa_id = $2`,
    [vendaId, empresaId]
  );
  if (jaAcumulou.rowCount > 0) return;

  const expiraEm = cfg.validade_dias > 0
    ? new Date(Date.now() + cfg.validade_dias * 86_400_000).toISOString().substring(0, 10)
    : null;

  // Atualiza saldo do cliente e calcula saldo_apos em uma transação
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE clientes SET pontos_fidelidade = GREATEST(0, COALESCE(pontos_fidelidade,0) + $1), atualizado_em = NOW()
       WHERE id = $2 AND empresa_id = $3`,
      [pontos, clienteId, empresaId]
    );

    const saldoResult = await client.query(
      `SELECT COALESCE(pontos_fidelidade, 0) AS saldo FROM clientes WHERE id = $1`,
      [clienteId]
    );
    const saldoApos = saldoResult.rows[0]?.saldo || 0;

    await client.query(
      `INSERT INTO fidelidade_movimentos
         (empresa_id, cliente_id, tipo, pontos, saldo_apos, descricao, referencia_tipo, referencia_id, expira_em)
       VALUES ($1,$2,'credito',$3,$4,$5,'venda',$6,$7)`,
      [
        empresaId, clienteId, pontos, saldoApos,
        `+${pontos} pontos por compra de R$ ${Number(totalVenda).toFixed(2)}`,
        vendaId, expiraEm
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Estorna pontos após devolução de venda.
 * Proporacional ao valor devolvido em relação ao total original da venda.
 * Idempotente: não desfaz duas vezes a mesma devolução.
 */
async function estornarPontosFidelidade(pool, {
  empresaId, clienteId, vendaId, devolucaoId, totalDevolvido, vendaTotal
}) {
  if (!clienteId || !empresaId || !vendaId || !devolucaoId) return;

  const cfgResult = await pool.query(
    `SELECT * FROM fidelidade_config WHERE empresa_id = $1 AND ativo = true`,
    [empresaId]
  );
  if (cfgResult.rowCount === 0) return;

  // Idempotência — não estorna a mesma devolução duas vezes
  const jaEstornou = await pool.query(
    `SELECT id FROM fidelidade_movimentos
     WHERE referencia_tipo = 'devolucao' AND referencia_id = $1 AND empresa_id = $2`,
    [devolucaoId, empresaId]
  );
  if (jaEstornou.rowCount > 0) return;

  // Busca movimento original da venda para saber quantos pontos foram creditados
  const movOriginal = await pool.query(
    `SELECT pontos FROM fidelidade_movimentos
     WHERE referencia_tipo = 'venda' AND referencia_id = $1 AND empresa_id = $2 AND tipo = 'credito'
     LIMIT 1`,
    [vendaId, empresaId]
  );
  if (movOriginal.rowCount === 0) return; // venda não gerou pontos

  const pontosOriginais = Number(movOriginal.rows[0].pontos);
  const proporcao = vendaTotal > 0 ? Math.min(Number(totalDevolvido) / Number(vendaTotal), 1) : 1;
  const pontosEstornar = Math.floor(pontosOriginais * proporcao);
  if (pontosEstornar <= 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE clientes
       SET pontos_fidelidade = GREATEST(0, COALESCE(pontos_fidelidade,0) - $1), atualizado_em = NOW()
       WHERE id = $2 AND empresa_id = $3`,
      [pontosEstornar, clienteId, empresaId]
    );

    const saldoResult = await client.query(
      `SELECT COALESCE(pontos_fidelidade, 0) AS saldo FROM clientes WHERE id = $1`,
      [clienteId]
    );
    const saldoApos = saldoResult.rows[0]?.saldo || 0;

    await client.query(
      `INSERT INTO fidelidade_movimentos
         (empresa_id, cliente_id, tipo, pontos, saldo_apos, descricao, referencia_tipo, referencia_id)
       VALUES ($1,$2,'debito',$3,$4,$5,'devolucao',$6)`,
      [
        empresaId, clienteId, pontosEstornar, saldoApos,
        `-${pontosEstornar} pontos estornados (devolução venda #${vendaId})`,
        devolucaoId
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { acumularPontosFidelidade, estornarPontosFidelidade };
