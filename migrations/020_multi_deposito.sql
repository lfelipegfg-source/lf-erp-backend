-- Migration 020 — Multi-depósito
-- Permite que uma empresa tenha múltiplos depósitos/filiais com
-- controle de estoque independente por produto.
--
-- Estratégia de migração gradual:
--   1. Cria tabela depositos com um "Depósito Principal" por empresa
--   2. Cria tabela produto_estoque_deposito para rastrear estoque por local
--   3. produtos.estoque mantém o total agregado (retrocompatibilidade)
--   4. Movimentações ganham deposito_id opcional

CREATE TABLE IF NOT EXISTS depositos (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL,
  nome        TEXT NOT NULL,
  descricao   TEXT,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  principal   BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em   TIMESTAMP NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, nome)
);

CREATE INDEX IF NOT EXISTS idx_depositos_empresa ON depositos(empresa_id, ativo);

CREATE TABLE IF NOT EXISTS produto_estoque_deposito (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL,
  produto_id   INTEGER NOT NULL,
  grade_id     INTEGER,
  deposito_id  INTEGER NOT NULL REFERENCES depositos(id) ON DELETE CASCADE,
  estoque      INTEGER NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (produto_id, grade_id, deposito_id)
);

CREATE INDEX IF NOT EXISTS idx_ped_produto   ON produto_estoque_deposito(produto_id, deposito_id);
CREATE INDEX IF NOT EXISTS idx_ped_deposito  ON produto_estoque_deposito(deposito_id, empresa_id);
CREATE INDEX IF NOT EXISTS idx_ped_grade     ON produto_estoque_deposito(grade_id) WHERE grade_id IS NOT NULL;

-- Deposito_id em movimentações (opcional — retrocompat)
ALTER TABLE movimentacoes_estoque
  ADD COLUMN IF NOT EXISTS deposito_id INTEGER REFERENCES depositos(id) ON DELETE SET NULL;
