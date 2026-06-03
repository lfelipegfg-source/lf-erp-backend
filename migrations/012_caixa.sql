-- Migration 012 — Controle de Caixa (PDV)
-- Registra abertura, movimentações e fechamento do caixa físico.

CREATE TABLE IF NOT EXISTS caixa_sessoes (
  id                SERIAL PRIMARY KEY,
  empresa_id        INTEGER NOT NULL,
  usuario_id        INTEGER,
  usuario_nome      TEXT,
  status            VARCHAR(20) DEFAULT 'aberto',
  -- 'aberto' | 'fechado'
  saldo_abertura    NUMERIC(12,2) DEFAULT 0,
  saldo_fechamento  NUMERIC(12,2),         -- informado pelo operador ao fechar
  saldo_calculado   NUMERIC(12,2),         -- calculado pelos movimentos
  diferenca         NUMERIC(12,2),         -- saldo_fechamento - saldo_calculado
  observacao        TEXT,
  aberto_em         TIMESTAMP DEFAULT NOW(),
  fechado_em        TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_empresa ON caixa_sessoes(empresa_id, status);

CREATE TABLE IF NOT EXISTS caixa_movimentos (
  id            SERIAL PRIMARY KEY,
  sessao_id     INTEGER NOT NULL REFERENCES caixa_sessoes(id) ON DELETE CASCADE,
  empresa_id    INTEGER NOT NULL,
  tipo          VARCHAR(20) NOT NULL,
  -- 'abertura' | 'sangria' | 'suprimento' | 'fechamento'
  valor         NUMERIC(12,2) NOT NULL,    -- positivo = entrada, negativo = saída
  descricao     TEXT,
  criado_em     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_sessao ON caixa_movimentos(sessao_id);
