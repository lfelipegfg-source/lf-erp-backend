-- Migration 019 — SMTP do SaaS Owner para emails transacionais
-- Adiciona configuração SMTP à saas_config (emails de boas-vindas, etc.)

ALTER TABLE saas_config
  ADD COLUMN IF NOT EXISTS smtp_host  TEXT,
  ADD COLUMN IF NOT EXISTS smtp_port  INTEGER DEFAULT 587,
  ADD COLUMN IF NOT EXISTS smtp_user  TEXT,
  ADD COLUMN IF NOT EXISTS smtp_pass  TEXT,
  ADD COLUMN IF NOT EXISTS smtp_from  TEXT,
  ADD COLUMN IF NOT EXISTS app_url    TEXT DEFAULT 'https://lf-erp-frontend.vercel.app';
