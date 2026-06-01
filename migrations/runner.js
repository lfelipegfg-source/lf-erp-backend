/**
 * Migration runner — LF ERP
 * Lê arquivos .sql de /migrations, aplica apenas os não executados.
 * Tabela de controle: _migrations (criada automaticamente).
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname);

async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id        SERIAL PRIMARY KEY,
      filename  TEXT NOT NULL UNIQUE,
      aplicado_em TIMESTAMP DEFAULT NOW()
    )
  `);

  const arquivos = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: aplicados } = await pool.query(`SELECT filename FROM _migrations`);
  const aplicadosSet = new Set(aplicados.map((r) => r.filename));

  const pendentes = arquivos.filter((f) => !aplicadosSet.has(f));

  if (pendentes.length === 0) {
    console.log('[migrations] Nenhuma migration pendente.');
    return;
  }

  for (const arquivo of pendentes) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, arquivo), 'utf8');
    console.log(`[migrations] Aplicando: ${arquivo}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO _migrations (filename) VALUES ($1)`, [arquivo]);
      await client.query('COMMIT');
      console.log(`[migrations] OK: ${arquivo}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrations] FALHOU: ${arquivo}`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`[migrations] ${pendentes.length} migration(s) aplicada(s).`);
}

module.exports = { runMigrations };
