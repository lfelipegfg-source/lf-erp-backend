-- Migration 025 — CRM básico (pipeline de oportunidades)

CREATE TABLE IF NOT EXISTS crm_oportunidades (
  id                   SERIAL PRIMARY KEY,
  empresa_id           INTEGER NOT NULL,
  titulo               TEXT NOT NULL,
  cliente_id           INTEGER,                        -- ref clientes (opcional)
  cliente_nome         TEXT,                           -- nome livre se não vinculado
  valor_estimado       NUMERIC(14,2) DEFAULT 0,
  estagio              TEXT NOT NULL DEFAULT 'lead',
  -- Estágios: lead | qualificado | proposta | negociacao | ganho | perdido
  probabilidade        INTEGER DEFAULT 50,             -- % de chance 0-100
  responsavel_id       INTEGER,                        -- ref usuarios
  responsavel_nome     TEXT,
  data_prev_fechamento DATE,
  origem               TEXT,                           -- indicação, site, Instagram, etc.
  observacoes          TEXT,
  criado_por           INTEGER,
  criado_em            TIMESTAMP DEFAULT NOW(),
  atualizado_em        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crm_atividades (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL,
  oportunidade_id  INTEGER NOT NULL REFERENCES crm_oportunidades(id) ON DELETE CASCADE,
  tipo             TEXT NOT NULL DEFAULT 'nota',  -- ligacao | email | reuniao | nota
  descricao        TEXT NOT NULL,
  data             DATE NOT NULL DEFAULT CURRENT_DATE,
  criado_por       INTEGER,
  criado_em        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_op_empresa  ON crm_oportunidades(empresa_id);
CREATE INDEX IF NOT EXISTS idx_crm_op_estagio  ON crm_oportunidades(empresa_id, estagio);
CREATE INDEX IF NOT EXISTS idx_crm_op_cliente  ON crm_oportunidades(cliente_id);
CREATE INDEX IF NOT EXISTS idx_crm_at_op       ON crm_atividades(oportunidade_id);
