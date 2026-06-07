/**
 * Webhook de integração contábil — LF ERP
 * Dispara notificações HTTP para sistemas externos quando eventos financeiros ocorrem.
 * Todas as funções são fire-and-forget: lançar com .catch(() => {}) no chamador.
 */

async function dispararWebhook(pool, empresaId, evento, dados) {
  const r = await pool.query(
    `SELECT webhook_url, webhook_secret, eventos_ativos
     FROM contabilidade_config
     WHERE empresa_id = $1 AND ativo = true
       AND webhook_url IS NOT NULL AND webhook_url <> ''`,
    [empresaId]
  );
  if (!r.rowCount) return;

  const { webhook_url, webhook_secret, eventos_ativos } = r.rows[0];
  if (Array.isArray(eventos_ativos) && !eventos_ativos.includes(evento)) return;

  const payload = JSON.stringify({
    evento,
    timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'America/Fortaleza' }).replace(' ', 'T'),
    empresa_id: empresaId,
    dados
  });

  const headers = { 'Content-Type': 'application/json' };
  if (webhook_secret) headers['X-LF-Secret'] = webhook_secret;

  await fetch(webhook_url, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(8000)
  });
}

module.exports = { dispararWebhook };
