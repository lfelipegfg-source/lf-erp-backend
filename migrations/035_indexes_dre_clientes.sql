-- Migration 035 — Índices para DRE e listagem de clientes com saldo

-- Acelera a subquery vi_cmv da DRE:
-- antes: full scan de venda_itens (todas as empresas) + hash join
-- depois: index scan por empresa_id + venda_id
CREATE INDEX IF NOT EXISTS idx_venda_itens_empresa_venda
  ON venda_itens(empresa_id, venda_id);

-- Acelera LEFT JOIN de saldo de clientes (total_em_aberto):
-- antes: subquery correlacionada por cliente_id + empresa_id
-- depois: scan direto por empresa_id + status com GROUP BY via index-only scan
-- NOTA: contas_receber não tem coluna deletado_em — filtro removido
CREATE INDEX IF NOT EXISTS idx_cr_empresa_status_cliente
  ON contas_receber(empresa_id, status, cliente_id)
  WHERE cliente_id IS NOT NULL;
