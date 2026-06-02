-- Migration 010 — Comissão de vendedores
-- Permite configurar % de comissão por usuário/vendedor.
-- A comissão é calculada e registrada automaticamente ao criar uma venda.

-- Configuração de comissão por usuário e empresa
CREATE TABLE IF NOT EXISTS comissoes_config (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  usuario_id      INTEGER NOT NULL,
  percentual      NUMERIC(5,2) NOT NULL DEFAULT 0,  -- % sobre o total da venda
  ativa           BOOLEAN DEFAULT true,
  criado_em       TIMESTAMP DEFAULT NOW(),
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_comissoes_config_usuario ON comissoes_config(usuario_id, empresa_id);

-- Override de comissão por produto (opcional — mais específico que o global)
CREATE TABLE IF NOT EXISTS comissoes_config_produtos (
  id              SERIAL PRIMARY KEY,
  config_id       INTEGER NOT NULL REFERENCES comissoes_config(id) ON DELETE CASCADE,
  empresa_id      INTEGER NOT NULL,
  produto_id      INTEGER NOT NULL,
  percentual      NUMERIC(5,2) NOT NULL,
  criado_em       TIMESTAMP DEFAULT NOW(),
  UNIQUE(config_id, produto_id)
);

-- Registro de comissões geradas por venda
CREATE TABLE IF NOT EXISTS comissoes (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  usuario_id      INTEGER NOT NULL,    -- vendedor
  venda_id        INTEGER NOT NULL,
  valor_venda     NUMERIC(12,2) NOT NULL DEFAULT 0,
  percentual      NUMERIC(5,2)  NOT NULL DEFAULT 0,
  valor_comissao  NUMERIC(12,2) NOT NULL DEFAULT 0,
  status          VARCHAR(20)   DEFAULT 'pendente',
  -- 'pendente' | 'pago' | 'cancelado'
  data_pagamento  DATE,
  forma_pagamento TEXT,
  observacao      TEXT,
  criado_em       TIMESTAMP DEFAULT NOW(),
  atualizado_em   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comissoes_usuario ON comissoes(usuario_id, empresa_id);
CREATE INDEX IF NOT EXISTS idx_comissoes_venda   ON comissoes(venda_id);
CREATE INDEX IF NOT EXISTS idx_comissoes_status  ON comissoes(status, empresa_id);
