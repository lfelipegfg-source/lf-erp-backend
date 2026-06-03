-- Migration 013 — Devoluções
-- Registra devoluções de vendas, restaura estoque e gera crédito financeiro.

CREATE TABLE IF NOT EXISTS devolucoes (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  venda_id        INTEGER NOT NULL,
  numero          INTEGER NOT NULL,
  cliente_id      INTEGER,
  cliente_nome    TEXT,
  motivo          TEXT,
  status          VARCHAR(20) DEFAULT 'processada',
  -- 'processada' | 'cancelada'
  total_devolvido NUMERIC(12,2) DEFAULT 0,
  criado_por      INTEGER,
  criado_em       TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, numero)
);

CREATE TABLE IF NOT EXISTS devolucao_itens (
  id              SERIAL PRIMARY KEY,
  devolucao_id    INTEGER NOT NULL REFERENCES devolucoes(id) ON DELETE CASCADE,
  empresa_id      INTEGER NOT NULL,
  produto_id      INTEGER NOT NULL,
  produto_nome    TEXT NOT NULL,
  grade_id        INTEGER,
  quantidade      NUMERIC(10,3) NOT NULL DEFAULT 1,
  preco_unitario  NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_devolucoes_empresa ON devolucoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_devolucoes_venda   ON devolucoes(venda_id);
CREATE INDEX IF NOT EXISTS idx_devolucao_itens    ON devolucao_itens(devolucao_id);
