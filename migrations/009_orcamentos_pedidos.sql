-- Migration 009 — Orçamentos e Pedidos
-- Fluxo: Orçamento → Pedido → Venda
-- Nenhuma das etapas anteriores movimenta estoque ou gera financeiro.
-- Apenas a conversão do Pedido em Venda aciona o fluxo normal de vendas.

-- ─── ORÇAMENTOS ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orcamentos (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  empresa         TEXT NOT NULL,
  numero          INTEGER NOT NULL,           -- número sequencial por empresa
  cliente_id      INTEGER,
  cliente_nome    TEXT,
  status          VARCHAR(20) DEFAULT 'rascunho',
  -- 'rascunho' | 'enviado' | 'aprovado' | 'recusado' | 'expirado' | 'convertido'
  validade        DATE,                       -- data de validade do orçamento
  subtotal        NUMERIC(12,2) DEFAULT 0,
  desconto        NUMERIC(12,2) DEFAULT 0,
  acrescimo       NUMERIC(12,2) DEFAULT 0,
  total           NUMERIC(12,2) DEFAULT 0,
  observacao      TEXT,
  criado_por      INTEGER,
  convertido_em   TIMESTAMP,                  -- quando virou pedido
  criado_em       TIMESTAMP DEFAULT NOW(),
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, numero)
);

CREATE INDEX IF NOT EXISTS idx_orcamentos_empresa  ON orcamentos(empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_orcamentos_cliente  ON orcamentos(cliente_id);

CREATE TABLE IF NOT EXISTS orcamento_itens (
  id              SERIAL PRIMARY KEY,
  orcamento_id    INTEGER NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
  empresa_id      INTEGER NOT NULL,
  produto_id      INTEGER NOT NULL,
  produto_nome    TEXT NOT NULL,
  grade_id        INTEGER,
  quantidade      NUMERIC(10,3) NOT NULL DEFAULT 1,
  preco_unitario  NUMERIC(10,2) NOT NULL DEFAULT 0,
  desconto_item   NUMERIC(10,2) DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orcamento_itens ON orcamento_itens(orcamento_id);

-- ─── PEDIDOS ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pedidos (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  empresa         TEXT NOT NULL,
  numero          INTEGER NOT NULL,
  orcamento_id    INTEGER,                    -- null se criado direto
  cliente_id      INTEGER,
  cliente_nome    TEXT,
  status          VARCHAR(20) DEFAULT 'pendente',
  -- 'pendente' | 'confirmado' | 'em_separacao' | 'enviado' | 'entregue' | 'cancelado' | 'convertido'
  previsao_entrega DATE,
  endereco_entrega TEXT,
  forma_pagamento TEXT,
  parcelas        INTEGER DEFAULT 1,
  subtotal        NUMERIC(12,2) DEFAULT 0,
  desconto        NUMERIC(12,2) DEFAULT 0,
  acrescimo       NUMERIC(12,2) DEFAULT 0,
  total           NUMERIC(12,2) DEFAULT 0,
  observacao      TEXT,
  criado_por      INTEGER,
  convertido_em   TIMESTAMP,
  criado_em       TIMESTAMP DEFAULT NOW(),
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, numero)
);

CREATE INDEX IF NOT EXISTS idx_pedidos_empresa    ON pedidos(empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente    ON pedidos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_orcamento  ON pedidos(orcamento_id);

CREATE TABLE IF NOT EXISTS pedido_itens (
  id              SERIAL PRIMARY KEY,
  pedido_id       INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  empresa_id      INTEGER NOT NULL,
  produto_id      INTEGER NOT NULL,
  produto_nome    TEXT NOT NULL,
  grade_id        INTEGER,
  quantidade      NUMERIC(10,3) NOT NULL DEFAULT 1,
  preco_unitario  NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pedido_itens ON pedido_itens(pedido_id);

-- ─── REFERÊNCIAS EM VENDAS ───────────────────────────────────────────────────
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pedido_id    INTEGER;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS orcamento_id INTEGER;
