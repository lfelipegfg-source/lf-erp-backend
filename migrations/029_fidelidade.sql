-- Migration 029 — Programa de Fidelidade (pontos por compra)

-- Saldo de pontos diretamente no cliente (cache do total em movimentos)
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pontos_fidelidade INTEGER NOT NULL DEFAULT 0;

-- Regras do programa por empresa
CREATE TABLE IF NOT EXISTS fidelidade_config (
  empresa_id       INTEGER PRIMARY KEY,
  ativo            BOOLEAN  NOT NULL DEFAULT TRUE,
  nome_programa    TEXT     NOT NULL DEFAULT 'Programa de Fidelidade',
  pontos_por_real  NUMERIC(8,2) NOT NULL DEFAULT 1,    -- pontos ganhos por R$ 1,00 gasto
  reais_por_ponto  NUMERIC(8,4) NOT NULL DEFAULT 0.05, -- R$ de desconto por ponto no resgate
  validade_dias    INTEGER NOT NULL DEFAULT 365,        -- 0 = sem validade
  minimo_resgate   INTEGER NOT NULL DEFAULT 100,        -- pontos mínimos para resgatar
  criado_em        TIMESTAMP DEFAULT NOW(),
  atualizado_em    TIMESTAMP DEFAULT NOW()
);

-- Histórico de movimentos de pontos
CREATE TABLE IF NOT EXISTS fidelidade_movimentos (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL,
  cliente_id      INTEGER NOT NULL,
  tipo            TEXT NOT NULL,       -- 'credito' | 'debito' | 'expiracao' | 'ajuste'
  pontos          INTEGER NOT NULL,    -- positivo = crédito, negativo = débito
  saldo_apos      INTEGER NOT NULL DEFAULT 0,
  descricao       TEXT,
  referencia_tipo TEXT,                -- 'venda' | 'resgate' | 'ajuste' | 'expiracao'
  referencia_id   INTEGER,
  expira_em       DATE,                -- NULL = não expira
  criado_em       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fid_mov_empresa  ON fidelidade_movimentos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_fid_mov_cliente  ON fidelidade_movimentos(empresa_id, cliente_id);
CREATE INDEX IF NOT EXISTS idx_fid_mov_tipo     ON fidelidade_movimentos(tipo);
CREATE INDEX IF NOT EXISTS idx_fid_mov_expira   ON fidelidade_movimentos(expira_em) WHERE expira_em IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_pontos  ON clientes(empresa_id, pontos_fidelidade DESC) WHERE pontos_fidelidade > 0;
