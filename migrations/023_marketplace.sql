-- Migration 023 — Integração com Marketplaces (ML, Shopee)
-- Armazena tokens OAuth e mapeamento de produtos/categorias.

CREATE TABLE IF NOT EXISTS marketplace_config (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  plataforma      TEXT NOT NULL,            -- 'mercadolivre' | 'shopee'
  access_token    TEXT,
  refresh_token   TEXT,
  token_expires_at TIMESTAMP,
  seller_id       TEXT,                     -- ID do vendedor na plataforma
  app_id          TEXT,                     -- App/Client ID
  client_secret   TEXT,
  ativo           BOOLEAN DEFAULT TRUE,
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  UNIQUE (empresa_id, plataforma)
);

CREATE TABLE IF NOT EXISTS marketplace_produtos (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL,
  produto_id          INTEGER NOT NULL,
  plataforma          TEXT NOT NULL,
  listing_id          TEXT NOT NULL,        -- ID do anúncio na plataforma
  titulo              TEXT,
  status_listing      TEXT DEFAULT 'active',
  preco_publicado     NUMERIC(12,2),
  estoque_publicado   INTEGER DEFAULT 0,
  ultimo_sync         TIMESTAMP,
  UNIQUE (empresa_id, produto_id, plataforma)
);

CREATE INDEX IF NOT EXISTS idx_mkt_config_empresa  ON marketplace_config(empresa_id);
CREATE INDEX IF NOT EXISTS idx_mkt_produtos_empresa ON marketplace_produtos(empresa_id, plataforma);
CREATE INDEX IF NOT EXISTS idx_mkt_produtos_produto  ON marketplace_produtos(produto_id, plataforma);
