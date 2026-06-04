-- Migration 024 — Rastreamento de pedidos de marketplace (idempotência)
-- Garante que cada pedido externo seja processado no máximo uma vez.

CREATE TABLE IF NOT EXISTS marketplace_pedidos (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  plataforma      TEXT NOT NULL,                 -- 'mercadolivre' | 'shopee'
  pedido_externo  TEXT NOT NULL,                 -- ID do pedido na plataforma
  status          TEXT NOT NULL DEFAULT 'processado', -- 'processado' | 'sem_produtos' | 'erro'
  venda_id        INTEGER,                       -- venda gerada no LF ERP (NULL se sem_produtos)
  erro_msg        TEXT,                          -- mensagem de erro, se houver
  dados_raw       JSONB,                         -- snapshot do pedido recebido da API
  criado_em       TIMESTAMP DEFAULT NOW(),
  UNIQUE (plataforma, pedido_externo)
);

CREATE INDEX IF NOT EXISTS idx_mkt_pedidos_empresa ON marketplace_pedidos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_mkt_pedidos_venda   ON marketplace_pedidos(venda_id);
