-- Migration 018 — Billing de assinaturas SaaS via Asaas
-- Rastreia o status de cobrança da assinatura de cada empresa.

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS asaas_customer_id  TEXT,
  ADD COLUMN IF NOT EXISTS assinatura_boleto_id TEXT,
  ADD COLUMN IF NOT EXISTS assinatura_boleto_url TEXT,
  ADD COLUMN IF NOT EXISTS assinatura_vencimento DATE,
  ADD COLUMN IF NOT EXISTS responsavel_nome      TEXT,
  ADD COLUMN IF NOT EXISTS responsavel_email     TEXT,
  ADD COLUMN IF NOT EXISTS responsavel_cpf       TEXT;

-- Configuração global da API Asaas do proprietário do SaaS (não das empresas)
CREATE TABLE IF NOT EXISTS saas_config (
  id                SERIAL PRIMARY KEY,
  asaas_api_key     TEXT,
  asaas_sandbox     BOOLEAN DEFAULT TRUE,
  atualizado_em     TIMESTAMP DEFAULT NOW()
);

-- Insere linha padrão se não existir
INSERT INTO saas_config (asaas_sandbox) VALUES (true) ON CONFLICT DO NOTHING;
