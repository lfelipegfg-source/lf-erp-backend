-- Migration 034 — Índices para NF-e e painel contábil

-- Acelera GET /exportacao/efd (query por empresa + período na tabela nfe_emissoes)
-- Usa DO block porque tabela pode não existir em deploys sem módulo NF-e ativo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_nfe_empresa_data') THEN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'nfe_emissoes' AND schemaname = 'public') THEN
      EXECUTE 'CREATE INDEX idx_nfe_empresa_data ON nfe_emissoes (empresa_id, criado_em)';
    END IF;
  END IF;
END $$;

-- Acelera GET /exportacao/painel (queries de período em lancamentos_financeiros)
CREATE INDEX IF NOT EXISTS idx_lancamentos_tipo_vencimento ON lancamentos_financeiros (empresa_id, tipo, vencimento);
CREATE INDEX IF NOT EXISTS idx_lancamentos_tipo_pagamento  ON lancamentos_financeiros (empresa_id, tipo, pagamento_data);
