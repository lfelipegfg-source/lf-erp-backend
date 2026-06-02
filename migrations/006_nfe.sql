-- Migration 006 — NF-e: campos fiscais em empresas + tabelas de configuração e emissão

-- Endereço estruturado e dados fiscais obrigatórios para NF-e
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS ie                TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS im                TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS crt               SMALLINT DEFAULT 1;  -- 1=Simples, 2=SN Exc., 3=Normal
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS logradouro        TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS numero            TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS complemento       TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS bairro            TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS municipio         TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS uf                CHAR(2);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cep               TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS codigo_municipio  TEXT;

-- Configuração NF-e por empresa
CREATE TABLE IF NOT EXISTS nfe_config (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL UNIQUE,
  token_focusnfe  TEXT,
  ambiente        SMALLINT DEFAULT 2,    -- 1=producao, 2=homologacao
  serie           VARCHAR(3) DEFAULT '1',
  numero_atual    INTEGER DEFAULT 0,
  criado_em       TIMESTAMP DEFAULT NOW(),
  atualizado_em   TIMESTAMP DEFAULT NOW()
);

-- Registro de NF-es emitidas
CREATE TABLE IF NOT EXISTS nfe_emissoes (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  venda_id        INTEGER,
  ref             TEXT NOT NULL UNIQUE,   -- referência única enviada ao Focus NFe
  chave_nfe       CHAR(44),
  numero          INTEGER,
  serie           VARCHAR(3),
  status          VARCHAR(30) DEFAULT 'processando',
  -- 'processando' | 'autorizado' | 'cancelado' | 'rejeitado' | 'erro'
  mensagem        TEXT,
  xml_url         TEXT,
  danfe_url       TEXT,
  ambiente        SMALLINT DEFAULT 2,
  cancelado_em    TIMESTAMP,
  motivo_cancelamento TEXT,
  criado_em       TIMESTAMP DEFAULT NOW(),
  atualizado_em   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nfe_emissoes_empresa  ON nfe_emissoes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_nfe_emissoes_venda    ON nfe_emissoes(venda_id);
CREATE INDEX IF NOT EXISTS idx_nfe_emissoes_status   ON nfe_emissoes(status);

-- Também adicionar cpf/cnpj e endereço estruturado em clientes (necessário para destinatário NF-e)
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cpf_cnpj        TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tipo_pessoa      CHAR(1) DEFAULT 'F';  -- F=fisica, J=juridica
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS ie_destinatario  TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS logradouro       TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS numero           TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS complemento      TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bairro           TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS municipio        TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS uf               CHAR(2);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cep              TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo_municipio TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email            TEXT;
