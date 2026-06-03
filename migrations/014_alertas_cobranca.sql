-- Migration 014 — Alertas de Cobrança
-- Configuração de email/WhatsApp e histórico de alertas enviados.

CREATE TABLE IF NOT EXISTS alertas_config (
  id                    SERIAL PRIMARY KEY,
  empresa_id            INTEGER NOT NULL UNIQUE,
  email_ativo           BOOLEAN DEFAULT false,
  smtp_host             TEXT,
  smtp_port             INTEGER DEFAULT 587,
  smtp_user             TEXT,
  smtp_pass             TEXT,    -- senha/app-password do SMTP
  smtp_from             TEXT,    -- "Lucileide Variedades <email@gmail.com>"
  email_assunto         TEXT DEFAULT 'Aviso de pagamento pendente',
  email_corpo           TEXT,
  whatsapp_ativo        BOOLEAN DEFAULT false,
  whatsapp_msg          TEXT,
  dias_atraso_minimo    INTEGER DEFAULT 1,
  atualizado_em         TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alertas_historico (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  tipo            VARCHAR(20) NOT NULL, -- 'email' | 'whatsapp'
  cliente_id      INTEGER,
  cliente_nome    TEXT,
  contato         TEXT,                 -- email ou telefone
  valor_total     NUMERIC(12,2),
  status          VARCHAR(20) DEFAULT 'enviado', -- 'enviado' | 'erro'
  erro_msg        TEXT,
  criado_em       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alertas_historico_empresa ON alertas_historico(empresa_id, criado_em DESC);
