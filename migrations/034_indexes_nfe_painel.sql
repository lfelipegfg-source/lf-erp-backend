-- Migration 034 — Índices para NF-e e painel contábil

-- Acelera GET /exportacao/efd (query por empresa + período na tabela nfe)
CREATE INDEX IF NOT EXISTS idx_nfe_empresa_data ON nfe (empresa_id, data_emissao);

-- Acelera GET /exportacao/painel (queries de período em lancamentos_financeiros)
CREATE INDEX IF NOT EXISTS idx_lancamentos_tipo_vencimento ON lancamentos_financeiros (empresa_id, tipo, vencimento);
CREATE INDEX IF NOT EXISTS idx_lancamentos_tipo_pagamento  ON lancamentos_financeiros (empresa_id, tipo, pagamento_data);
