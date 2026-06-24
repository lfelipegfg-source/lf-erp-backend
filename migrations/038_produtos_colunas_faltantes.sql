-- Migration 038 — Colunas de produtos que existem em produção mas nunca foram
-- formalizadas em migration (adicionadas diretamente na época do initDb).
-- Idempotente: ADD COLUMN IF NOT EXISTS não afeta DBs que já têm as colunas.

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo_unitario    NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo_medio       NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS lucro_unitario    NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS margem_lucro      NUMERIC(8,4)  NOT NULL DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS preco_promocional NUMERIC(12,2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS promocao_ativa    BOOLEAN       NOT NULL DEFAULT false;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS deletado_em       TIMESTAMP;

ALTER TABLE clientes    ADD COLUMN IF NOT EXISTS deletado_em    TIMESTAMP;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS deletado_em   TIMESTAMP;
