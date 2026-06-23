-- Migration 036 — Finalização da migração multiempresa
--
-- Pré-condição: migration 032 fez backfill de empresa_id em todas as tabelas.
-- Esta migration garante que não há empresa_id = NULL antes de adicionar NOT NULL.
-- Registros órfãos (empresa = NULL E empresa_id = NULL) são atribuídos à primeira empresa.

DO $$
DECLARE
  emp_id INTEGER;
BEGIN
  -- Encontra empresa padrão para backfill residual
  SELECT id INTO emp_id FROM empresas ORDER BY id LIMIT 1;
  IF emp_id IS NULL THEN
    RAISE EXCEPTION 'Nenhuma empresa cadastrada. Não é possível completar o backfill de empresa_id.';
  END IF;

  -- Backfill residual: registros que 032 não conseguiu resolver
  -- (empresa = NULL impossibilita resolução por nome; atribui à empresa principal)
  UPDATE produtos               SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE clientes               SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE fornecedores           SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE vendas                 SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE venda_itens            SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE compras                SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE compra_itens           SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE contas_receber         SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE contas_pagar           SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE lancamentos_financeiros SET empresa_id = emp_id WHERE empresa_id IS NULL;
  UPDATE movimentacoes_estoque   SET empresa_id = emp_id WHERE empresa_id IS NULL;

  RAISE NOTICE 'Migration 036: backfill residual OK — empresa_id=% atribuído a registros órfãos.', emp_id;
END $$;

-- ── NOT NULL nas tabelas de cadastro ─────────────────────────────────────────

ALTER TABLE produtos     ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE clientes     ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE fornecedores ALTER COLUMN empresa_id SET NOT NULL;

-- ── NOT NULL nas tabelas transacionais ────────────────────────────────────────

ALTER TABLE vendas       ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE compras      ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE contas_receber    ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE contas_pagar      ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE lancamentos_financeiros ALTER COLUMN empresa_id SET NOT NULL;

-- ── NOT NULL nas tabelas de itens e estoque ───────────────────────────────────

ALTER TABLE venda_itens          ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE compra_itens         ALTER COLUMN empresa_id SET NOT NULL;
ALTER TABLE movimentacoes_estoque ALTER COLUMN empresa_id SET NOT NULL;
