-- Migration 007 — Tabela de preços
-- Permite definir preços diferenciados por cliente, grupo ou quantidade.
-- Tipos de regra suportados:
--   'percentual' → desconto ou markup global sobre o preço do produto
--   'fixo'       → preço fixo por produto cadastrado em tabela_preco_itens

CREATE TABLE IF NOT EXISTS tabelas_preco (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL,
  nome                VARCHAR(100) NOT NULL,
  descricao           TEXT,
  tipo                VARCHAR(20) NOT NULL DEFAULT 'percentual',
  -- Para tipo 'percentual': desconto ou markup aplicado a todos os produtos
  desconto_percentual NUMERIC(5,2) DEFAULT 0,   -- positivo = desconto
  markup_percentual   NUMERIC(5,2) DEFAULT 0,    -- positivo = acréscimo
  ativa               BOOLEAN DEFAULT true,
  criado_em           TIMESTAMP DEFAULT NOW(),
  atualizado_em       TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, nome)
);

CREATE INDEX IF NOT EXISTS idx_tabelas_preco_empresa ON tabelas_preco(empresa_id);

-- Preços específicos por produto dentro de uma tabela (tipo 'fixo' ou override)
CREATE TABLE IF NOT EXISTS tabela_preco_itens (
  id                SERIAL PRIMARY KEY,
  tabela_id         INTEGER NOT NULL REFERENCES tabelas_preco(id) ON DELETE CASCADE,
  produto_id        INTEGER NOT NULL,
  empresa_id        INTEGER NOT NULL,
  grade_id          INTEGER,                    -- opcional: preço específico por grade
  preco             NUMERIC(10,2) NOT NULL,
  quantidade_minima INTEGER NOT NULL DEFAULT 1, -- quantidade mínima para este preço
  criado_em         TIMESTAMP DEFAULT NOW(),
  atualizado_em     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tpi_tabela    ON tabela_preco_itens(tabela_id);
CREATE INDEX IF NOT EXISTS idx_tpi_produto   ON tabela_preco_itens(produto_id, empresa_id);
-- Unicidade com suporte a grade_id NULL via índice de expressão
CREATE UNIQUE INDEX IF NOT EXISTS idx_tpi_unique
  ON tabela_preco_itens(tabela_id, produto_id, COALESCE(grade_id, 0), quantidade_minima);

-- Vincula cliente a uma tabela de preços
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tabela_preco_id INTEGER;
