require('dotenv').config();

// Sentry — monitoramento de erros em produção (C5.3)
const Sentry = require('@sentry/node');
const _sentryDsn = process.env.SENTRY_DSN;
if (_sentryDsn) {
  Sentry.init({
    dsn: _sentryDsn,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.05, // 5% das requisições para performance
  });
}

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');
const { runMigrations } = require('./migrations/runner');
const { requirePermissao, obterPermissoes } = require('./utils/permissoes');
const { encryptField, decryptField } = require('./utils/pixCrypto');
const { normalizarFormaPagamentoFluxo } = require('./utils/financeiroUtils');
const {
  hoje,
  normalizarDecimal,
  normalizarInt,
  addDias,
  normalizarDataISO,
  validarItensVenda
} = require('./utils/normalizadores');

// Rate limiter em memória para o endpoint /login
const loginAttempts     = new Map(); // por IP
const loginUserAttempts = new Map(); // por username
const LOGIN_MAP_MAX = 10000;
const LOGIN_MAX_TENTATIVAS      = 10; // tentativas por IP / 15 min
const LOGIN_USER_MAX_TENTATIVAS = 15; // tentativas por username / 15 min
const LOGIN_JANELA_MS = 15 * 60 * 1000; // 15 minutos

// Rate limiter geral para endpoints de escrita (por userId + rota)
const writeAttempts = new Map();
const WRITE_MAX = 30;
const WRITE_JANELA_MS = 60 * 1000; // 1 minuto

const WRITE_MAP_MAX = 5000;

function writeRateLimiter(req, res, next) {
  if (!req.user) return next();
  const chave = `${req.user.id}:${req.method}:${req.route?.path || req.path}`;
  const agora = Date.now();
  const entrada = writeAttempts.get(chave) || { count: 0, inicio: agora };

  if (agora - entrada.inicio > WRITE_JANELA_MS) {
    entrada.count = 0;
    entrada.inicio = agora;
  }

  entrada.count += 1;

  if (writeAttempts.size >= WRITE_MAP_MAX && !writeAttempts.has(chave)) {
    // Map cheio: descarta entrada mais antiga para evitar crescimento unbounded
    writeAttempts.delete(writeAttempts.keys().next().value);
  }

  writeAttempts.set(chave, entrada);

  if (entrada.count > WRITE_MAX) {
    return res.status(429).json({
      sucesso: false,
      erro: 'Muitas requisições. Aguarde um momento e tente novamente.'
    });
  }

  next();
}

setInterval(() => {
  const agora = Date.now();
  for (const [chave, entrada] of writeAttempts) {
    if (agora - entrada.inicio > WRITE_JANELA_MS) writeAttempts.delete(chave);
  }
}, WRITE_JANELA_MS).unref();

function loginRateLimiter(req, res, next) {
  const ip       = req.ip || req.connection?.remoteAddress || 'unknown';
  const username = (req.body?.usuario || '').toLowerCase().trim();
  const agora    = Date.now();

  // Limite por IP (protege contra password spray)
  const entradaIp = loginAttempts.get(ip) || { count: 0, inicio: agora };
  if (agora - entradaIp.inicio > LOGIN_JANELA_MS) { entradaIp.count = 0; entradaIp.inicio = agora; }
  entradaIp.count += 1;
  if (loginAttempts.size >= LOGIN_MAP_MAX && !loginAttempts.has(ip)) {
    loginAttempts.delete(loginAttempts.keys().next().value);
  }
  loginAttempts.set(ip, entradaIp);
  if (entradaIp.count > LOGIN_MAX_TENTATIVAS) {
    const restante = Math.ceil((LOGIN_JANELA_MS - (agora - entradaIp.inicio)) / 60000);
    return res.status(429).json({ sucesso: false, erro: `Muitas tentativas de login. Tente novamente em ${restante} minuto(s).` });
  }

  // Limite por username (protege contra ataques em redes corporativas / NAT compartilhado)
  if (username) {
    const entradaUser = loginUserAttempts.get(username) || { count: 0, inicio: agora };
    if (agora - entradaUser.inicio > LOGIN_JANELA_MS) { entradaUser.count = 0; entradaUser.inicio = agora; }
    entradaUser.count += 1;
    if (loginUserAttempts.size >= LOGIN_MAP_MAX && !loginUserAttempts.has(username)) {
      loginUserAttempts.delete(loginUserAttempts.keys().next().value);
    }
    loginUserAttempts.set(username, entradaUser);
    if (entradaUser.count > LOGIN_USER_MAX_TENTATIVAS) {
      const restante = Math.ceil((LOGIN_JANELA_MS - (agora - entradaUser.inicio)) / 60000);
      return res.status(429).json({ sucesso: false, erro: `Muitas tentativas para este usuário. Tente novamente em ${restante} minuto(s).` });
    }
  }

  next();
}

setInterval(() => {
  const agora = Date.now();
  for (const [ip, entrada] of loginAttempts) {
    if (agora - entrada.inicio > LOGIN_JANELA_MS) loginAttempts.delete(ip);
  }
  for (const [user, entrada] of loginUserAttempts) {
    if (agora - entrada.inicio > LOGIN_JANELA_MS) loginUserAttempts.delete(user);
  }
}, LOGIN_JANELA_MS).unref();

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

const app = express();
app.set('trust proxy', 1); // S-0: Render usa proxy reverso — necessário para req.ip correto no rate limiter

// S-1: CORS — default seguro; sem ALLOWED_ORIGINS usa o domínio Vercel conhecido
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['https://lf-erp-frontend.vercel.app'];
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));
const jsonUpload = express.json({ limit: '50mb' }); // usado só em rotas de importação

app.disable('x-powered-by');

// S-2: Headers de segurança HTTP + redirect HTTPS em produção
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

const SECRET = process.env.JWT_SECRET;

// Helper global de resposta de erro JSON — substitui res.status(x).send('texto')
function jsonErro(res, status, mensagem, codigo = null) {
  const body = { sucesso: false, erro: mensagem };
  if (codigo) body.codigo = codigo;
  return res.status(status).json(body);
}
const PORT = process.env.PORT || 3001;

if (!SECRET) {
  console.error('JWT_SECRET não definida.');
  process.exit(1);
}
if (SECRET.length < 32) {
  console.error('JWT_SECRET muito curta (mínimo 32 caracteres). Configure uma chave segura em produção.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida.');
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

async function registrarLogFinanceiro({
  empresa,
  empresa_id,
  tipo,
  entidade,
  entidade_id,
  descricao,
  valor,
  usuario_id
}) {
  return pool.query(
    `
    INSERT INTO financeiro_logs
    (empresa, empresa_id, tipo, entidade, entidade_id, descricao, valor, usuario_id, criado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() AT TIME ZONE 'America/Fortaleza')
    `,
    [
      empresa || null,
      empresa_id || null,
      tipo || '',
      entidade || '',
      entidade_id || null,
      descricao || '',
      Number(valor || 0),
      usuario_id || null
    ]
  ).catch((err) => console.error('[log_financeiro]', err));
}

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
  // expressões compostas (hardcoded no código)
  'COALESCE(pagamento_data, vencimento)',
  'COALESCE(pagamento_data,vencimento)'
]);

function adicionarFiltroPeriodo({ campo, params, dataInicial, dataFinal, castDate = true }) {
  if (!CAMPOS_PERIODO_PERMITIDOS.has(campo)) {
    console.error(`[adicionarFiltroPeriodo] campo não permitido: ${campo}`);
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
    throw new Error(`Campo não permitido em adicionarFiltroPeriodoRange: ${campoInicial} / ${campoFinal}`);
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

async function obterEmpresaPorId(empresaId) {
  if (!empresaId) return null;

  const result = await pool.query(`SELECT id, nome FROM empresas WHERE id = $1 LIMIT 1`, [
    empresaId
  ]);

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function obterEmpresaPorNome(nome) {
  if (!nome) return null;

  const result = await pool.query(`SELECT id, nome FROM empresas WHERE LOWER(nome) = LOWER($1) LIMIT 1`, [nome]);

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function resolverEmpresaRequest(req, empresaInformada = null, empresaIdInformado = null) {
  const empresaIdInformada =
    empresaIdInformado ||
    req.body?.empresa_id || req.query?.empresa_id || req.params?.empresa_id || null;

  if (empresaIdInformada) {
    const empresa = await obterEmpresaPorId(Number(empresaIdInformada));
    if (empresa) return empresa;
  }

  if (empresaInformada) {
    const empresa = await obterEmpresaPorNome(empresaInformada);
    if (empresa) return empresa;
  }

  if (req.user?.empresa_id) {
    const empresa = await obterEmpresaPorId(Number(req.user.empresa_id));
    if (empresa) return empresa;
  }

  if (req.user?.empresa) {
    const empresa = await obterEmpresaPorNome(req.user.empresa);
    if (empresa) return empresa;
  }

  return null;
}

async function validarAcessoEmpresa(req, empresaInformada = null, empresaIdInformado = null) {
  if (req.user.is_saas_owner) {
    return await resolverEmpresaRequest(req, empresaInformada, empresaIdInformado);
  }

  const empresaResolvida = await resolverEmpresaRequest(req, empresaInformada, empresaIdInformado);

  if (!empresaResolvida) return null;

  const empresaIdUsuario = Number(req.user?.empresa_id || 0);
  const empresaNomeUsuario = req.user?.empresa || null;

  if (
    (empresaIdUsuario && empresaResolvida.id === empresaIdUsuario) ||
    (empresaNomeUsuario && empresaResolvida.nome === empresaNomeUsuario)
  ) {
    return empresaResolvida;
  }

  return null;
}

function adicionarFiltroEmpresaSaaS({ alias = '', params, empresaResolvida }) {
  const prefixo = alias ? `${alias}.` : '';

  params.push(Number(empresaResolvida.id));
  const idxEmpresaId = params.length;

  params.push(empresaResolvida.nome);
  const idxEmpresaNome = params.length;

  return `
      AND (
        ${prefixo}empresa_id = $${idxEmpresaId}
        OR (
          ${prefixo}empresa_id IS NULL
          AND ${prefixo}empresa = $${idxEmpresaNome}
        )
      )
    `;
}

function podeGerenciarUsuarios(req) {
  return req.user.tipo === 'admin' || req.user.tipo === 'gerente';
}

function podeGerenciarFinanceiro(req) {
  return req.user.tipo === 'admin' || req.user.tipo === 'gerente';
}

function podeGerenciarCompras(req) {
  return req.user.tipo === 'admin' || req.user.tipo === 'gerente';
}

function podeGerenciarVendas(req) {
  return (
    req.user.tipo === 'admin' || req.user.tipo === 'gerente' || req.user.tipo === 'funcionario'
  );
}

const _planoCache = new Map();
const PLANO_CACHE_TTL_MS = 60_000;

async function obterPlanoEmpresa(empresaId, empresaNome) {
  const cacheKey = empresaId ? `id:${empresaId}` : `nome:${empresaNome}`;
  const agora = Date.now();
  const cached = _planoCache.get(cacheKey);
  if (cached && agora - cached.ts < PLANO_CACHE_TTL_MS) return cached.data;

  const result = await pool.query(
    `
    SELECT
      e.id AS empresa_id,
      e.nome AS empresa_nome,
      e.assinatura_status,
      e.bloqueada,
      e.trial_fim,
      p.*
    FROM empresas e
    LEFT JOIN planos p ON p.id = e.plano_id
    WHERE e.id = $1 OR LOWER(e.nome) = LOWER($2)
    LIMIT 1
    `,
    [empresaId || 0, empresaNome || '']
  );

  if (result.rowCount === 0) {
    _planoCache.delete(cacheKey);
    return null;
  }

  const data = result.rows[0];
  if (_planoCache.size > 500) {
    for (const [k, v] of _planoCache) {
      if (agora - v.ts > PLANO_CACHE_TTL_MS) _planoCache.delete(k);
    }
  }
  _planoCache.set(cacheKey, { ts: agora, data });
  return data;
}

async function validarLimitePlano({ empresaResolvida, recurso }) {
  const plano = await obterPlanoEmpresa(empresaResolvida.id, empresaResolvida.nome);

  if (!plano) {
    return { permitido: false, mensagem: 'Plano da empresa não encontrado.' };
  }

  if (plano.bloqueada) {
    return { permitido: false, mensagem: 'Empresa bloqueada. Entre em contato com o suporte.' };
  }

  if (plano.assinatura_status === 'inativo' || plano.assinatura_status === 'cancelado') {
    return {
      permitido: false,
      mensagem: 'Assinatura inativa. Regularize o acesso para continuar.'
    };
  }

  const _planoTrialFimStr = plano.trial_fim instanceof Date
    ? plano.trial_fim.toISOString().slice(0, 10)
    : String(plano.trial_fim || '').slice(0, 10);
  if (plano.assinatura_status === 'trial' && plano.trial_fim && _planoTrialFimStr < hoje()) {
    return {
      permitido: false,
      mensagem: 'Período de teste expirado. Escolha um plano para continuar.'
    };
  }

  const limites = {
    usuarios: {
      tabela: 'usuarios',
      coluna: 'limite_usuarios'
    },
    produtos: {
      tabela: 'produtos',
      coluna: 'limite_produtos'
    },
    clientes: {
      tabela: 'clientes',
      coluna: 'limite_clientes'
    },
    fornecedores: {
      tabela: 'fornecedores',
      coluna: 'limite_fornecedores'
    }
  };

  const config = limites[recurso];

  if (!config) {
    return { permitido: true, plano };
  }

  const limite = Number(plano[config.coluna] || 0);

  if (limite <= 0) {
    return { permitido: true, plano };
  }

  const totalResult = await pool.query(
    `SELECT COUNT(*) AS total FROM ${config.tabela}
     WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
       AND deletado_em IS NULL`,
    [empresaResolvida.id, empresaResolvida.nome]
  );

  const totalAtual = Number(totalResult.rows[0].total || 0);

  if (totalAtual >= limite) {
    return {
      permitido: false,
      mensagem: `Limite do plano atingido para ${recurso}. Plano atual permite até ${limite}.`
    };
  }

  return { permitido: true, plano };
}

async function validarLimiteVendasMes(empresaResolvida) {
  const plano = await obterPlanoEmpresa(empresaResolvida.id, empresaResolvida.nome);

  if (!plano) {
    return { permitido: false, mensagem: 'Plano da empresa não encontrado.' };
  }

  const limite = Number(plano.limite_vendas_mes || 0);

  if (limite <= 0) {
    return { permitido: true, plano };
  }

  const hojeData = hoje();
  const inicioMes = hojeData.slice(0, 8) + '01';

  const totalResult = await pool.query(
    `
    SELECT COUNT(*) AS total
    FROM vendas
    WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
      AND data >= $3
      AND data <= $4
    `,
    [empresaResolvida.id, empresaResolvida.nome, inicioMes, hojeData]
  );

  const totalAtual = Number(totalResult.rows[0].total || 0);

  if (totalAtual >= limite) {
    return {
      permitido: false,
      mensagem: `Limite mensal de vendas atingido. Plano atual permite até ${limite} vendas por mês.`
    };
  }

  return { permitido: true, plano };
}

async function validarSenhaUsuario(senhaInformada, user) {
  const senhaSalva = String(user?.senha || '');

  if (!senhaSalva) return false;

  const pareceHashBcrypt =
    senhaSalva.startsWith('$2a$') || senhaSalva.startsWith('$2b$') || senhaSalva.startsWith('$2y$');

  if (pareceHashBcrypt) {
    return bcrypt.compare(senhaInformada, senhaSalva);
  }

  const bufA = Buffer.from(senhaInformada);
  const bufB = Buffer.from(senhaSalva);
  const iguais =
    bufA.length === bufB.length &&
    crypto.timingSafeEqual(bufA, bufB);

  if (iguais) {
    const novaHash = await bcrypt.hash(senhaInformada, 10);

    try {
      await pool.query(
        `UPDATE usuarios
          SET senha = $1,
              atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
          WHERE id = $2`,
        [novaHash, user.id]
      );
    } catch (e) { console.error('[validarSenhaUsuario] erro ao migrar hash:', e.message); }

    return true;
  }

  return false;
}

// Valida força mínima: 8+ chars, 1 maiúscula, 1 número
function validarForcaSenha(senha) {
  if (!senha || senha.length < 8) {
    return { valido: false, mensagem: 'A senha deve ter pelo menos 8 caracteres.' };
  }
  if (senha.length > 72) {
    return { valido: false, mensagem: 'A senha deve ter no máximo 72 caracteres.' };
  }
  if (!/[A-Z]/.test(senha)) {
    return { valido: false, mensagem: 'A senha deve conter pelo menos uma letra maiúscula.' };
  }
  if (!/[0-9]/.test(senha)) {
    return { valido: false, mensagem: 'A senha deve conter pelo menos um número.' };
  }
  return { valido: true };
}

const tokenBlacklist = new Map(); // hash → timestamp de revogação (L1 cache)
const JWT_EXPIRY_MS = 12 * 60 * 60 * 1000;

function _tokenHash(tok) {
  return crypto.createHash('sha256').update(tok).digest('hex');
}

setInterval(() => {
  const limite = Date.now() - JWT_EXPIRY_MS;
  for (const [hash, ts] of tokenBlacklist) {
    if (ts < limite) tokenBlacklist.delete(hash);
  }
  pool.query('DELETE FROM jwt_blacklist WHERE expires_at < NOW()').catch(() => {});
}, 60 * 60 * 1000).unref();

async function loadBlacklistFromDb() {
  try {
    const result = await pool.query(
      `SELECT token_hash, revoked_at FROM jwt_blacklist WHERE expires_at > NOW()`
    );
    for (const row of result.rows) {
      tokenBlacklist.set(row.token_hash, new Date(row.revoked_at).getTime());
    }
    if (result.rowCount > 0) {
      console.log(`[blacklist] ${result.rowCount} tokens carregados do banco`);
    }
  } catch (e) {
    console.warn('[blacklist] Falha ao carregar do banco:', e.message);
  }
}

// Nonces de curta duração para SSE — evita JWT na URL de logs
const _sseNonces = new Map(); // nonce → { token, expiry }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _sseNonces) { if (v.expiry < now) _sseNonces.delete(k); }
}, 30_000).unref();

function auth(req, res, next) {
  let authHeader = req.headers.authorization;

  // EventSource não suporta headers — aceita nonce de uso único SOMENTE para SSE
  if (!authHeader && req.method === 'GET' && req.path === '/sse-notificacoes') {
    const nonce = req.query.nonce;
    if (nonce && _sseNonces.has(nonce)) {
      const entry = _sseNonces.get(nonce);
      if (entry.expiry >= Date.now()) {
        authHeader = `Bearer ${entry.token}`;
      }
      _sseNonces.delete(nonce); // uso único
    }
  }

  if (!authHeader) {
    return res.status(403).json({ sucesso: false, erro: 'Sem acesso', codigo: 'SEM_TOKEN' });
  }

  let token = authHeader;

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (!token) {
    return res.status(403).json({ sucesso: false, erro: 'Token inválido', codigo: 'TOKEN_INVALIDO' });
  }

  if (tokenBlacklist.has(_tokenHash(token))) {
    return res.status(403).json({ sucesso: false, erro: 'Token revogado', codigo: 'TOKEN_REVOGADO' });
  }

  try {
    const decoded = jwt.verify(token, SECRET);

    req.user = decoded;

    req.empresa_id = decoded.empresa_id != null ? Number(decoded.empresa_id) : null;
    req.empresa_nome = decoded.empresa_nome || decoded.empresa || null;

    if (!req.user?.id || !req.user?.tipo) {
      return res.status(403).json({ sucesso: false, erro: 'Token inválido', codigo: 'TOKEN_INVALIDO' });
    }

    if (!req.user.is_saas_owner && req.empresa_id == null) {
      return res.status(403).json({ sucesso: false, erro: 'Empresa não identificada no token', codigo: 'EMPRESA_NAO_IDENTIFICADA' });
    }

    next();
  } catch (error) {
    return res.status(403).json({ sucesso: false, erro: 'Token inválido ou expirado', codigo: 'TOKEN_EXPIRADO' });
  }
}

function apenasAdmin(req, res, next) {
  if (!req.user.is_saas_owner) {
    return res.status(403).json({ sucesso: false, erro: 'Acesso restrito ao SaaS Owner', codigo: 'SEM_PERMISSAO' });
  }
  next();
}

async function registrarMovimentacaoEstoque({
  empresa,
  empresa_id,
  produto_id,
  grade_id = null,
  tipo,
  quantidade,
  observacao,
  referencia_tipo,
  referencia_id,
  usuario_id,
  client = null
}) {
  const executor = client || pool;

  await executor.query(
    `INSERT INTO movimentacoes_estoque
      (
        empresa,
        empresa_id,
        produto_id,
        grade_id,
        tipo,
        quantidade,
        observacao,
        referencia_tipo,
        referencia_id,
        usuario_id,
        data_movimentacao
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() AT TIME ZONE 'America/Fortaleza')`,
    [
      empresa,
      empresa_id || null,
      produto_id,
      grade_id || null,
      tipo,
      quantidade,
      observacao || '',
      referencia_tipo || null,
      referencia_id || null,
      usuario_id || null
    ]
  );
}

async function registrarAuditoria({
  empresa,
  empresa_id,
  usuario_id,
  usuario_nome,
  modulo,
  acao,
  referencia_id = null,
  dados_anteriores = null,
  dados_novos = null,
  req = null,
  client = null
}) {
  const executor = client || pool;

  const query = executor.query(
    `INSERT INTO logs_auditoria
    (
      empresa,
      empresa_id,
      usuario_id,
      usuario_nome,
      modulo,
      acao,
      referencia_id,
      dados_anteriores,
      dados_novos,
      ip,
      user_agent,
      criado_em
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW() AT TIME ZONE 'America/Fortaleza')`,
    [
      empresa || null,
      empresa_id || null,
      usuario_id || null,
      usuario_nome || '',
      modulo,
      acao,
      referencia_id,
      dados_anteriores ? JSON.stringify(dados_anteriores) : null,
      dados_novos ? JSON.stringify(dados_novos) : null,
      req?.ip || null,
      req?.headers?.['user-agent'] || null
    ]
  );

  if (client) {
    await query;
  } else {
    query.catch((err) => console.error('[auditoria]', err));
  }
}

const _statusThrottleReceber = new Map();
const _statusThrottlePagar = new Map();
const STATUS_THROTTLE_MS = 60_000;

const _configCache = new Map();
const CONFIG_CACHE_TTL_MS = 60_000;

async function obterConfigEmpresa(empresa, empresaId = null) {
  const agora = Date.now();
  const cached = _configCache.get(empresa);
  if (cached && agora - cached.ts < CONFIG_CACHE_TTL_MS) return cached.data;
  const result = await pool.query(
    `SELECT taxa_multa, taxa_juros_dia FROM configuracoes WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) LIMIT 1`,
    [empresaId || 0, empresa]
  );
  const data = result.rows[0] || {};
  if (_configCache.size > 500) {
    for (const [k, v] of _configCache) {
      if (agora - v.ts > CONFIG_CACHE_TTL_MS) _configCache.delete(k);
    }
  }
  _configCache.set(empresa, { ts: agora, data });
  return data;
}

async function atualizarStatusContasReceberPorEmpresa(empresa, empresaId = null) {
  const agora = Date.now();
  if (_statusThrottleReceber.has(empresa) && agora - _statusThrottleReceber.get(empresa) < STATUS_THROTTLE_MS) return;
  if (_statusThrottleReceber.size > 500) {
    for (const [k, v] of _statusThrottleReceber) {
      if (agora > v + STATUS_THROTTLE_MS) _statusThrottleReceber.delete(k);
    }
  }
  _statusThrottleReceber.set(empresa, agora);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // pg_try_advisory_xact_lock garante exclusão entre instâncias; libera no COMMIT/ROLLBACK
    const lockKey = Number(empresaId || 0);
    const lock = await client.query(`SELECT pg_try_advisory_xact_lock($1, 1)`, [lockKey]);
    if (!lock.rows[0].pg_try_advisory_xact_lock) {
      await client.query('ROLLBACK');
      return;
    }

    const dataHoje = hoje();

    const config = await obterConfigEmpresa(empresa, empresaId);
    const taxaMulta = Number(config?.taxa_multa ?? 0.02);
    const taxaJurosDia = Number(config?.taxa_juros_dia ?? 0.00033);

    await client.query(
      `
      UPDATE contas_receber
      SET status = 'atrasado',
          dias_atraso = GREATEST(($2::date - data_vencimento::date), 0),
          multa = ROUND((valor * $3)::numeric, 2),
          juros = ROUND((valor * $4 * GREATEST(($2::date - data_vencimento::date), 0))::numeric, 2),
          valor_atualizado = ROUND(
            (
              valor
              + (valor * $3)
              + (valor * $4 * GREATEST(($2::date - data_vencimento::date), 0))
            )::numeric,
            2
          ),
          atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
      WHERE (empresa_id = $5 OR (empresa_id IS NULL AND empresa = $1))
        AND LOWER(COALESCE(status, 'pendente')) IN ('pendente', 'atrasado', 'parcial')
        AND data_vencimento IS NOT NULL
        AND data_vencimento < $2
      `,
      [empresa, dataHoje, taxaMulta, taxaJurosDia, empresaId]
    );

    await client.query(
      `
      UPDATE contas_receber
      SET dias_atraso = 0,
          multa = 0,
          juros = 0,
          valor_atualizado = valor,
          atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
      WHERE (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $1))
        AND LOWER(COALESCE(status, 'pendente')) = 'pendente'
        AND data_vencimento IS NOT NULL
        AND data_vencimento >= $2
      `,
      [empresa, dataHoje, empresaId]
    );

    await client.query(
      `
      UPDATE contas_receber
      SET status = 'pendente',
          dias_atraso = 0,
          multa = 0,
          juros = 0,
          valor_atualizado = valor,
          atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
      WHERE (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $1))
        AND LOWER(COALESCE(status, 'pendente')) = 'atrasado'
        AND data_vencimento IS NOT NULL
        AND data_vencimento >= $2
      `,
      [empresa, dataHoje, empresaId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function atualizarStatusContasReceberGlobal() {
  await pool.query(
    `UPDATE contas_receber
      SET status = 'atrasado',
          atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
      WHERE status = 'pendente'
        AND data_vencimento IS NOT NULL
        AND data_vencimento < $1`,
    [hoje()]
  );
}

async function atualizarStatusContasPagarPorEmpresa(empresa, empresaId = null) {
  const agora = Date.now();
  if (_statusThrottlePagar.has(empresa) && agora - _statusThrottlePagar.get(empresa) < STATUS_THROTTLE_MS) return;
  if (_statusThrottlePagar.size > 500) {
    for (const [k, v] of _statusThrottlePagar) {
      if (agora > v + STATUS_THROTTLE_MS) _statusThrottlePagar.delete(k);
    }
  }
  _statusThrottlePagar.set(empresa, agora);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockKey = Number(empresaId || 0);
    const lock = await client.query(`SELECT pg_try_advisory_xact_lock($1, 2)`, [lockKey]);
    if (!lock.rows[0].pg_try_advisory_xact_lock) {
      await client.query('ROLLBACK');
      return;
    }
    await client.query(
      `UPDATE contas_pagar
        SET status = 'atrasado',
            atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
        WHERE (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $1))
          AND LOWER(COALESCE(status, 'pendente')) = 'pendente'
          AND data_vencimento IS NOT NULL
          AND data_vencimento < $2`,
      [empresa, hoje(), empresaId]
    );
    await client.query(
      `UPDATE contas_pagar
        SET status = 'pendente',
            atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
        WHERE (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $1))
          AND LOWER(COALESCE(status, 'pendente')) = 'atrasado'
          AND data_vencimento IS NOT NULL
          AND data_vencimento >= $2`,
      [empresa, hoje(), empresaId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function atualizarStatusContasPagarGlobal() {
  await pool.query(
    `UPDATE contas_pagar
      SET status = 'atrasado',
          atualizado_em = NOW() AT TIME ZONE 'America/Fortaleza'
      WHERE status = 'pendente'
        AND data_vencimento IS NOT NULL
        AND data_vencimento < $1`,
    [hoje()]
  );
}

function agendarAtualizacaoNoturna() {
  function msAteMeianoite() {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
    const meia = new Date(agora);
    meia.setDate(meia.getDate() + 1);
    meia.setHours(0, 0, 0, 0);
    return Math.max(60000, meia - agora); // mínimo 1 min para evitar loop imediato
  }

  async function rodar() {
    try {
      const { rows: empresas } = await pool.query(
        `SELECT id, nome FROM empresas ORDER BY id`
      );
      const batchSize = 5;
      for (let i = 0; i < empresas.length; i += batchSize) {
        const batch = empresas.slice(i, i + batchSize);
        await Promise.all(
          batch.flatMap(emp => [
            atualizarStatusContasReceberPorEmpresa(emp.nome, emp.id),
            atualizarStatusContasPagarPorEmpresa(emp.nome, emp.id)
          ])
        );
      }
      console.log(`[scheduler] Status financeiro atualizado para ${empresas.length} empresa(s) (meia-noite Fortaleza)`);
    } catch (err) {
      console.error('[scheduler] Erro na atualização noturna:', err.message);
    }
    setTimeout(rodar, msAteMeianoite()).unref(); // recalcula meia-noite a cada execução
  }

  const delay = msAteMeianoite();
  setTimeout(rodar, delay).unref();
  console.log(`[scheduler] Próxima atualização noturna em ${Math.round(delay / 60000)} min`);
}

async function criarParcelasContasReceber({
  client,
  empresa,
  empresa_id,
  venda_id,
  cliente_id,
  cliente_nome,
  total,
  quantidade_parcelas,
  data_primeiro_vencimento,
  intervalo_dias,
  observacao,
  criado_por,
  forma_pagamento
}) {
  const parcelas = Math.min(normalizarInt(quantidade_parcelas), 360);
  const valorTotal = normalizarDecimal(total);
  const primeiroVencimento = data_primeiro_vencimento || hoje();

  if (parcelas <= 0) return [];

  const valorBase = Math.round((valorTotal / parcelas) * 100) / 100;
  let acumulado = 0;
  const parcelasGeradas = [];

  for (let i = 1; i <= parcelas; i++) {
    let valorParcela = valorBase;

    if (i === parcelas) {
      valorParcela = Number((valorTotal - acumulado).toFixed(2));
    }

    acumulado = Number((acumulado + valorParcela).toFixed(2));

    const vencimento =
      i === 1
        ? primeiroVencimento
        : addDias(primeiroVencimento, (i - 1) * normalizarInt(intervalo_dias || 30));

    const result = await client.query(
      `INSERT INTO contas_receber
      (
        empresa,
        empresa_id,
        venda_id,
        cliente_id,
        cliente_nome,
        parcela,
        total_parcelas,
        valor,
        valor_original,
        data_vencimento,
        data_pagamento,
        status,
        forma_pagamento,
        observacao,
        criado_por,
        criado_em,
        atualizado_em
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, NULL, 'pendente', $10, $11, $12, NOW() AT TIME ZONE 'America/Fortaleza', NOW() AT TIME ZONE 'America/Fortaleza')
      RETURNING *`,
      [
        empresa,
        empresa_id || null,
        venda_id,
        cliente_id || null,
        cliente_nome || '',
        i,
        parcelas,
        valorParcela,
        vencimento,
        forma_pagamento || 'Promissória',
        observacao || '',
        criado_por || null
      ]
    );

    parcelasGeradas.push(result.rows[0]);
  }

  return parcelasGeradas;
}

async function initDb() {
  // Fast-path: banco já inicializado → pula as ~168 queries DDL (cold start 8–15s → <1s)
  // Novas colunas/tabelas devem ir em backend/migrations/, não aqui
  const { rows: _chk } = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='empresas' LIMIT 1"
  );
  if (_chk.length > 0) return;

  // ================= EMPRESAS / PLANOS / CONFIGURAÇÕES =================
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
    ('starter', 'Starter', 'Plano inicial para pequenos negócios', 49.90, 2, 300, 500, 100, 500, 1, TRUE, FALSE, FALSE),
    ('pro', 'Pro', 'Plano profissional para empresas em crescimento', 99.90, 5, 2000, 3000, 500, 3000, 1, TRUE, TRUE, FALSE),
    ('premium', 'Premium', 'Plano completo para operação avançada', 199.90, 15, 10000, 20000, 2000, 15000, 3, TRUE, TRUE, TRUE)
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

  // ================= ALTERAÇÕES / COLUNAS =================
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

  // ================= EMPRESA PADRÃO =================
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

  // ================= MIGRAÇÃO EMPRESA_ID =================
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

  // ================= ÍNDICES =================
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

    -- Índices faltantes adicionados em 2026-06-06
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

  // ── Permissões granulares ─────────────────────────────────────────────────
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

  // Defaults por tipo — INSERT OR IGNORE (ON CONFLICT DO NOTHING)
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

  // ================= USUÁRIO SAAS OWNER =================
  const ownerSenhaEnv = process.env.SAAS_OWNER_SENHA;
  if (!ownerSenhaEnv) {
    console.warn('[init] SAAS_OWNER_SENHA não definida — senha do owner não será alterada');
    return;
  }
  const ownerHash = await bcrypt.hash(ownerSenhaEnv, 10);

  // Migra nome antigo 'Lfelipeg' → 'lfelipeg' se existir
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
  res.send('LF ERP backend online 🚀');
});


// ── Auth (login/logout/me/registro) → routes/auth.routes.js
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

// ── Usuários, permissões e lixeira → routes/usuarios.routes.js
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

// ── Contas a Receber → routes/contas-receber.routes.js
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

// ── Contas a Pagar → routes/contas-pagar.routes.js
app.use('/', contasPagarRoutes({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  atualizarStatusContasPagarPorEmpresa,
  registrarLogFinanceiro,
  jsonErro
}));

// ── Lançamentos Financeiros → routes/lancamentos.routes.js
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

// ── Fluxo de Caixa + Investimentos → routes/fluxo-caixa.routes.js
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

// ── Dashboard → routes/dashboard.routes.js
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

// -- Conciliação Bancária -> routes/conciliacao.routes.js
app.use('/', conciliacaoRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  jsonUpload, jsonErro
}));

// -- Admin (Configurações + Alertas + Billing + Admin) -> routes/admin.routes.js
app.use('/', adminRoutes({
  auth, writeRateLimiter, pool,
  validarAcessoEmpresa, podeGerenciarFinanceiro,
  apenasAdmin, _configCache, _planoCache,
  jsonErro
}));

// ================= COMPRAS =================

app.get('/compras/:empresa', auth, requirePermissao(pool, 'compras', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const busca = (req.query.busca || '').trim().toLowerCase();
    const fornecedorId = normalizarInt(req.query.fornecedor_id || 0);
    const { dataInicial, dataFinal } = obterPeriodo(req);

    const params = [];
    let sql = `
        SELECT
          c.*,
          f.nome AS fornecedor_nome
        FROM compras c
        LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
        WHERE 1=1
      `;
    sql += adicionarFiltroEmpresaSaaS({ alias: 'c', params, empresaResolvida });
    let idx = params.length + 1;

    if (fornecedorId > 0) {
      sql += ` AND c.fornecedor_id = $${idx} `;
      params.push(fornecedorId);
      idx++;
    }

    if (busca) {
      const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
      sql += `
          AND (
            LOWER(COALESCE(f.nome, '')) LIKE $${idx} ESCAPE '\\'
            OR LOWER(COALESCE(c.observacao, '')) LIKE $${idx} ESCAPE '\\'
            OR CAST(c.id AS TEXT) LIKE $${idx} ESCAPE '\\'
          )
        `;
      params.push(`%${buscaEsc}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'c.data',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const paginaC = Math.max(1, normalizarInt(req.query.page || 1));
    const limiteC = Math.min(normalizarInt(req.query.limit || 100), 500);
    const offsetC = (paginaC - 1) * limiteC;
    sql += ` ORDER BY c.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limiteC, offsetC);

    const result = await pool.query(sql, params);
    res.json(
      result.rows.map((row) => ({
        ...row,
        total: Number(row.total || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar compras:', error);
    jsonErro(res, 500, 'Erro ao buscar compras');
  }
});

app.delete('/compras/:id', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'deletar'), async (req, res) => {
  if (!podeGerenciarCompras(req)) {
    return jsonErro(res, 403, 'Sem permissão para excluir compras');
  }

  const id = Number(req.params.id);
  if (!id) return jsonErro(res, 400, 'Compra inválida');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const empresa = req.query.empresa || req.body.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      await client.query('ROLLBACK');
      return jsonErro(res, 403, 'Sem acesso');
    }

    const compraResult = await client.query(
      `SELECT * FROM compras
       WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
       FOR UPDATE`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    if (compraResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return jsonErro(res, 404, 'Compra não encontrada');
    }

    const itensResult = await client.query(
      `
      SELECT *
      FROM compra_itens
      WHERE compra_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      ORDER BY id ASC
      FOR UPDATE
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    for (const item of itensResult.rows) {
      await client.query(
        `UPDATE produtos SET estoque = GREATEST(0, estoque - $1), atualizado_em = NOW()
         WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
        [normalizarInt(item.quantidade), item.produto_id, empresaResolvida.id, empresaResolvida.nome]
      );
    }

    await client.query(
      `
      DELETE FROM movimentacoes_estoque
      WHERE referencia_tipo = 'compra'
        AND referencia_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM contas_pagar
      WHERE compra_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM compra_itens
      WHERE compra_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM compras
      WHERE id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query('COMMIT');
    try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[del-compra] status-cp:', e.message); }

    res.json({ sucesso: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro real ao excluir compra:', error);
    jsonErro(res, 500, 'Erro ao excluir compra');
  } finally {
    client.release();
  }
});

app.get('/compras-detalhe/:id', auth, requirePermissao(pool, 'compras', 'ver'), async (req, res) => {
  try {
    const id = Number(req.params.id);

    const empresaResolvida = await validarAcessoEmpresa(req, req.user.empresa || null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const compraResult = await pool.query(
      `
      SELECT
        c.*,
        f.nome AS fornecedor_nome
      FROM compras c
      LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
      WHERE c.id = $1
        AND (c.empresa_id = $2 OR (c.empresa_id IS NULL AND c.empresa = $3))
      `,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    if (compraResult.rowCount === 0) {
      return jsonErro(res, 404, 'Compra não encontrada');
    }

    const compra = compraResult.rows[0];

    const itensResult = await pool.query(
      `SELECT * FROM compra_itens WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) ORDER BY id ASC`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    const contasPagarResult = await pool.query(
      `SELECT * FROM contas_pagar WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) ORDER BY parcela ASC, id ASC`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    res.json({
      ...compra,
      total: Number(compra.total || 0),
      parcelas: Number(contasPagarResult.rows[0]?.total_parcelas || 1),
      itens: itensResult.rows.map((item) => ({
        ...item,
        quantidade: Number(item.quantidade || 0),
        custo_unitario: Number(item.custo_unitario || 0),
        subtotal: Number(item.subtotal || 0)
      })),
      contas_pagar: contasPagarResult.rows.map((cp) => ({
        ...cp,
        parcela: Number(cp.parcela || 1),
        total_parcelas: Number(cp.total_parcelas || 1),
        valor: Number(cp.valor || 0)
      }))
    });
  } catch (error) {
    console.error('Erro real ao buscar compra:', error);
    jsonErro(res, 500, 'Erro ao buscar compra');
  }
});

// ================= LISTAGENS OPERACIONAIS AUXILIARES =================
app.get('/estoque/resumo/:empresa', auth, requirePermissao(pool, 'estoque', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const params = [];
    const filtro = adicionarFiltroEmpresaSaaS({ params, empresaResolvida });

    const result = await pool.query(
      `
        SELECT
          COUNT(*) AS total_produtos,
          COALESCE(SUM(estoque), 0) AS total_unidades,
          COALESCE(SUM(estoque * custo), 0) AS valor_total_estoque,
          COALESCE(SUM(CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN 1 ELSE 0 END), 0) AS produtos_alerta
        FROM produtos
        WHERE deletado_em IS NULL
        ${filtro}
        `,
      params
    );

    res.json({
      total_produtos: Number(result.rows[0].total_produtos || 0),
      total_unidades: Number(result.rows[0].total_unidades || 0),
      valor_total_estoque: Number(result.rows[0].valor_total_estoque || 0),
      produtos_alerta: Number(result.rows[0].produtos_alerta || 0)
    });
  } catch (error) {
    console.error('Erro ao buscar resumo de estoque:', error);
    jsonErro(res, 500, 'Erro ao buscar resumo de estoque');
  }
});

app.get('/compras-fornecedores/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          f.id,
          f.nome,
          COUNT(c.id) AS total_compras,
          COALESCE(SUM(c.total), 0) AS valor_total
        FROM fornecedores f
        LEFT JOIN compras c ON c.fornecedor_id = f.id AND (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))
        WHERE (f.empresa_id = $1 OR (f.empresa_id IS NULL AND f.empresa = $2))
        GROUP BY f.id, f.nome
        ORDER BY valor_total DESC, f.nome ASC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(
      result.rows.map((row) => ({
        ...row,
        total_compras: Number(row.total_compras || 0),
        valor_total: Number(row.valor_total || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar resumo de compras por fornecedor:', error);
    jsonErro(res, 500, 'Erro ao buscar resumo de compras por fornecedor');
  }
});

app.get('/vendas-clientes/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          COALESCE(cliente_nome, 'Sem cliente') AS cliente,
          COUNT(*) AS total_vendas,
          COALESCE(SUM(total), 0) AS valor_total
        FROM vendas
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
        GROUP BY COALESCE(cliente_nome, 'Sem cliente')
        ORDER BY valor_total DESC, cliente ASC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(
      result.rows.map((row) => ({
        ...row,
        total_vendas: Number(row.total_vendas || 0),
        valor_total: Number(row.valor_total || 0)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar resumo de vendas por cliente:', error);
    jsonErro(res, 500, 'Erro ao buscar resumo de vendas por cliente');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason, promise);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});



// ================= START =================
async function start() {
  try {
    await initDb();
    await runMigrations(pool);
    await loadBlacklistFromDb();
    if (_sentryDsn) Sentry.setupExpressErrorHandler(app);
    app.listen(PORT, () => {
      console.log(`LF ERP Backend Online 🚀 porta ${PORT}`);
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




// ── Metas de vendas ───────────────────────────────────────────────────────────

// GET /metas-vendas?periodo=YYYY-MM — lista metas com progresso real
app.get('/metas-vendas', auth, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const periodo = req.query.periodo || hoje().slice(0, 7); // default: mês atual

    // Calcula intervalo de datas do período
    let dataInicio, dataFim;
    if (/^\d{4}-\d{2}$/.test(periodo)) {
      // Mensal: YYYY-MM
      dataInicio = `${periodo}-01`;
      const [y, m] = periodo.split('-').map(Number);
      const fim = new Date(y, m, 0); // último dia do mês
      dataFim = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(fim);
    } else {
      dataInicio = hoje().slice(0, 8) + '01';
      dataFim = hoje();
    }

    const metasResult = await pool.query(
      `SELECT m.*, u.nome_completo AS vendedor_nome, u.usuario AS vendedor_usuario
       FROM metas_vendas m
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.empresa_id = $1 AND m.periodo = $2
       ORDER BY m.usuario_id NULLS FIRST, m.id`,
      [empresaResolvida.id, periodo]
    );

    // Calcula progresso real via vendas do período — query única com GROUP BY (evita N+1)
    const realizadoResult = await pool.query(
      `SELECT criado_por AS usuario_id, COALESCE(SUM(total), 0) AS realizado
       FROM vendas
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $4)) AND data >= $2 AND data <= $3
       GROUP BY criado_por`,
      [empresaResolvida.id, dataInicio, dataFim, empresaResolvida.nome || '']
    );
    const realizadoMap = {};
    let realizadoTotal = 0;
    for (const r of realizadoResult.rows) {
      const v = Number(r.realizado || 0);
      realizadoMap[r.usuario_id] = v;
      realizadoTotal += v;
    }
    const metasComProgresso = metasResult.rows.map((meta) => {
      // Meta por usuário → apenas vendas daquele usuário; meta geral → todas as vendas
      const realizado = meta.usuario_id ? (realizadoMap[meta.usuario_id] || 0) : realizadoTotal;
      const meta_valor = Number(meta.valor_meta || 0);
      const percentual = meta_valor > 0 ? Math.min(100, Math.round((realizado / meta_valor) * 100)) : 0;
      return { ...meta, realizado, percentual, faltando: Math.max(0, meta_valor - realizado) };
    });

    res.json({ sucesso: true, periodo, data_inicio: dataInicio, data_fim: dataFim, metas: metasComProgresso });
  } catch (err) {
    console.error('[metas] GET:', err.message);
    jsonErro(res, 500, 'Erro ao carregar metas');
  }
});

// POST /metas-vendas — criar ou atualizar meta
app.post('/metas-vendas', auth, writeRateLimiter, requirePermissao(pool, 'relatorios', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { usuario_id, periodo, valor_meta, descricao } = req.body;
    if (!periodo || !valor_meta) return jsonErro(res, 400, 'periodo e valor_meta são obrigatórios');
    if (!/^\d{4}-\d{2}$/.test(periodo)) return jsonErro(res, 400, 'periodo deve ser YYYY-MM');

    if (usuario_id) {
      const uCheck = await pool.query(
        `SELECT 1 FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
        [Number(usuario_id), empresaResolvida.id, empresaResolvida.nome || '']
      );
      if (uCheck.rowCount === 0) return jsonErro(res, 400, 'Usuário não pertence à empresa');
    }

    const result = await pool.query(
      `INSERT INTO metas_vendas (empresa_id, usuario_id, periodo, valor_meta, descricao)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (empresa_id, usuario_id, periodo) DO UPDATE
       SET valor_meta = $4, descricao = $5, atualizado_em = NOW()
       RETURNING *`,
      [empresaResolvida.id, usuario_id || null, periodo,
       normalizarDecimal(valor_meta), descricao || null]
    );

    res.status(201).json({ sucesso: true, meta: result.rows[0] });
  } catch (err) {
    console.error('[metas] POST:', err.message);
    jsonErro(res, 500, 'Erro ao salvar meta');
  }
});

// DELETE /metas-vendas/:id
app.delete('/metas-vendas/:id', auth, writeRateLimiter, requirePermissao(pool, 'relatorios', 'deletar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const r = await pool.query(
      `DELETE FROM metas_vendas WHERE id = $1 AND empresa_id = $2`,
      [Number(req.params.id), empresaResolvida.id]
    );
    if (r.rowCount === 0) return jsonErro(res, 404, 'Meta não encontrada');
    res.json({ sucesso: true });
  } catch (err) {
    console.error('[metas] DELETE:', err.message);
    jsonErro(res, 500, 'Erro ao excluir meta');
  }
});

// ── Multi-depósito ────────────────────────────────────────────────────────────

// GET /depositos — lista depósitos da empresa
app.get('/depositos', auth, requirePermissao(pool, 'estoque', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const result = await pool.query(
      `SELECT d.*,
              COUNT(ped.produto_id) AS total_produtos,
              COALESCE(SUM(ped.estoque), 0) AS total_unidades
       FROM depositos d
       LEFT JOIN produto_estoque_deposito ped ON ped.deposito_id = d.id
       WHERE d.empresa_id = $1
       GROUP BY d.id
       ORDER BY d.principal DESC, d.nome`,
      [empresaResolvida.id]
    );

    res.json({ sucesso: true, depositos: result.rows });
  } catch (err) {
    console.error('[depositos] GET lista:', err.message);
    jsonErro(res, 500, 'Erro ao listar depósitos');
  }
});

// POST /depositos — criar depósito
app.post('/depositos', auth, writeRateLimiter, requirePermissao(pool, 'estoque', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { nome, descricao } = req.body;
    if (!nome) return jsonErro(res, 400, 'Nome do depósito é obrigatório');

    const result = await pool.query(
      `INSERT INTO depositos (empresa_id, nome, descricao, ativo, principal)
       VALUES ($1, $2, $3, true, false)
       RETURNING *`,
      [empresaResolvida.id, nome.trim(), descricao || null]
    );

    res.status(201).json({ sucesso: true, deposito: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return jsonErro(res, 409, 'Já existe um depósito com esse nome');
    console.error('[depositos] POST:', err.message);
    jsonErro(res, 500, 'Erro ao criar depósito');
  }
});

// PUT /depositos/:id — editar depósito
app.put('/depositos/:id', auth, writeRateLimiter, requirePermissao(pool, 'estoque', 'editar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = Number(req.params.id);
    const { nome, descricao, ativo } = req.body;

    const result = await pool.query(
      `UPDATE depositos
       SET nome = COALESCE($1, nome),
           descricao = COALESCE($2, descricao),
           ativo = COALESCE($3, ativo),
           atualizado_em = NOW()
       WHERE id = $4 AND empresa_id = $5
       RETURNING *`,
      [nome?.trim() || null, descricao !== undefined ? descricao : null,
       ativo != null ? Boolean(ativo) : null, id, empresaResolvida.id]
    );

    if (result.rowCount === 0) return jsonErro(res, 404, 'Depósito não encontrado');
    res.json({ sucesso: true, deposito: result.rows[0] });
  } catch (err) {
    console.error('[depositos] PUT:', err.message);
    jsonErro(res, 500, 'Erro ao editar depósito');
  }
});

// DELETE /depositos/:id — remover depósito (só se sem estoque)
app.delete('/depositos/:id', auth, writeRateLimiter, requirePermissao(pool, 'estoque', 'deletar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = Number(req.params.id);

    // Verifica ownership antes de qualquer outra check (evita info leak)
    const deposito = await pool.query(
      `SELECT principal FROM depositos WHERE id = $1 AND empresa_id = $2`,
      [id, empresaResolvida.id]
    );
    if (deposito.rowCount === 0) return jsonErro(res, 404, 'Depósito não encontrado');
    if (deposito.rows[0].principal) return jsonErro(res, 400, 'O depósito principal não pode ser excluído');

    // Verifica se tem estoque (apenas após confirmar ownership)
    const temEstoque = await pool.query(
      `SELECT 1 FROM produto_estoque_deposito WHERE deposito_id = $1 AND estoque > 0 LIMIT 1`,
      [id]
    );
    if (temEstoque.rowCount > 0) {
      return jsonErro(res, 400, 'Não é possível excluir um depósito com estoque. Transfira ou zere o estoque primeiro.');
    }

    await pool.query(`DELETE FROM depositos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]);
    res.json({ sucesso: true, mensagem: 'Depósito excluído' });
  } catch (err) {
    console.error('[depositos] DELETE:', err.message);
    jsonErro(res, 500, 'Erro ao excluir depósito');
  }
});

// GET /depositos/:id/estoque — estoque de um depósito
app.get('/depositos/:id/estoque', auth, requirePermissao(pool, 'estoque', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = Number(req.params.id);

    // Verifica que o depósito pertence à empresa antes de expor o estoque
    const ownerCheck = await pool.query(
      `SELECT 1 FROM depositos WHERE id = $1 AND empresa_id = $2 LIMIT 1`,
      [id, empresaResolvida.id]
    );
    if (ownerCheck.rowCount === 0) return jsonErro(res, 404, 'Depósito não encontrado');

    const busca = (req.query.busca || '').trim().toLowerCase();

    let sql = `
      SELECT ped.produto_id, p.nome AS produto_nome, p.categoria,
             p.codigo_barras, ped.grade_id,
             pg.atributo1, pg.atributo2,
             ped.estoque, ped.atualizado_em
      FROM produto_estoque_deposito ped
      JOIN produtos p ON p.id = ped.produto_id AND p.empresa_id = $1
      LEFT JOIN produto_grades pg ON pg.id = ped.grade_id
      WHERE ped.deposito_id = $2`;

    const params = [empresaResolvida.id, id];

    if (busca) {
      const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
      sql += ` AND (LOWER(p.nome) LIKE $3 OR LOWER(COALESCE(p.categoria,'')) LIKE $3)`;
      params.push(`%${buscaEsc}%`);
    }

    sql += ` ORDER BY p.nome, pg.atributo1`;

    const result = await pool.query(sql, params);
    res.json({ sucesso: true, itens: result.rows });
  } catch (err) {
    console.error('[depositos] GET estoque:', err.message);
    jsonErro(res, 500, 'Erro ao buscar estoque do depósito');
  }
});

// POST /depositos/transferir — mover estoque entre depósitos
app.post('/depositos/transferir', auth, writeRateLimiter, requirePermissao(pool, 'estoque', 'editar'), async (req, res) => {
  const client = await pool.connect();
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { deposito_origem_id, deposito_destino_id, produto_id, grade_id, quantidade } = req.body;
    const qtd = normalizarInt(quantidade);

    if (!deposito_origem_id || !deposito_destino_id || !produto_id || qtd <= 0) {
      return jsonErro(res, 400, 'Campos obrigatórios: deposito_origem_id, deposito_destino_id, produto_id, quantidade > 0');
    }
    if (deposito_origem_id === deposito_destino_id) {
      return jsonErro(res, 400, 'Depósito de origem e destino devem ser diferentes');
    }

    await client.query('BEGIN');

    // Verifica que ambos os depósitos pertencem à empresa (anti-cross-tenant)
    const depositosCheck = await client.query(
      `SELECT id FROM depositos WHERE id = ANY($1::integer[]) AND empresa_id = $2`,
      [[Number(deposito_origem_id), Number(deposito_destino_id)], empresaResolvida.id]
    );
    if (depositosCheck.rowCount !== 2) {
      await client.query('ROLLBACK');
      return jsonErro(res, 403, 'Depósitos não pertencem à empresa');
    }

    // Verifica estoque na origem com FOR UPDATE
    const origem = await client.query(
      `SELECT estoque FROM produto_estoque_deposito
       WHERE deposito_id = $1 AND produto_id = $2 AND (grade_id = $3 OR ($3::INTEGER IS NULL AND grade_id IS NULL))
       FOR UPDATE`,
      [deposito_origem_id, produto_id, grade_id || null]
    );

    if (origem.rowCount === 0 || Number(origem.rows[0].estoque) < qtd) {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, `Estoque insuficiente no depósito de origem. Disponível: ${origem.rows[0]?.estoque || 0}`);
    }

    // Debita na origem
    await client.query(
      `UPDATE produto_estoque_deposito
       SET estoque = estoque - $1, atualizado_em = NOW()
       WHERE deposito_id = $2 AND produto_id = $3
         AND (grade_id = $4 OR ($4::INTEGER IS NULL AND grade_id IS NULL))`,
      [qtd, deposito_origem_id, produto_id, grade_id || null]
    );

    // Credita no destino (upsert)
    await client.query(
      `INSERT INTO produto_estoque_deposito (empresa_id, produto_id, grade_id, deposito_id, estoque)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (produto_id, grade_id, deposito_id) DO UPDATE
       SET estoque = produto_estoque_deposito.estoque + $5, atualizado_em = NOW()`,
      [empresaResolvida.id, produto_id, grade_id || null, deposito_destino_id, qtd]
    );

    await client.query('COMMIT');

    res.json({ sucesso: true, mensagem: `${qtd} unidade(s) transferida(s) com sucesso` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[depositos] transferir:', err.message);
    jsonErro(res, 500, 'Erro ao transferir estoque');
  } finally {
    client.release();
  }
});

// Inicializa depósito principal para empresas sem depósito
async function garantirDepositoPrincipal(empresaId, empresaNome, client) {
  const executor = client || pool;
  const existente = await executor.query(
    `SELECT id FROM depositos WHERE empresa_id = $1 LIMIT 1`,
    [empresaId]
  );
  if (existente.rowCount === 0) {
    await executor.query(
      `INSERT INTO depositos (empresa_id, nome, principal, ativo)
       VALUES ($1, 'Depósito Principal', true, true)
       ON CONFLICT (empresa_id, nome) DO NOTHING`,
      [empresaId]
    );
  }
}

// ── LGPD — exportação de dados da própria empresa ─────────────────────────────
app.get('/empresa/exportar-dados', auth, writeRateLimiter, requirePermissao(pool, 'relatorios', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = empresaResolvida.id;
    const nome = empresaResolvida.nome;

    const [
      clientesResult, produtosResult, vendasResult,
      venda_itensResult, comprasResult, compra_itensResult,
      crResult, cpResult, movimResult, lancamentosResult
    ] = await Promise.all([
      pool.query(`SELECT id,nome,telefone,email,cpf,cpf_cnpj,endereco,criado_em FROM clientes WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, nome]),
      pool.query(`SELECT id,nome,categoria,preco,custo_medio,estoque,estoque_minimo,codigo_barras,criado_em FROM produtos WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, nome]),
      pool.query(`SELECT id,cliente_nome,subtotal,desconto,acrescimo,total,pagamento,status_pagamento,data,criado_em FROM vendas WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, nome]),
      pool.query(`SELECT vi.venda_id,vi.produto_nome,vi.quantidade,vi.preco_unitario,vi.total FROM venda_itens vi JOIN vendas v ON v.id=vi.venda_id WHERE (v.empresa_id=$1 OR (v.empresa_id IS NULL AND v.empresa=$2)) ORDER BY vi.venda_id,vi.id`, [id, nome]),
      pool.query(`SELECT id,fornecedor_id,data,total,pagamento,status,criado_em FROM compras WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, nome]),
      pool.query(`SELECT ci.compra_id,ci.produto_nome,ci.quantidade,ci.custo_unitario FROM compra_itens ci JOIN compras c ON c.id=ci.compra_id WHERE (c.empresa_id=$1 OR (c.empresa_id IS NULL AND c.empresa=$2)) ORDER BY ci.compra_id`, [id, nome]),
      pool.query(`SELECT id,cliente_nome,parcela,total_parcelas,valor,data_vencimento,data_pagamento,status,forma_pagamento FROM contas_receber WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, nome]),
      pool.query(`SELECT id,fornecedor_id,descricao,valor,data_vencimento,data_pagamento,status FROM contas_pagar WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, nome]),
      pool.query(`SELECT produto_id,tipo,quantidade,data_movimentacao FROM movimentacoes_estoque WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY data_movimentacao`, [id, nome]),
      pool.query(`SELECT id,tipo,descricao,valor,vencimento AS data,categoria FROM lancamentos_financeiros WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY vencimento`, [id, nome])
    ]);

    const payload = {
      exportacao: {
        empresa:      { id: empresaResolvida.id, nome: empresaResolvida.nome },
        gerado_em:    new Date().toISOString(),
        aviso_lgpd:   'Exportação de dados pessoais conforme LGPD (Lei 13.709/2018).'
      },
      clientes:              clientesResult.rows,
      produtos:              produtosResult.rows,
      vendas:                vendasResult.rows,
      venda_itens:           venda_itensResult.rows,
      compras:               comprasResult.rows,
      compra_itens:          compra_itensResult.rows,
      contas_receber:        crResult.rows,
      contas_pagar:          cpResult.rows,
      movimentacoes_estoque: movimResult.rows,
      lancamentos_financeiros: lancamentosResult.rows
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const _nomeExport = empresaResolvida.nome.replace(/\s+/g,'_').replace(/[;="\\]/g,'_').replace(/[\r\n]/g,'');
    res.setHeader('Content-Disposition',
      `attachment; filename="lferp-dados-${_nomeExport}-${hoje()}.json"`
    );
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[lgpd] exportar-dados:', err.message);
    jsonErro(res, 500, 'Erro ao exportar dados');
  }
});

// ── Notificações in-app ───────────────────────────────────────────────────────
// GET /notificacoes — retorna notificações relevantes para a empresa logada
app.get('/notificacoes', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return res.json({ sucesso: true, notificacoes: [] });
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const dataHoje = hoje();
    const amanha   = addDias(dataHoje, 1);
    const em7dias  = addDias(dataHoje, 7);

    const [estoqueResult, crResult, cpResult, trialResult] = await Promise.all([
      // Produtos abaixo do estoque mínimo
      pool.query(
        `SELECT id, nome, estoque, estoque_minimo FROM produtos
         WHERE empresa_id = $1 AND deletado_em IS NULL
           AND estoque_minimo > 0 AND estoque < estoque_minimo
         ORDER BY (estoque_minimo - estoque) DESC LIMIT 10`,
        [empresaResolvida.id]
      ),
      // Contas a receber vencendo hoje ou já atrasadas
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(COALESCE(valor_atualizado, valor)), 0) AS valor_total
         FROM contas_receber
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3))
           AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago')
           AND data_vencimento <= $2`,
        [empresaResolvida.id, dataHoje, empresaResolvida.nome]
      ),
      // Contas a pagar vencendo hoje ou amanhã
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(valor), 0) AS valor_total
         FROM contas_pagar
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $3))
           AND LOWER(COALESCE(status,'pendente')) = 'pendente'
           AND data_vencimento <= $2`,
        [empresaResolvida.id, amanha, empresaResolvida.nome]
      ),
      // Trial expirando em até 7 dias
      pool.query(
        `SELECT trial_fim FROM empresas
         WHERE id = $1 AND assinatura_status = 'trial'
           AND trial_fim IS NOT NULL AND trial_fim <= $2`,
        [empresaResolvida.id, em7dias]
      )
    ]);

    const notifs = [];

    // Estoque baixo
    const prodAbaixo = estoqueResult.rows;
    if (prodAbaixo.length > 0) {
      notifs.push({
        tipo:   'estoque',
        icone:  'fa-boxes-stacked',
        cor:    '#d69e2e',
        titulo: `${prodAbaixo.length} produto(s) abaixo do estoque mínimo`,
        texto:  prodAbaixo.slice(0, 3).map((p) => `${p.nome} (${p.estoque}/${p.estoque_minimo})`).join(', ') + (prodAbaixo.length > 3 ? ` e mais ${prodAbaixo.length - 3}` : ''),
        link:   'estoque'
      });
    }

    // CR vencidas/vencendo
    const cr = crResult.rows[0];
    if (Number(cr.total) > 0) {
      notifs.push({
        tipo:   'contas_receber',
        icone:  'fa-money-bill-wave',
        cor:    '#e53e3e',
        titulo: `${cr.total} conta(s) a receber em atraso`,
        texto:  `Total: R$ ${Number(cr.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        link:   'contas-receber'
      });
    }

    // CP vencendo
    const cp = cpResult.rows[0];
    if (Number(cp.total) > 0) {
      notifs.push({
        tipo:   'contas_pagar',
        icone:  'fa-calendar-xmark',
        cor:    '#e53e3e',
        titulo: `${cp.total} conta(s) a pagar vencendo hoje/amanhã`,
        texto:  `Total: R$ ${Number(cp.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        link:   'contas-pagar'
      });
    }

    // Trial expirando
    if (trialResult.rowCount > 0) {
      const tf = trialResult.rows[0].trial_fim;
      const diasRestantes = Math.ceil((new Date(tf) - new Date(dataHoje)) / 86400000);
      notifs.push({
        tipo:   'trial',
        icone:  'fa-clock',
        cor:    '#d69e2e',
        titulo: diasRestantes <= 0 ? 'Seu trial expirou' : `Trial expira em ${diasRestantes} dia(s)`,
        texto:  'Escolha um plano para continuar usando o sistema.',
        link:   'configuracoes'
      });
    }

    res.json({ sucesso: true, notificacoes: notifs, total: notifs.length });
  } catch (err) {
    console.error('[notificacoes]', err.message);
    jsonErro(res, 500, 'Erro ao carregar notificações');
  }
});

// ── SSE (Server-Sent Events) — notificações em tempo real ────────────────────

const _sseClients = new Map(); // empresaId → Set<Response>

async function _sseQueryNotificacoes(empresaId) {
  const dataHoje = hoje();
  const amanha   = addDias(dataHoje, 1);
  const em7dias  = addDias(dataHoje, 7);

  const [estoqueResult, crResult, cpResult, trialResult] = await Promise.all([
    pool.query(
      `SELECT id, nome, estoque, estoque_minimo FROM produtos
       WHERE empresa_id = $1 AND deletado_em IS NULL
         AND estoque_minimo > 0 AND estoque < estoque_minimo
       ORDER BY (estoque_minimo - estoque) DESC LIMIT 10`,
      [empresaId]
    ),
    pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(COALESCE(valor_atualizado, valor)), 0) AS valor_total
       FROM contas_receber
       WHERE empresa_id = $1
         AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago')
         AND data_vencimento <= $2`,
      [empresaId, dataHoje]
    ),
    pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(valor), 0) AS valor_total
       FROM contas_pagar
       WHERE empresa_id = $1
         AND LOWER(COALESCE(status,'pendente')) = 'pendente'
         AND data_vencimento <= $2`,
      [empresaId, amanha]
    ),
    pool.query(
      `SELECT trial_fim FROM empresas
       WHERE id = $1 AND assinatura_status = 'trial'
         AND trial_fim IS NOT NULL AND trial_fim <= $2`,
      [empresaId, em7dias]
    )
  ]);

  const notifs = [];

  const prodAbaixo = estoqueResult.rows;
  if (prodAbaixo.length > 0) {
    notifs.push({
      tipo:   'estoque',
      icone:  'fa-boxes-stacked',
      cor:    '#d69e2e',
      titulo: `${prodAbaixo.length} produto(s) abaixo do estoque mínimo`,
      texto:  prodAbaixo.slice(0, 3).map(p => `${p.nome} (${p.estoque}/${p.estoque_minimo})`).join(', ') +
              (prodAbaixo.length > 3 ? ` e mais ${prodAbaixo.length - 3}` : ''),
      link:   'estoque'
    });
  }

  const cr = crResult.rows[0];
  if (Number(cr.total) > 0) {
    notifs.push({
      tipo:   'contas_receber',
      icone:  'fa-money-bill-wave',
      cor:    '#e53e3e',
      titulo: `${cr.total} conta(s) a receber em atraso`,
      texto:  `Total: R$ ${Number(cr.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      link:   'contas-receber'
    });
  }

  const cp = cpResult.rows[0];
  if (Number(cp.total) > 0) {
    notifs.push({
      tipo:   'contas_pagar',
      icone:  'fa-calendar-xmark',
      cor:    '#e53e3e',
      titulo: `${cp.total} conta(s) a pagar vencendo hoje/amanhã`,
      texto:  `Total: R$ ${Number(cp.valor_total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
      link:   'contas-pagar'
    });
  }

  if (trialResult.rowCount > 0) {
    const tf = trialResult.rows[0].trial_fim;
    const diasRestantes = Math.ceil((new Date(tf) - new Date(dataHoje)) / 86400000);
    notifs.push({
      tipo:   'trial',
      icone:  'fa-clock',
      cor:    '#d69e2e',
      titulo: diasRestantes <= 0 ? 'Seu trial expirou' : `Trial expira em ${diasRestantes} dia(s)`,
      texto:  'Escolha um plano para continuar usando o sistema.',
      link:   'configuracoes'
    });
  }

  return { notificacoes: notifs, total: notifs.length };
}

async function ssePush(res, empresaId) {
  try {
    const dados = await _sseQueryNotificacoes(empresaId);
    res.write(`event: notificacoes\ndata: ${JSON.stringify(dados)}\n\n`);
  } catch (err) {
    console.error('[SSE] ssePush:', err.message);
  }
}

function sseNotificarEmpresa(empresaId) {
  const clientes = _sseClients.get(empresaId);
  if (!clientes || clientes.size === 0) return;
  for (const res of [...clientes]) {
    ssePush(res, empresaId).catch(() => clientes.delete(res));
  }
}

// GET /sse-notificacoes — stream de eventos para o frontend
app.get('/sse-notificacoes', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const SSE_MAX_EMPRESAS = 1000;
    const empresaId = empresaResolvida.id;
    if (!_sseClients.has(empresaId)) {
      if (_sseClients.size >= SSE_MAX_EMPRESAS) {
        const [primeiraKey] = _sseClients.keys();
        const primeiroSet = _sseClients.get(primeiraKey);
        for (const r of primeiroSet) { try { r.end(); } catch {} }
        _sseClients.delete(primeiraKey);
      }
      _sseClients.set(empresaId, new Set());
    }
    const clientes = _sseClients.get(empresaId);
    if (clientes.size >= 30) {
      return jsonErro(res, 429, 'Limite de conexões SSE atingido para esta empresa');
    }
    clientes.add(res);

    // Envio imediato
    await ssePush(res, empresaId);

    // Heartbeat a cada 25s (menor que timeout de proxy)
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);
    heartbeat.unref();

    // Refresh a cada 60s
    const refresh = setInterval(async () => {
      await ssePush(res, empresaId).catch(() => {});
    }, 60000);
    refresh.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(refresh);
      clientes.delete(res);
    });
  } catch (err) {
    console.error('[SSE] Conexão:', err.message);
    if (!res.headersSent) jsonErro(res, 500, 'Erro no SSE');
  }
});

// ── Config SMTP SaaS Owner ────────────────────────────────────────────────────

app.get('/admin/smtp/config', auth, apenasAdmin, async (req, res) => {
  try {
    const cfg = await getSaasSmtp(pool);
    res.json({
      sucesso: true,
      smtp_host:  cfg.smtp_host  || '',
      smtp_port:  cfg.smtp_port  || 587,
      smtp_user:  cfg.smtp_user  || '',
      smtp_pass:  cfg.smtp_pass  ? '***' : '',
      smtp_from:  cfg.smtp_from  || '',
      app_url:    cfg.app_url    || ''
    });
  } catch (err) {
    jsonErro(res, 500, 'Erro ao buscar config SMTP');
  }
});

app.put('/admin/smtp/config', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, app_url } = req.body;
    await pool.query(
      `UPDATE saas_config SET
         smtp_host = $1, smtp_port = $2, smtp_user = $3,
         smtp_pass = COALESCE(NULLIF($4,'***'), smtp_pass),
         smtp_from = $5, app_url = $6, atualizado_em = NOW()`,
      [smtp_host || null, Number(smtp_port || 587), smtp_user || null,
       smtp_pass || null, smtp_from || null, app_url || null]
    );
    res.json({ sucesso: true });
  } catch (err) {
    jsonErro(res, 500, 'Erro ao salvar config SMTP');
  }
});

app.post('/admin/smtp/testar', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const cfg = await getSaasSmtp(pool);
    const transporter = criarTransporter(cfg);
    if (!transporter) return jsonErro(res, 400, 'SMTP não configurado');

    const toEmail = req.body.email || req.user.email;
    if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(toEmail))) {
      return jsonErro(res, 400, 'Email de destino inválido');
    }
    await transporter.sendMail({
      from:    cfg.smtp_from || cfg.smtp_user,
      to:      toEmail,
      subject: 'Teste de SMTP — LF ERP',
      text:    'Este é um email de teste do sistema LF ERP. Configuração funcionando!'
    });
    res.json({ sucesso: true, mensagem: 'Email de teste enviado com sucesso' });
  } catch (err) {
    jsonErro(res, 500, 'Erro ao enviar teste de e-mail');
  }
});

// ── GET /admin/dashboard — métricas SaaS Owner ───────────────────────────────
app.get('/admin/dashboard', auth, apenasAdmin, async (req, res) => {
  try {
    const [empresasResult, receitaResult, ativosResult] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE assinatura_status = 'ativo')   AS ativos,
          COUNT(*) FILTER (WHERE assinatura_status = 'trial')   AS em_trial,
          COUNT(*) FILTER (WHERE bloqueada = true)              AS bloqueados,
          COUNT(*) FILTER (WHERE assinatura_status IN ('inativo','cancelado')) AS inativos,
          COUNT(*) FILTER (WHERE criado_em >= (NOW() AT TIME ZONE 'America/Fortaleza') - INTERVAL '30 days') AS novos_30d,
          COUNT(*) FILTER (WHERE assinatura_status = 'trial' AND trial_fim < CURRENT_DATE) AS trial_expirado
        FROM empresas`),
      pool.query(`
        SELECT COALESCE(SUM(p.preco_mensal), 0) AS mrr
        FROM empresas e
        JOIN planos p ON p.id = e.plano_id
        WHERE e.assinatura_status = 'ativo' AND NOT e.bloqueada`),
      pool.query(`
        SELECT
          COUNT(*) AS total_vendas_30d,
          COALESCE(SUM(total), 0) AS volume_vendas_30d
        FROM vendas
        WHERE criado_em >= (NOW() AT TIME ZONE 'America/Fortaleza') - INTERVAL '30 days'`),
    ]);

    const e = empresasResult.rows[0];
    const mrr = Number(receitaResult.rows[0]?.mrr || 0);
    const v = ativosResult.rows[0];

    // Últimas 6 empresas criadas
    const ultimasResult = await pool.query(
      `SELECT e.nome, e.assinatura_status, e.criado_em, p.nome AS plano_nome
       FROM empresas e
       LEFT JOIN planos p ON p.id = e.plano_id
       ORDER BY e.criado_em DESC LIMIT 6`
    );

    res.json({
      sucesso: true,
      metricas: {
        total_empresas:    Number(e.total),
        ativas:            Number(e.ativos),
        em_trial:          Number(e.em_trial),
        bloqueadas:        Number(e.bloqueados),
        inativos:          Number(e.inativos),
        novos_30d:         Number(e.novos_30d),
        trial_expirado:    Number(e.trial_expirado),
        mrr:               Number(mrr.toFixed(2)),
        total_vendas_30d:  Number(v.total_vendas_30d),
        volume_vendas_30d: Number(v.volume_vendas_30d || 0)
      },
      ultimas_empresas: ultimasResult.rows
    });
  } catch (err) {
    console.error('[admin] dashboard:', err.message);
    jsonErro(res, 500, 'Erro ao carregar dashboard admin');
  }
});

// ================= ADMIN: GESTÃO DE EMPRESAS =================

app.get('/admin/empresas', auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.id, e.nome, e.email, e.telefone, e.cnpj,
        e.assinatura_status, e.bloqueada, e.motivo_bloqueio,
        e.trial_inicio, e.trial_fim, e.criado_em, e.atualizado_em,
        p.nome AS plano_nome, p.codigo AS plano_codigo,
        (SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id = e.id) AS total_usuarios,
        (SELECT COUNT(*) FROM vendas v WHERE v.empresa_id = e.id) AS total_vendas
      FROM empresas e
      LEFT JOIN planos p ON p.id = e.plano_id
      ORDER BY e.criado_em DESC
    `);

    res.json(result.rows.map((r) => ({
      ...r,
      bloqueada: Boolean(r.bloqueada),
      total_usuarios: Number(r.total_usuarios || 0),
      total_vendas: Number(r.total_vendas || 0)
    })));
  } catch (error) {
    console.error('Erro ao listar empresas:', error);
    jsonErro(res, 500, 'Erro ao listar empresas');
  }
});

app.get('/admin/empresas/:id/exportar', auth, apenasAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return jsonErro(res, 400, 'ID inválido');

    const empresaResult = await pool.query(`SELECT * FROM empresas WHERE id = $1`, [id]);
    if (empresaResult.rowCount === 0) return jsonErro(res, 404, 'Empresa não encontrada');
    const empresa = empresaResult.rows[0];
    const empresaNome = empresa.nome;

    const [
      clientesR, produtosR, fornecedoresR, vendasR, vendaItensR,
      comprasR, compraItensR, crR, cpR, movimR, lancamentosR
    ] = await Promise.all([
      pool.query(`SELECT * FROM clientes WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM produtos WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM fornecedores WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) AND deletado_em IS NULL ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM vendas WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT vi.* FROM venda_itens vi JOIN vendas v ON v.id=vi.venda_id WHERE (v.empresa_id=$1 OR (v.empresa_id IS NULL AND v.empresa=$2)) ORDER BY vi.venda_id,vi.id`, [id, empresaNome]),
      pool.query(`SELECT * FROM compras WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT ci.* FROM compra_itens ci JOIN compras c ON c.id=ci.compra_id WHERE (c.empresa_id=$1 OR (c.empresa_id IS NULL AND c.empresa=$2)) ORDER BY ci.compra_id`, [id, empresaNome]),
      pool.query(`SELECT * FROM contas_receber WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM contas_pagar WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY id`, [id, empresaNome]),
      pool.query(`SELECT * FROM movimentacoes_estoque WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY data_movimentacao`, [id, empresaNome]),
      pool.query(`SELECT * FROM lancamentos_financeiros WHERE (empresa_id=$1 OR (empresa_id IS NULL AND empresa=$2)) ORDER BY vencimento`, [id, empresaNome])
    ]);

    const payload = {
      exportacao: {
        empresa:    { id: empresa.id, nome: empresa.nome },
        gerado_em:  new Date().toISOString(),
        gerado_por: 'admin'
      },
      clientes:               clientesR.rows,
      produtos:               produtosR.rows,
      fornecedores:           fornecedoresR.rows,
      vendas:                 vendasR.rows,
      venda_itens:            vendaItensR.rows,
      compras:                comprasR.rows,
      compra_itens:           compraItensR.rows,
      contas_receber:         crR.rows,
      contas_pagar:           cpR.rows,
      movimentacoes_estoque:  movimR.rows,
      lancamentos_financeiros: lancamentosR.rows
    };

    const nomeArquivo = `lferp-backup-${empresa.nome.replace(/\s+/g,'_').replace(/[;"\\]/g,'').replace(/[\r\n]/g,'')}-${hoje()}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error('Erro ao exportar empresa:', error);
    jsonErro(res, 500, 'Erro ao exportar dados da empresa');
  }
});

app.get('/admin/empresas/:id', auth, apenasAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return jsonErro(res, 400, 'ID inválido');

    const [empresaResult, usuariosResult, vendasResult, logsResult] = await Promise.all([
      pool.query(
        `SELECT e.*, p.nome AS plano_nome, p.codigo AS plano_codigo
         FROM empresas e LEFT JOIN planos p ON p.id = e.plano_id
         WHERE e.id = $1`, [id]
      ),
      pool.query(`SELECT id, usuario, tipo, nome_completo, criado_em FROM usuarios WHERE empresa_id = $1 ORDER BY criado_em DESC`, [id]),
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(total), 0) AS valor_total
         FROM vendas WHERE empresa_id = $1`, [id]
      ),
      pool.query(
        `SELECT acao, usuario_nome, ip, criado_em FROM logs_auditoria
         WHERE empresa_id = $1 ORDER BY criado_em DESC LIMIT 10`, [id]
      )
    ]);

    if (empresaResult.rowCount === 0) return jsonErro(res, 404, 'Empresa não encontrada');

    res.json({
      empresa: { ...empresaResult.rows[0], bloqueada: Boolean(empresaResult.rows[0].bloqueada) },
      usuarios: usuariosResult.rows,
      resumo_vendas: {
        total: Number(vendasResult.rows[0].total || 0),
        valor_total: Number(vendasResult.rows[0].valor_total || 0)
      },
      ultimos_acessos: logsResult.rows
    });
  } catch (error) {
    console.error('Erro ao buscar detalhe da empresa:', error);
    jsonErro(res, 500, 'Erro ao buscar empresa');
  }
});


app.post('/admin/empresas', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  let adminClient;
  try {
    const { nome, plano_id, trial_dias = 30, email, telefone, cnpj } = req.body;

    if (!nome) {
      return jsonErro(res, 400, 'Nome da empresa é obrigatório');
    }

    adminClient = await pool.connect();
    await adminClient.query('BEGIN');

    const existe = await adminClient.query(
      `SELECT id FROM empresas WHERE LOWER(nome) = LOWER($1) LIMIT 1 FOR UPDATE`,
      [nome]
    );
    if (existe.rowCount > 0) {
      await adminClient.query('ROLLBACK');
      return jsonErro(res, 400, 'Já existe uma empresa com esse nome');
    }

    const trialFim = addDias(hoje(), trial_dias);

    const empresaResult = await adminClient.query(
      `INSERT INTO empresas
        (nome, cnpj, telefone, email, plano_id, assinatura_status, trial_inicio, trial_fim, bloqueada, criado_em, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, 'trial', $6, $7, false, NOW(), NOW())
       RETURNING *`,
      [nome, cnpj || null, telefone || null, email || null, plano_id || null, hoje(), trialFim]
    );

    const empresa = empresaResult.rows[0];

    await adminClient.query(
      `INSERT INTO configuracoes (empresa, empresa_id, nome_empresa, criado_em, atualizado_em)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [empresa.nome, empresa.id, empresa.nome]
    );

    await adminClient.query('COMMIT');

    return res.status(201).json({ sucesso: true, empresa });
  } catch (error) {
    if (adminClient) await adminClient.query('ROLLBACK').catch(() => {});
    console.error('Erro ao criar empresa:', error);
    jsonErro(res, 500, 'Erro ao criar empresa');
  } finally {
    if (adminClient) adminClient.release();
  }
});

app.put('/admin/empresas/:id/status', auth, apenasAdmin, writeRateLimiter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { assinatura_status, bloqueada, plano_id, trial_fim, motivo_bloqueio } = req.body;

    if (!id) {
      return jsonErro(res, 400, 'ID de empresa inválido');
    }

    const empresaExiste = await pool.query(`SELECT id, nome FROM empresas WHERE id = $1`, [id]);
    if (empresaExiste.rowCount === 0) {
      return jsonErro(res, 404, 'Empresa não encontrada');
    }

    const nomeEmpresa = empresaExiste.rows[0].nome;

    await pool.query(
      `UPDATE empresas SET
        assinatura_status = COALESCE($1, assinatura_status),
        bloqueada = COALESCE($2, bloqueada),
        plano_id = COALESCE($3, plano_id),
        trial_fim = COALESCE($4, trial_fim),
        motivo_bloqueio = COALESCE($5, motivo_bloqueio),
        atualizado_em = NOW()
       WHERE id = $6`,
      [
        assinatura_status || null,
        bloqueada !== undefined ? Boolean(bloqueada) : null,
        plano_id || null,
        trial_fim || null,
        motivo_bloqueio || null,
        id
      ]
    );

    _planoCache.delete(`id:${id}`);
    _planoCache.delete(`nome:${nomeEmpresa}`);
    _configCache.delete(nomeEmpresa);

    return res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao atualizar status da empresa:', error);
    jsonErro(res, 500, 'Erro ao atualizar empresa');
  }
});
