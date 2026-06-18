-- Migration 037 — Índices de performance (auditoria 2026-06-18)
-- Baseado em auditoria de 3 agentes: SQL queries, infraestrutura e frontend

-- ── produto_grades ────────────────────────────────────────────────────────────
-- Crítico para PDV: toda venda com grade consulta esta tabela sem índice

CREATE INDEX IF NOT EXISTS idx_produto_grades_produto_empresa
  ON produto_grades(produto_id, empresa_id);

-- Variante parcial para grades ativas (lookup mais frequente)
CREATE INDEX IF NOT EXISTS idx_produto_grades_produto_empresa_ativo
  ON produto_grades(produto_id, empresa_id)
  WHERE ativo IS DISTINCT FROM false;

-- ── contas_pagar ──────────────────────────────────────────────────────────────
-- NOT EXISTS check ao cancelar/estornar compras e no fluxo-caixa
-- (015 tem idx_cp_compra em (compra_id) apenas; este cobre o filtro status tb)

CREATE INDEX IF NOT EXISTS idx_cp_compra_id_status
  ON contas_pagar(compra_id, status)
  WHERE compra_id IS NOT NULL;

-- ── vendas ────────────────────────────────────────────────────────────────────
-- Histórico por cliente com filtro de período (relatórios e CRM)
-- (015 tem idx_vendas_cliente em (cliente_id, empresa_id) sem data)

CREATE INDEX IF NOT EXISTS idx_vendas_empresa_cliente_data
  ON vendas(empresa_id, cliente_id, data DESC)
  WHERE cliente_id IS NOT NULL;

-- ── contas_receber ────────────────────────────────────────────────────────────
-- Hot path do status update: pendente/atrasado com data_vencimento
-- Complementa idx_cr_empresa_status_venc (015) com filtro parcial mais seletivo

CREATE INDEX IF NOT EXISTS idx_cr_pend_atr_venc
  ON contas_receber(empresa_id, data_vencimento)
  WHERE status IN ('pendente', 'atrasado') AND data_vencimento IS NOT NULL;

-- cashflow-futuro: contas a receber por vencimento excluindo pagas
CREATE INDEX IF NOT EXISTS idx_cr_cashflow_venc
  ON contas_receber(empresa_id, data_vencimento)
  WHERE status NOT IN ('pago') AND data_vencimento IS NOT NULL;

-- ── compras ───────────────────────────────────────────────────────────────────
-- Listagem filtrada por empresa + status (GET /compras/:empresa)

CREATE INDEX IF NOT EXISTS idx_compras_empresa_status_data
  ON compras(empresa_id, status, data DESC)
  WHERE deletado_em IS NULL;

-- ── lancamentos_financeiros ───────────────────────────────────────────────────
-- Subquery de recebidos parciais em contas-receber filtra por categoria

CREATE INDEX IF NOT EXISTS idx_lancamentos_categoria_status
  ON lancamentos_financeiros(empresa_id, categoria, status)
  WHERE categoria IS NOT NULL;
