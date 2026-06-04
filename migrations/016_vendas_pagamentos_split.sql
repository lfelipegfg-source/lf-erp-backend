-- Migration 016 — Split de pagamento em vendas
-- Adiciona coluna JSONB para armazenar múltiplas formas de pagamento
-- por venda (ex: R$50 Dinheiro + R$80 Pix + R$70 Promissória).
-- Retrocompatível: vendas existentes mantêm pagamento (TEXT) intacto;
-- pagamentos NULL = venda gerada antes do split.

ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pagamentos JSONB;
