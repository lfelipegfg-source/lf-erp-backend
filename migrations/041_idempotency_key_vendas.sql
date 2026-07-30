-- Migration 041: adiciona coluna idempotency_key na tabela vendas
-- Necessária para deduplicação de vendas offline (PDV retry).
-- A coluna é opcional (NULL permitido) para manter retrocompatibilidade
-- com vendas existentes e vendas criadas sem chave (PDV online direto).

ALTER TABLE vendas
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Índice único parcial: garante deduplicação por empresa, mas permite
-- múltiplas linhas NULL (vendas sem chave de idempotência).
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendas_idempotency_key
  ON vendas (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
