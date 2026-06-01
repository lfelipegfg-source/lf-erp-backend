-- Migration 002 — Expansão do modelo de Produto
-- Adiciona campos fiscais (NF-e), dimensões, grade e rastreabilidade.
-- Todos os campos são opcionais (nullable ou com default) para manter
-- retrocompatibilidade total com produtos já cadastrados.

-- Identificação e rastreabilidade
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS codigo_interno   VARCHAR(100);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS gtin             VARCHAR(14);

-- Unidade de medida
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS unidade          VARCHAR(10) DEFAULT 'UN';

-- Descrição completa (campo livre para detalhes além do nome)
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS descricao_completa TEXT;

-- Dimensões e peso (para frete e NF-e)
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_bruto       NUMERIC(10,3);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_liquido     NUMERIC(10,3);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS comprimento_cm   NUMERIC(10,2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS largura_cm       NUMERIC(10,2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS altura_cm        NUMERIC(10,2);

-- Dados fiscais (obrigatórios para NF-e)
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ncm              VARCHAR(8);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cfop_padrao      VARCHAR(4);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS origem           SMALLINT DEFAULT 0;

-- ICMS
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS icms_cst         VARCHAR(3);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS icms_aliquota    NUMERIC(5,2) DEFAULT 0;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS icms_base_calculo NUMERIC(5,2) DEFAULT 100;

-- PIS
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS pis_cst          VARCHAR(2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS pis_aliquota     NUMERIC(5,2) DEFAULT 0;

-- COFINS
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cofins_cst       VARCHAR(2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cofins_aliquota  NUMERIC(5,2) DEFAULT 0;

-- IPI (para indústria)
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ipi_cst          VARCHAR(2);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ipi_aliquota     NUMERIC(5,2) DEFAULT 0;

-- Grade de variações (tamanho, cor etc.)
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS tem_grade        BOOLEAN DEFAULT false;

-- Tabela de grades de produtos (variações com estoque próprio)
CREATE TABLE IF NOT EXISTS produto_grades (
  id            SERIAL PRIMARY KEY,
  produto_id    INTEGER NOT NULL,
  empresa_id    INTEGER NOT NULL,
  atributo1     VARCHAR(50),   -- ex: 'P', 'M', 'G', 'GG'
  atributo2     VARCHAR(50),   -- ex: 'Azul', 'Vermelho'
  sku           VARCHAR(100),
  gtin          VARCHAR(14),
  preco         NUMERIC(10,2),
  custo         NUMERIC(10,2),
  estoque       INTEGER DEFAULT 0,
  estoque_minimo INTEGER DEFAULT 0,
  ativo         BOOLEAN DEFAULT true,
  criado_em     TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_produto_grades_produto ON produto_grades(produto_id, empresa_id);

-- Tabela de atributos configuráveis por empresa (ex: Tamanho, Cor, Sabor)
CREATE TABLE IF NOT EXISTS produto_atributos (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL,
  nome        VARCHAR(50) NOT NULL,   -- ex: 'Tamanho', 'Cor'
  valores     TEXT[],                 -- ex: ['P','M','G','GG']
  criado_em   TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, nome)
);
