-- Migration 004 — Storage: imagens de produtos e arquivos fiscais
-- Prepara as tabelas para F4 (Cloudinary / S3).
-- Os campos url e url_thumbnail recebem a URL retornada pelo provider de storage.

-- Imagens de produtos
CREATE TABLE IF NOT EXISTS produto_imagens (
  id              SERIAL PRIMARY KEY,
  produto_id      INTEGER NOT NULL,
  empresa_id      INTEGER NOT NULL,
  url             TEXT NOT NULL,
  url_thumbnail   TEXT,
  storage_public_id TEXT,        -- ID no Cloudinary/S3 para deleção
  ordem           INTEGER DEFAULT 0,
  principal       BOOLEAN DEFAULT false,
  criado_em       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_produto_imagens_produto ON produto_imagens(produto_id, empresa_id);

-- Arquivos fiscais (XMLs de NF-e, DANFEs, certificados)
CREATE TABLE IF NOT EXISTS arquivos_fiscais (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  tipo            VARCHAR(20) NOT NULL,  -- 'nfe_xml', 'danfe', 'certificado'
  referencia_tipo VARCHAR(30),           -- 'venda', 'compra', 'empresa'
  referencia_id   INTEGER,
  chave_nfe       VARCHAR(44),
  url             TEXT NOT NULL,
  storage_public_id TEXT,
  criado_em       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arquivos_fiscais_empresa ON arquivos_fiscais(empresa_id, tipo);
CREATE INDEX IF NOT EXISTS idx_arquivos_fiscais_ref ON arquivos_fiscais(referencia_tipo, referencia_id);
