-- Migration 030 — Links de Pagamento / Checkout Online

CREATE TABLE IF NOT EXISTS checkout_links (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  token           TEXT NOT NULL UNIQUE,         -- token público da URL
  descricao       TEXT NOT NULL,
  valor           NUMERIC(12,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pendente',
  -- pendente | pago | expirado | cancelado
  cliente_nome    TEXT,
  cliente_email   TEXT,
  cliente_telefone TEXT,
  metodo_pago     TEXT,                         -- 'pix' | 'boleto' | null
  asaas_payment_id TEXT,                        -- ID do pagamento no Asaas (boleto/pix dinâmico)
  pix_copia_cola  TEXT,                         -- string PIX EMV para copiar/colar
  boleto_url      TEXT,                         -- URL do boleto
  boleto_linha    TEXT,                         -- linha digitável
  expira_em       TIMESTAMP,
  pago_em         TIMESTAMP,
  observacoes     TEXT,
  criado_por      INTEGER,
  criado_em       TIMESTAMP DEFAULT NOW(),
  atualizado_em   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkout_empresa ON checkout_links(empresa_id);
CREATE INDEX IF NOT EXISTS idx_checkout_token   ON checkout_links(token);
CREATE INDEX IF NOT EXISTS idx_checkout_status  ON checkout_links(empresa_id, status);
