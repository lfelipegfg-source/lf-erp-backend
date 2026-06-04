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

module.exports = { acumularPontosFidelidade };
