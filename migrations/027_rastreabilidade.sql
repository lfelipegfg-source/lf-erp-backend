-- Migration 027 — Rastreabilidade por lote e número de série

-- Habilita rastreabilidade por produto
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS controla_rastreabilidade TEXT NOT NULL DEFAULT 'none';
-- 'none' | 'lote' | 'serie'

-- Lotes de produção / validade
CREATE TABLE IF NOT EXISTS lotes (
  id                 SERIAL PRIMARY KEY,
  empresa_id         INTEGER NOT NULL,
  produto_id         INTEGER NOT NULL,
  produto_nome       TEXT,
  numero             TEXT NOT NULL,           -- ex: LOT-2024-001
  data_fabricacao    DATE,
  data_validade      DATE,
  quantidade_entrada INTEGER NOT NULL DEFAULT 0,
  quantidade_atual   INTEGER NOT NULL DEFAULT 0,
  compra_id          INTEGER,                 -- compra de entrada (opcional)
  observacoes        TEXT,
  criado_em          TIMESTAMP DEFAULT NOW(),
  atualizado_em      TIMESTAMP DEFAULT NOW(),
  UNIQUE (empresa_id, produto_id, numero)
);

-- Números de série por unidade
CREATE TABLE IF NOT EXISTS numeros_serie (
  id            SERIAL PRIMARY KEY,
  empresa_id    INTEGER NOT NULL,
  produto_id    INTEGER NOT NULL,
  produto_nome  TEXT,
  numero        TEXT NOT NULL,               -- número de série único por empresa
  status        TEXT NOT NULL DEFAULT 'disponivel',
  -- disponivel | vendido | devolvido | defeito
  compra_id     INTEGER,
  venda_id      INTEGER,
  criado_em     TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW(),
  UNIQUE (empresa_id, numero)
);

-- Histórico de movimentos rastreados
CREATE TABLE IF NOT EXISTS rastreabilidade_movimentos (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  tipo            TEXT NOT NULL,              -- 'entrada' | 'saida' | 'ajuste'
  referencia_tipo TEXT,                       -- 'compra' | 'venda' | 'manual'
  referencia_id   INTEGER,
  lote_id         INTEGER REFERENCES lotes(id)         ON DELETE CASCADE,
  serie_id        INTEGER REFERENCES numeros_serie(id) ON DELETE CASCADE,
  produto_id      INTEGER NOT NULL,
  produto_nome    TEXT,
  quantidade      INTEGER NOT NULL DEFAULT 1,
  observacao      TEXT,
  usuario_id      INTEGER,
  criado_em       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lotes_empresa    ON lotes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_lotes_produto    ON lotes(produto_id);
CREATE INDEX IF NOT EXISTS idx_lotes_validade   ON lotes(data_validade);
CREATE INDEX IF NOT EXISTS idx_serie_empresa    ON numeros_serie(empresa_id);
CREATE INDEX IF NOT EXISTS idx_serie_produto    ON numeros_serie(produto_id);
CREATE INDEX IF NOT EXISTS idx_serie_status     ON numeros_serie(status);
CREATE INDEX IF NOT EXISTS idx_rast_mov_lote    ON rastreabilidade_movimentos(lote_id);
CREATE INDEX IF NOT EXISTS idx_rast_mov_serie   ON rastreabilidade_movimentos(serie_id);
CREATE INDEX IF NOT EXISTS idx_rast_mov_empresa ON rastreabilidade_movimentos(empresa_id);
