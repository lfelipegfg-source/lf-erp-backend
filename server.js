require('dotenv').config();

// Sentry — monitoramento de erros em produção (C5.3)
const Sentry = require('@sentry/node');
const _sentryDsn = process.env.SENTRY_DSN;
if (_sentryDsn) {
  Sentry.init({
    dsn: _sentryDsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.05,
  });
}

const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcrypt');
const { Pool } = require('pg');
const { runMigrations } = require('./migrations/runner');
const { requirePermissao } = require('./utils/permissoes');
const {
  hoje,
  normalizarDecimal,
  normalizarInt,
  addDias,
  normalizarDataISO,
  validarItensVenda
} = require('./utils/normalizadores');

const { loginRateLimiter, writeRateLimiter } = require('./middleware/rateLimiter');
const {
  SECRET,
  JWT_EXPIRY_MS,
  tokenBlacklist,
  _tokenHash,
  _sseNonces,
  loadBlacklistFromDb,
  auth,
  apenasAdmin,
  createAuthHelpers,
  validarForcaSenha
} = require('./middleware/auth');
const { createEmpresaUtils }          = require('./utils/empresa');
const { createPlanoUtils, _planoCache } = require('./utils/plano');
const { createFinanceiroOps, _configCache } = require('./utils/financeiroOps');


const financeiroRoutes = require('./routes/financeiro.routes');
const relatoriosRoutes = require('./routes/relatorios.routes');
const comprasRoutes = require('./routes/compras.routes');
const vendasRoutes = require('./routes/vendas.routes');
const produtosRoutes = require('./routes/produtos.routes');
const estoqueRoutes = require('./routes/estoque.routes');
const clientesRoutes = require('./routes/clientes.routes');
const fornecedoresRoutes = require('./routes/fornecedores.routes');
const gradesRoutes = require('./routes/grades.routes');
const nfeRoutes  = require('./routes/nfe.routes');
const nfceRoutes = require('./routes/nfce.routes');
const nfseRoutes = require('./routes/nfse.routes');
const tabelasPrecoRoutes = require('./routes/tabelasPreco.routes');
const kitsRoutes = require('./routes/kits.routes');
const imagensRoutes = require('./routes/imagens.routes');
const orcamentosRoutes = require('./routes/orcamentos.routes');
const pedidosRoutes = require('./routes/pedidos.routes');
const comissoesRoutes = require('./routes/comissoes.routes');
const portalRoutes    = require('./routes/portal.routes');
const caixaRoutes     = require('./routes/caixa.routes');
const devolucoesRoutes = require('./routes/devolucoes.routes');
const alertasRoutes      = require('./routes/alertas.routes');
const marketplaceRoutes  = require('./routes/marketplace.routes');
const crmRoutes          = require('./routes/crm.routes');
const exportacaoRoutes   = require('./routes/exportacao.routes');
const apiPublicaRoutes   = require('./routes/api-publica.routes');
const webhooksRoutes         = require('./routes/webhooks.routes');
const rastreabilidadeRoutes  = require('./routes/rastreabilidade.routes');
const whatsappRoutes         = require('./routes/whatsapp.routes');
const fidelidadeRoutes       = require('./routes/fidelidade.routes');
const checkoutRoutes         = require('./routes/checkout.routes');
const filiaisRoutes          = require('./routes/filiais.routes');
const biRoutes               = require('./routes/bi.routes');
const authRoutes             = require('./routes/auth.routes');
const usuariosRoutes         = require('./routes/usuarios.routes');
const contasReceberRoutes    = require('./routes/contas-receber.routes');
const contasPagarRoutes      = require('./routes/contas-pagar.routes');
const lancamentosRoutes      = require('./routes/lancamentos.routes');
const fluxoCaixaRoutes       = require('./routes/fluxo-caixa.routes');
const dashboardRoutes        = require('./routes/dashboard.routes');
const pagamentosRoutes        = require('./routes/pagamentos.routes');
const conciliacaoRoutes        = require('./routes/conciliacao.routes');
const adminRoutes              = require('./routes/admin.routes');
const miscRoutes               = require('./routes/misc.routes');
const adminSaasRoutes          = require('./routes/admin-saas.routes');

const app = express();
app.set('trust proxy', 1); // S-0: Render usa proxy reverso â€” necessÃ¡rio para req.ip correto no rate limiter

// S-1: CORS â€” default seguro; sem ALLOWED_ORIGINS usa o domÃ­nio Vercel conhecido
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['https://lf-erp-frontend.vercel.app'];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));
const jsonUpload = express.json({ limit: '50mb' }); // usado sÃ³ em rotas de importaÃ§Ã£o

app.disable('x-powered-by');

// S-2: Headers de seguranÃ§a HTTP + redirect HTTPS em produÃ§Ã£o
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.header('x-forwarded-proto') === 'http') {
      return res.redirect(301, `https://${req.header('host')}${req.url}`);
    }
  }
  next();
});

app.use((req, res, next) => {
  const inicio = Date.now();

  res.on('finish', () => {
    const duracao = Date.now() - inicio;

    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duracao}ms`
    );
  });

  next();
});

// Helper global de resposta de erro JSON — substitui res.status(x).send('texto')
function jsonErro(res, status, mensagem, codigo = null) {
  const body = { sucesso: false, erro: mensagem };
  if (codigo) body.codigo = codigo;
  return res.status(status).json(body);
}
const PORT = process.env.PORT || 3001;

if (!SECRET) {
  console.error('JWT_SECRET nÃ£o definida.');
  process.exit(1);
}
if (SECRET.length < 32) {
  console.error('JWT_SECRET muito curta (mÃ­nimo 32 caracteres). Configure uma chave segura em produÃ§Ã£o.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL nÃ£o definida.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: true } : false,
  max: 10,
  min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000, // FIX 4: mata queries lentas antes de exaurir o pool
  query_timeout: 35_000      // FIX 4: timeout do driver (superior ao statement_timeout)
});

// Neon derruba conexões idle — sem este handler o processo encerra com uncaughtException
pool.on('error', (err) => {
  console.error('[pool] erro em conexão idle (Neon dropped connection):', err.message);
});

const { validarSenhaUsuario } = createAuthHelpers(pool);

const {
  obterEmpresaPorId, obterEmpresaPorNome, resolverEmpresaRequest,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  podeGerenciarUsuarios, podeGerenciarFinanceiro, podeGerenciarCompras, podeGerenciarVendas
} = createEmpresaUtils(pool);

const { obterPlanoEmpresa, validarLimitePlano, validarLimiteVendasMes } =
  createPlanoUtils(pool, { hoje });

const {
  obterConfigEmpresa,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasReceberGlobal,
  atualizarStatusContasPagarPorEmpresa,
  atualizarStatusContasPagarGlobal,
  agendarAtualizacaoNoturna,
  criarParcelasContasReceber,
  registrarMovimentacaoEstoque,
  registrarAuditoria,
  registrarLogFinanceiro
} = createFinanceiroOps(pool, { hoje, normalizarDecimal, normalizarInt, addDias });

// Disponibiliza pool para middlewares via app.locals
app.locals.pool = pool;

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', sistema: 'LF ERP', database: 'online' });
  } catch (error) {
    console.error('Erro no health check:', error);
    res.status(500).json({ status: 'erro', sistema: 'LF ERP', database: 'offline' });
  }
});

app.use(
  '/financeiro',
  financeiroRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    atualizarStatusContasReceberPorEmpresa,
    atualizarStatusContasPagarPorEmpresa
  })
);

app.use(
  '/relatorios',
  relatoriosRoutes({
    auth,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    atualizarStatusContasReceberPorEmpresa,
    atualizarStatusContasPagarPorEmpresa,
    podeGerenciarFinanceiro
  })
);

app.use(
  '/compras',
  comprasRoutes({
    auth,
    pool,
    writeRateLimiter,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    podeGerenciarCompras,
    registrarAuditoria,
    registrarMovimentacaoEstoque,
    atualizarStatusContasPagarPorEmpresa
  })
);

app.use(
  '/vendas',
  vendasRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    podeGerenciarVendas,
    validarLimiteVendasMes,
    normalizarDecimal,
    normalizarInt,
    normalizarDataISO,
    hoje,
    registrarMovimentacaoEstoque,
    criarParcelasContasReceber,
    atualizarStatusContasReceberPorEmpresa,
    obterPeriodo,
    adicionarFiltroEmpresaSaaS,
    adicionarFiltroPeriodo,
    registrarAuditoria,
    validarItensVenda
  })
);

app.use(
  '/produtos',
  produtosRoutes({
    auth,
    writeRateLimiter,
    apenasAdmin,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    validarLimitePlano,
    normalizarDecimal,
    registrarAuditoria,
    normalizarInt,
    registrarMovimentacaoEstoque,
    obterPeriodo,
    adicionarFiltroPeriodo
  })
);

app.use(
  '/estoque',
  estoqueRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    normalizarInt,
    obterPeriodo,
    adicionarFiltroPeriodo,
    registrarMovimentacaoEstoque
  })
);

app.use(
  '/clientes',
  clientesRoutes({
    auth,
    writeRateLimiter,
    apenasAdmin,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    registrarAuditoria,
    validarLimitePlano,
    obterPeriodo,
    adicionarFiltroPeriodo
  })
);

app.use(
  '/fornecedores',
  fornecedoresRoutes({
    auth,
    writeRateLimiter,
    apenasAdmin,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    registrarAuditoria,
    validarLimitePlano,
    obterPeriodo,
    adicionarFiltroPeriodo
  })
);

app.use(
  '/grades',
  gradesRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt,
    registrarMovimentacaoEstoque,
    requirePermissao
  })
);

app.use('/portal', portalRoutes({ auth, writeRateLimiter, pool }));
app.use('/caixa',      caixaRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal }));
app.use('/alertas',    alertasRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa }));
app.use('/marketplace', marketplaceRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje, registrarMovimentacaoEstoque, criarParcelasContasReceber }));
app.use('/crm', crmRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje }));
app.use('/exportacao', exportacaoRoutes({ auth, pool, validarAcessoEmpresa, adicionarFiltroPeriodo, obterPeriodo, normalizarDecimal, hoje }));
app.use('/api/v1',    apiPublicaRoutes({ pool, writeRateLimiter, normalizarDecimal, normalizarInt, hoje, registrarMovimentacaoEstoque }));
app.use('/webhooks',         webhooksRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa }));
app.use('/rastreabilidade', rastreabilidadeRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarInt, normalizarDataISO, hoje, requirePermissao }));
app.use('/whatsapp',       whatsappRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, hoje, requirePermissao }));
app.use('/fidelidade',    fidelidadeRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, hoje, requirePermissao }));
app.use('/checkout',     checkoutRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, hoje }));
app.use('/filiais',     filiaisRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, obterPeriodo, adicionarFiltroPeriodo, hoje }));
app.use('/bi',         biRoutes({ auth, pool, validarAcessoEmpresa, hoje, requirePermissao }));
app.use('/devolucoes', devolucoesRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, registrarMovimentacaoEstoque }));

app.use('/nfce', nfceRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, requirePermissao }));
app.use('/nfse', nfseRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, requirePermissao }));

app.use(
  '/nfe',
  nfeRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    requirePermissao
  })
);

app.use(
  '/imagens',
  imagensRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarInt
  })
);

app.use(
  '/kits',
  kitsRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt
  })
);

app.use(
  '/orcamentos',
  orcamentosRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt,
    normalizarDataISO,
    obterPeriodo,
    adicionarFiltroPeriodo,
    requirePermissao
  })
);

app.use(
  '/pedidos',
  pedidosRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt,
    normalizarDataISO,
    obterPeriodo,
    registrarMovimentacaoEstoque,
    criarParcelasContasReceber,
    atualizarStatusContasReceberPorEmpresa,
    atualizarStatusContasPagarPorEmpresa,
    registrarAuditoria,
    requirePermissao
  })
);

app.use(
  '/comissoes',
  comissoesRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarDataISO,
    obterPeriodo
  })
);

app.use(
  '/tabelas-preco',
  tabelasPrecoRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal,
    normalizarInt
  })
);


function obterPeriodo(req) {
  return {
    dataInicial: normalizarDataISO(req.query.data_inicial || req.query.inicio || ''),
    dataFinal: normalizarDataISO(req.query.data_final || req.query.fim || '')
  };
}

const CAMPOS_PERIODO_PERMITIDOS = new Set([
  // simples
  'data', 'data_pagamento', 'data_vencimento', 'data_emissao', 'data_entrada', 'data_saida',
  'criado_em', 'atualizado_em', 'pagamento_data', 'vencimento', 'competencia',
  'data_movimento', 'lancamento_data',
  // aliases de tabela
  'c.data', 'v.data', 'p.data', 'e.data', 'f.data', 'lf.data',
  'cr.data_vencimento', 'cp.data_vencimento', 'fl.criado_em',
  'm.data_movimentacao',
  // expressÃµes compostas (hardcoded no cÃ³digo)
  'COALESCE(pagamento_data, vencimento)',
  'COALESCE(pagamento_data,vencimento)'
]);

function adicionarFiltroPeriodo({ campo, params, dataInicial, dataFinal, castDate = true }) {
  if (!CAMPOS_PERIODO_PERMITIDOS.has(campo)) {
    console.error(`[adicionarFiltroPeriodo] campo nÃ£o permitido: ${campo}`);
    return '';
  }
  let sql = '';
  const campoSql = castDate ? `DATE(${campo})` : campo;

  if (dataInicial) {
    params.push(dataInicial);
    sql += ` AND ${campoSql} >= $${params.length}`;
  }

  if (dataFinal) {
    params.push(dataFinal);
    sql += ` AND ${campoSql} <= $${params.length}`;
  }

  return sql;
}

const CAMPOS_PERIODO_RANGE_PERMITIDOS = new Set([
  'data', 'data_inicio', 'data_fim', 'data_vencimento', 'data_pagamento',
  'data_emissao', 'data_competencia', 'data_entrada', 'data_saida',
  'criado_em', 'atualizado_em', 'vencimento', 'pagamento_data',
  'data_movimentacao', 'lancamento_data'
]);

function adicionarFiltroPeriodoRange({
  campoInicial,
  campoFinal,
  params,
  dataInicial,
  dataFinal,
  castDate = true
}) {
  if (!CAMPOS_PERIODO_RANGE_PERMITIDOS.has(campoInicial) || !CAMPOS_PERIODO_RANGE_PERMITIDOS.has(campoFinal)) {
    throw new Error(`Campo nÃ£o permitido em adicionarFiltroPeriodoRange: ${campoInicial} / ${campoFinal}`);
  }
  let sql = '';
  const inicioSql = castDate ? `DATE(${campoInicial})` : campoInicial;
  const fimSql = castDate ? `DATE(${campoFinal})` : campoFinal;

  if (dataInicial) {
    params.push(dataInicial);
    sql += ` AND COALESCE(${fimSql}, ${inicioSql}) >= $${params.length}`;
  }

  if (dataFinal) {
    params.push(dataFinal);
    sql += ` AND COALESCE(${fimSql}, ${inicioSql}) <= $${params.length}`;
  }

  return sql;
}







async function initDb() {
  // Fast-path: banco jÃ¡ inicializado â†’ pula as ~168 queries DDL (cold start 8â€“15s â†’ <1s)
  // Novas colunas/tabelas devem ir em backend/migrations/, nÃ£o aqui
  const { rows: _chk } = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='empresas' LIMIT 1"
  );
  if (_chk.length > 0) return;

  // ================= EMPRESAS / PLANOS / CONFIGURAÃ‡Ã•ES =================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      cnpj TEXT,
      telefone TEXT,
      email TEXT,
      plano TEXT DEFAULT 'free',
      status TEXT DEFAULT 'ativo',
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plano_id INTEGER;
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS slug TEXT;
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS responsavel_nome TEXT;
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS responsavel_email TEXT;
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS assinatura_status TEXT DEFAULT 'trial';
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS trial_inicio TEXT;
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS trial_fim TEXT;
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS bloqueada BOOLEAN DEFAULT FALSE;
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS motivo_bloqueio TEXT;
    ALTER TABLE empresas ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP DEFAULT NOW();
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS planos (
      id SERIAL PRIMARY KEY,
      codigo TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      preco_mensal NUMERIC(12,2) NOT NULL DEFAULT 0,
      limite_usuarios INTEGER NOT NULL DEFAULT 1,
      limite_produtos INTEGER NOT NULL DEFAULT 100,
      limite_clientes INTEGER NOT NULL DEFAULT 300,
      limite_fornecedores INTEGER NOT NULL DEFAULT 100,
      limite_vendas_mes INTEGER NOT NULL DEFAULT 300,
      limite_empresas INTEGER NOT NULL DEFAULT 1,
      permite_multiusuarios BOOLEAN NOT NULL DEFAULT TRUE,
      permite_relatorios_avancados BOOLEAN NOT NULL DEFAULT FALSE,
      permite_suporte_prioritario BOOLEAN NOT NULL DEFAULT FALSE,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO planos
    (
      codigo,
      nome,
      descricao,
      preco_mensal,
      limite_usuarios,
      limite_produtos,
      limite_clientes,
      limite_fornecedores,
      limite_vendas_mes,
      limite_empresas,
      permite_multiusuarios,
      permite_relatorios_avancados,
      permite_suporte_prioritario
    )
    VALUES
    ('starter', 'Starter', 'Plano inicial para pequenos negÃ³cios', 49.90, 2, 300, 500, 100, 500, 1, TRUE, FALSE, FALSE),
    ('pro', 'Pro', 'Plano profissional para empresas em crescimento', 99.90, 5, 2000, 3000, 500, 3000, 1, TRUE, TRUE, FALSE),
    ('premium', 'Premium', 'Plano completo para operaÃ§Ã£o avanÃ§ada', 199.90, 15, 10000, 20000, 2000, 15000, 3, TRUE, TRUE, TRUE)
    ON CONFLICT (codigo) DO NOTHING;
  `);

  // ================= TABELAS PRINCIPAIS =================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      usuario TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      tipo TEXT NOT NULL,
      empresa TEXT,
      nome_completo TEXT,
      cpf TEXT,
      nascimento TEXT,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS produtos (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      nome TEXT NOT NULL,
      preco NUMERIC(12,2) NOT NULL DEFAULT 0,
      custo NUMERIC(12,2) NOT NULL DEFAULT 0,
      estoque INTEGER NOT NULL DEFAULT 0,
      estoque_minimo INTEGER NOT NULL DEFAULT 0,
      codigo_barras TEXT,
      categoria TEXT,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      nome TEXT NOT NULL,
      endereco TEXT,
      telefone TEXT,
      nascimento TEXT,
      cpf TEXT,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fornecedores (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      nome TEXT NOT NULL,
      contato TEXT,
      telefone TEXT,
      email TEXT,
      endereco TEXT,
      observacao TEXT,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compras (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      fornecedor_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      observacao TEXT,
      gerar_conta_pagar BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'finalizada',
      criado_por INTEGER,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compra_itens (
      id SERIAL PRIMARY KEY,
      compra_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      produto_nome TEXT NOT NULL,
      quantidade INTEGER NOT NULL DEFAULT 0,
      custo_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendas (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      cliente_id INTEGER,
      cliente_nome TEXT,
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
      desconto NUMERIC(12,2) NOT NULL DEFAULT 0,
      acrescimo NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      pagamento TEXT,
      parcelas INTEGER NOT NULL DEFAULT 1,
      status_pagamento TEXT NOT NULL DEFAULT 'pago',
      data TEXT,
      observacao TEXT,
      criado_por INTEGER,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS venda_itens (
      id SERIAL PRIMARY KEY,
      venda_id INTEGER NOT NULL,
      empresa TEXT NOT NULL,
      produto_id INTEGER NOT NULL,
      produto_nome TEXT NOT NULL,
      quantidade INTEGER NOT NULL DEFAULT 0,
      preco_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
      custo_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      produto_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      quantidade INTEGER NOT NULL DEFAULT 0,
      observacao TEXT,
      referencia_tipo TEXT,
      referencia_id INTEGER,
      usuario_id INTEGER,
      data_movimentacao TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lancamentos_financeiros (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      tipo TEXT NOT NULL,
      categoria TEXT NOT NULL,
      descricao TEXT NOT NULL,
      valor NUMERIC(12,2) NOT NULL DEFAULT 0,
      vencimento TEXT,
      pagamento_data TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      forma_pagamento TEXT,
      recorrente BOOLEAN NOT NULL DEFAULT FALSE,
      frequencia TEXT,
      observacao TEXT,
      criado_por INTEGER,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS investimentos (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      tipo_investimento TEXT NOT NULL,
      descricao TEXT NOT NULL,
      valor NUMERIC(12,2) NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      forma_pagamento TEXT,
      observacao TEXT,
      criado_por INTEGER,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contas_receber (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      venda_id INTEGER,
      cliente_id INTEGER,
      cliente_nome TEXT,
      parcela INTEGER NOT NULL DEFAULT 1,
      total_parcelas INTEGER NOT NULL DEFAULT 1,
      valor NUMERIC(12,2) NOT NULL DEFAULT 0,
      data_vencimento TEXT,
      data_pagamento TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      forma_pagamento TEXT,
      observacao TEXT,
      criado_por INTEGER,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contas_pagar (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      fornecedor_id INTEGER,
      fornecedor_nome TEXT,
      compra_id INTEGER,
      descricao TEXT NOT NULL,
      parcela INTEGER NOT NULL DEFAULT 1,
      total_parcelas INTEGER NOT NULL DEFAULT 1,
      valor NUMERIC(12,2) NOT NULL DEFAULT 0,
      data_vencimento TEXT,
      data_pagamento TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      forma_pagamento TEXT,
      observacao TEXT,
      criado_por INTEGER,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL UNIQUE,
      empresa_id INTEGER,
      nome_empresa TEXT,
      cnpj TEXT,
      telefone TEXT,
      email TEXT,
      endereco TEXT,
      logo_url TEXT,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS logs_auditoria (
      id SERIAL PRIMARY KEY,
      empresa TEXT,
      empresa_id INTEGER,
      usuario_id INTEGER,
      usuario_nome TEXT,
      modulo TEXT NOT NULL,
      acao TEXT NOT NULL,
      referencia_id INTEGER,
      dados_anteriores JSONB,
      dados_novos JSONB,
      ip TEXT,
      user_agent TEXT,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS financeiro_logs (
      id SERIAL PRIMARY KEY,
      empresa TEXT,
      empresa_id INTEGER,
      tipo TEXT NOT NULL,
      entidade TEXT,
      entidade_id INTEGER,
      descricao TEXT,
      valor NUMERIC(12,2),
      usuario_id INTEGER,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conciliacoes (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      empresa_id INTEGER,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      conta TEXT,
      data_inicio DATE,
      data_fim DATE,
      total_itens INTEGER DEFAULT 0,
      itens_conciliados INTEGER DEFAULT 0,
      itens_ignorados INTEGER DEFAULT 0,
      status TEXT DEFAULT 'em_andamento',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nfce_emissoes (
      id SERIAL PRIMARY KEY,
      empresa_id INTEGER,
      venda_id INTEGER,
      ref TEXT UNIQUE NOT NULL,
      ambiente INTEGER DEFAULT 2,
      status TEXT DEFAULT 'processando',
      chave_nfe TEXT,
      numero INTEGER,
      serie TEXT,
      mensagem TEXT,
      cancelado_em TIMESTAMPTZ,
      motivo_cancelamento TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cobrancas_pix (
      id SERIAL PRIMARY KEY,
      empresa TEXT,
      empresa_id INTEGER,
      conta_receber_id INTEGER,
      txid TEXT UNIQUE,
      valor NUMERIC(12,2),
      cliente_nome TEXT,
      status TEXT DEFAULT 'ATIVA',
      pix_copia_e_cola TEXT,
      qr_image TEXT,
      expiracao TIMESTAMPTZ,
      pago_em TIMESTAMPTZ,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conciliacao_itens (
      id SERIAL PRIMARY KEY,
      conciliacao_id INTEGER NOT NULL,
      empresa TEXT,
      empresa_id INTEGER,
      fitid TEXT,
      data DATE,
      descricao TEXT,
      valor NUMERIC(12,2),
      tipo TEXT,
      status TEXT DEFAULT 'pendente',
      lancamento_id INTEGER,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ================= ALTERAÃ‡Ã•ES / COLUNAS =================
  await pool.query(`
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS pagamento TEXT;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE investimentos ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
  `);

  await pool.query(`
    ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS cnpj TEXT;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque_minimo INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS codigo_barras TEXT;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria TEXT;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();

    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS cliente_id INTEGER;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS total_itens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS desconto NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS acrescimo NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS parcelas INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS status_pagamento TEXT NOT NULL DEFAULT 'pago';
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS observacao TEXT;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();

    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nome_completo TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cpf TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nascimento TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS is_saas_owner BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();

    ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();

    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS nome_empresa TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS cnpj TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS telefone TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS endereco TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS logo_url TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS cor_primaria TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS taxa_multa NUMERIC(8,4) NOT NULL DEFAULT 0.02;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS taxa_juros_dia NUMERIC(8,6) NOT NULL DEFAULT 0.00033;
  `);

  await pool.query(`
    ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS conta_receber_id INTEGER;
    ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS conta_pagar_id INTEGER;
  `);

  await pool.query(`
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS valor_original    NUMERIC(12,2);
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS valor_atualizado  NUMERIC(12,2);
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS dias_atraso       INTEGER DEFAULT 0;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS multa             NUMERIC(12,2) DEFAULT 0;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS juros             NUMERIC(12,2) DEFAULT 0;
    ALTER TABLE contas_pagar   ADD COLUMN IF NOT EXISTS valor_original    NUMERIC(12,2);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nfe_config (
      id         SERIAL PRIMARY KEY,
      empresa_id INTEGER UNIQUE,
      token_focusnfe TEXT,
      ambiente   INTEGER DEFAULT 2,
      serie      TEXT DEFAULT '1',
      codigo_csc TEXT,
      id_token_csc TEXT,
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE nfe_config ADD COLUMN IF NOT EXISTS codigo_csc   TEXT;
    ALTER TABLE nfe_config ADD COLUMN IF NOT EXISTS id_token_csc TEXT;
  `);

  await pool.query(`
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_gateway TEXT DEFAULT 'efi';
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_client_id TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_client_secret TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_certificado TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_chave TEXT;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS pix_sandbox BOOLEAN DEFAULT TRUE;
  `);

  // ================= EMPRESA PADRÃƒO =================
  const empresaSaaSResult = await pool.query(`SELECT id FROM empresas WHERE nome = $1 LIMIT 1`, [
    'LF ERP'
  ]);

  let empresaSaaSId;

  if (empresaSaaSResult.rowCount === 0) {
    const novaEmpresa = await pool.query(
      `INSERT INTO empresas
      (nome, plano, status, plano_id, assinatura_status, trial_inicio, trial_fim, bloqueada, criado_em, atualizado_em)
      VALUES (
        $1,
        'pro',
        'ativo',
        (SELECT id FROM planos WHERE codigo = 'pro' LIMIT 1),
        'trial',
        $2,
        $3,
        FALSE,
        NOW(),
        NOW()
      )
      RETURNING id`,
      ['LF ERP', hoje(), addDias(hoje(), 14)]
    );

    empresaSaaSId = novaEmpresa.rows[0].id;
  } else {
    empresaSaaSId = empresaSaaSResult.rows[0].id;
  }

  await pool.query(
    `
    UPDATE empresas
    SET plano_id = COALESCE(plano_id, (SELECT id FROM planos WHERE codigo = 'pro' LIMIT 1)),
        assinatura_status = 'ativo',
        trial_fim = NULL,
        bloqueada = FALSE,
        atualizado_em = NOW()
    WHERE id = $1
    `,
    [empresaSaaSId]
  );

  await pool.query(
    `
    INSERT INTO configuracoes (empresa, empresa_id, nome_empresa, criado_em, atualizado_em)
    VALUES ($1, $2, $3, NOW(), NOW())
    ON CONFLICT (empresa) DO UPDATE
    SET empresa_id = EXCLUDED.empresa_id,
        nome_empresa = COALESCE(configuracoes.nome_empresa, EXCLUDED.nome_empresa),
        atualizado_em = NOW()
    `,
    ['LF ERP', empresaSaaSId, 'LF ERP']
  );

  // ================= MIGRAÃ‡ÃƒO EMPRESA_ID =================
  await pool.query(`UPDATE usuarios SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
  await pool.query(`UPDATE clientes SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
  await pool.query(`UPDATE fornecedores SET empresa_id = $1 WHERE empresa_id IS NULL`, [
    empresaSaaSId
  ]);
  await pool.query(`UPDATE produtos SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
  await pool.query(`UPDATE compras SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
  await pool.query(`UPDATE vendas SET empresa_id = $1 WHERE empresa_id IS NULL`, [empresaSaaSId]);
  await pool.query(`UPDATE contas_receber SET empresa_id = $1 WHERE empresa_id IS NULL`, [
    empresaSaaSId
  ]);
  await pool.query(`UPDATE contas_pagar SET empresa_id = $1 WHERE empresa_id IS NULL`, [
    empresaSaaSId
  ]);
  await pool.query(`UPDATE configuracoes SET empresa_id = $1 WHERE empresa_id IS NULL`, [
    empresaSaaSId
  ]);

  // ================= ÃNDICES =================
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_empresas_plano_id ON empresas (plano_id);
    CREATE INDEX IF NOT EXISTS idx_empresas_status ON empresas (assinatura_status);
    CREATE INDEX IF NOT EXISTS idx_empresas_slug ON empresas (slug);
    CREATE INDEX IF NOT EXISTS idx_planos_codigo ON planos (codigo);

    CREATE INDEX IF NOT EXISTS idx_produtos_empresa ON produtos (empresa);
    CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes (empresa);
    CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa ON fornecedores (empresa);
    CREATE INDEX IF NOT EXISTS idx_compras_empresa ON compras (empresa);
    CREATE INDEX IF NOT EXISTS idx_compra_itens_compra ON compra_itens (compra_id);
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa ON vendas (empresa);
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa_data ON vendas (empresa, data);
    CREATE INDEX IF NOT EXISTS idx_venda_itens_venda ON venda_itens (venda_id);
    CREATE INDEX IF NOT EXISTS idx_venda_itens_empresa ON venda_itens (empresa);
    CREATE INDEX IF NOT EXISTS idx_mov_estoque_empresa ON movimentacoes_estoque (empresa);
    CREATE INDEX IF NOT EXISTS idx_mov_estoque_produto ON movimentacoes_estoque (produto_id);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa ON lancamentos_financeiros (empresa);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_status ON lancamentos_financeiros (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_id ON lancamentos_financeiros (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_conta_receber_id ON lancamentos_financeiros (conta_receber_id);
    CREATE INDEX IF NOT EXISTS idx_investimentos_empresa ON investimentos (empresa);
    CREATE INDEX IF NOT EXISTS idx_investimentos_empresa_id ON investimentos (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_empresa ON contas_receber (empresa);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_status ON contas_receber (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa ON contas_pagar (empresa);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_status ON contas_pagar (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_configuracoes_empresa ON configuracoes (empresa);
    CREATE INDEX IF NOT EXISTS idx_configuracoes_empresa_id ON configuracoes (empresa_id);

    CREATE INDEX IF NOT EXISTS idx_contas_receber_cliente ON contas_receber (cliente_id);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_vencimento ON contas_receber (empresa, data_vencimento);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_empresa_id ON contas_receber (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_cr_empresa_id_status ON contas_receber (empresa_id, status);
    CREATE INDEX IF NOT EXISTS idx_cr_empresa_id_vencimento ON contas_receber (empresa_id, data_vencimento);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_fornecedor ON contas_pagar (fornecedor_id);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento ON contas_pagar (empresa, data_vencimento);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa_id ON contas_pagar (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_cp_empresa_id_status ON contas_pagar (empresa_id, status);
    CREATE INDEX IF NOT EXISTS idx_cp_empresa_id_vencimento ON contas_pagar (empresa_id, data_vencimento);
    CREATE INDEX IF NOT EXISTS idx_compra_itens_produto ON compra_itens (produto_id);
    CREATE INDEX IF NOT EXISTS idx_venda_itens_produto ON venda_itens (produto_id);
    CREATE INDEX IF NOT EXISTS idx_mov_estoque_data ON movimentacoes_estoque (produto_id, data_movimentacao);
    CREATE INDEX IF NOT EXISTS idx_produtos_empresa_id ON produtos (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id ON vendas (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_vendas_cliente ON vendas (cliente_id);
    CREATE INDEX IF NOT EXISTS idx_compras_empresa_id ON compras (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_venda_itens_empresa_id ON venda_itens (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_compra_itens_empresa_id ON compra_itens (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_logs_auditoria_empresa_id ON logs_auditoria (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_logs_auditoria_criado_em ON logs_auditoria (criado_em DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_auditoria_modulo_acao ON logs_auditoria (modulo, acao);

    -- Ãndices faltantes adicionados em 2026-06-06
    CREATE INDEX IF NOT EXISTS idx_clientes_empresa_id ON clientes (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa_id ON fornecedores (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_produtos_codigo_barras ON produtos (codigo_barras) WHERE codigo_barras IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_clientes_cpf ON clientes (cpf) WHERE cpf IS NOT NULL AND cpf <> '';
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id_data ON vendas (empresa_id, data DESC);
    CREATE INDEX IF NOT EXISTS idx_compras_empresa_id_data ON compras (empresa_id, data DESC);
    CREATE INDEX IF NOT EXISTS idx_produtos_deletado_em ON produtos (empresa_id, deletado_em) WHERE deletado_em IS NULL;
    CREATE INDEX IF NOT EXISTS idx_clientes_deletado_em ON clientes (empresa_id, deletado_em) WHERE deletado_em IS NULL;
    CREATE INDEX IF NOT EXISTS idx_fornecedores_deletado_em ON fornecedores (empresa_id, deletado_em) WHERE deletado_em IS NULL;
    CREATE INDEX IF NOT EXISTS idx_usuarios_usuario_lower ON usuarios (LOWER(usuario));
    CREATE INDEX IF NOT EXISTS idx_usuarios_empresa_id ON usuarios (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_mov_estoque_empresa_id ON movimentacoes_estoque (empresa_id);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_vencimento_id ON contas_receber (empresa_id, data_vencimento);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento_id ON contas_pagar (empresa_id, data_vencimento);
    CREATE INDEX IF NOT EXISTS idx_financeiro_logs_empresa_id ON financeiro_logs (empresa_id, criado_em DESC);
    CREATE INDEX IF NOT EXISTS idx_financeiro_logs_tipo ON financeiro_logs (tipo);
  `);

  // â”€â”€ PermissÃµes granulares â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permissoes_padrao (
      id          SERIAL PRIMARY KEY,
      tipo_usuario TEXT NOT NULL,
      modulo       TEXT NOT NULL,
      pode_ver     BOOLEAN NOT NULL DEFAULT false,
      pode_criar   BOOLEAN NOT NULL DEFAULT false,
      pode_editar  BOOLEAN NOT NULL DEFAULT false,
      pode_deletar BOOLEAN NOT NULL DEFAULT false,
      UNIQUE(tipo_usuario, modulo)
    );

    CREATE TABLE IF NOT EXISTS permissoes_usuario (
      id          SERIAL PRIMARY KEY,
      usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      empresa_id  INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
      modulo      TEXT NOT NULL,
      pode_ver    BOOLEAN,
      pode_criar  BOOLEAN,
      pode_editar BOOLEAN,
      pode_deletar BOOLEAN,
      UNIQUE(usuario_id, empresa_id, modulo)
    );

    CREATE INDEX IF NOT EXISTS idx_perm_usuario_uid ON permissoes_usuario (usuario_id);
    CREATE INDEX IF NOT EXISTS idx_perm_padrao_tipo ON permissoes_padrao (tipo_usuario);
  `);

  // Defaults por tipo â€” INSERT OR IGNORE (ON CONFLICT DO NOTHING)
  const defaultsGerente = [
    ['gerente', 'produtos',      true,  true,  true,  false],
    ['gerente', 'clientes',      true,  true,  true,  false],
    ['gerente', 'fornecedores',  true,  true,  true,  false],
    ['gerente', 'compras',       true,  true,  true,  false],
    ['gerente', 'vendas',        true,  true,  true,  false],
    ['gerente', 'estoque',       true,  false, false, false],
    ['gerente', 'financeiro',    true,  true,  true,  false],
    ['gerente', 'relatorios',    true,  false, false, false],
    ['gerente', 'dre',           false, false, false, false],
    ['gerente', 'lucratividade', true,  false, false, false],
    ['gerente', 'usuarios',      false, false, false, false],
    ['gerente', 'configuracoes', false, false, false, false],
  ];
  const defaultsFuncionario = [
    ['funcionario', 'produtos',      true,  false, false, false],
    ['funcionario', 'clientes',      true,  true,  true,  false],
    ['funcionario', 'fornecedores',  true,  false, false, false],
    ['funcionario', 'compras',       true,  false, false, false],
    ['funcionario', 'vendas',        true,  true,  false, false],
    ['funcionario', 'estoque',       true,  false, false, false],
    ['funcionario', 'financeiro',    false, false, false, false],
    ['funcionario', 'relatorios',    false, false, false, false],
    ['funcionario', 'dre',           false, false, false, false],
    ['funcionario', 'lucratividade', false, false, false, false],
    ['funcionario', 'usuarios',      false, false, false, false],
    ['funcionario', 'configuracoes', false, false, false, false],
  ];
  for (const [tipo, modulo, ver, criar, editar, deletar] of [...defaultsGerente, ...defaultsFuncionario]) {
    await pool.query(
      `INSERT INTO permissoes_padrao (tipo_usuario, modulo, pode_ver, pode_criar, pode_editar, pode_deletar)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tipo_usuario, modulo) DO NOTHING`,
      [tipo, modulo, ver, criar, editar, deletar]
    );
  }

  // ================= USUÃRIO SAAS OWNER =================
  const ownerSenhaEnv = process.env.SAAS_OWNER_SENHA;
  if (!ownerSenhaEnv) {
    console.warn('[init] SAAS_OWNER_SENHA nÃ£o definida â€” senha do owner nÃ£o serÃ¡ alterada');
    return;
  }
  const ownerHash = await bcrypt.hash(ownerSenhaEnv, 10);

  // Migra nome antigo 'Lfelipeg' â†’ 'lfelipeg' se existir
  await pool.query(
    `UPDATE usuarios SET usuario = 'lfelipeg', atualizado_em = NOW()
     WHERE LOWER(usuario) = 'lfelipeg' AND usuario != 'lfelipeg'`
  );

  const existing = await pool.query(`SELECT id FROM usuarios WHERE LOWER(usuario) = 'lfelipeg'`);

  if (existing.rowCount === 0) {
    await pool.query(
      `INSERT INTO usuarios
       (usuario, senha, tipo, empresa, empresa_id, nome_completo, cpf, nascimento, is_saas_owner)
       VALUES ($1, $2, 'admin', 'LF ERP', $3, 'Felipe Gomes', '', '', TRUE)`,
      ['lfelipeg', ownerHash, empresaSaaSId]
    );
  } else {
    await pool.query(
      `UPDATE usuarios
       SET senha = $1, tipo = 'admin', empresa = 'LF ERP',
           empresa_id = $2, is_saas_owner = TRUE, atualizado_em = NOW()
       WHERE LOWER(usuario) = 'lfelipeg'`,
      [ownerHash, empresaSaaSId]
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jwt_blacklist (
      token_hash TEXT PRIMARY KEY,
      revoked_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jwt_blacklist_expires ON jwt_blacklist (expires_at);
  `);

  await pool.query(`
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS compras_idempotency_idx
      ON compras (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);

  try {
    const { rows: _empresasInit } = await pool.query(`SELECT id, nome FROM empresas ORDER BY id`);
    for (const _emp of _empresasInit) {
      await atualizarStatusContasReceberPorEmpresa(_emp.nome, _emp.id).catch(e => console.error('[initDb] status-cr:', e.message));
      await atualizarStatusContasPagarPorEmpresa(_emp.nome, _emp.id).catch(e => console.error('[initDb] status-cp:', e.message));
    }
  } catch (e) { console.error('[initDb] status-global:', e.message); }
}

app.get('/', (req, res) => {
  res.send('LF ERP backend online ðŸš€');
});


// â”€â”€ Auth (login/logout/me/registro) â†’ routes/auth.routes.js
app.use('/', authRoutes({
  auth,
  writeRateLimiter,
  loginRateLimiter,
  pool,
  validarAcessoEmpresa,
  tokenBlacklist,
  _sseNonces,
  _tokenHash,
  JWT_EXPIRY_MS,
  validarSenhaUsuario,
  validarForcaSenha,
  registrarAuditoria,
  SECRET,
  jsonErro
}));

// â”€â”€ UsuÃ¡rios, permissÃµes e lixeira â†’ routes/usuarios.routes.js
app.use('/', usuariosRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  validarLimitePlano,
  validarForcaSenha,
  requirePermissao,
  registrarAuditoria,
  jsonErro
}));

// â”€â”€ Contas a Receber â†’ routes/contas-receber.routes.js
app.use('/', contasReceberRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  atualizarStatusContasReceberPorEmpresa,
  podeGerenciarFinanceiro,
  registrarLogFinanceiro,
  jsonErro
}));

// â”€â”€ Contas a Pagar â†’ routes/contas-pagar.routes.js
app.use('/', contasPagarRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  atualizarStatusContasPagarPorEmpresa,
  registrarLogFinanceiro,
  jsonErro
}));

// â”€â”€ LanÃ§amentos Financeiros â†’ routes/lancamentos.routes.js
app.use('/', lancamentosRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  podeGerenciarFinanceiro,
  atualizarStatusContasReceberPorEmpresa,
  registrarLogFinanceiro,
  jsonErro
}));

// â”€â”€ Fluxo de Caixa + Investimentos â†’ routes/fluxo-caixa.routes.js
app.use('/', fluxoCaixaRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  podeGerenciarFinanceiro,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
  jsonErro
}));

// â”€â”€ Dashboard â†’ routes/dashboard.routes.js
app.use('/', dashboardRoutes({
  auth,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  atualizarStatusContasReceberPorEmpresa,
  atualizarStatusContasPagarPorEmpresa,
  jsonErro
}));

// -- Pagamentos (PIX + Boleto) -> routes/pagamentos.routes.js
app.use('/', pagamentosRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  jsonErro
}));

// -- ConciliaÃ§Ã£o BancÃ¡ria -> routes/conciliacao.routes.js
app.use('/', conciliacaoRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  jsonUpload, jsonErro
}));

// -- Admin (ConfiguraÃ§Ãµes + Alertas + Billing + Admin) -> routes/admin.routes.js
app.use('/', adminRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  apenasAdmin, _configCache, _planoCache,
  jsonErro
}));

// -- Misc (Compras inline + Listagens + Metas + DepÃ³sitos + LGPD + Notif + SSE) -> routes/misc.routes.js
app.use('/', miscRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, adicionarFiltroEmpresaSaaS,
  podeGerenciarFinanceiro, podeGerenciarCompras,
  atualizarStatusContasPagarPorEmpresa,
  jsonErro
}));

// -- Admin SaaS Owner (SMTP + Dashboard + Empresas) -> routes/admin-saas.routes.js
app.use('/', adminSaasRoutes({
  auth, writeRateLimiter, pool,
  apenasAdmin, _planoCache, _configCache,
  jsonErro
}));



// ================= START =================
async function start() {
  try {
    await initDb();
    await runMigrations(pool);
    await loadBlacklistFromDb(pool);
    if (_sentryDsn) Sentry.setupExpressErrorHandler(app);
    app.listen(PORT, () => {
      console.log(`LF ERP Backend Online ðŸš€ porta ${PORT}`);
      agendarAtualizacaoNoturna();
    });
  } catch (error) {
    console.error('Erro ao iniciar backend:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
} else {
  // Permite que testes importem o app sem iniciar o servidor
  module.exports = { app };
}




