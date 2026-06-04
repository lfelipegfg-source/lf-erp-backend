-- Migration 022 — NFS-e (Nota Fiscal de Serviço Eletrônica)
-- Armazena emissões de NFS-e e configuração por empresa.

CREATE TABLE IF NOT EXISTS nfse_config (
  id                  SERIAL PRIMARY KEY,
  empresa_id          INTEGER NOT NULL UNIQUE,
  token_focus         TEXT,                    -- Token da empresa no FocusNFe
  ambiente            INTEGER DEFAULT 2,       -- 1=produção 2=homologação
  codigo_municipio    TEXT,                    -- Código IBGE do município
  item_lista_servico  TEXT,                    -- Código do serviço (LC 116/2003)
  aliquota_iss        NUMERIC(5,2) DEFAULT 5,  -- % ISS padrão
  incentivo_fiscal    BOOLEAN DEFAULT FALSE,
  rps_serie           TEXT DEFAULT '1',
  rps_ultimo_numero   INTEGER DEFAULT 0,
  atualizado_em       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nfse_emissoes (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL,
  venda_id         INTEGER,
  ref              TEXT NOT NULL UNIQUE,    -- Referência FocusNFe
  rps_numero       INTEGER,
  numero_nfse      TEXT,                   -- Número retornado pela prefeitura
  status           TEXT DEFAULT 'pendente', -- pendente | autorizada | cancelada | erro
  valor_servico    NUMERIC(12,2),
  tomador_nome     TEXT,
  tomador_cpf_cnpj TEXT,
  discriminacao    TEXT,
  link_pdf         TEXT,
  link_xml         TEXT,
  codigo_verificacao TEXT,
  mensagem_erro    TEXT,
  criado_em        TIMESTAMP DEFAULT NOW(),
  atualizado_em    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nfse_empresa   ON nfse_emissoes(empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_nfse_venda     ON nfse_emissoes(venda_id) WHERE venda_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfse_ref       ON nfse_emissoes(ref);
