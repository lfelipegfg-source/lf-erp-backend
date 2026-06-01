-- Migration 005 — grade_id em tabelas de itens e movimentações
-- Permite rastrear qual variação (grade) foi vendida/comprada/movimentada.
-- Retrocompatível: grade_id nullable, registros antigos ficam NULL.

ALTER TABLE venda_itens          ADD COLUMN IF NOT EXISTS grade_id INTEGER;
ALTER TABLE compra_itens         ADD COLUMN IF NOT EXISTS grade_id INTEGER;
ALTER TABLE movimentacoes_estoque ADD COLUMN IF NOT EXISTS grade_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_venda_itens_grade      ON venda_itens(grade_id)           WHERE grade_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compra_itens_grade     ON compra_itens(grade_id)          WHERE grade_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movim_estoque_grade    ON movimentacoes_estoque(grade_id) WHERE grade_id IS NOT NULL;
