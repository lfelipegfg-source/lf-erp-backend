-- Migration 011 — Portal do Cliente (B2B)
-- Acesso externo para clientes consultarem títulos e histórico de compras.

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS senha_portal       TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS portal_ativo       BOOLEAN DEFAULT false;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS portal_ultimo_acesso TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_clientes_portal ON clientes(cpf_cnpj) WHERE portal_ativo = true;
