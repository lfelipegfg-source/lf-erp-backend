const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: true } : false,
  max: 20,
  min: 2,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000
});

module.exports = pool;
