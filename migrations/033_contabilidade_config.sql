-- Migration 033 — Integração Contábil em Tempo Real
-- Tabela de configuração de webhook/email por empresa

CREATE TABLE IF NOT EXISTS contabilidade_config (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL UNIQUE,
  email_contador  TEXT,
  webhook_url     TEXT,
  webhook_secret  TEXT,
  eventos_ativos  TEXT[] NOT NULL DEFAULT ARRAY['venda.criada','recebimento.registrado','pagamento.registrado'],
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contabilidade_config_empresa ON contabilidade_config (empresa_id);
