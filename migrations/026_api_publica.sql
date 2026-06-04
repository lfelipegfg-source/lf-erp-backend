-- Migration 026 — API pública + webhooks

-- API Keys por empresa (hash SHA-256 do token real)
CREATE TABLE IF NOT EXISTS empresa_api_keys (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL,
  nome        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  key_prefix  TEXT NOT NULL,          -- primeiros 12 chars para identificação visual
  ativo       BOOLEAN DEFAULT TRUE,
  ultimo_uso  TIMESTAMP,
  criado_em   TIMESTAMP DEFAULT NOW()
);

-- Endpoints de webhook registrados pela empresa
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id            SERIAL PRIMARY KEY,
  empresa_id    INTEGER NOT NULL,
  nome          TEXT NOT NULL,
  url           TEXT NOT NULL,
  eventos       TEXT[] NOT NULL DEFAULT '{}',
  -- eventos suportados: venda.criada | venda.cancelada | pagamento.recebido
  --                     compra.criada | estoque.baixo | conta_pagar.vencida
  secret        TEXT,                 -- HMAC-SHA256 secret para assinar o payload
  ativo         BOOLEAN DEFAULT TRUE,
  criado_em     TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW()
);

-- Histórico de entregas de webhooks
CREATE TABLE IF NOT EXISTS webhook_logs (
  id          SERIAL PRIMARY KEY,
  endpoint_id INTEGER NOT NULL,
  empresa_id  INTEGER NOT NULL,
  evento      TEXT NOT NULL,
  payload     JSONB,
  status_http INTEGER,
  sucesso     BOOLEAN DEFAULT FALSE,
  tentativa   INTEGER DEFAULT 1,
  erro        TEXT,
  criado_em   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_empresa  ON empresa_api_keys(empresa_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash     ON empresa_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_wh_ep_empresa     ON webhook_endpoints(empresa_id);
CREATE INDEX IF NOT EXISTS idx_wh_logs_endpoint  ON webhook_logs(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_wh_logs_empresa   ON webhook_logs(empresa_id);
