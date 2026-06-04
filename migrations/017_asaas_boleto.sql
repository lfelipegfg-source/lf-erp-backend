-- Migration 017 — Integração Asaas (boleto bancário)
-- Adiciona configuração da API Asaas e rastreamento de boletos
-- gerados por conta a receber.

-- Configuração da conta Asaas por empresa
ALTER TABLE configuracoes
  ADD COLUMN IF NOT EXISTS asaas_api_key  TEXT,
  ADD COLUMN IF NOT EXISTS asaas_sandbox  BOOLEAN DEFAULT TRUE;

-- Boleto gerado para cada conta a receber
ALTER TABLE contas_receber
  ADD COLUMN IF NOT EXISTS boleto_id            TEXT,
  ADD COLUMN IF NOT EXISTS boleto_url           TEXT,
  ADD COLUMN IF NOT EXISTS boleto_linha_digitavel TEXT,
  ADD COLUMN IF NOT EXISTS boleto_status        TEXT,
  ADD COLUMN IF NOT EXISTS boleto_gerado_em     TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_cr_boleto_id
  ON contas_receber(boleto_id)
  WHERE boleto_id IS NOT NULL;
