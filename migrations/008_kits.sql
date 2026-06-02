-- Migration 008 — Kits / composições de produtos
-- Um kit é um produto composto de outros produtos (componentes).
-- Ao vender um kit, o estoque de cada componente é debitado.
-- O estoque do kit em produtos.estoque é mantido como o mínimo
-- de unidades de kit montáveis pelos componentes disponíveis.

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS e_kit BOOLEAN DEFAULT false;

CREATE TABLE IF NOT EXISTS kit_componentes (
  id              SERIAL PRIMARY KEY,
  kit_id          INTEGER NOT NULL,       -- produto pai (o kit)
  componente_id   INTEGER NOT NULL,       -- produto componente
  empresa_id      INTEGER NOT NULL,
  quantidade      NUMERIC(10,3) NOT NULL DEFAULT 1,  -- qtd do componente por unidade de kit
  criado_em       TIMESTAMP DEFAULT NOW(),
  atualizado_em   TIMESTAMP DEFAULT NOW(),
  UNIQUE(kit_id, componente_id)
);

CREATE INDEX IF NOT EXISTS idx_kit_componentes_kit  ON kit_componentes(kit_id, empresa_id);
CREATE INDEX IF NOT EXISTS idx_kit_componentes_comp ON kit_componentes(componente_id, empresa_id);
