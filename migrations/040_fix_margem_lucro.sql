-- Corrige margem_lucro de todos os produtos existentes.
-- Fórmula anterior usada: (lucro / custo) * 100  → markup, não margem
-- Fórmula correta:        (lucro / preco)  * 100  → margem real de lucro
--
-- Exemplo: preco=150, custo=100
--   Markup (errado):  50/100*100 = 50%
--   Margem  (certo):  50/150*100 = 33.3%

UPDATE produtos
SET
  lucro_unitario = ROUND((preco - COALESCE(custo_medio, custo, 0))::numeric, 2),
  margem_lucro   = CASE
    WHEN preco > 0
    THEN ROUND(((preco - COALESCE(custo_medio, custo, 0)) / preco * 100)::numeric, 2)
    ELSE 0
  END,
  atualizado_em  = NOW()
WHERE deletado_em IS NULL;
