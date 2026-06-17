-- Migration 036 — Finalização da migração multiempresa
--
-- Pré-condição: migration 032 fez backfill de empresa_id em todas as tabelas.
-- Esta migration valida que o backfill está completo e adiciona NOT NULL
-- nas tabelas principais, tornando empresa_id obrigatório para novos registros.
--
-- Estratégia segura: bloco DO aborta a transaction se ainda houver NULLs.
-- Em produção com dataset pequeno (single client) a operação é instantânea.

DO $$
DECLARE
  tabela TEXT;
  qtd    BIGINT;
BEGIN
  -- Verifica que não há NULLs antes de adicionar constraints
  FOR tabela, qtd IN
    SELECT 'produtos',             COUNT(*) FROM produtos            WHERE empresa_id IS NULL UNION ALL
    SELECT 'clientes',             COUNT(*) FROM clientes            WHERE empresa_id IS NULL UNION ALL
    SELECT 'fornecedores',         COUNT(*) FROM fornecedores        WHERE empresa_id IS NULL UNION ALL
    SELECT 'vendas',               COUNT(*) FROM vendas              WHERE empresa_id IS NULL UNION ALL
    SELECT 'venda_itens',          COUNT(*) FROM venda_itens         WHERE empresa_id IS NULL UNION ALL
    SELECT 'compras',              COUNT(*) FROM compras             WHERE empresa_id IS NULL UNION ALL
    SELECT 'compra_itens',         COUNT(*) FROM compra_itens        WHERE empresa_id IS NULL UNION ALL
    SELECT 'contas_receber',       COUNT(*) FROM contas_receber      WHERE empresa_id IS NULL UNION ALL
    SELECT 'contas_pagar',         COUNT(*) FROM contas_pagar        WHERE empresa_id IS NULL UNION ALL
    SELECT 'lancamentos_financeiros', COUNT(*) FROM lancamentos_financeiros WHERE empresa_id IS NULL UNION ALL
    SELECT 'movimentacoes_estoque',   COUNT(*) FROM movimentacoes_estoque   WHERE empresa_id IS NULL
  LOOP
    IF qtd > 0 THEN
      RAISE EXCEPTION 'Backfill incompleto: tabela % ainda tem % registro(s) sem empresa_id. Execute novamente a migration 032.', tabela, qtd;
    END IF;
  END LOOP;
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

-- ── DEFAULT para novos registros usarem empresa_id do registro pai ────────────
-- (proteção extra: impede INSERT acidental sem o campo)
-- Não há DEFAULT lógico aqui — a ausência de DEFAULT força o código a sempre
-- fornecer empresa_id explicitamente, o que já acontece em todos os routes.
