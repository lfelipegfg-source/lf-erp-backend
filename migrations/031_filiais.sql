-- Migration 031 — Multi-filial (pontos de venda independentes)
-- Filiais são unidades de negócio com PDV, caixa e vendas próprias.
-- Diferente de "depositos" (C2.7), que são apenas locais de estoque.
--
-- Estratégia: filial_id nullable em vendas/compras/caixa.
-- NULL = sede principal / sem filial (retrocompatibilidade total).

CREATE TABLE IF NOT EXISTS filiais (
  id            SERIAL PRIMARY KEY,
  empresa_id    INTEGER NOT NULL,
  nome          TEXT NOT NULL,
  cnpj          TEXT,
  telefone      TEXT,
  endereco      TEXT,
  cidade        TEXT,
  uf            TEXT,
  responsavel   TEXT,
  principal     BOOLEAN NOT NULL DEFAULT FALSE,   -- sede principal
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW(),
  UNIQUE (empresa_id, nome)
);

-- filial_id em transações (retrocompat: NULL = sede)
ALTER TABLE vendas  ADD COLUMN IF NOT EXISTS filial_id INTEGER REFERENCES filiais(id) ON DELETE SET NULL;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS filial_id INTEGER REFERENCES filiais(id) ON DELETE SET NULL;

-- filial_id em caixa
ALTER TABLE caixa_sessoes   ADD COLUMN IF NOT EXISTS filial_id INTEGER REFERENCES filiais(id) ON DELETE SET NULL;
ALTER TABLE caixa_movimentos ADD COLUMN IF NOT EXISTS filial_id INTEGER REFERENCES filiais(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_filiais_empresa      ON filiais(empresa_id, ativo);
CREATE INDEX IF NOT EXISTS idx_vendas_filial        ON vendas(filial_id, empresa_id) WHERE filial_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compras_filial       ON compras(filial_id, empresa_id) WHERE filial_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_filial ON caixa_sessoes(filial_id) WHERE filial_id IS NOT NULL;
