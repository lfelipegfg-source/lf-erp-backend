-- Migration 015 — Índices de performance
-- Cobre os acessos mais frequentes em produção: listagens financeiras,
-- atualização de status em lote, detalhe de venda/compra e histórico de estoque.

-- ── contas_receber ────────────────────────────────────────────────────────────

-- Atualização em lote de status (atualizarStatusContasReceberPorEmpresa)
-- e listagem por empresa + status + vencimento
CREATE INDEX IF NOT EXISTS idx_cr_empresa_status_venc
  ON contas_receber(empresa_id, status, data_vencimento);

-- Detalhe de venda (GET /vendas/detalhe/:id) e estorno
CREATE INDEX IF NOT EXISTS idx_cr_venda
  ON contas_receber(venda_id)
  WHERE venda_id IS NOT NULL;

-- Listagem filtrada por cliente
CREATE INDEX IF NOT EXISTS idx_cr_cliente
  ON contas_receber(cliente_id, empresa_id)
  WHERE cliente_id IS NOT NULL;

-- ── contas_pagar ──────────────────────────────────────────────────────────────

-- Atualização em lote de status (atualizarStatusContasPagarPorEmpresa)
-- e listagem por empresa + status + vencimento
CREATE INDEX IF NOT EXISTS idx_cp_empresa_status_venc
  ON contas_pagar(empresa_id, status, data_vencimento);

-- Detalhe de compra e verificação de parcelas pagas antes de editar
CREATE INDEX IF NOT EXISTS idx_cp_compra
  ON contas_pagar(compra_id)
  WHERE compra_id IS NOT NULL;

-- ── vendas ────────────────────────────────────────────────────────────────────

-- Listagem com filtro de período (GET /vendas/:empresa)
CREATE INDEX IF NOT EXISTS idx_vendas_empresa_data
  ON vendas(empresa_id, data DESC);

-- Listagem por cliente
CREATE INDEX IF NOT EXISTS idx_vendas_cliente
  ON vendas(cliente_id, empresa_id)
  WHERE cliente_id IS NOT NULL;

-- ── venda_itens ───────────────────────────────────────────────────────────────

-- Detalhe de venda, estorno de estoque e reversão
CREATE INDEX IF NOT EXISTS idx_venda_itens_venda
  ON venda_itens(venda_id);

-- ── compra_itens ──────────────────────────────────────────────────────────────

-- Detalhe de compra e reversão de estoque no PUT
CREATE INDEX IF NOT EXISTS idx_compra_itens_compra
  ON compra_itens(compra_id);

-- ── movimentacoes_estoque ─────────────────────────────────────────────────────

-- Histórico por empresa + produto (módulo de estoque)
CREATE INDEX IF NOT EXISTS idx_movim_empresa_produto
  ON movimentacoes_estoque(empresa_id, produto_id);

-- Busca por referência para remoção em estorno/reversão
CREATE INDEX IF NOT EXISTS idx_movim_ref
  ON movimentacoes_estoque(referencia_tipo, referencia_id);

-- ── cadastros (produtos, clientes, fornecedores) ──────────────────────────────

-- Listagem de produtos por empresa (excluindo deletados)
CREATE INDEX IF NOT EXISTS idx_produtos_empresa
  ON produtos(empresa_id, deletado_em NULLS FIRST);

-- Listagem de clientes por empresa (excluindo deletados)
CREATE INDEX IF NOT EXISTS idx_clientes_empresa
  ON clientes(empresa_id, deletado_em NULLS FIRST);

-- Listagem de fornecedores por empresa (excluindo deletados)
CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa
  ON fornecedores(empresa_id, deletado_em NULLS FIRST);

-- ── financeiro_logs ───────────────────────────────────────────────────────────

-- Consulta de logs financeiros por empresa + data
CREATE INDEX IF NOT EXISTS idx_financeiro_logs_empresa
  ON financeiro_logs(empresa_id, criado_em DESC)
  WHERE empresa_id IS NOT NULL;
