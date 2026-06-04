-- Migration 028 — WhatsApp Business API (Evolution API / Z-API)
-- Estende alertas_config com credenciais de API e adiciona
-- tabelas de templates por evento e log de envios.

ALTER TABLE alertas_config
  ADD COLUMN IF NOT EXISTS wpp_provider     TEXT DEFAULT 'link',
  -- 'link' (wa.me) | 'evolution' (Evolution API) | 'zapi' (Z-API)
  ADD COLUMN IF NOT EXISTS wpp_api_url      TEXT,   -- URL base da instância (Evolution) ou Z-API
  ADD COLUMN IF NOT EXISTS wpp_instance     TEXT,   -- nome da instância (Evolution) ou instance_id (Z-API)
  ADD COLUMN IF NOT EXISTS wpp_token        TEXT,   -- API key / token
  ADD COLUMN IF NOT EXISTS wpp_numero       TEXT,   -- número do WhatsApp Business (com DDI, sem +)
  ADD COLUMN IF NOT EXISTS wpp_ativo        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS wpp_cooldown_h   INTEGER DEFAULT 24; -- horas mínimas entre mensagens para o mesmo cliente/evento

-- Templates de mensagem por evento
CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL,
  evento      TEXT NOT NULL,
  -- eventos: cobranca.atrasada | cobranca.vencendo | venda.confirmada
  --          pedido.criado | nfe.emitida | boleto.gerado | manual
  ativo       BOOLEAN DEFAULT TRUE,
  mensagem    TEXT NOT NULL,  -- suporta {{nome}}, {{valor}}, {{dias}}, {{vencimento}}, {{empresa}}, {{link}}
  criado_em   TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW(),
  UNIQUE (empresa_id, evento)
);

-- Log de envios via API WhatsApp (separado do alertas_historico para não misturar)
CREATE TABLE IF NOT EXISTS whatsapp_envios (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL,
  evento       TEXT NOT NULL,
  cliente_id   INTEGER,
  cliente_nome TEXT,
  telefone     TEXT NOT NULL,
  mensagem     TEXT,
  status       TEXT NOT NULL DEFAULT 'enviado',  -- 'enviado' | 'erro' | 'link'
  erro_msg     TEXT,
  referencia_id   INTEGER,    -- id da venda/conta/pedido que originou o envio
  referencia_tipo TEXT,
  criado_em    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wpp_envios_empresa ON whatsapp_envios(empresa_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_wpp_envios_cliente ON whatsapp_envios(empresa_id, cliente_id, evento, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_wpp_tpl_empresa    ON whatsapp_templates(empresa_id);
