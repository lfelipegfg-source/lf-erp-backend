-- Migration 039 — Ativar assinatura premium permanente (Lucileide Variedades)
--
-- ATENÇÃO: O script de reset completo de dados foi REMOVIDO desta migration automática
-- para evitar exclusão acidental de dados de produção.
--
-- Se precisar executar o reset manual (zerar todos os dados da empresa),
-- use o script: backend/scripts/reset_lucileide_dados.sql
-- via Neon Console → SQL Editor (AÇÃO IRREVERSÍVEL — faça backup antes)
--
-- Esta migration apenas garante que a empresa esteja com status de assinatura ativo.

DO $$
DECLARE
  emp_id INTEGER;
BEGIN
  SELECT id INTO emp_id FROM empresas WHERE LOWER(nome) = 'lucileide variedades';
  IF emp_id IS NOT NULL THEN
    UPDATE empresas
    SET assinatura_status = 'ativo',
        trial_fim         = NULL,
        bloqueada         = FALSE,
        motivo_bloqueio   = NULL,
        atualizado_em     = NOW()
    WHERE id = emp_id;
    RAISE NOTICE 'Migration 039: empresa_id=% atualizada para ativo permanente (sem reset de dados).', emp_id;
  ELSE
    RAISE NOTICE 'Migration 039: empresa Lucileide Variedades não encontrada — OK se outro tenant.';
  END IF;
END $$;
