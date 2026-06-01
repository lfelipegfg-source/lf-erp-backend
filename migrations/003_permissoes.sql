-- Migration 003 — Permissões granulares
-- Cria o sistema de controle de acesso por módulo e ação.
-- Retrocompatível: o campo tipo (admin/gerente/funcionario) continua
-- funcionando como fallback via permissoes_padrao.

-- Permissões padrão por tipo de usuário (seed de defaults)
CREATE TABLE IF NOT EXISTS permissoes_padrao (
  id              SERIAL PRIMARY KEY,
  tipo_usuario    VARCHAR(20) NOT NULL,
  modulo          VARCHAR(50) NOT NULL,
  pode_ver        BOOLEAN DEFAULT false,
  pode_criar      BOOLEAN DEFAULT false,
  pode_editar     BOOLEAN DEFAULT false,
  pode_deletar    BOOLEAN DEFAULT false,
  UNIQUE(tipo_usuario, modulo)
);

-- Permissões individuais por usuário (sobrescreve o padrão do tipo)
CREATE TABLE IF NOT EXISTS permissoes_usuario (
  id          SERIAL PRIMARY KEY,
  usuario_id  INTEGER NOT NULL,
  empresa_id  INTEGER,
  modulo      VARCHAR(50) NOT NULL,
  pode_ver    BOOLEAN DEFAULT false,
  pode_criar  BOOLEAN DEFAULT false,
  pode_editar BOOLEAN DEFAULT false,
  pode_deletar BOOLEAN DEFAULT false,
  criado_em   TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW(),
  UNIQUE(usuario_id, empresa_id, modulo)
);

CREATE INDEX IF NOT EXISTS idx_perm_usuario ON permissoes_usuario(usuario_id, empresa_id);

-- Seed: GERENTE — acesso total exceto usuarios e configuracoes globais
INSERT INTO permissoes_padrao (tipo_usuario, modulo, pode_ver, pode_criar, pode_editar, pode_deletar) VALUES
  ('gerente', 'produtos',        true, true, true, true),
  ('gerente', 'clientes',        true, true, true, true),
  ('gerente', 'fornecedores',    true, true, true, true),
  ('gerente', 'compras',         true, true, true, true),
  ('gerente', 'vendas',          true, true, true, true),
  ('gerente', 'estoque',         true, true, true, true),
  ('gerente', 'financeiro',      true, true, true, false),
  ('gerente', 'relatorios',      true, false, false, false),
  ('gerente', 'usuarios',        true, false, false, false),
  ('gerente', 'configuracoes',   false, false, false, false)
ON CONFLICT (tipo_usuario, modulo) DO NOTHING;

-- Seed: FUNCIONARIO — operação do dia a dia, sem acesso a financeiro e exclusões
INSERT INTO permissoes_padrao (tipo_usuario, modulo, pode_ver, pode_criar, pode_editar, pode_deletar) VALUES
  ('funcionario', 'produtos',     true, false, false, false),
  ('funcionario', 'clientes',     true, true,  true,  false),
  ('funcionario', 'fornecedores', true, false, false, false),
  ('funcionario', 'compras',      false, false, false, false),
  ('funcionario', 'vendas',       true, true,  false, false),
  ('funcionario', 'estoque',      true, false, false, false),
  ('funcionario', 'financeiro',   false, false, false, false),
  ('funcionario', 'relatorios',   false, false, false, false),
  ('funcionario', 'usuarios',     false, false, false, false),
  ('funcionario', 'configuracoes',false, false, false, false)
ON CONFLICT (tipo_usuario, modulo) DO NOTHING;
