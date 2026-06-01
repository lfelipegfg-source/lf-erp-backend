/**
 * CLI de migrações — uso: node migrate.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const { runMigrations } = require('./migrations/runner');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

runMigrations(pool)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrations] Erro fatal:', err.message);
    process.exit(1);
  });
