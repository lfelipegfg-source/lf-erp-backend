-- Migration 021 — Metas de vendas por vendedor/período
-- Permite definir metas mensais ou periódicas de valor de vendas
-- por usuário, com acompanhamento de progresso em tempo real.

CREATE TABLE IF NOT EXISTS metas_vendas (
  id            SERIAL PRIMARY KEY,
  empresa_id    INTEGER NOT NULL,
  usuario_id    INTEGER,                     -- NULL = meta global da empresa
  periodo       TEXT NOT NULL,               -- 'YYYY-MM' (mês) ou 'YYYY-QN' (trimestre)
  valor_meta    NUMERIC(14,2) NOT NULL DEFAULT 0,
  descricao     TEXT,
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMP NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, usuario_id, periodo)
);

CREATE INDEX IF NOT EXISTS idx_metas_empresa ON metas_vendas(empresa_id, periodo);
CREATE INDEX IF NOT EXISTS idx_metas_usuario ON metas_vendas(usuario_id, empresa_id);
