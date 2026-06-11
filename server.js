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

// Rate limiter em memória para o endpoint /login
const loginAttempts     = new Map(); // por IP
const loginUserAttempts = new Map(); // por username
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
  const chave = `${req.user.id}:${req.path}`;
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

const app = express();

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
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

// Disponibiliza pool para middlewares via app.locals
app.locals.pool = pool;

app.get('/health', async (req, res) => {
  const inicio = Date.now();
  try {
    await pool.query('SELECT 1');
    const latencia = Date.now() - inicio;
    const mem = process.memoryUsage();

    res.json({
      status: 'ok',
      sistema: 'LF ERP',
      database: 'online',
      latencia_ms: latencia,
      uptime_s: Math.floor(process.uptime()),
      memoria_mb: Math.round(mem.rss / 1024 / 1024),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro no health check:', error);
    res.status(500).json({
      status: 'erro',
      sistema: 'LF ERP',
      database: 'offline',
      latencia_ms: Date.now() - inicio,
      timestamp: new Date().toISOString()
    });
  }
});

app.use(
  '/financeiro',
  financeiroRoutes({
    auth,
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

app.use('/portal', portalRoutes({ auth, pool }));
app.use('/caixa',      caixaRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal }));
app.use('/alertas',    alertasRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa }));
app.use('/marketplace', marketplaceRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje, registrarMovimentacaoEstoque, criarParcelasContasReceber }));
app.use('/crm', crmRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, normalizarDataISO, hoje }));
app.use('/exportacao', exportacaoRoutes({ auth, pool, validarAcessoEmpresa, adicionarFiltroPeriodo, obterPeriodo, normalizarDecimal, hoje }));
app.use('/api/v1',    apiPublicaRoutes({ pool, writeRateLimiter, normalizarDecimal, normalizarInt, hoje }));
app.use('/webhooks',         webhooksRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa }));
app.use('/rastreabilidade', rastreabilidadeRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarInt, normalizarDataISO, hoje }));
app.use('/whatsapp',       whatsappRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, hoje }));
app.use('/fidelidade',    fidelidadeRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, hoje }));
app.use('/checkout',     checkoutRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, hoje }));
app.use('/filiais',     filiaisRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, obterPeriodo, adicionarFiltroPeriodo, hoje }));
app.use('/bi',         biRoutes({ auth, pool, validarAcessoEmpresa, hoje }));
app.use('/devolucoes', devolucoesRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal, normalizarInt, registrarMovimentacaoEstoque }));

app.use('/nfce', nfceRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal }));
app.use('/nfse', nfseRoutes({ auth, writeRateLimiter, pool, validarAcessoEmpresa, normalizarDecimal }));

app.use(
  '/nfe',
  nfeRoutes({
    auth,
    writeRateLimiter,
    pool,
    validarAcessoEmpresa,
    normalizarDecimal
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
    adicionarFiltroPeriodo
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
    registrarAuditoria
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

function hoje() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Fortaleza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function agoraISO() {
  return new Date().toISOString();
}

function normalizarDecimal(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

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
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
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

function normalizarInt(valor) {
  const numero = parseInt(valor, 10);
  return Number.isFinite(numero) ? numero : 0;
}

function validarItensVenda(itens) {
  if (!Array.isArray(itens) || itens.length === 0) return false;
  for (const item of itens) {
    if (!Number(item.produto_id) || normalizarInt(item.quantidade) <= 0) return false;
  }
  return true;
}

function addDias(dataBase, dias) {
  const data = new Date(`${dataBase}T00:00:00`);
  data.setDate(data.getDate() + Number(dias || 0));
  return data.toISOString().slice(0, 10);
}

function normalizarDataISO(valor) {
  if (!valor) return null;
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) {
    return valor.trim();
  }
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  // Usar timezone Fortaleza para evitar shift de data ao converter Date → string
  return d.toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
}

function obterPeriodo(req) {
  return {
    dataInicial: normalizarDataISO(req.query.data_inicial || req.query.inicio || ''),
    dataFinal: normalizarDataISO(req.query.data_final || req.query.fim || '')
  };
}

function adicionarFiltroPeriodo({ campo, params, dataInicial, dataFinal, castDate = true }) {
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

function adicionarFiltroPeriodoRange({
  campoInicial,
  campoFinal,
  params,
  dataInicial,
  dataFinal,
  castDate = true
}) {
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

  const result = await pool.query(`SELECT id, nome FROM empresas WHERE nome = $1 LIMIT 1`, [nome]);

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
    WHERE e.id = $1 OR e.nome = $2
    LIMIT 1
    `,
    [empresaId || 0, empresaNome || '']
  );

  if (result.rowCount === 0) {
    _planoCache.delete(cacheKey);
    return null;
  }

  const data = result.rows[0];
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

  if (plano.assinatura_status === 'trial' && plano.trial_fim && String(plano.trial_fim) < hoje()) {
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
    `SELECT COUNT(*) AS total FROM ${config.tabela} WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`,
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

    await pool.query(
      `UPDATE usuarios
        SET senha = $1,
            atualizado_em = NOW()
        WHERE id = $2`,
      [novaHash, user.id]
    );

    return true;
  }

  return false;
}

// Valida força mínima: 8+ chars, 1 maiúscula, 1 número
function validarForcaSenha(senha) {
  if (!senha || senha.length < 8) {
    return { valido: false, mensagem: 'A senha deve ter pelo menos 8 caracteres.' };
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

function auth(req, res, next) {
  let authHeader = req.headers.authorization;

  // EventSource não suporta headers — aceita token via query param SOMENTE para SSE
  if (!authHeader && req.method === 'GET' && req.query.token && req.path === '/sse-notificacoes') {
    authHeader = `Bearer ${req.query.token}`;
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

    req.empresa_id = decoded.empresa_id ? Number(decoded.empresa_id) : null;
    req.empresa_nome = decoded.empresa_nome || decoded.empresa || null;

    if (!req.user?.id || !req.user?.tipo) {
      return res.status(403).json({ sucesso: false, erro: 'Token inválido', codigo: 'TOKEN_INVALIDO' });
    }

    if (!req.user.is_saas_owner && !req.empresa_id) {
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
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
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
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
  _configCache.set(empresa, { ts: agora, data });
  return data;
}

async function atualizarStatusContasReceberPorEmpresa(empresa, empresaId = null) {
  const agora = Date.now();
  if (_statusThrottleReceber.has(empresa) && agora - _statusThrottleReceber.get(empresa) < STATUS_THROTTLE_MS) return;
  _statusThrottleReceber.set(empresa, agora);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // pg_try_advisory_xact_lock garante exclusão entre instâncias; libera no COMMIT/ROLLBACK
    const lockKey = Number(empresaId || 0);
    const lock = await client.query(`SELECT pg_try_advisory_xact_lock($1, 1)`, [lockKey]);
    if (!lock.rows[0].pg_try_advisory_xact_lock) {
      await client.query('ROLLBACK');
      client.release();
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
          atualizado_em = NOW()
      WHERE (empresa = $1 OR (empresa_id IS NOT NULL AND empresa_id = $5))
        AND LOWER(COALESCE(status, 'pendente')) IN ('pendente', 'atrasado')
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
          atualizado_em = NOW()
      WHERE (empresa = $1 OR (empresa_id IS NOT NULL AND empresa_id = $3))
        AND LOWER(COALESCE(status, 'pendente')) = 'pendente'
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
          atualizado_em = NOW()
      WHERE status = 'pendente'
        AND data_vencimento IS NOT NULL
        AND data_vencimento < $1`,
    [hoje()]
  );
}

async function atualizarStatusContasPagarPorEmpresa(empresa, empresaId = null) {
  const agora = Date.now();
  if (_statusThrottlePagar.has(empresa) && agora - _statusThrottlePagar.get(empresa) < STATUS_THROTTLE_MS) return;
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
            atualizado_em = NOW()
        WHERE (empresa = $1 OR (empresa_id IS NOT NULL AND empresa_id = $3))
          AND status = 'pendente'
          AND data_vencimento IS NOT NULL
          AND data_vencimento < $2`,
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
          atualizado_em = NOW()
      WHERE status = 'pendente'
        AND data_vencimento IS NOT NULL
        AND data_vencimento < $1`,
    [hoje()]
  );
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
  const parcelas = normalizarInt(quantidade_parcelas);
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, NULL, 'pendente', $10, $11, $12, NOW(), NOW())
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
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS taxa_multa NUMERIC(8,4) NOT NULL DEFAULT 0.02;
    ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS taxa_juros_dia NUMERIC(8,6) NOT NULL DEFAULT 0.00033;
  `);

  await pool.query(`
    ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS empresa_id INTEGER;
    ALTER TABLE lancamentos_financeiros ADD COLUMN IF NOT EXISTS conta_receber_id INTEGER;
  `);

  await pool.query(`
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS valor_original NUMERIC(12,2);
    ALTER TABLE contas_pagar   ADD COLUMN IF NOT EXISTS valor_original NUMERIC(12,2);
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

  // ================= PILOTO — LUCILEIDE VARIEDADES =================
  // Empresa piloto fica sempre no plano premium, ativa, sem bloqueio
  const premiumId = await pool.query(`SELECT id FROM planos WHERE codigo = 'premium' LIMIT 1`);
  const premiumPlanoId = premiumId.rows[0]?.id || null;

  await pool.query(
    `UPDATE empresas
     SET plano_id         = COALESCE($1, plano_id),
         assinatura_status = 'ativo',
         bloqueada         = FALSE,
         motivo_bloqueio   = NULL,
         trial_fim         = NULL,
         atualizado_em     = NOW()
     WHERE LOWER(nome) = 'lucileide variedades'`,
    [premiumPlanoId]
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jwt_blacklist (
      token_hash TEXT PRIMARY KEY,
      revoked_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jwt_blacklist_expires ON jwt_blacklist (expires_at);
  `);

  await atualizarStatusContasReceberGlobal();
  await atualizarStatusContasPagarGlobal();
}

app.get('/', (req, res) => {
  res.send('LF ERP backend online 🚀');
});

app.post('/reset-dados', auth, async (req, res) => {
  try {
    if (!req.user.is_saas_owner) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const resetToken = process.env.RESET_SECRET;
    const headerToken = req.headers['x-reset-token'];

    const _bufReset = Buffer.from(resetToken);
    const _bufHeader = Buffer.from(headerToken || '');
    if (!resetToken || !headerToken || _bufReset.length !== _bufHeader.length || !crypto.timingSafeEqual(_bufReset, _bufHeader)) {
      return jsonErro(res, 403, 'Token de reset inválido ou ausente');
    }

    await pool.query(`
      TRUNCATE TABLE
        venda_itens,
        vendas,
        compra_itens,
        compras,
        contas_receber,
        contas_pagar,
        movimentacoes_estoque,
        lancamentos_financeiros,
        investimentos,
        produtos,
        clientes,
        fornecedores
      RESTART IDENTITY CASCADE
    `);

    res.json({ sucesso: true, mensagem: 'Dados resetados com sucesso' });
  } catch (error) {
    console.error('Erro no reset:', error);
    jsonErro(res, 500, 'Erro ao resetar dados');
  }
});

// ================= AUTH =================
app.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const { usuario, senha } = req.body;

    if (!usuario || !senha) {
      return jsonErro(res, 400, 'Informe usuário e senha.');
    }

    const result = await pool.query(
      `SELECT
        u.*,
        u.is_saas_owner,
        e.id AS empresa_id_real,
        e.nome AS empresa_nome_real,
        e.assinatura_status,
        e.bloqueada,
        e.trial_fim,
        p.codigo AS plano_codigo,
        p.nome AS plano_nome
      FROM usuarios u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      LEFT JOIN planos p ON p.id = e.plano_id
      WHERE LOWER(u.usuario) = LOWER($1)`,
      [usuario]
    );

    if (result.rowCount === 0) {
      registrarAuditoria({
        empresa: null, empresa_id: null, usuario_id: null,
        usuario_nome: usuario, modulo: 'acesso', acao: 'login_falha',
        dados_novos: { motivo: 'usuario_nao_encontrado', usuario }, req
      });
      return jsonErro(res, 401, 'Usuário ou senha inválidos.', 'CREDENCIAIS_INVALIDAS');
    }

    const user = result.rows[0];

    // SaaS owner nunca é bloqueado por status de empresa
    if (!user.is_saas_owner) {
      if (user.bloqueada) {
        return jsonErro(res, 403, 'Empresa bloqueada. Entre em contato com o suporte.', 'EMPRESA_BLOQUEADA');
      }

      if (user.assinatura_status === 'inativo' || user.assinatura_status === 'cancelado') {
        return jsonErro(res, 403, 'Assinatura inativa. Regularize o acesso para continuar.', 'ASSINATURA_INATIVA');
      }

      if (user.assinatura_status === 'trial' && user.trial_fim) {
        if (String(user.trial_fim) < hoje()) {
          return jsonErro(res, 403, 'Período de teste expirado. Escolha um plano para continuar.', 'TRIAL_EXPIRADO');
        }
      }
    }

    const senhaOk = await validarSenhaUsuario(senha, user);

    if (!senhaOk) {
      registrarAuditoria({
        empresa: user.empresa_nome_real || user.empresa || null,
        empresa_id: user.empresa_id_real || user.empresa_id || null,
        usuario_id: user.id, usuario_nome: user.usuario,
        modulo: 'acesso', acao: 'login_falha',
        dados_novos: { motivo: 'senha_incorreta' }, req
      });
      return jsonErro(res, 401, 'Usuário ou senha inválidos.', 'CREDENCIAIS_INVALIDAS');
    }

    const nomeCompleto = user.nome_completo || user.usuario;

    const token = jwt.sign(
      {
        id:               user.id,
        usuario:          user.usuario,
        tipo:             user.tipo,
        is_saas_owner:    Boolean(user.is_saas_owner),
        empresa:          user.empresa || null,
        empresa_id:       user.empresa_id_real || user.empresa_id || null,
        empresa_nome:     user.empresa_nome_real || user.empresa || null,
        nome_completo:    nomeCompleto,
        plano_codigo:     user.plano_codigo || null,
        plano_nome:       user.plano_nome || null,
        assinatura_status: user.assinatura_status || null
      },
      SECRET,
      { expiresIn: '12h' }
    );

    registrarAuditoria({
      empresa: user.empresa_nome_real || user.empresa || null,
      empresa_id: user.empresa_id_real || user.empresa_id || null,
      usuario_id: user.id,
      usuario_nome: nomeCompleto,
      modulo: 'acesso',
      acao: 'login',
      req
    });

    res.json({
      token,
      authToken: token,
      empresaId: user.empresa_id_real || user.empresa_id || null,
      empresa: {
        id: user.empresa_id_real || user.empresa_id || null,
        nome: user.empresa_nome_real || user.empresa || null,
        plano: user.plano_codigo || null,
        plano_nome: user.plano_nome || null,
        assinatura_status: user.assinatura_status || null
      },
      user: {
        id: user.id,
        usuario: user.usuario,
        nome: nomeCompleto,
        nome_completo: nomeCompleto,
        perfil: user.tipo,
        tipo: user.tipo,
        empresa: user.empresa_nome_real || user.empresa || null,
        empresa_id: user.empresa_id_real || user.empresa_id || null
      }
    });
  } catch (error) {
    console.error('Erro ao fazer login:', error);
    jsonErro(res, 500, 'Erro ao fazer login');
  }
});

app.post('/auth/refresh', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.*, e.id AS empresa_id_real, e.nome AS empresa_nome_real,
              e.assinatura_status, e.bloqueada,
              p.codigo AS plano_codigo, p.nome AS plano_nome
       FROM usuarios u
       LEFT JOIN empresas e ON e.id = u.empresa_id
       LEFT JOIN planos p ON p.id = e.plano_id
       WHERE u.id = $1 AND u.ativo = true
       LIMIT 1`,
      [req.user.id]
    );
    if (result.rowCount === 0) return jsonErro(res, 403, 'Usuário inativo ou não encontrado');
    const u = result.rows[0];
    if (!u.is_saas_owner && u.bloqueada) return jsonErro(res, 403, 'Empresa bloqueada');
    const novoToken = jwt.sign(
      {
        id:               u.id,
        usuario:          u.usuario,
        tipo:             u.tipo,
        is_saas_owner:    Boolean(u.is_saas_owner),
        empresa:          u.empresa               || null,
        empresa_id:       u.empresa_id_real        || u.empresa_id || null,
        empresa_nome:     u.empresa_nome_real      || u.empresa    || null,
        nome_completo:    u.nome_completo          || u.usuario,
        plano_codigo:     u.plano_codigo           || null,
        plano_nome:       u.plano_nome             || null,
        assinatura_status: u.assinatura_status     || null
      },
      SECRET,
      { expiresIn: '12h' }
    );
    res.json({ sucesso: true, dados: { token: novoToken, authToken: novoToken } });
  } catch (error) {
    console.error('Erro ao renovar token:', error);
    jsonErro(res, 500, 'Erro ao renovar token');
  }
});

app.post('/logout', auth, (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
  if (token) {
    const hash = _tokenHash(token);
    tokenBlacklist.set(hash, Date.now());
    const expiresAt = new Date(Date.now() + JWT_EXPIRY_MS).toISOString();
    pool.query(
      `INSERT INTO jwt_blacklist (token_hash, revoked_at, expires_at)
       VALUES ($1, NOW(), $2) ON CONFLICT DO NOTHING`,
      [hash, expiresAt]
    ).catch((e) => console.warn('[blacklist] Falha ao persistir logout:', e.message));
  }

  registrarAuditoria({
    empresa: req.empresa_nome || null,
    empresa_id: req.empresa_id || null,
    usuario_id: req.user.id,
    usuario_nome: req.user.nome_completo || req.user.usuario,
    modulo: 'acesso',
    acao: 'logout',
    req
  });

  res.json({ sucesso: true });
});

app.put('/me/perfil', auth, async (req, res) => {
  try {
    const { nome_completo, cpf, nascimento } = req.body;

    await pool.query(
      `UPDATE usuarios SET
        nome_completo = COALESCE($1, nome_completo),
        cpf = COALESCE($2, cpf),
        nascimento = COALESCE($3, nascimento),
        atualizado_em = NOW()
       WHERE id = $4`,
      [nome_completo || null, cpf || null, nascimento || null, req.user.id]
    );

    res.json({ sucesso: true, mensagem: 'Perfil atualizado com sucesso' });
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    jsonErro(res, 500, 'Erro ao atualizar perfil');
  }
});

app.put('/me/senha', auth, async (req, res) => {
  try {
    const { senha_atual, nova_senha, confirmar_senha } = req.body;

    if (!senha_atual || !nova_senha || !confirmar_senha) {
      return jsonErro(res, 400, 'Informe a senha atual e a nova senha');
    }

    if (nova_senha !== confirmar_senha) {
      return jsonErro(res, 400, 'A nova senha e a confirmação não conferem');
    }

    const forcaSenha = validarForcaSenha(nova_senha);
    if (!forcaSenha.valido) return jsonErro(res, 400, forcaSenha.mensagem);

    const result = await pool.query(`SELECT senha FROM usuarios WHERE id = $1`, [req.user.id]);
    if (result.rowCount === 0) return jsonErro(res, 404, 'Usuário não encontrado');

    const senhaOk = await validarSenhaUsuario(senha_atual, result.rows[0]);
    if (!senhaOk) return jsonErro(res, 401, 'Senha atual incorreta', 'SENHA_INCORRETA');

    const hash = await bcrypt.hash(nova_senha, 10);
    await pool.query(`UPDATE usuarios SET senha = $1, atualizado_em = NOW() WHERE id = $2`, [hash, req.user.id]);

    registrarAuditoria({
      empresa: req.empresa_nome || null,
      empresa_id: req.empresa_id || null,
      usuario_id: req.user.id,
      usuario_nome: req.user.nome_completo || req.user.usuario,
      modulo: 'acesso', acao: 'troca_senha', req
    });

    res.json({ sucesso: true, mensagem: 'Senha alterada com sucesso' });
  } catch (error) {
    console.error('Erro ao trocar senha:', error);
    jsonErro(res, 500, 'Erro ao alterar senha');
  }
});

app.get('/me/historico-acesso', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT acao, ip, user_agent, criado_em
       FROM logs_auditoria
       WHERE usuario_id = $1 AND modulo = 'acesso'
       ORDER BY criado_em DESC
       LIMIT 20`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar histórico:', error);
    jsonErro(res, 500, 'Erro ao buscar histórico de acesso');
  }
});

app.get('/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
        u.id, u.usuario, u.tipo, u.empresa, u.empresa_id,
        u.nome_completo, u.cpf, u.nascimento,
        e.nome AS empresa_nome_real,
        e.assinatura_status, e.trial_fim, e.bloqueada,
        p.nome AS plano_nome, p.codigo AS plano_codigo
      FROM usuarios u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      LEFT JOIN planos p ON p.id = e.plano_id
      WHERE u.id = $1
      `,
      [req.user.id]
    );

    if (result.rowCount === 0) {
      return jsonErro(res, 404, 'Usuário não encontrado');
    }

    const user = result.rows[0];
    const nomeCompleto = user.nome_completo || user.usuario;

    let dias_restantes_trial = null;
    if (!user.is_saas_owner && user.trial_fim && user.assinatura_status === 'trial') {
      dias_restantes_trial = Math.ceil(
        (new Date(`${user.trial_fim}T00:00:00`) - new Date(`${hoje()}T00:00:00`)) / 86400000
      );
    }

    res.json({
      id: user.id,
      usuario: user.usuario,
      nome: nomeCompleto,
      nome_completo: nomeCompleto,
      perfil: user.tipo,
      tipo: user.tipo,
      empresa: user.empresa_nome_real || user.empresa || null,
      empresa_id: user.empresa_id || null,
      cpf: user.cpf || '',
      nascimento: user.nascimento || '',
      assinatura_status: user.assinatura_status || null,
      trial_fim: user.trial_fim || null,
      dias_restantes_trial,
      plano_nome: user.plano_nome || null,
      plano_codigo: user.plano_codigo || null,
      bloqueada: Boolean(user.bloqueada)
    });
  } catch (error) {
    console.error('Erro ao validar sessão:', error);
    jsonErro(res, 500, 'Erro ao validar sessão');
  }
});

app.get('/empresa/status', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(
      req,
      req.user.empresa_nome || req.user.empresa
    );

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
      SELECT
        e.id,
        e.nome,
        e.assinatura_status,
        e.trial_inicio,
        e.trial_fim,
        e.bloqueada,
        e.motivo_bloqueio,
        p.codigo AS plano_codigo,
        p.nome AS plano_nome,
        p.preco_mensal,
        p.limite_usuarios,
        p.limite_produtos,
        p.limite_clientes,
        p.limite_fornecedores,
        p.limite_vendas_mes,
        p.permite_relatorios_avancados,
        p.permite_suporte_prioritario
      FROM empresas e
      LEFT JOIN planos p ON p.id = e.plano_id
      WHERE e.id = $1
      LIMIT 1
      `,
      [empresaResolvida.id]
    );

    if (result.rowCount === 0) {
      return jsonErro(res, 404, 'Empresa não encontrada');
    }

    const empresa = result.rows[0];

    const [usuariosResult, produtosResult, clientesResult, fornecedoresResult, vendasMesResult] =
      await Promise.all([
        pool.query(`SELECT COUNT(*) AS total FROM usuarios WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`, [
          empresaResolvida.id, empresaResolvida.nome
        ]),
        pool.query(`SELECT COUNT(*) AS total FROM produtos WHERE deletado_em IS NULL AND (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`, [
          empresaResolvida.id, empresaResolvida.nome
        ]),
        pool.query(`SELECT COUNT(*) AS total FROM clientes WHERE deletado_em IS NULL AND (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`, [
          empresaResolvida.id, empresaResolvida.nome
        ]),
        pool.query(`SELECT COUNT(*) AS total FROM fornecedores WHERE deletado_em IS NULL AND (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`, [
          empresaResolvida.id, empresaResolvida.nome
        ]),
        pool.query(
          `
        SELECT COUNT(*) AS total
        FROM vendas
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
          AND data >= $3
          AND data <= $4
        `,
          [empresaResolvida.id, empresaResolvida.nome, hoje().slice(0, 8) + '01', hoje()]
        )
      ]);

    const trialFim = empresa.trial_fim || null;
    let dias_restantes_trial = null;

    if (trialFim) {
      const hojeData = new Date(`${hoje()}T00:00:00`);
      const fimData = new Date(`${trialFim}T00:00:00`);
      dias_restantes_trial = Math.ceil((fimData - hojeData) / (1000 * 60 * 60 * 24));
    }

    function montarUso(total, limite) {
      const usado = Number(total || 0);
      const maximo = Number(limite || 0);
      const percentual = maximo > 0 ? Math.round((usado / maximo) * 100) : 0;

      return {
        usado,
        limite: maximo,
        percentual,
        alerta: maximo > 0 && percentual >= 80,
        bloqueado: maximo > 0 && usado >= maximo
      };
    }

    res.json({
      empresa: {
        id: empresa.id,
        nome: empresa.nome,
        bloqueada: Boolean(empresa.bloqueada),
        motivo_bloqueio: empresa.motivo_bloqueio || ''
      },
      assinatura: {
        status: empresa.assinatura_status || 'trial',
        trial_inicio: empresa.trial_inicio || null,
        trial_fim: trialFim,
        dias_restantes_trial
      },
      plano: {
        codigo: empresa.plano_codigo || 'sem_plano',
        nome: empresa.plano_nome || 'Sem plano',
        preco_mensal: Number(empresa.preco_mensal || 0),
        permite_relatorios_avancados: Boolean(empresa.permite_relatorios_avancados),
        permite_suporte_prioritario: Boolean(empresa.permite_suporte_prioritario)
      },
      uso: {
        usuarios: montarUso(usuariosResult.rows[0].total, empresa.limite_usuarios),
        produtos: montarUso(produtosResult.rows[0].total, empresa.limite_produtos),
        clientes: montarUso(clientesResult.rows[0].total, empresa.limite_clientes),
        fornecedores: montarUso(fornecedoresResult.rows[0].total, empresa.limite_fornecedores),
        vendas_mes: montarUso(vendasMesResult.rows[0].total, empresa.limite_vendas_mes)
      }
    });
  } catch (error) {
    console.error('Erro ao carregar status da empresa:', error);
    jsonErro(res, 500, 'Erro ao carregar status da empresa');
  }
});

// ================= USUÁRIOS =================

// LISTAR USUÁRIOS
app.get('/usuarios/:empresa', auth, requirePermissao(pool, 'usuarios', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!podeGerenciarUsuarios(req)) {
      return jsonErro(res, 403, 'Sem permissão para acessar usuários');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          id,
          COALESCE(nome_completo, usuario) AS nome,
          usuario,
          tipo,
          empresa,
          criado_em,
          atualizado_em
        FROM usuarios
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
        ORDER BY id DESC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    jsonErro(res, 500, 'Erro ao listar usuários');
  }
});

// CRIAR USUÁRIO
app.post('/usuarios', auth, writeRateLimiter, requirePermissao(pool, 'usuarios', 'criar'), async (req, res) => {
  try {
    const { empresa, empresa_id, nome, usuario, senha, tipo } = req.body;

    if (!podeGerenciarUsuarios(req)) {
      return jsonErro(res, 403, 'Sem permissão para cadastrar usuários');
    }

    if (!nome || !usuario || !senha || !tipo) {
      return jsonErro(res, 400, 'Dados obrigatórios');
    }

    const forcaSenha = validarForcaSenha(senha.trim());
    if (!forcaSenha.valido) return jsonErro(res, 400, forcaSenha.mensagem);

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const limitePlano = await validarLimitePlano({
      empresaResolvida,
      recurso: 'usuarios'
    });

    if (!limitePlano.permitido) {
      return jsonErro(res, 403, limitePlano.mensagem);
    }

    const usuarioExiste = await pool.query(`SELECT id FROM usuarios WHERE usuario = $1`, [
      usuario.trim()
    ]);

    if (usuarioExiste.rowCount > 0) {
      return jsonErro(res, 400, 'Usuário já existe');
    }

    const senhaHash = await bcrypt.hash(senha.trim(), 10);

    const result = await pool.query(
      `
        INSERT INTO usuarios
        (empresa, nome_completo, usuario, senha, tipo, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        RETURNING id
        `,
      [empresaResolvida.nome, nome.trim(), usuario.trim(), senhaHash, tipo]
    );

    await pool.query(
      `UPDATE usuarios
        SET empresa_id = $1
        WHERE id = $2`,
      [empresaResolvida.id, result.rows[0].id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    jsonErro(res, 500, 'Erro ao criar usuário');
  }
});

// ATUALIZAR USUÁRIO
app.put('/usuarios/:id', auth, writeRateLimiter, requirePermissao(pool, 'usuarios', 'editar'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { empresa, empresa_id, nome, usuario, senha, tipo } = req.body;

    if (!podeGerenciarUsuarios(req)) {
      return jsonErro(res, 403, 'Sem permissão para editar usuários');
    }

    if (!nome || !usuario || !tipo) {
      return jsonErro(res, 400, 'Dados obrigatórios');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const atualResult = await pool.query(
      `SELECT * FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    if (atualResult.rowCount === 0) {
      return jsonErro(res, 404, 'Usuário não encontrado');
    }

    const usuarioDuplicado = await pool.query(
      `SELECT id FROM usuarios WHERE usuario = $1 AND id <> $2`,
      [usuario.trim(), id]
    );

    if (usuarioDuplicado.rowCount > 0) {
      return jsonErro(res, 400, 'Já existe outro usuário com esse login');
    }

    if (senha && senha.trim()) {
      const forcaSenha = validarForcaSenha(senha.trim());
      if (!forcaSenha.valido) return jsonErro(res, 400, forcaSenha.mensagem);

      const senhaHash = await bcrypt.hash(senha.trim(), 10);

      await pool.query(
        `
          UPDATE usuarios
          SET nome_completo = $1,
              usuario = $2,
              senha = $3,
              tipo = $4,
              atualizado_em = NOW()
          WHERE id = $5 AND (empresa_id = $6 OR (empresa_id IS NULL AND empresa = $7))
          `,
        [nome.trim(), usuario.trim(), senhaHash, tipo, id, empresaResolvida.id, empresaResolvida.nome]
      );
    } else {
      await pool.query(
        `
          UPDATE usuarios
          SET nome_completo = $1,
              usuario = $2,
              tipo = $3,
              atualizado_em = NOW()
          WHERE id = $4 AND (empresa_id = $5 OR (empresa_id IS NULL AND empresa = $6))
          `,
        [nome.trim(), usuario.trim(), tipo, id, empresaResolvida.id, empresaResolvida.nome]
      );
    }

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao atualizar usuário:', error);
    jsonErro(res, 500, 'Erro ao atualizar usuário');
  }
});

// EXCLUIR USUÁRIO
app.delete('/usuarios/:id', auth, writeRateLimiter, requirePermissao(pool, 'usuarios', 'deletar'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const empresa = req.query.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!podeGerenciarUsuarios(req)) {
      return jsonErro(res, 403, 'Sem permissão para excluir usuários');
    }

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (req.user.id === id) {
      return jsonErro(res, 400, 'Você não pode excluir o próprio usuário');
    }

    const existe = await pool.query(
      `SELECT id FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    if (existe.rowCount === 0) {
      return jsonErro(res, 404, 'Usuário não encontrado');
    }

    await pool.query(
      `DELETE FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao excluir usuário:', error);
    jsonErro(res, 500, 'Erro ao excluir usuário');
  }
});

// GET /usuarios/:id/permissoes — retorna permissões do usuário (individuais + defaults do tipo)
app.get('/usuarios/:id/permissoes', auth, requirePermissao(pool, 'usuarios', 'ver'), async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) return jsonErro(res, 403, 'Sem permissão');

    const id = Number(req.params.id);
    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const usuarioResult = await pool.query(
      `SELECT tipo FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );
    if (usuarioResult.rowCount === 0) return jsonErro(res, 404, 'Usuário não encontrado');

    const tipo = usuarioResult.rows[0].tipo;

    const [individuaisResult, padraoResult] = await Promise.all([
      pool.query(
        `SELECT modulo, pode_ver, pode_criar, pode_editar, pode_deletar
         FROM permissoes_usuario WHERE usuario_id = $1 AND (empresa_id = $2 OR empresa_id IS NULL)`,
        [id, empresaResolvida.id]
      ),
      pool.query(
        `SELECT modulo, pode_ver, pode_criar, pode_editar, pode_deletar
         FROM permissoes_padrao WHERE tipo_usuario = $1`,
        [tipo]
      )
    ]);

    const mapPadrao     = Object.fromEntries(padraoResult.rows.map((r) => [r.modulo, r]));
    const mapIndividual = Object.fromEntries(individuaisResult.rows.map((r) => [r.modulo, r]));

    const MODULOS = ['produtos','clientes','fornecedores','compras','vendas','estoque',
                     'financeiro','relatorios','dre','lucratividade','usuarios','configuracoes'];
    const permissoes = {};
    for (const m of MODULOS) {
      const ind = mapIndividual[m];
      const pad = mapPadrao[m] || { pode_ver: false, pode_criar: false, pode_editar: false, pode_deletar: false };
      permissoes[m] = {
        pode_ver:     ind?.pode_ver     ?? pad.pode_ver,
        pode_criar:   ind?.pode_criar   ?? pad.pode_criar,
        pode_editar:  ind?.pode_editar  ?? pad.pode_editar,
        pode_deletar: ind?.pode_deletar ?? pad.pode_deletar,
        override: !!ind
      };
    }

    res.json({ sucesso: true, permissoes, tipo });
  } catch (err) {
    console.error('[permissoes GET]', err.message);
    jsonErro(res, 500, 'Erro ao carregar permissões');
  }
});

// PUT /usuarios/:id/permissoes — grava overrides individuais
app.put('/usuarios/:id/permissoes', auth, writeRateLimiter, requirePermissao(pool, 'usuarios', 'editar'), async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) return jsonErro(res, 403, 'Sem permissão');

    const id = Number(req.params.id);
    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const usuarioResult = await pool.query(
      `SELECT id FROM usuarios WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
      [id, empresaResolvida.id, empresaResolvida.nome]
    );
    if (usuarioResult.rowCount === 0) return jsonErro(res, 404, 'Usuário não encontrado');

    const { permissoes } = req.body;
    if (!permissoes || typeof permissoes !== 'object') return jsonErro(res, 400, 'Dados inválidos');

    const MODULOS = ['produtos','clientes','fornecedores','compras','vendas','estoque',
                     'financeiro','relatorios','dre','lucratividade','usuarios','configuracoes'];

    for (const modulo of MODULOS) {
      if (!permissoes[modulo]) continue;
      const p = permissoes[modulo];
      if (p.usar_padrao) {
        await pool.query(
          `DELETE FROM permissoes_usuario WHERE usuario_id = $1 AND empresa_id = $2 AND modulo = $3`,
          [id, empresaResolvida.id, modulo]
        );
      } else {
        await pool.query(
          `INSERT INTO permissoes_usuario (usuario_id, empresa_id, modulo, pode_ver, pode_criar, pode_editar, pode_deletar)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (usuario_id, empresa_id, modulo)
           DO UPDATE SET pode_ver=$4, pode_criar=$5, pode_editar=$6, pode_deletar=$7`,
          [id, empresaResolvida.id, modulo,
           !!p.pode_ver, !!p.pode_criar, !!p.pode_editar, !!p.pode_deletar]
        );
      }
    }

    res.json({ sucesso: true });
  } catch (err) {
    console.error('[permissoes PUT]', err.message);
    jsonErro(res, 500, 'Erro ao salvar permissões');
  }
});

// ── Lixeira (soft delete recovery) ──────────────────────────────────────────

const TABELAS_LIXEIRA = new Set(['produtos', 'clientes', 'fornecedores']);

// GET /lixeira — lista registros deletados da empresa
app.get('/lixeira', auth, async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const eId   = empresaResolvida.id;
    const eNome = empresaResolvida.nome;

    const [produtosR, clientesR, fornecedoresR] = await Promise.all([
      pool.query(
        `SELECT id, nome, categoria, deletado_em FROM produtos
         WHERE (empresa_id = $1 OR empresa = $2) AND deletado_em IS NOT NULL
         ORDER BY deletado_em DESC LIMIT 200`,
        [eId, eNome]
      ),
      pool.query(
        `SELECT id, nome, telefone, email, deletado_em FROM clientes
         WHERE (empresa_id = $1 OR empresa = $2) AND deletado_em IS NOT NULL
         ORDER BY deletado_em DESC LIMIT 200`,
        [eId, eNome]
      ),
      pool.query(
        `SELECT id, nome, telefone, email, deletado_em FROM fornecedores
         WHERE (empresa_id = $1 OR empresa = $2) AND deletado_em IS NOT NULL
         ORDER BY deletado_em DESC LIMIT 200`,
        [eId, eNome]
      )
    ]);

    res.json({
      sucesso: true,
      produtos:     produtosR.rows,
      clientes:     clientesR.rows,
      fornecedores: fornecedoresR.rows,
      total: produtosR.rowCount + clientesR.rowCount + fornecedoresR.rowCount
    });
  } catch (err) {
    console.error('[lixeira GET]', err.message);
    jsonErro(res, 500, 'Erro ao carregar lixeira');
  }
});

// PUT /lixeira/recuperar/:tabela/:id — restaura registro (deletado_em = NULL)
app.put('/lixeira/recuperar/:tabela/:id', auth, writeRateLimiter, async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

    const { tabela, id } = req.params;
    if (!TABELAS_LIXEIRA.has(tabela)) return jsonErro(res, 400, 'Tabela inválida');

    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const eId   = empresaResolvida.id;
    const eNome = empresaResolvida.nome;

    const result = await pool.query(
      `UPDATE ${tabela}
       SET deletado_em = NULL, atualizado_em = NOW()
       WHERE id = $1
         AND (empresa_id = $2 OR empresa = $3)
         AND deletado_em IS NOT NULL
       RETURNING id, nome`,
      [Number(id), eId, eNome]
    );

    if (result.rowCount === 0) return jsonErro(res, 404, 'Registro não encontrado na lixeira');

    registrarAuditoria({
      empresa: eNome, empresa_id: eId,
      usuario_id: req.user.id, usuario_nome: req.user.nome || '',
      modulo: tabela, acao: 'recuperar',
      referencia_id: Number(id), req
    });

    res.json({ sucesso: true, registro: result.rows[0] });
  } catch (err) {
    console.error('[lixeira recuperar]', err.message);
    jsonErro(res, 500, 'Erro ao recuperar registro');
  }
});

// DELETE /lixeira/excluir/:tabela/:id — exclusão permanente (somente admin)
app.delete('/lixeira/excluir/:tabela/:id', auth, writeRateLimiter, async (req, res) => {
  try {
    if (req.user.tipo !== 'admin' && !req.user.is_saas_owner) {
      return jsonErro(res, 403, 'Exclusão permanente restrita a administradores');
    }

    const { tabela, id } = req.params;
    if (!TABELAS_LIXEIRA.has(tabela)) return jsonErro(res, 400, 'Tabela inválida');

    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const eId   = empresaResolvida.id;
    const eNome = empresaResolvida.nome;

    const result = await pool.query(
      `DELETE FROM ${tabela}
       WHERE id = $1
         AND (empresa_id = $2 OR empresa = $3)
         AND deletado_em IS NOT NULL
       RETURNING id`,
      [Number(id), eId, eNome]
    );

    if (result.rowCount === 0) return jsonErro(res, 404, 'Registro não encontrado na lixeira');

    registrarAuditoria({
      empresa: eNome, empresa_id: eId,
      usuario_id: req.user.id, usuario_nome: req.user.nome || '',
      modulo: tabela, acao: 'exclusao_permanente',
      referencia_id: Number(id), req
    });

    res.json({ sucesso: true });
  } catch (err) {
    console.error('[lixeira excluir]', err.message);
    jsonErro(res, 500, 'Erro ao excluir permanentemente');
  }
});

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
      sql += `
          AND (
            LOWER(COALESCE(f.nome, '')) LIKE $${idx}
            OR LOWER(COALESCE(c.observacao, '')) LIKE $${idx}
            OR CAST(c.id AS TEXT) LIKE $${idx}
          )
        `;
      params.push(`%${busca}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'c.data',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    sql += ` ORDER BY c.id DESC`;

    const result = await pool.query(sql, params);
    res.json(
      result.rows.map((row) => ({
        ...row,
        total: Number(row.total || 0)
      }))
    );
  } catch (error) {
    jsonErro(res, 500, 'Erro ao buscar compras');
  }
});

app.delete('/compras/:id', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'deletar'), async (req, res) => {
  const empresa = req.query.empresa || req.body.empresa || null;
  const empresaResolvida = await validarAcessoEmpresa(req, empresa);

  if (!empresaResolvida) {
    return jsonErro(res, 403, 'Sem acesso');
  }

  const client = await pool.connect();

  try {
    if (!podeGerenciarCompras(req)) {
      return jsonErro(res, 403, 'Sem permissão para excluir compras');
    }

    const id = Number(req.params.id);

    if (!id) {
      return jsonErro(res, 400, 'Compra inválida');
    }

    await client.query('BEGIN');

    const compraResult = await client.query(
      `
      SELECT *
      FROM compras
      WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
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
      ORDER BY id ASC
      `,
      [id]
    );

    for (const item of itensResult.rows) {
      const produtoResult = await client.query(
        `
        SELECT *
        FROM produtos
        WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        `,
        [item.produto_id, empresaResolvida.id, empresaResolvida.nome]
      );

      if (produtoResult.rowCount > 0) {
        const produto = produtoResult.rows[0];
        const estoqueAtual = normalizarInt(produto.estoque);
        const quantidadeItem = normalizarInt(item.quantidade);
        const novoEstoque = Math.max(0, estoqueAtual - quantidadeItem);

        await client.query(
          `
          UPDATE produtos
          SET estoque = $1,
              atualizado_em = NOW()
          WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
          `,
          [novoEstoque, item.produto_id, empresaResolvida.id, empresaResolvida.nome]
        );
      }
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
      `,
      [id]
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
    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id);

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
      `SELECT * FROM compra_itens WHERE compra_id = $1 ORDER BY id ASC`,
      [id]
    );

    const contasPagarResult = await pool.query(
      `SELECT * FROM contas_pagar WHERE compra_id = $1 ORDER BY parcela ASC, id ASC`,
      [id]
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
    jsonErro(res, 500, 'Erro ao buscar resumo de estoque');
  }
});

app.get('/compras-fornecedores/:empresa', auth, async (req, res) => {
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
        LEFT JOIN compras c ON c.fornecedor_id = f.id AND (c.empresa_id = f.empresa_id OR c.empresa = f.empresa)
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
    jsonErro(res, 500, 'Erro ao buscar resumo de compras por fornecedor');
  }
});

app.get('/vendas-clientes/:empresa', auth, async (req, res) => {
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
    jsonErro(res, 500, 'Erro ao buscar resumo de vendas por cliente');
  }
});

// ================= CONTAS A RECEBER =================
app.get('/contas-receber-clientes/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          id,
          nome
        FROM clientes
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
          AND deletado_em IS NULL
        ORDER BY nome ASC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar clientes de contas a receber:', error);
    jsonErro(res, 500, 'Erro ao buscar clientes');
  }
});

app.get('/contas-receber/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id);

    const status = (req.query.status || '').trim().toLowerCase();
    const cliente = (req.query.cliente || '').trim().toLowerCase();
    const clienteId = normalizarInt(req.query.cliente_id || 0);
    const busca = (req.query.busca || '').trim().toLowerCase();
    const { dataInicial, dataFinal } = obterPeriodo(req);

    let sql = `
      SELECT
        cr.*,
        v.id AS venda_origem_id,
        v.data AS venda_data,
        v.total AS venda_total,
        v.pagamento AS venda_pagamento,
        CASE
          WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'pago' THEN 'pago'
          WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'parcial'
  AND cr.data_vencimento IS NOT NULL
  AND cr.data_vencimento < $2
THEN 'parcial_atrasado'

WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'parcial'
THEN 'parcial'

WHEN cr.data_vencimento IS NOT NULL
  AND cr.data_vencimento < $2
THEN 'atrasado'
          ELSE 'pendente'
        END AS status_exibicao
      FROM contas_receber cr
      LEFT JOIN vendas v
        ON v.id = cr.venda_id
       AND v.empresa = cr.empresa
      WHERE cr.empresa = $1
        AND (cr.empresa_id IS NULL OR cr.empresa_id = $3)
    `;

    const params = [empresaResolvida.nome, hoje(), empresaResolvida.id];
    let idx = 4;

    if (status === 'pago') {
      sql += ` AND LOWER(COALESCE(cr.status, 'pendente')) = 'pago' `;
    } else if (status === 'pendente') {
      sql += `
        AND LOWER(COALESCE(cr.status, 'pendente')) <> 'pago'
        AND (cr.data_vencimento IS NULL OR cr.data_vencimento >= $2)
      `;
    } else if (status === 'atrasado') {
      sql += `
        AND LOWER(COALESCE(cr.status, 'pendente')) <> 'pago'
        AND cr.data_vencimento IS NOT NULL
        AND cr.data_vencimento < $2
      `;
    }

    if (clienteId > 0) {
      sql += ` AND cr.cliente_id = $${idx} `;
      params.push(clienteId);
      idx++;
    }

    if (cliente) {
      sql += ` AND LOWER(COALESCE(cr.cliente_nome, '')) LIKE $${idx} `;
      params.push(`%${cliente}%`);
      idx++;
    }

    if (busca) {
      sql += `
        AND (
          LOWER(COALESCE(cr.cliente_nome, '')) LIKE $${idx}
          OR LOWER(COALESCE(cr.observacao, '')) LIKE $${idx}
          OR CAST(cr.id AS TEXT) LIKE $${idx}
          OR CAST(cr.venda_id AS TEXT) LIKE $${idx}
        )
      `;
      params.push(`%${busca}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'cr.data_vencimento',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const pagina = Math.max(1, normalizarInt(req.query.page || 1));
    const limite = Math.min(normalizarInt(req.query.limit || 50), 200);

    const filterParamsCR = [...params];
    const resumoGlobalSqlCR = `
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(q.valor),0)::numeric AS total_valor,
        COALESCE(SUM(CASE WHEN q.status_exibicao='pago' THEN q.valor ELSE 0 END),0)::numeric AS total_pago,
        COALESCE(SUM(CASE WHEN q.status_exibicao IN ('atrasado','parcial_atrasado') THEN q.valor ELSE 0 END),0)::numeric AS total_atrasado,
        COALESCE(SUM(CASE WHEN q.status_exibicao NOT IN ('pago','atrasado','parcial_atrasado') THEN q.valor ELSE 0 END),0)::numeric AS total_pendente,
        COUNT(CASE WHEN q.status_exibicao='pago' THEN 1 END)::int AS qtd_pago,
        COUNT(CASE WHEN q.status_exibicao IN ('atrasado','parcial_atrasado') THEN 1 END)::int AS qtd_atrasado,
        COUNT(CASE WHEN q.status_exibicao NOT IN ('pago','atrasado','parcial_atrasado') THEN 1 END)::int AS qtd_pendente
      FROM (${sql}) AS q
    `;

    const offset = (pagina - 1) * limite;
    const sqlPaginado = sql + ` ORDER BY cr.id DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(limite, offset);

    const [result, resumoGlobalResult] = await Promise.all([
      pool.query(sqlPaginado, params),
      pool.query(resumoGlobalSqlCR, filterParamsCR)
    ]);

    const recebidosParciaisResult = await pool.query(
      `
  SELECT COALESCE(SUM(lf.valor), 0) AS total
  FROM lancamentos_financeiros lf
  WHERE (
    lf.empresa = $1
    OR lf.empresa_id = $2
  )
    AND LOWER(COALESCE(lf.tipo, '')) = 'receita'
    AND LOWER(COALESCE(lf.status, 'pendente')) = 'pago'
    AND LOWER(COALESCE(lf.categoria, '')) = 'contas_receber'
    AND lf.pagamento_data IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM contas_receber cr
      WHERE (
        (lf.conta_receber_id IS NOT NULL AND cr.id = lf.conta_receber_id)
        OR (lf.conta_receber_id IS NULL AND cr.id = CASE WHEN REGEXP_REPLACE(lf.descricao, '\D', '', 'g') ~ '^[1-9][0-9]*$' THEN REGEXP_REPLACE(lf.descricao, '\D', '', 'g')::INTEGER ELSE NULL END)
      )
        AND cr.empresa = lf.empresa
    )
  `,
      [empresaResolvida.nome, empresaResolvida.id]
    );

    const contas = result.rows.map((row) => ({
      ...row,
      valor: Number(row.valor || 0),
      parcela: Number(row.parcela || 1),
      total_parcelas: Number(row.total_parcelas || 1),
      venda_total: Number(row.venda_total || 0),
      status: row.status_exibicao
    }));

    const rg = resumoGlobalResult.rows[0];
    const resumo = {
      total:                 Number(rg.total_valor || 0),
      total_pago:            Number(rg.total_pago || 0),
      total_pendente:        Number(rg.total_pendente || 0),
      total_atrasado:        Number(rg.total_atrasado || 0),
      total_recebido_parcial: Number(recebidosParciaisResult.rows[0].total || 0),
      qtd_pago:              Number(rg.qtd_pago || 0),
      qtd_pendente:          Number(rg.qtd_pendente || 0),
      qtd_atrasado:          Number(rg.qtd_atrasado || 0)
    };

    const totalRegistros = Number(rg.total || 0);
    res.json({
      contas,
      resumo,
      paginacao: {
        pagina,
        limite,
        total: totalRegistros,
        total_paginas: Math.ceil(totalRegistros / limite) || 1
      }
    });
  } catch (error) {
    console.error('Erro ao buscar contas a receber:', error);
    jsonErro(res, 500, 'Erro ao buscar contas a receber');
  }
});

app.get('/contas-receber/detalhe/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    let _detParams = [id, hoje()];
    let _detEmpresaWhere = '';
    if (!req.user.is_saas_owner) {
      _detParams = [..._detParams, req.user.empresa_id || 0, req.user.empresa || ''];
      _detEmpresaWhere = `AND (cr.empresa_id = $3 OR (cr.empresa_id IS NULL AND cr.empresa = $4))`;
    }

    const contaResult = await pool.query(
      `
        SELECT
          cr.*,
          CASE
            WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'pago'
THEN 'pago'

WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'parcial'
  AND cr.data_vencimento IS NOT NULL
  AND cr.data_vencimento < $2
THEN 'parcial_atrasado'

WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'parcial'
THEN 'parcial'

WHEN cr.data_vencimento IS NOT NULL
  AND cr.data_vencimento < $2
THEN 'atrasado'

ELSE 'pendente'
          END AS status_exibicao
        FROM contas_receber cr
        WHERE cr.id = $1 ${_detEmpresaWhere}
        LIMIT 1
        `,
      _detParams
    );

    if (contaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id)) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    res.json({
      ...conta,
      valor: Number(conta.valor || 0),
      parcela: Number(conta.parcela || 1),
      total_parcelas: Number(conta.total_parcelas || 1),
      status: conta.status_exibicao
    });
  } catch (error) {
    console.error('Erro ao buscar detalhe da conta:', error);
    jsonErro(res, 500, 'Erro ao buscar detalhe da conta');
  }
});

app.get('/contas-receber/origem-venda/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = req.user.is_saas_owner
      ? await pool.query(`SELECT * FROM contas_receber WHERE id = $1 LIMIT 1`, [id])
      : await pool.query(
          `SELECT * FROM contas_receber WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
          [id, req.user.empresa_id || 0, req.user.empresa || '']
        );

    if (contaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id)) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (!conta.venda_id) {
      return jsonErro(res, 404, 'Esta conta não possui venda de origem');
    }

    const vendaResult = await pool.query(
      `
        SELECT *
        FROM vendas
        WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        LIMIT 1
        `,
      [conta.venda_id, conta.empresa_id, conta.empresa]
    );

    if (vendaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Venda de origem não encontrada');
    }

    const itensResult = await pool.query(
      `
        SELECT
          vi.*,
          p.categoria,
          p.codigo_barras
        FROM venda_itens vi
        LEFT JOIN produtos p
          ON p.id = vi.produto_id
          AND (p.empresa_id = vi.empresa_id OR p.empresa = vi.empresa)
        WHERE vi.venda_id = $1 AND (vi.empresa_id = $2 OR (vi.empresa_id IS NULL AND vi.empresa = $3))
        ORDER BY vi.id ASC
        `,
      [conta.venda_id, conta.empresa_id, conta.empresa]
    );

    const parcelasResult = await pool.query(
      `
        SELECT *
        FROM contas_receber
        WHERE venda_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        ORDER BY parcela ASC, id ASC
        `,
      [conta.venda_id, conta.empresa_id, conta.empresa]
    );

    res.json({
      conta: {
        ...conta,
        valor: Number(conta.valor || 0),
        parcela: Number(conta.parcela || 1),
        total_parcelas: Number(conta.total_parcelas || 1)
      },
      venda: {
        ...vendaResult.rows[0],
        subtotal: Number(vendaResult.rows[0].subtotal || 0),
        desconto: Number(vendaResult.rows[0].desconto || 0),
        acrescimo: Number(vendaResult.rows[0].acrescimo || 0),
        total: Number(vendaResult.rows[0].total || 0),
        parcelas: Number(vendaResult.rows[0].parcelas || 1)
      },
      itens: itensResult.rows.map((item) => ({
        ...item,
        quantidade: Number(item.quantidade || 0),
        preco_unitario: Number(item.preco_unitario || 0),
        custo_unitario: Number(item.custo_unitario || 0),
        total: Number(item.total || 0)
      })),
      parcelas: parcelasResult.rows.map((item) => ({
        ...item,
        valor: Number(item.valor || 0),
        parcela: Number(item.parcela || 1),
        total_parcelas: Number(item.total_parcelas || 1)
      }))
    });
  } catch (error) {
    console.error('Erro ao buscar origem da venda:', error);
    jsonErro(res, 500, 'Erro ao buscar origem da venda');
  }
});

// ================= HISTÓRICO FINANCEIRO DO CLIENTE =================
app.get('/contas-receber/cliente-historico/:clienteId', auth, async (req, res) => {
  try {
    const clienteId = Number(req.params.clienteId);

    if (!clienteId) {
      return jsonErro(res, 400, 'Cliente inválido');
    }

    const _chEmpresaId = req.is_saas_owner ? null : (req.empresa_id || null);
    const _chEmpresaWhere = _chEmpresaId ? 'AND empresa_id = $2' : '';
    const _chParams = _chEmpresaId ? [clienteId, _chEmpresaId] : [clienteId];

    const clienteResult = await pool.query(
      `SELECT * FROM clientes WHERE id = $1 AND deletado_em IS NULL ${_chEmpresaWhere} LIMIT 1`,
      _chParams
    );

    if (clienteResult.rowCount === 0) {
      return jsonErro(res, 404, 'Cliente não encontrado');
    }

    const cliente = clienteResult.rows[0];

    const empresaResolvida = await validarAcessoEmpresa(req, cliente.empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id);

    const contasResult = await pool.query(
      `
      SELECT
        *,
        CASE
          WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
          WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial'
  AND data_vencimento IS NOT NULL
  AND data_vencimento < $4
THEN 'parcial_atrasado'

WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial'
THEN 'parcial'

WHEN data_vencimento IS NOT NULL
  AND data_vencimento < $4
THEN 'atrasado'
          ELSE 'pendente'
        END AS status_exibicao
      FROM contas_receber
      WHERE cliente_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      ORDER BY id DESC
      `,
      [clienteId, empresaResolvida.id, empresaResolvida.nome, hoje()]
    );

    const contas = contasResult.rows.map((conta) => ({
      ...conta,
      valor: Number(conta.valor || 0),
      status: conta.status_exibicao
    }));

    const recebimentosParciaisResult = await pool.query(
      `
  SELECT COALESCE(SUM(lf.valor), 0) AS total
  FROM lancamentos_financeiros lf
  WHERE (
    lf.empresa = $1
    OR lf.empresa_id = $2
  )
    AND LOWER(COALESCE(lf.tipo, '')) = 'receita'
    AND LOWER(COALESCE(lf.status, '')) = 'pago'
    AND LOWER(COALESCE(lf.categoria, '')) = 'contas_receber'
    AND lf.pagamento_data IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM contas_receber cr
      WHERE cr.cliente_id = $3
        AND cr.empresa = $1
        AND (
          (lf.conta_receber_id IS NOT NULL AND cr.id = lf.conta_receber_id)
          OR (lf.conta_receber_id IS NULL AND cr.id = CASE WHEN REGEXP_REPLACE(lf.descricao, '\D', '', 'g') ~ '^[1-9][0-9]*$' THEN REGEXP_REPLACE(lf.descricao, '\D', '', 'g')::INTEGER ELSE NULL END)
        )
    )
  `,
      [empresaResolvida.nome, empresaResolvida.id, clienteId]
    );

    const resumo = contas.reduce(
      (acc, conta) => {
        acc.total += conta.valor;

        if (conta.status === 'pago') {
          acc.total_pago += conta.valor;
        } else if (conta.status === 'parcial') {
          acc.total_parcial += conta.valor;
          acc.total_pendente += conta.valor;
        } else if (conta.status === 'parcial_atrasado') {
          acc.total_parcial += conta.valor;
          acc.total_atrasado += conta.valor;
        } else if (conta.status === 'atrasado') {
          acc.total_atrasado += conta.valor;
        } else {
          acc.total_pendente += conta.valor;
        }

        return acc;
      },
      {
        total: 0,
        total_pago: 0,
        total_pendente: 0,
        total_atrasado: 0,
        total_parcial: 0,
        total_recebido_parcial: Number(recebimentosParciaisResult.rows[0].total || 0)
      }
    );

    res.json({
      cliente: {
        id: cliente.id,
        nome: cliente.nome,
        telefone: cliente.telefone || null
      },
      resumo,
      contas
    });
  } catch (error) {
    console.error('Erro ao buscar histórico do cliente:', error);
    jsonErro(res, 500, 'Erro ao buscar histórico do cliente');
  }
});

app.post('/contas-receber/pagar/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) return jsonErro(res, 400, 'ID inválido');

  const client = await pool.connect();
  try {

    await client.query('BEGIN');

    const contaResult = await client.query(
      `SELECT * FROM contas_receber
       WHERE id = $1
         AND (empresa_id = $2 OR empresa = $3)
       FOR UPDATE`,
      [id, req.empresa_id, req.empresa_nome]
    );

    if (contaResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

    if (!empresaResolvida) {
      await client.query('ROLLBACK');
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (String(conta.status || '').toLowerCase() === 'pago') {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, 'Esta conta já está paga');
    }

    const valorAtual = normalizarDecimal(conta.valor || 0);
    const valorPagoInformado = normalizarDecimal(req.body?.valor_pago || 0);
    const valorPago = valorPagoInformado > 0 ? valorPagoInformado : valorAtual;

    if (valorPago <= 0) {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, 'Valor de pagamento inválido');
    }

    if (valorPago > valorAtual) {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, 'Valor pago não pode ser maior que o saldo da conta');
    }

    const dataPagamento = normalizarDataISO(req.body?.data_pagamento) || hoje();

    const pagamentoTotal = valorPago >= valorAtual;
    const novoValor = pagamentoTotal ? valorAtual : Number((valorAtual - valorPago).toFixed(2));
    const novoStatus = pagamentoTotal ? 'pago' : 'parcial';

    await client.query(
      `
      UPDATE contas_receber
      SET status = $1,
          valor_original = COALESCE(valor_original, valor),
          valor = $2,
          data_pagamento = CASE WHEN $1 = 'pago' THEN $3 ELSE data_pagamento END,
          atualizado_em = NOW()
      WHERE id = $4 AND (empresa_id = $5 OR empresa = $6)
      `,
      [novoStatus, novoValor, dataPagamento, id, empresaResolvida.id, empresaResolvida.nome]
    );

    if (!pagamentoTotal) {
      await client.query(
        `
        INSERT INTO lancamentos_financeiros (
  empresa,
  empresa_id,
  tipo,
  categoria,
  descricao,
  valor,
  status,
  vencimento,
  pagamento_data,
  observacao,
  conta_receber_id,
  criado_em,
  atualizado_em
)
VALUES (
  $1,
  $2,
  'receita',
  'contas_receber',
  $3,
  $4,
  'pago',
  $5,
  $5,
  $6,
  $7,
  NOW(),
  NOW()
)
        `,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          `Recebimento parcial da conta #${id}`,
          valorPago,
          dataPagamento,
          `Baixa parcial registrada automaticamente. Saldo restante: ${novoValor}`,
          id
        ]
      );
    }

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: pagamentoTotal ? 'baixa' : 'baixa_parcial',
      entidade: 'contas_receber',
      entidade_id: id,
      descricao: pagamentoTotal
        ? `Baixa total da conta a receber #${id}`
        : `Baixa parcial da conta a receber #${id}`,
      valor: valorPago,
      usuario_id: req.user?.id
    });

    await client.query('COMMIT');

    // Notifica integração contábil em background
    dispararWebhookComRetry(pool, empresaResolvida.id, 'recebimento.registrado', {
      id, valor: valorPago, cliente: conta.cliente_nome, status: novoStatus
    }).catch((e) => console.error(`[webhook-contabil] recebimento=${id}:`, e.message));

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id);

    const contaAtualizadaResult = await pool.query(
      `
      SELECT
        *,
        CASE
          WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
         WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial'
  AND data_vencimento IS NOT NULL
  AND data_vencimento < $2
THEN 'parcial_atrasado'
WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial' THEN 'parcial'
WHEN data_vencimento IS NOT NULL AND data_vencimento < $2 THEN 'atrasado'
          ELSE 'pendente'
        END AS status_exibicao
      FROM contas_receber
      WHERE id = $1
      `,
      [id, hoje()]
    );

    const contaAtualizada = contaAtualizadaResult.rows[0];

    res.json({
      sucesso: true,
      mensagem: pagamentoTotal
        ? 'Conta baixada com sucesso'
        : 'Baixa parcial registrada com sucesso',
      conta: {
        ...contaAtualizada,
        valor: Number(contaAtualizada.valor || 0),
        parcela: Number(contaAtualizada.parcela || 1),
        total_parcelas: Number(contaAtualizada.total_parcelas || 1),
        status: contaAtualizada.status_exibicao
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao baixar conta:', error);
    jsonErro(res, 500, 'Erro ao baixar conta');
  } finally {
    client.release();
  }
});

app.get('/contas-receber/:id/recebimentos-parciais', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = await pool.query(`SELECT * FROM contas_receber WHERE id = $1 LIMIT 1`, [
      id
    ]);

    if (contaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
      SELECT
        id,
        descricao,
        valor,
        pagamento_data,
        observacao,
        criado_em
      FROM lancamentos_financeiros
      WHERE (
        empresa = $1
        OR empresa_id = $2
      )
        AND LOWER(COALESCE(tipo, '')) = 'receita'
        AND LOWER(COALESCE(categoria, '')) = 'contas_receber'
        AND LOWER(COALESCE(status, '')) = 'pago'
        AND descricao = $3
      ORDER BY pagamento_data DESC, id DESC
      `,
      [empresaResolvida.nome, empresaResolvida.id, `Recebimento parcial da conta #${id}`]
    );

    res.json({
      conta_id: id,
      recebimentos: result.rows.map((item) => ({
        ...item,
        valor: Number(item.valor || 0)
      }))
    });
  } catch (error) {
    console.error('Erro ao buscar recebimentos parciais:', error);
    jsonErro(res, 500, 'Erro ao buscar recebimentos parciais');
  }
});

app.post('/contas-receber/estornar/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = await pool.query(`SELECT * FROM contas_receber WHERE id = $1`, [id]);

    if (contaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (String(conta.status || '').toLowerCase() !== 'pago') {
      return jsonErro(res, 400, 'Esta conta não está paga');
    }

    const novoStatus =
      conta.data_vencimento &&
      new Date(`${String(conta.data_vencimento).slice(0, 10)}T00:00:00`) <
        new Date(`${hoje()}T00:00:00`)
        ? 'atrasado'
        : 'pendente';

    await pool.query(
      `
      UPDATE contas_receber
      SET status = $1,
          data_pagamento = NULL,
          valor = COALESCE(valor_original, valor),
          atualizado_em = NOW()
      WHERE id = $2 AND (empresa_id = $3 OR empresa = $4)
      `,
      [novoStatus, id, empresaResolvida.id, empresaResolvida.nome]
    );

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: 'estorno',
      entidade: 'contas_receber',
      entidade_id: id,
      descricao: `Estorno da baixa da conta a receber #${id}`,
      valor: conta.valor_atualizado || conta.valor || 0,
      usuario_id: req.user?.id
    });

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id);

    const contaAtualizadaResult = await pool.query(
      `
      SELECT *
      FROM contas_receber
      WHERE id = $1
      `,
      [id]
    );

    const contaAtualizada = contaAtualizadaResult.rows[0];

    res.json({
      sucesso: true,
      mensagem: 'Baixa estornada com sucesso',
      conta: {
        ...contaAtualizada,
        valor: Number(contaAtualizada.valor || 0),
        parcela: Number(contaAtualizada.parcela || 1),
        total_parcelas: Number(contaAtualizada.total_parcelas || 1),
        multa: Number(contaAtualizada.multa || 0),
        juros: Number(contaAtualizada.juros || 0),
        valor_atualizado: Number(contaAtualizada.valor_atualizado || contaAtualizada.valor || 0),
        dias_atraso: Number(contaAtualizada.dias_atraso || 0)
      }
    });
  } catch (error) {
    console.error('Erro ao estornar baixa de conta a receber:', error);
    jsonErro(res, 500, 'Erro ao estornar baixa de conta a receber');
  }
});

app.post('/contas-receber/estornar-parcial/:lancamentoId', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  const lancamentoId = Number(req.params.lancamentoId);
  if (!lancamentoId || isNaN(lancamentoId)) return jsonErro(res, 400, 'ID inválido');

  const client = await pool.connect();
  try {

    await client.query('BEGIN');

    const lancamentoResult = await client.query(
      `
      SELECT *
      FROM lancamentos_financeiros
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [lancamentoId]
    );

    if (lancamentoResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return jsonErro(res, 404, 'Recebimento parcial não encontrado');
    }

    const lancamento = lancamentoResult.rows[0];

    if (String(lancamento.status || '').toLowerCase() !== 'pago') {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, 'Este recebimento parcial já foi estornado');
    }

    const contaId = Number(lancamento.conta_receber_id || 0);

    if (!contaId) {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, 'Não foi possível identificar a conta vinculada');
    }

    const contaResult = await client.query(
      `
      SELECT *
      FROM contas_receber
      WHERE id = $1
      FOR UPDATE
      `,
      [contaId]
    );

    if (contaResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return jsonErro(res, 404, 'Conta vinculada não encontrada');
    }

    const conta = contaResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

    if (!empresaResolvida) {
      await client.query('ROLLBACK');
      return jsonErro(res, 403, 'Sem acesso');
    }

    const valorEstorno = normalizarDecimal(lancamento.valor || 0);
    const valorAtualConta = normalizarDecimal(conta.valor || 0);
    const novoValorConta = Number((valorAtualConta + valorEstorno).toFixed(2));

    const novoStatus =
      conta.data_vencimento &&
      new Date(`${String(conta.data_vencimento).slice(0, 10)}T00:00:00`) <
        new Date(`${hoje()}T00:00:00`)
        ? 'atrasado'
        : 'pendente';

    await client.query(
      `
      UPDATE contas_receber
      SET valor = $1,
          status = $2,
          atualizado_em = NOW()
      WHERE id = $3
      `,
      [novoValorConta, novoStatus, contaId]
    );

    await client.query(
      `
      UPDATE lancamentos_financeiros
      SET status = 'estornado',
          observacao = COALESCE(observacao, '') || ' | Estornado em ' || NOW(),
          atualizado_em = NOW()
      WHERE id = $1
      `,
      [lancamentoId]
    );

    await client.query('COMMIT');

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: 'estorno_baixa_parcial',
      entidade: 'lancamentos_financeiros',
      entidade_id: lancamentoId,
      descricao: `Estorno do recebimento parcial #${lancamentoId} da conta #${contaId}`,
      valor: valorEstorno,
      usuario_id: req.user?.id
    });

    res.json({
      sucesso: true,
      mensagem: 'Recebimento parcial estornado com sucesso',
      conta_id: contaId,
      valor_estornado: valorEstorno,
      novo_saldo: novoValorConta
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao estornar recebimento parcial:', error);
    jsonErro(res, 500, 'Erro ao estornar recebimento parcial');
  } finally {
    client.release();
  }
});

app.delete('/contas-receber/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'deletar'), async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = await pool.query(
      `
      SELECT *
      FROM contas_receber
      WHERE id = $1
      LIMIT 1
      `,
      [id]
    );

    if (contaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    // 🔒 impedir apagar contas reais de venda
    if (conta.venda_id) {
      return jsonErro(res, 400, 'Contas originadas de venda não podem ser excluídas');
    }

    // 🔒 impedir apagar conta parcialmente recebida
    if (String(conta.status || '').toLowerCase() === 'parcial') {
      const recebimentosAtivosResult = await pool.query(
        `
    SELECT COUNT(*) AS total
    FROM lancamentos_financeiros
    WHERE (
      empresa = $1
      OR empresa_id = $2
    )
      AND LOWER(COALESCE(status, '')) = 'pago'
      AND conta_receber_id = $3
    `,
        [empresaResolvida.nome, empresaResolvida.id, id]
      );

      if (Number(recebimentosAtivosResult.rows[0].total || 0) > 0) {
        return jsonErro(res, 400, 'Conta parcialmente recebida possui recebimentos ativos. Estorne os recebimentos antes de excluir.');
      }
    }

    // 🔒 impedir apagar conta paga
    if (String(conta.status || '').toLowerCase() === 'pago') {
      return jsonErro(res, 400, 'Conta paga não pode ser excluída');
    }

    await pool.query(
      `
      DELETE FROM contas_receber
      WHERE id = $1
        AND (empresa = $2 OR empresa_id = $3)
      `,
      [id, empresaResolvida.nome, empresaResolvida.id]
    );

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: 'exclusao',
      entidade: 'contas_receber',
      entidade_id: id,
      descricao: `Exclusão da conta manual #${id}`,
      valor: conta.valor || 0,
      usuario_id: req.user?.id
    });

    res.json({
      sucesso: true,
      mensagem: 'Conta manual excluída com sucesso'
    });
  } catch (error) {
    console.error('Erro ao excluir conta manual:', error);
    jsonErro(res, 500, 'Erro ao excluir conta manual');
  }
});

// ================= CRIAÇÃO MANUAL DE CONTA A RECEBER =================
app.post('/contas-receber/manual', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'criar'), async (req, res) => {
  try {
    const {
      empresa,
      cliente_id,
      cliente_nome,
      descricao,
      valor,
      data_vencimento,
      observacao,
      forma_pagamento
    } = req.body;

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const valorFinal = normalizarDecimal(valor);

    if (valorFinal <= 0) {
      return jsonErro(res, 400, 'Valor inválido');
    }

    const dataVencimento = normalizarDataISO(data_vencimento) || hoje();

    let nomeCliente = String(cliente_nome || '').trim();

    if (cliente_id) {
      const clienteResult = await pool.query(
        `
        SELECT nome
        FROM clientes
        WHERE id = $1
          AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        LIMIT 1
        `,
        [cliente_id, empresaResolvida.id, empresaResolvida.nome]
      );

      if (clienteResult.rowCount > 0) {
        nomeCliente = clienteResult.rows[0].nome;
      }
    }

    const insertResult = await pool.query(
      `
      INSERT INTO contas_receber (
  empresa,
  empresa_id,
  cliente_id,
  cliente_nome,
  observacao,
  valor,
  valor_original,
  status,
  parcela,
  total_parcelas,
  data_vencimento,
  criado_em,
  atualizado_em
)
VALUES (
  $1,$2,$3,$4,$5,$6,$6,
  'pendente',
  1,
  1,
  $7,
  NOW(),
  NOW()
)
RETURNING *
      `,
      [
        empresaResolvida.nome,
        empresaResolvida.id,
        cliente_id || null,
        nomeCliente || 'Cliente avulso',
        observacao || descricao || 'Promissória antiga cadastrada manualmente',
        valorFinal,
        dataVencimento
      ]
    );

    const conta = insertResult.rows[0];

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: 'criacao',
      entidade: 'contas_receber',
      entidade_id: conta.id,
      descricao: `Criação manual da conta a receber #${conta.id}`,
      valor: valorFinal,
      usuario_id: req.user?.id
    });

    res.json({
      sucesso: true,
      mensagem: 'Conta manual cadastrada com sucesso',
      conta: {
        ...conta,
        valor: Number(conta.valor || 0),
        valor_original: Number(conta.valor_original || 0),
        valor_atualizado: Number(conta.valor_atualizado || 0)
      }
    });
  } catch (error) {
    console.error('Erro ao criar conta manual:', error);
    jsonErro(res, 500, 'Erro ao criar conta manual');
  }
});

// ================= CONTAS A PAGAR =================
app.get('/contas-pagar-fornecedores/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          id,
          nome
        FROM fornecedores
        WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
          AND deletado_em IS NULL
        ORDER BY nome ASC
        `,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar fornecedores de contas a pagar:', error);
    jsonErro(res, 500, 'Erro ao buscar fornecedores');
  }
});

app.get('/contas-pagar/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id);

    const status = (req.query.status || '').trim().toLowerCase();
    const fornecedor = (req.query.fornecedor || '').trim().toLowerCase();
    const fornecedorId = normalizarInt(req.query.fornecedor_id || 0);
    const busca = (req.query.busca || '').trim().toLowerCase();
    const { dataInicial, dataFinal } = obterPeriodo(req);

    let sql = `
      SELECT
        cp.*,
        c.id AS compra_origem_id,
        c.data AS compra_data,
        c.total AS compra_total,
        CASE
          WHEN LOWER(COALESCE(cp.status, 'pendente')) = 'pago' THEN 'pago'
          WHEN cp.data_vencimento IS NOT NULL AND cp.data_vencimento < $2 THEN 'atrasado'
          ELSE 'pendente'
        END AS status_exibicao
      FROM contas_pagar cp
      LEFT JOIN compras c
        ON c.id = cp.compra_id
       AND c.empresa = cp.empresa
      WHERE cp.empresa = $1
        AND (cp.empresa_id IS NULL OR cp.empresa_id = $3)
    `;

    const params = [empresaResolvida.nome, hoje(), empresaResolvida.id];
    let idx = 4;

    if (status === 'pago') {
      sql += ` AND LOWER(COALESCE(cp.status, 'pendente')) = 'pago' `;
    } else if (status === 'pendente') {
      sql += `
        AND LOWER(COALESCE(cp.status, 'pendente')) <> 'pago'
        AND (cp.data_vencimento IS NULL OR cp.data_vencimento >= $2)
      `;
    } else if (status === 'atrasado') {
      sql += `
        AND LOWER(COALESCE(cp.status, 'pendente')) <> 'pago'
        AND cp.data_vencimento IS NOT NULL
        AND cp.data_vencimento < $2
      `;
    }

    if (fornecedorId > 0) {
      sql += ` AND cp.fornecedor_id = $${idx} `;
      params.push(fornecedorId);
      idx++;
    }

    if (fornecedor) {
      sql += ` AND LOWER(COALESCE(cp.fornecedor_nome, '')) LIKE $${idx} `;
      params.push(`%${fornecedor}%`);
      idx++;
    }

    if (busca) {
      sql += `
        AND (
          LOWER(COALESCE(cp.fornecedor_nome, '')) LIKE $${idx}
          OR LOWER(COALESCE(cp.observacao, '')) LIKE $${idx}
          OR LOWER(COALESCE(cp.descricao, '')) LIKE $${idx}
          OR CAST(cp.id AS TEXT) LIKE $${idx}
          OR CAST(cp.compra_id AS TEXT) LIKE $${idx}
        )
      `;
      params.push(`%${busca}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'cp.data_vencimento',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const paginaCP = Math.max(1, normalizarInt(req.query.page || 1));
    const limiteCP = Math.min(normalizarInt(req.query.limit || 50), 200);

    const filterParamsCP = [...params];
    const resumoGlobalSqlCP = `
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(q.valor),0)::numeric AS total_valor,
        COALESCE(SUM(CASE WHEN q.status_exibicao='pago' THEN q.valor ELSE 0 END),0)::numeric AS total_pago,
        COALESCE(SUM(CASE WHEN q.status_exibicao='atrasado' THEN q.valor ELSE 0 END),0)::numeric AS total_atrasado,
        COALESCE(SUM(CASE WHEN q.status_exibicao NOT IN ('pago','atrasado') THEN q.valor ELSE 0 END),0)::numeric AS total_pendente,
        COUNT(CASE WHEN q.status_exibicao='pago' THEN 1 END)::int AS qtd_pago,
        COUNT(CASE WHEN q.status_exibicao='atrasado' THEN 1 END)::int AS qtd_atrasado,
        COUNT(CASE WHEN q.status_exibicao NOT IN ('pago','atrasado') THEN 1 END)::int AS qtd_pendente
      FROM (${sql}) AS q
    `;

    const offsetCP = (paginaCP - 1) * limiteCP;
    const sqlPaginadoCP = sql + ` ORDER BY cp.id DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(limiteCP, offsetCP);

    const [resultCP, resumoGlobalResultCP] = await Promise.all([
      pool.query(sqlPaginadoCP, params),
      pool.query(resumoGlobalSqlCP, filterParamsCP)
    ]);

    const result = resultCP;

    const contas = result.rows.map((row) => ({
      ...row,
      valor: Number(row.valor || 0),
      parcela: Number(row.parcela || 1),
      total_parcelas: Number(row.total_parcelas || 1),
      compra_total: Number(row.compra_total || 0),
      status: row.status_exibicao
    }));

    const rgCP = resumoGlobalResultCP.rows[0];
    const resumo = {
      total:          Number(rgCP.total_valor || 0),
      total_pago:     Number(rgCP.total_pago || 0),
      total_pendente: Number(rgCP.total_pendente || 0),
      total_atrasado: Number(rgCP.total_atrasado || 0),
      qtd_pago:       Number(rgCP.qtd_pago || 0),
      qtd_pendente:   Number(rgCP.qtd_pendente || 0),
      qtd_atrasado:   Number(rgCP.qtd_atrasado || 0)
    };

    res.json({
      contas,
      resumo,
      paginacao: {
        pagina: paginaCP,
        limite: limiteCP,
        total: Number(rgCP.total || 0),
        total_paginas: Math.ceil(Number(rgCP.total || 0) / limiteCP) || 1
      }
    });
  } catch (error) {
    console.error('Erro ao buscar contas a pagar:', error);
    jsonErro(res, 500, 'Erro ao buscar contas a pagar');
  }
});

app.get('/contas-pagar/detalhe/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const _cpEmpresaId = req.is_saas_owner ? null : (req.empresa_id || null);
    const _cpEmpresaWhere = _cpEmpresaId ? 'AND cp.empresa_id = $3' : '';
    const _cpParams = _cpEmpresaId ? [id, hoje(), _cpEmpresaId] : [id, hoje()];

    const contaResult = await pool.query(
      `
        SELECT
          cp.*,
          CASE
            WHEN LOWER(COALESCE(cp.status, 'pendente')) = 'pago' THEN 'pago'
            WHEN cp.data_vencimento IS NOT NULL AND cp.data_vencimento < $2 THEN 'atrasado'
            ELSE 'pendente'
          END AS status_exibicao
        FROM contas_pagar cp
        WHERE cp.id = $1 ${_cpEmpresaWhere}
        LIMIT 1
        `,
      _cpParams
    );

    if (contaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id)) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    res.json({
      ...conta,
      valor: Number(conta.valor || 0),
      parcela: Number(conta.parcela || 1),
      total_parcelas: Number(conta.total_parcelas || 1),
      status: conta.status_exibicao
    });
  } catch (error) {
    console.error('Erro ao buscar detalhe da conta a pagar:', error);
    jsonErro(res, 500, 'Erro ao buscar detalhe da conta');
  }
});

app.get('/contas-pagar/origem-compra/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = req.user.is_saas_owner
      ? await pool.query(`SELECT * FROM contas_pagar WHERE id = $1 LIMIT 1`, [id])
      : await pool.query(
          `SELECT * FROM contas_pagar WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
          [id, req.user.empresa_id || 0, req.user.empresa || '']
        );

    if (contaResult.rowCount === 0) {
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id)) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (!conta.compra_id) {
      return jsonErro(res, 404, 'Esta conta não possui compra de origem');
    }

    const compraResult = await pool.query(
      `
        SELECT
          c.*,
          f.nome AS fornecedor_nome_origem
        FROM compras c
        LEFT JOIN fornecedores f
          ON f.id = c.fornecedor_id
        AND f.empresa = c.empresa
        WHERE c.id = $1 AND (c.empresa_id = $2 OR (c.empresa_id IS NULL AND c.empresa = $3))
        LIMIT 1
        `,
      [conta.compra_id, conta.empresa_id, conta.empresa]
    );

    if (compraResult.rowCount === 0) {
      return jsonErro(res, 404, 'Compra de origem não encontrada');
    }

    const itensResult = await pool.query(
      `
        SELECT *
        FROM compra_itens
        WHERE compra_id = $1
        ORDER BY id ASC
        `,
      [conta.compra_id]
    );

    const parcelasResult = await pool.query(
      `
        SELECT *
        FROM contas_pagar
        WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        ORDER BY parcela ASC, id ASC
        `,
      [conta.compra_id, conta.empresa_id, conta.empresa]
    );

    res.json({
      conta: {
        ...conta,
        valor: Number(conta.valor || 0),
        parcela: Number(conta.parcela || 1),
        total_parcelas: Number(conta.total_parcelas || 1)
      },
      compra: {
        ...compraResult.rows[0],
        total: Number(compraResult.rows[0].total || 0)
      },
      itens: itensResult.rows.map((item) => ({
        ...item,
        quantidade: Number(item.quantidade || 0),
        custo_unitario: Number(item.custo_unitario || 0),
        subtotal: Number(item.subtotal || 0)
      })),
      parcelas: parcelasResult.rows.map((item) => ({
        ...item,
        valor: Number(item.valor || 0),
        parcela: Number(item.parcela || 1),
        total_parcelas: Number(item.total_parcelas || 1)
      }))
    });
  } catch (error) {
    console.error('Erro ao buscar origem da compra:', error);
    jsonErro(res, 500, 'Erro ao buscar origem da compra');
  }
});

app.post('/contas-pagar/pagar/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) return jsonErro(res, 400, 'ID inválido');

  const client = await pool.connect();
  try {

    await client.query('BEGIN');

    const contaResult = await client.query(
      `SELECT * FROM contas_pagar
       WHERE id = $1
         AND (empresa_id = $2 OR empresa = $3)
       FOR UPDATE`,
      [id, req.empresa_id, req.empresa_nome]
    );

    if (contaResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return jsonErro(res, 404, 'Conta não encontrada');
    }

    const conta = contaResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa, conta.empresa_id);

    if (!empresaResolvida) {
      await client.query('ROLLBACK');
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (String(conta.status || '').toLowerCase() === 'pago') {
      await client.query('ROLLBACK');
      return jsonErro(res, 400, 'Esta conta já está paga');
    }

    const dataPagamento = normalizarDataISO(req.body?.data_pagamento) || hoje();
    const valorAtualCP = normalizarDecimal(conta.valor || 0);
    const valorPagoCP = normalizarDecimal(req.body?.valor_pago || 0);
    const valorPagoFinal = valorPagoCP > 0 ? Math.min(valorPagoCP, valorAtualCP) : valorAtualCP;
    const pagamentoTotalCP = valorPagoFinal >= valorAtualCP;
    const novoValorCP = pagamentoTotalCP ? valorAtualCP : Number((valorAtualCP - valorPagoFinal).toFixed(2));
    const novoStatusCP = pagamentoTotalCP ? 'pago' : 'parcial';

    await client.query(
      `
      UPDATE contas_pagar
      SET status = $1,
          valor_original = COALESCE(valor_original, valor),
          valor = $2,
          data_pagamento = CASE WHEN $1 = 'pago' THEN $3 ELSE data_pagamento END,
          atualizado_em = NOW()
      WHERE id = $4
      `,
      [novoStatusCP, novoValorCP, dataPagamento, id]
    );

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: pagamentoTotalCP ? 'baixa' : 'baixa_parcial',
      entidade: 'contas_pagar',
      entidade_id: id,
      descricao: pagamentoTotalCP
        ? `Baixa total da conta a pagar #${id}`
        : `Baixa parcial da conta a pagar #${id}`,
      valor: valorPagoFinal,
      usuario_id: req.user?.id
    });

    await client.query('COMMIT');

    // Notifica integração contábil em background
    dispararWebhookComRetry(pool, empresaResolvida.id, 'pagamento.registrado', {
      id, valor: valorPagoFinal, fornecedor: conta.fornecedor
    }).catch((e) => console.error(`[webhook-contabil] pagamento=${id}:`, e.message));

    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id);

    const contaAtualizadaResult = await pool.query(
      `
      SELECT
        *,
        CASE
          WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
          WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial'
            AND data_vencimento IS NOT NULL
            AND data_vencimento < $2 THEN 'parcial_atrasado'
          WHEN LOWER(COALESCE(status, 'pendente')) = 'parcial' THEN 'parcial'
          WHEN data_vencimento IS NOT NULL AND data_vencimento < $2 THEN 'atrasado'
          ELSE 'pendente'
        END AS status_exibicao
      FROM contas_pagar
      WHERE id = $1
      `,
      [id, hoje()]
    );

    const contaAtualizada = contaAtualizadaResult.rows[0];

    res.json({
      sucesso: true,
      mensagem: pagamentoTotalCP ? 'Conta paga com sucesso' : 'Baixa parcial registrada com sucesso',
      conta: {
        ...contaAtualizada,
        valor: Number(contaAtualizada.valor || 0),
        valor_original: Number(contaAtualizada.valor_original || 0),
        parcela: Number(contaAtualizada.parcela || 1),
        total_parcelas: Number(contaAtualizada.total_parcelas || 1),
        status: contaAtualizada.status_exibicao
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao pagar conta:', error);
    jsonErro(res, 500, 'Erro ao pagar conta');
  } finally {
    client.release();
  }
});

// ================= LANÇAMENTOS FINANCEIROS =================
app.post('/financeiro/lancamentos', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'criar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const {
      empresa,
      empresa_id,
      tipo,
      categoria,
      descricao,
      valor,
      vencimento,
      pagamento_data,
      status,
      forma_pagamento,
      recorrente,
      frequencia,
      observacao
    } = req.body;

    if (!tipo || !categoria || !descricao) {
      return jsonErro(res, 400, 'Preencha os campos obrigatórios do lançamento');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (!['receita', 'despesa'].includes(String(tipo).toLowerCase())) {
      return jsonErro(res, 400, 'Tipo de lançamento inválido');
    }

    const _statusesValidos = ['pendente', 'pago', 'atrasado'];
    const statusFinal = _statusesValidos.includes(String(status || '').toLowerCase())
      ? String(status).toLowerCase()
      : 'pendente';

    const valorFinal = normalizarDecimal(valor);
    if (valorFinal <= 0) {
      return jsonErro(res, 400, 'Valor inválido');
    }

    const result = await pool.query(
      `
      INSERT INTO lancamentos_financeiros
      (
        empresa,
        empresa_id,
        tipo,
        categoria,
        descricao,
        valor,
        vencimento,
        pagamento_data,
        status,
        forma_pagamento,
        recorrente,
        frequencia,
        observacao,
        criado_por,
        criado_em,
        atualizado_em
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
      RETURNING *
      `,
      [
        empresaResolvida.nome,
        empresaResolvida.id,
        String(tipo).toLowerCase(),
        categoria,
        descricao,
        valorFinal,
        normalizarDataISO(vencimento) || null,
        normalizarDataISO(pagamento_data) || null,
        statusFinal,
        forma_pagamento || '',
        Boolean(recorrente),
        frequencia || '',
        observacao || '',
        req.user.id
      ]
    );

    res.json({
      sucesso: true,
      item: {
        ...result.rows[0],
        valor: Number(result.rows[0].valor || 0)
      }
    });
  } catch (error) {
    console.error('Erro ao cadastrar lançamento financeiro:', error);
    jsonErro(res, 500, 'Erro ao cadastrar lançamento financeiro');
  }
});

app.get('/financeiro/lancamentos/:empresa', auth, requirePermissao(pool, 'financeiro', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const tipo = (req.query.tipo || '').trim().toLowerCase();
    const status = (req.query.status || '').trim().toLowerCase();
    const categoria = (req.query.categoria || '').trim().toLowerCase();
    const busca = (req.query.busca || '').trim().toLowerCase();
    const { dataInicial, dataFinal } = obterPeriodo(req);

    let sql = `
      SELECT
        *
      FROM lancamentos_financeiros
      WHERE (empresa = $1 OR empresa_id = $2)
    `;

    const params = [empresaResolvida.nome, empresaResolvida.id];
    let idx = 3;

    if (tipo) {
      sql += ` AND LOWER(COALESCE(tipo, '')) = $${idx} `;
      params.push(tipo);
      idx++;
    }

    if (status) {
      sql += ` AND LOWER(COALESCE(status, '')) = $${idx} `;
      params.push(status);
      idx++;
    }

    if (categoria) {
      sql += ` AND LOWER(COALESCE(categoria, '')) LIKE $${idx} `;
      params.push(`%${categoria}%`);
      idx++;
    }

    if (busca) {
      sql += `
        AND (
          LOWER(COALESCE(descricao, '')) LIKE $${idx}
          OR LOWER(COALESCE(observacao, '')) LIKE $${idx}
          OR LOWER(COALESCE(categoria, '')) LIKE $${idx}
          OR CAST(id AS TEXT) LIKE $${idx}
        )
      `;
      params.push(`%${busca}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodoRange({
      campoInicial: 'vencimento',
      campoFinal: 'pagamento_data',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const paginaL = Math.max(1, normalizarInt(req.query.page || 1));
    const limiteL = Math.min(normalizarInt(req.query.limit || 50), 200);
    const filterParamsL = [...params];

    const offsetL = (paginaL - 1) * limiteL;
    const sqlPaginado = sql + ` ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const paramsPaginado = [...params, limiteL, offsetL];

    const resumoSqlL = `
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(CASE WHEN tipo = 'receita' THEN valor ELSE 0 END), 0)::float AS receitas,
        COALESCE(SUM(CASE WHEN tipo != 'receita' THEN valor ELSE 0 END), 0)::float AS despesas
      FROM (${sql}) AS q`;

    const [result, resumoResultL] = await Promise.all([
      pool.query(sqlPaginado, paramsPaginado),
      pool.query(resumoSqlL, filterParamsL)
    ]);

    const rgL = resumoResultL.rows[0];
    const totalL = Number(rgL.total || 0);

    res.json({
      itens: result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0),
        recorrente: Boolean(row.recorrente)
      })),
      resumo: {
        receitas: Number(rgL.receitas || 0),
        despesas: Number(rgL.despesas || 0),
        saldo: Number(rgL.receitas || 0) - Number(rgL.despesas || 0)
      },
      paginacao: {
        pagina: paginaL,
        limite: limiteL,
        total: totalL,
        total_paginas: Math.ceil(totalL / limiteL) || 1
      }
    });
  } catch (error) {
    console.error('Erro ao buscar lançamentos financeiros:', error);
    jsonErro(res, 500, 'Erro ao buscar lançamentos financeiros');
  }
});

app.get('/financeiro/lancamentos-detalhe/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1`, [id]);

    if (result.rowCount === 0) {
      return jsonErro(res, 404, 'Lançamento não encontrado');
    }

    const item = result.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, item.empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    res.json({
      ...item,
      valor: Number(item.valor || 0),
      recorrente: Boolean(item.recorrente)
    });
  } catch (error) {
    console.error('Erro ao buscar detalhe do lançamento:', error);
    jsonErro(res, 500, 'Erro ao buscar detalhe do lançamento');
  }
});

app.put('/financeiro/lancamentos/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const id = Number(req.params.id);

    const atualResult = await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1`, [
      id
    ]);

    if (atualResult.rowCount === 0) {
      return jsonErro(res, 404, 'Lançamento não encontrado');
    }

    const atual = atualResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, atual.empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    if (atual.conta_receber_id) {
      return jsonErro(res, 400, 'Lançamentos vinculados a contas a receber não podem ser editados diretamente');
    }

    const {
      tipo,
      categoria,
      descricao,
      valor,
      vencimento,
      pagamento_data,
      status,
      forma_pagamento,
      recorrente,
      frequencia,
      observacao
    } = req.body;

    if (!tipo || !categoria || !descricao) {
      return jsonErro(res, 400, 'Preencha os campos obrigatórios do lançamento');
    }

    if (!['receita', 'despesa'].includes(String(tipo).toLowerCase())) {
      return jsonErro(res, 400, 'Tipo de lançamento inválido');
    }

    const valorFinal = normalizarDecimal(valor);
    if (valorFinal <= 0) {
      return jsonErro(res, 400, 'Valor inválido');
    }

    await pool.query(
      `
      UPDATE lancamentos_financeiros
      SET tipo = $1,
          categoria = $2,
          descricao = $3,
          valor = $4,
          vencimento = $5,
          pagamento_data = $6,
          status = $7,
          forma_pagamento = $8,
          recorrente = $9,
          frequencia = $10,
          observacao = $11,
          atualizado_em = NOW()
      WHERE id = $12 AND (empresa_id = $13 OR empresa = $14)
      `,
      [
        String(tipo).toLowerCase(),
        categoria,
        descricao,
        valorFinal,
        normalizarDataISO(vencimento) || null,
        normalizarDataISO(pagamento_data) || null,
        status || 'pendente',
        forma_pagamento || '',
        Boolean(recorrente),
        frequencia || '',
        observacao || '',
        id,
        empresaResolvida.id,
        empresaResolvida.nome
      ]
    );

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: 'edicao',
      entidade: 'lancamentos_financeiros',
      entidade_id: id,
      descricao: `Lançamento editado: ${descricao}`,
      valor: valorFinal,
      usuario_id: req.user?.id
    });

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao atualizar lançamento financeiro:', error);
    jsonErro(res, 500, 'Erro ao atualizar lançamento financeiro');
  }
});

app.post('/financeiro/lancamentos/pagar/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'editar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const id = Number(req.params.id);

    const atualResult = await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1`, [
      id
    ]);

    if (atualResult.rowCount === 0) {
      return jsonErro(res, 404, 'Lançamento não encontrado');
    }

    const atual = atualResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, atual.empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    await pool.query(
      `
      UPDATE lancamentos_financeiros
      SET status = 'pago',
          pagamento_data = $1,
          atualizado_em = NOW()
      WHERE id = $2 AND (empresa_id = $3 OR empresa = $4)
      `,
      [normalizarDataISO(req.body?.pagamento_data) || hoje(), id, empresaResolvida.id, empresaResolvida.nome]
    );

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: 'pagamento',
      entidade: 'lancamentos_financeiros',
      entidade_id: id,
      descricao: `Lançamento pago: ${atual.descricao || ''}`,
      valor: Number(atual.valor || 0),
      usuario_id: req.user?.id
    });

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao pagar lançamento financeiro:', error);
    jsonErro(res, 500, 'Erro ao pagar lançamento financeiro');
  }
});

app.delete('/financeiro/lancamentos/:id', auth, writeRateLimiter, requirePermissao(pool, 'financeiro', 'deletar'), async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const id = Number(req.params.id);

    const atualResult = await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1`, [
      id
    ]);

    if (atualResult.rowCount === 0) {
      return jsonErro(res, 404, 'Lançamento não encontrado');
    }

    const atual = atualResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, atual.empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    await pool.query(
      `DELETE FROM lancamentos_financeiros WHERE id = $1 AND (empresa = $2 OR empresa_id = $3)`,
      [id, empresaResolvida.nome, empresaResolvida.id]
    );

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: 'exclusao',
      entidade: 'lancamentos_financeiros',
      entidade_id: id,
      descricao: `Lançamento excluído: ${atual.descricao || ''}`,
      valor: Number(atual.valor || 0),
      usuario_id: req.user?.id
    });

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao excluir lançamento financeiro:', error);
    jsonErro(res, 500, 'Erro ao excluir lançamento financeiro');
  }
});

// ================= INVESTIMENTOS =================
app.post('/investimentos', auth, writeRateLimiter, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return jsonErro(res, 403, 'Sem permissão');
    }

    const { empresa, tipo_investimento, descricao, valor, data, forma_pagamento, observacao } =
      req.body;

    if (!empresa || !tipo_investimento || !descricao || !data) {
      return jsonErro(res, 400, 'Dados do investimento incompletos');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `INSERT INTO investimentos
        (empresa, empresa_id, tipo_investimento, descricao, valor, data, forma_pagamento, observacao, criado_por, criado_em, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
        RETURNING *`,
      [
        empresaResolvida.nome,
        empresaResolvida.id,
        tipo_investimento,
        descricao,
        normalizarDecimal(valor),
        normalizarDataISO(data) || data,
        forma_pagamento || '',
        observacao || '',
        req.user.id
      ]
    );

    res.json({
      sucesso: true,
      item: {
        ...result.rows[0],
        valor: Number(result.rows[0].valor || 0)
      }
    });
  } catch (error) {
    jsonErro(res, 500, 'Erro ao cadastrar investimento');
  }
});

app.get('/investimentos/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const tipo = (req.query.tipo_investimento || '').trim();
    const busca = (req.query.busca || '').trim().toLowerCase();
    const { dataInicial, dataFinal } = obterPeriodo(req);

    const params = [];
    let sql = `SELECT * FROM investimentos WHERE 1=1`;
    sql += adicionarFiltroEmpresaSaaS({ params, empresaResolvida });
    let idx = params.length + 1;

    if (tipo) {
      sql += ` AND tipo_investimento = $${idx}`;
      params.push(tipo);
      idx++;
    }

    if (busca) {
      sql += `
          AND (
            LOWER(COALESCE(descricao, '')) LIKE $${idx}
            OR LOWER(COALESCE(tipo_investimento, '')) LIKE $${idx}
            OR LOWER(COALESCE(observacao, '')) LIKE $${idx}
          )
        `;
      params.push(`%${busca}%`);
      idx++;
    }

    sql += adicionarFiltroPeriodo({
      campo: 'data',
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    sql += ` ORDER BY id DESC`;

    const result = await pool.query(sql, params);

    res.json(
      result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0)
      }))
    );
  } catch (error) {
    jsonErro(res, 500, 'Erro ao buscar investimentos');
  }
});

// ================= FLUXO DE CAIXA =================
// GET /financeiro/auditoria — histórico de operações financeiras da empresa
app.get('/financeiro/auditoria', auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) return jsonErro(res, 403, 'Acesso restrito a administradores e gerentes');

    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const { tipo, entidade, busca } = req.query;

    const params = [empresaResolvida.id, empresaResolvida.nome];
    let where = `WHERE (fl.empresa_id = $1 OR fl.empresa = $2)`;

    if (tipo)    { params.push(tipo);    where += ` AND fl.tipo = $${params.length}`; }
    if (entidade){ params.push(entidade); where += ` AND fl.entidade = $${params.length}`; }
    if (busca)   { params.push(`%${busca}%`); where += ` AND fl.descricao ILIKE $${params.length}`; }

    where += adicionarFiltroPeriodo({ campo: 'fl.criado_em', params, dataInicial, dataFinal });

    const result = await pool.query(
      `SELECT
         fl.id,
         fl.tipo,
         fl.entidade,
         fl.entidade_id,
         fl.descricao,
         fl.valor,
         fl.criado_em,
         COALESCE(u.nome_completo, u.usuario, 'Sistema') AS usuario_nome
       FROM financeiro_logs fl
       LEFT JOIN usuarios u ON u.id = fl.usuario_id
       ${where}
       ORDER BY fl.criado_em DESC
       LIMIT 500`,
      params
    );

    const total = result.rowCount;
    const truncado = total >= 500;

    res.json({ sucesso: true, logs: result.rows, total, truncado });
  } catch (err) {
    console.error('[auditoria financeira]', err.message);
    jsonErro(res, 500, 'Erro ao buscar auditoria financeira');
  }
});

app.get('/financeiro/fluxo-caixa/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id);
    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id);

    const { dataInicial, dataFinal } = obterPeriodo(req);

    const paramsReceber = [empresaResolvida.id, empresaResolvida.nome];
    const paramsPagar = [empresaResolvida.id, empresaResolvida.nome];
    const paramsLanc = [empresaResolvida.nome, empresaResolvida.id];
    const paramsInvest = [empresaResolvida.id, empresaResolvida.nome];
    const paramsVendas = [empresaResolvida.id, empresaResolvida.nome];
    const paramsCompras = [empresaResolvida.id, empresaResolvida.nome];

    let whereReceber = `
      WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
    `;

    let wherePagar = `
      WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
    `;

    let whereLanc = `
  WHERE (
    empresa = $1
    OR empresa_id = $2
  )
    AND LOWER(COALESCE(status, 'pendente')) = 'pago'
    AND pagamento_data IS NOT NULL
`;

    let whereInvest = `
      WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
    `;

    let whereVendas = `
      WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))
        AND NOT EXISTS (
          SELECT 1 FROM contas_receber cr
          WHERE cr.venda_id = v.id
        )
    `;

    let whereCompras = `
      WHERE (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))
        AND LOWER(COALESCE(c.status, 'finalizada')) = 'finalizada'
        AND NOT EXISTS (
          SELECT 1
          FROM contas_pagar cp
          WHERE cp.compra_id = c.id
            AND (cp.empresa_id = c.empresa_id OR cp.empresa = c.empresa)
        )
    `;

    whereReceber += adicionarFiltroPeriodo({
      campo: 'data_pagamento',
      params: paramsReceber,
      dataInicial,
      dataFinal,
      castDate: false
    });

    wherePagar += adicionarFiltroPeriodo({
      campo: 'data_pagamento',
      params: paramsPagar,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereLanc += adicionarFiltroPeriodo({
      campo: 'pagamento_data',
      params: paramsLanc,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereInvest += adicionarFiltroPeriodo({
      campo: 'data',
      params: paramsInvest,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereVendas += adicionarFiltroPeriodo({
      campo: 'v.data',
      params: paramsVendas,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereCompras += adicionarFiltroPeriodo({
      campo: 'c.data',
      params: paramsCompras,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const [
      receitasResult,
      despesasResult,
      lancamentosResult,
      investimentosResult,
      vendasDiretasResult,
      comprasDiretasResult,
      movimentosReceberResult,
      movimentosPagarResult,
      movimentosLancamentosResult,
      movimentosInvestimentosResult,
      movimentosVendasResult,
      movimentosComprasResult
    ] = await Promise.all([
      // 1
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM contas_receber ${whereReceber}`,
        paramsReceber
      ),

      // 2
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM contas_pagar ${wherePagar}`,
        paramsPagar
      ),

      // 3
      pool.query(
        `
    SELECT tipo, COALESCE(SUM(valor), 0) AS total
    FROM lancamentos_financeiros
    ${whereLanc}
    GROUP BY tipo
  `,
        paramsLanc
      ),

      // 4
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS total FROM investimentos ${whereInvest}`,
        paramsInvest
      ),

      // 5 🔥 vendas diretas
      pool.query(
        `
    SELECT COALESCE(SUM(v.total), 0) AS total
    FROM vendas v
    ${whereVendas}
  `,
        paramsVendas
      ),

      // 6 🔥 compras diretas (AQUI!)
      pool.query(
        `
    SELECT COALESCE(SUM(c.total), 0) AS total
    FROM compras c
    ${whereCompras}
  `,
        paramsCompras
      ),

      // 7
      pool.query(
        `
    SELECT id, 'conta_receber' AS origem, 'entrada' AS tipo,
    COALESCE(cliente_nome, 'Cliente') AS descricao,
    valor, data_pagamento AS data_movimento,
    venda_id AS referencia_id, observacao
    FROM contas_receber
    ${whereReceber}
  `,
        paramsReceber
      ),

      // 8
      pool.query(
        `
    SELECT id, 'conta_pagar' AS origem, 'saida' AS tipo,
    COALESCE(descricao, fornecedor_nome) AS descricao,
    valor, data_pagamento AS data_movimento,
    compra_id AS referencia_id, observacao
    FROM contas_pagar
    ${wherePagar}
  `,
        paramsPagar
      ),

      // 9
      pool.query(
        `
    SELECT id, 'lancamento_financeiro' AS origem,
    CASE WHEN LOWER(tipo) = 'receita' THEN 'entrada' ELSE 'saida' END AS tipo,
    descricao, valor, pagamento_data AS data_movimento,
    NULL AS referencia_id, NULL AS forma_pagamento, observacao
    FROM lancamentos_financeiros
    ${whereLanc}
  `,
        paramsLanc
      ),

      // 10
      pool.query(
        `
    SELECT id, 'investimento' AS origem, 'saida' AS tipo,
    descricao, valor, data AS data_movimento,
    NULL AS referencia_id, NULL AS forma_pagamento, observacao
    FROM investimentos
    ${whereInvest}
  `,
        paramsInvest
      ),

      // 11 🔥 movimentos vendas
      pool.query(
        `
    SELECT v.id, 'venda_direta' AS origem, 'entrada' AS tipo,
    v.cliente_nome AS descricao,
    v.total AS valor,
    v.data AS data_movimento,
    v.pagamento AS forma_pagamento,
    v.id AS referencia_id,
    NULL AS observacao
    FROM vendas v
    ${whereVendas}
  `,
        paramsVendas
      ),

      // 12 🔥 movimentos compras
      pool.query(
        `
    SELECT c.id, 'compra_direta' AS origem, 'saida' AS tipo,
    COALESCE(f.nome, 'Compra') AS descricao,
    c.total AS valor,
    c.data AS data_movimento,
    c.pagamento AS forma_pagamento,
    c.id AS referencia_id,
    c.observacao
    FROM compras c
    LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
    ${whereCompras}
  `,
        paramsCompras
      )
    ]);

    const totalReceitasRecebidas = Number(receitasResult.rows[0].total || 0);
    const totalDespesasPagas = Number(despesasResult.rows[0].total || 0);
    const totalInvestimentos = Number(investimentosResult.rows[0].total || 0);
    const totalVendasDiretas = Number(vendasDiretasResult.rows[0].total || 0);
    const totalComprasDiretas = Number(comprasDiretasResult?.rows?.[0]?.total || 0);

    const totaisLancamentos = lancamentosResult.rows.reduce(
      (acc, row) => {
        const tipo = String(row.tipo || '').toLowerCase();
        const valor = Number(row.total || 0);

        if (tipo === 'receita') acc.receitas += valor;
        if (tipo === 'despesa') acc.despesas += valor;

        return acc;
      },
      { receitas: 0, despesas: 0 }
    );

    const entradas = Number(
      (totalReceitasRecebidas + totalVendasDiretas + totaisLancamentos.receitas).toFixed(2)
    );

    const saidas = Number(
      (
        totalDespesasPagas +
        totalComprasDiretas +
        totaisLancamentos.despesas +
        totalInvestimentos
      ).toFixed(2)
    );

    const saldo = Number((entradas - saidas).toFixed(2));

    const movimentos = [
      ...movimentosReceberResult.rows,
      ...movimentosPagarResult.rows,
      ...movimentosLancamentosResult.rows,
      ...movimentosInvestimentosResult.rows,
      ...movimentosVendasResult.rows,
      ...movimentosComprasResult.rows
    ]
      .map((item) => ({
        ...item,
        valor: Number(item.valor || 0)
      }))
      .sort((a, b) => {
        const dataA = new Date(`${a.data_movimento || '1970-01-01'}T00:00:00`).getTime();
        const dataB = new Date(`${b.data_movimento || '1970-01-01'}T00:00:00`).getTime();
        return dataB - dataA;
      });

    const resumoFormasPagamento = movimentos.reduce((acc, movimento) => {
      const forma = normalizarFormaPagamentoFluxo(movimento.forma_pagamento);
      const tipo = String(movimento.tipo || '').toLowerCase();
      const valor = Number(movimento.valor || 0);

      if (!acc[forma]) {
        acc[forma] = {
          forma_pagamento: forma,
          entradas: 0,
          saidas: 0,
          saldo: 0
        };
      }

      if (tipo === 'entrada') {
        acc[forma].entradas += valor;
        acc[forma].saldo += valor;
      }

      if (tipo === 'saida') {
        acc[forma].saidas += valor;
        acc[forma].saldo -= valor;
      }

      return acc;
    }, {});

    res.json({
      entradas,
      saidas,
      saldo,
      movimentos,
      resumo_formas_pagamento: Object.values(resumoFormasPagamento).map((item) => ({
        ...item,
        entradas: Number(item.entradas.toFixed(2)),
        saidas: Number(item.saidas.toFixed(2)),
        saldo: Number(item.saldo.toFixed(2))
      }))
    });
  } catch (error) {
    console.error('Erro ao calcular fluxo de caixa:', error);
    jsonErro(res, 500, 'Erro ao calcular fluxo de caixa');
  }
});

// Endpoint de debug removido da produção (expunha schema do banco)

// ================= DASHBOARD =================
app.get('/dashboard', auth, async (req, res) => {
  try {
    const empresaInformada = req.query.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresaInformada);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id);
    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id);

    const { dataInicial, dataFinal } = obterPeriodo(req);

    // Período anterior (mesma duração, imediatamente antes)
    let prevInicial = null, prevFinal = null;
    if (dataInicial && dataFinal) {
      const ini = new Date(dataInicial);
      const fim = new Date(dataFinal);
      const dias = Math.round((fim - ini) / 86400000);
      const pFim = new Date(ini);
      pFim.setDate(pFim.getDate() - 1);
      const pIni = new Date(pFim);
      pIni.setDate(pIni.getDate() - dias);
      prevInicial = pIni.toISOString().slice(0, 10);
      prevFinal   = pFim.toISOString().slice(0, 10);
    }

    const vendasParams = [];
    const comprasParams = [];
    const receberParams = [];
    const pagarParams = [];
    const clientesParams = [];
    const produtosParams = [];
    const lancamentosParams = [empresaResolvida.nome, empresaResolvida.id];

    let vendasWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: vendasParams, empresaResolvida })}
`;

    let comprasWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: comprasParams, empresaResolvida })}
`;

    let receberWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: receberParams, empresaResolvida })}
  AND status IN ('pendente', 'atrasado')
`;

    let pagarWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: pagarParams, empresaResolvida })}
  AND status IN ('pendente', 'atrasado')
`;

    let clientesWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: clientesParams, empresaResolvida })}
`;

    let produtosWhere = `
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({ params: produtosParams, empresaResolvida })}
`;

    let lancamentosWhere = `
  WHERE (
    empresa = $1
    OR empresa_id = $2
  )
  AND LOWER(COALESCE(status, 'pendente')) = 'pago'
  AND pagamento_data IS NOT NULL
`;

    vendasWhere += adicionarFiltroPeriodo({
      campo: 'data',
      params: vendasParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    comprasWhere += adicionarFiltroPeriodo({
      campo: 'data',
      params: comprasParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    receberWhere += adicionarFiltroPeriodo({
      campo: 'data_vencimento',
      params: receberParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    pagarWhere += adicionarFiltroPeriodo({
      campo: 'data_vencimento',
      params: pagarParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    clientesWhere += adicionarFiltroPeriodo({
      campo: 'criado_em',
      params: clientesParams,
      dataInicial,
      dataFinal
    });

    lancamentosWhere += adicionarFiltroPeriodo({
      campo: 'pagamento_data',
      params: lancamentosParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const topProdutosParams = [];
    const estoqueBaixoParams = [];
    const indicadoresFinanceirosParams = [];
    const abcParams = [];

    let topProdutosJoinAndWhere = `
  FROM venda_itens vi
  INNER JOIN vendas v
    ON v.id = vi.venda_id
    AND (
      v.empresa_id = vi.empresa_id
      OR (
        vi.empresa_id IS NULL
        AND v.empresa = vi.empresa
      )
    )
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    alias: 'vi',
    params: topProdutosParams,
    empresaResolvida
  })}
`;

    if (dataInicial) {
      topProdutosParams.push(dataInicial);
      topProdutosJoinAndWhere += ` AND v.data >= $${topProdutosParams.length}`;
    }

    if (dataFinal) {
      topProdutosParams.push(dataFinal);
      topProdutosJoinAndWhere += ` AND v.data <= $${topProdutosParams.length}`;
    }

    // Queries do período anterior (faturamento, vendas, clientes)
    const vAntParams = [];
    const cAntParams = [];
    let vAntWhere = `WHERE 1=1 ${adicionarFiltroEmpresaSaaS({ params: vAntParams, empresaResolvida })}`;
    let cAntWhere = `WHERE 1=1 ${adicionarFiltroEmpresaSaaS({ params: cAntParams, empresaResolvida })}`;
    if (prevInicial) {
      vAntParams.push(prevInicial); vAntWhere += ` AND data >= $${vAntParams.length}`;
      cAntParams.push(prevInicial); cAntWhere += ` AND criado_em::date >= $${cAntParams.length}`;
    }
    if (prevFinal) {
      vAntParams.push(prevFinal); vAntWhere += ` AND data <= $${vAntParams.length}`;
      cAntParams.push(prevFinal); cAntWhere += ` AND criado_em::date <= $${cAntParams.length}`;
    }

    const [
      vendasResult,
      comprasResult,
      receberResult,
      pagarResult,
      produtosResult,
      clientesResult,
      topProdutosResult,
      estoqueBaixoResult,
      indicadoresFinanceirosResult,
      abcResult,
      lancamentosFinanceirosResult,
      vendasAntResult,
      clientesAntResult
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total_vendas, COALESCE(SUM(total), 0) AS faturamento FROM vendas ${vendasWhere}`,
        vendasParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total_compras, COALESCE(SUM(total), 0) AS total_compras_valor FROM compras ${comprasWhere}`,
        comprasParams
      ),
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS contas_receber FROM contas_receber ${receberWhere}`,
        receberParams
      ),
      pool.query(
        `SELECT COALESCE(SUM(valor), 0) AS contas_pagar FROM contas_pagar ${pagarWhere}`,
        pagarParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total_produtos, COALESCE(SUM(estoque), 0) AS total_estoque FROM produtos ${produtosWhere}`,
        produtosParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total_clientes FROM clientes ${clientesWhere}`,
        clientesParams
      ),
      pool.query(
        `
          SELECT
            vi.produto_nome AS nome,
            COALESCE(SUM(vi.quantidade), 0) AS quantidade
          ${topProdutosJoinAndWhere}
          GROUP BY vi.produto_nome
          ORDER BY quantidade DESC, nome ASC
          LIMIT 5
          `,
        topProdutosParams
      ),
      pool.query(
        `
  SELECT COUNT(*) AS total
  FROM produtos
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: estoqueBaixoParams,
    empresaResolvida
  })}
    AND estoque <= estoque_minimo
    AND estoque_minimo > 0
  `,
        estoqueBaixoParams
      ),

      pool.query(
        `
  SELECT
    COALESCE(SUM(estoque * custo_medio), 0) AS estoque_investido,
    COALESCE(SUM(estoque * lucro_unitario), 0) AS lucro_potencial,
    COALESCE(AVG(margem_lucro), 0) AS margem_media,
    COUNT(*) FILTER (
      WHERE promocao_ativa = TRUE
    ) AS produtos_promocao,
    COUNT(*) FILTER (
      WHERE lucro_unitario < 0
    ) AS produtos_prejuizo
  FROM produtos
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    params: indicadoresFinanceirosParams,
    empresaResolvida
  })}
  `,
        indicadoresFinanceirosParams
      ),
      pool.query(
        `
  WITH base AS (
    SELECT
      id,
      nome,
      COALESCE(lucro_unitario, 0) * COALESCE(estoque, 0) AS lucro_total
    FROM produtos
    WHERE 1=1
    ${adicionarFiltroEmpresaSaaS({
      params: abcParams,
      empresaResolvida
    })}
  ),
  ordenado AS (
    SELECT
      *,
      SUM(lucro_total) OVER () AS lucro_geral
    FROM base
  ),
  acumulado AS (
    SELECT
      *,
      CASE
        WHEN lucro_geral <= 0 THEN 0
        ELSE (
          SUM(lucro_total) OVER (
            ORDER BY lucro_total DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) / lucro_geral
        ) * 100
      END AS acumulado_percentual
    FROM ordenado
  )
  SELECT
    COUNT(*) FILTER (
      WHERE acumulado_percentual <= 80
    ) AS classe_a,
    COUNT(*) FILTER (
      WHERE acumulado_percentual > 80
      AND acumulado_percentual <= 95
    ) AS classe_b,
    COUNT(*) FILTER (
      WHERE acumulado_percentual > 95
    ) AS classe_c
  FROM acumulado
  `,
        abcParams
      ),

      pool.query(
        `
  SELECT
    tipo,
    COALESCE(SUM(valor), 0) AS total
  FROM lancamentos_financeiros
  ${lancamentosWhere}
  GROUP BY tipo
  `,
        lancamentosParams
      ),

      // Período anterior
      pool.query(
        `SELECT COUNT(*) AS total_vendas, COALESCE(SUM(total), 0) AS faturamento FROM vendas ${vAntWhere}`,
        vAntParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total_clientes FROM clientes ${cAntWhere}`,
        cAntParams
      )
    ]);

    const vendasRow = vendasResult.rows[0];
    const comprasRow = comprasResult.rows[0];
    const receberRow = receberResult.rows[0];
    const pagarRow = pagarResult.rows[0];
    const produtosRow = produtosResult.rows[0];
    const clientesRow = clientesResult.rows[0];
    const indicadoresFinanceirosRow = indicadoresFinanceirosResult.rows[0];
    const abcRow = abcResult.rows[0];
    const lancamentosFinanceirosResumo = lancamentosFinanceirosResult.rows.reduce(
      (acc, row) => {
        const tipo = String(row.tipo || '').toLowerCase();
        const valor = Number(row.total || 0);

        if (tipo === 'receita') acc.receitas += valor;
        if (tipo === 'despesa') acc.despesas += valor;

        return acc;
      },
      { receitas: 0, despesas: 0 }
    );

    const alertas = [];
    if (Number(estoqueBaixoResult.rows[0].total || 0) > 0) {
      alertas.push({
        tipo: 'warning',
        texto: `${Number(estoqueBaixoResult.rows[0].total || 0)} produto(s) com estoque baixo`
      });
    }

    if (Number(pagarRow.contas_pagar || 0) > 0) {
      alertas.push({
        tipo: 'danger',
        texto: `Há ${Number(pagarRow.contas_pagar || 0).toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL'
        })} em contas a pagar`
      });
    }

    if (Number(receberRow.contas_receber || 0) > 0) {
      alertas.push({
        tipo: 'info',
        texto: `Há ${Number(receberRow.contas_receber || 0).toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL'
        })} em contas a receber`
      });
    }

    res.json({
      faturamento: Number(vendasRow.faturamento || 0),
      receitas_realizadas: Number(lancamentosFinanceirosResumo.receitas || 0),
      despesas_realizadas: Number(lancamentosFinanceirosResumo.despesas || 0),
      saldo_financeiro_realizado: Number(
        (
          Number(lancamentosFinanceirosResumo.receitas || 0) -
          Number(lancamentosFinanceirosResumo.despesas || 0)
        ).toFixed(2)
      ),
      vendas: Number(vendasRow.total_vendas || 0),
      contas_receber: Number(receberRow.contas_receber || 0),
      contas_pagar: Number(pagarRow.contas_pagar || 0),
      estoque: Number(produtosRow.total_estoque || 0),
      clientes: Number(clientesRow.total_clientes || 0),
      total_produtos: Number(produtosRow.total_produtos || 0),
      total_compras: Number(comprasRow.total_compras || 0),
      total_compras_valor: Number(comprasRow.total_compras_valor || 0),
      estoque_investido: Number(indicadoresFinanceirosRow.estoque_investido || 0),

      lucro_potencial: Number(indicadoresFinanceirosRow.lucro_potencial || 0),

      margem_media: Number(indicadoresFinanceirosRow.margem_media || 0),

      produtos_promocao: Number(indicadoresFinanceirosRow.produtos_promocao || 0),

      produtos_prejuizo: Number(indicadoresFinanceirosRow.produtos_prejuizo || 0),
      classe_a: Number(abcRow.classe_a || 0),

      classe_b: Number(abcRow.classe_b || 0),

      classe_c: Number(abcRow.classe_c || 0),

      recomendacoes: [
        ...(Number(indicadoresFinanceirosRow.produtos_prejuizo || 0) > 0
          ? [
              {
                tipo: 'danger',
                texto: `${Number(indicadoresFinanceirosRow.produtos_prejuizo)} produto(s) operando com prejuízo`
              }
            ]
          : []),

        ...(Number(indicadoresFinanceirosRow.margem_media || 0) < 15
          ? [
              {
                tipo: 'warning',
                texto: 'Margem média da operação está baixa'
              }
            ]
          : []),

        ...(Number(abcRow.classe_c || 0) > Number(abcRow.classe_a || 0)
          ? [
              {
                tipo: 'warning',
                texto: 'Quantidade elevada de produtos Classe C'
              }
            ]
          : []),

        ...(Number(indicadoresFinanceirosRow.produtos_promocao || 0) > 0
          ? [
              {
                tipo: 'info',
                texto: `${Number(indicadoresFinanceirosRow.produtos_promocao)} produto(s) em promoção ativa`
              }
            ]
          : [])
      ],

      top_produtos: topProdutosResult.rows.map((row) => ({
        nome: row.nome,
        quantidade: Number(row.quantidade || 0)
      })),
      alertas,

      comparativo: prevInicial ? {
        faturamento: Number(vendasAntResult.rows[0]?.faturamento  || 0),
        vendas:      Number(vendasAntResult.rows[0]?.total_vendas || 0),
        clientes:    Number(clientesAntResult.rows[0]?.total_clientes || 0)
      } : null
    });
  } catch (error) {
    console.error('Erro real ao carregar dashboard:', error);
    jsonErro(res, 500, 'Erro ao carregar dashboard');
  }
});

// ================= DASHBOARD — GRÁFICOS =================

app.get('/dashboard/grafico', auth, async (req, res) => {
  try {
    const empresaInformada = req.query.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresaInformada);

    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { dataInicial, dataFinal } = obterPeriodo(req);

    const vendasDiaParams = [];
    const formaParams = [];

    let vendasDiaWhere = `WHERE 1=1 ${adicionarFiltroEmpresaSaaS({ params: vendasDiaParams, empresaResolvida })}`;
    let formaWhere = `WHERE 1=1 ${adicionarFiltroEmpresaSaaS({ params: formaParams, empresaResolvida })}`;

    vendasDiaWhere += adicionarFiltroPeriodo({ campo: 'data', params: vendasDiaParams, dataInicial, dataFinal, castDate: false });
    formaWhere    += adicionarFiltroPeriodo({ campo: 'data', params: formaParams,    dataInicial, dataFinal, castDate: false });

    const [vendasDiaResult, formaResult] = await Promise.all([
      pool.query(
        `SELECT
           data::date AS dia,
           COALESCE(SUM(total), 0)  AS total,
           COUNT(*)                 AS quantidade
         FROM vendas
         ${vendasDiaWhere}
         GROUP BY dia
         ORDER BY dia`,
        vendasDiaParams
      ),
      pool.query(
        `SELECT
           COALESCE(NULLIF(TRIM(forma_pagamento), ''), 'Outros') AS forma,
           COUNT(*)                                              AS quantidade,
           COALESCE(SUM(total), 0)                              AS total
         FROM vendas
         ${formaWhere}
         GROUP BY forma
         ORDER BY total DESC`,
        formaParams
      )
    ]);

    res.json({
      vendas_por_dia: vendasDiaResult.rows.map((r) => ({
        data:       r.dia,
        total:      Number(r.total),
        quantidade: Number(r.quantidade)
      })),
      forma_pagamento: formaResult.rows.map((r) => ({
        forma:      r.forma,
        quantidade: Number(r.quantidade),
        total:      Number(r.total)
      }))
    });
  } catch (error) {
    console.error('Erro ao carregar gráfico do dashboard:', error);
    jsonErro(res, 500, 'Erro ao carregar gráfico');
  }
});

// ================= PIX (EFÍ / Gerencianet) =================

const https = require('https');

function httpsPost(url, headers, body, agentOptions = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const agent = agentOptions.pfx
      ? new https.Agent(agentOptions)
      : undefined;

    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      agent
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, headers, agentOptions = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const agent = agentOptions.pfx
      ? new https.Agent(agentOptions)
      : undefined;

    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, agent };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function efiAuth(config) {
  const base = config.pix_sandbox
    ? 'https://api-pix-h.gerencianet.com.br'
    : 'https://api-pix.gerencianet.com.br';

  const creds = Buffer.from(`${config.pix_client_id}:${config.pix_client_secret}`).toString('base64');
  const agentOpts = config.pix_certificado
    ? { pfx: Buffer.from(config.pix_certificado, 'base64'), passphrase: '' }
    : {};

  const res = await httpsPost(
    `${base}/oauth/token`,
    { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
    JSON.stringify({ grant_type: 'client_credentials' }),
    agentOpts
  );

  if (res.status !== 200 || !res.body.access_token) {
    throw new Error(`Falha na autenticação EFÍ: ${JSON.stringify(res.body)}`);
  }

  return { accessToken: res.body.access_token, base, agentOpts };
}

// Descriptografa os campos sensíveis do PIX antes de usar nas chamadas à EFÍ
function resolvePixConfig(config) {
  if (!config) return {};
  return {
    ...config,
    pix_client_id:     decryptField(config.pix_client_id),
    pix_client_secret: decryptField(config.pix_client_secret),
    pix_certificado:   decryptField(config.pix_certificado)
  };
}

// GET /pagamentos/pix/config
app.get('/pagamentos/pix/config', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const result = await pool.query(
      `SELECT pix_gateway, pix_client_id, pix_chave, pix_sandbox,
              CASE WHEN pix_client_secret IS NOT NULL THEN '****' ELSE NULL END AS pix_client_secret,
              CASE WHEN pix_certificado IS NOT NULL THEN 'configurado' ELSE NULL END AS pix_certificado
       FROM configuracoes WHERE empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    const row = result.rows[0] || { pix_gateway: 'efi', pix_sandbox: true };
    if (row.pix_client_id) row.pix_client_id = decryptField(row.pix_client_id);
    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar config PIX:', error);
    jsonErro(res, 500, 'Erro ao buscar configuração PIX');
  }
});

// PUT /pagamentos/pix/config
app.put('/pagamentos/pix/config', auth, writeRateLimiter, requirePermissao(pool, 'configuracoes', 'editar'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { pix_client_id, pix_client_secret, pix_certificado, pix_chave, pix_sandbox } = req.body;

    const encClientSecret = pix_client_secret && pix_client_secret !== '****'
      ? encryptField(pix_client_secret) : pix_client_secret;
    const encCertificado = pix_certificado && pix_certificado !== 'configurado'
      ? encryptField(pix_certificado) : pix_certificado;

    await pool.query(
      `UPDATE configuracoes
       SET pix_gateway       = 'efi',
           pix_client_id     = $3,
           pix_client_secret = COALESCE(NULLIF($4, '****'), pix_client_secret),
           pix_certificado   = COALESCE(NULLIF($5, 'configurado'), pix_certificado),
           pix_chave         = $6,
           pix_sandbox       = $7,
           atualizado_em     = NOW()
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`,
      [empresaResolvida.id, empresaResolvida.nome,
       encryptField(pix_client_id), encClientSecret, encCertificado,
       pix_chave, pix_sandbox ?? true]
    );

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao salvar config PIX:', error);
    jsonErro(res, 500, 'Erro ao salvar configuração PIX');
  }
});

// POST /pagamentos/pix/gerar
app.post('/pagamentos/pix/gerar', auth, writeRateLimiter, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { conta_receber_id, valor, cliente_nome } = req.body;
    if (!valor || Number(valor) <= 0) return jsonErro(res, 400, 'Valor inválido');

    const cfg = await pool.query(
      `SELECT * FROM configuracoes WHERE empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );
    const config = resolvePixConfig(cfg.rows[0] || {});

    const expiracao = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    let txid, pixCopiaECola, qrImage;

    if (config.pix_sandbox || !config.pix_client_id) {
      // ── Modo sandbox: dados de demonstração ──────────────────────────────
      txid = `SANDBOX_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      pixCopiaECola = `00020126580014br.gov.bcb.pix0136${config.pix_chave || 'chave-pix-sandbox'}5204000053039865802BR5925SANDBOX DEMO LF ERP6009SAO PAULO62070503***6304DEMO`;
      qrImage = null; // frontend mostra placeholder
    } else {
      // ── Modo produção: chamada real à EFÍ ────────────────────────────────
      const { accessToken, base, agentOpts } = await efiAuth(config);

      const valorStr = Number(valor).toFixed(2);
      const cobPayload = {
        calendario: { expiracao: 1800 },
        valor: { original: valorStr },
        chave: config.pix_chave,
        infoAdicionais: [
          { nome: 'Sistema', valor: 'LF ERP' },
          ...(cliente_nome ? [{ nome: 'Cliente', valor: cliente_nome }] : [])
        ]
      };

      const cobRes = await httpsPost(
        `${base}/v2/cob`,
        { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        JSON.stringify(cobPayload),
        agentOpts
      );

      if (cobRes.status !== 201) throw new Error(`EFÍ /v2/cob: ${JSON.stringify(cobRes.body)}`);
      txid = cobRes.body.txid;
      pixCopiaECola = cobRes.body.pixCopiaECola;

      // Buscar QR code image
      const locId = cobRes.body.loc?.id;
      if (locId) {
        const qrRes = await httpsGet(`${base}/v2/loc/${locId}/qrcode`,
          { 'Authorization': `Bearer ${accessToken}` }, agentOpts);
        if (qrRes.status === 200) qrImage = qrRes.body.imagemQrcode;
      }
    }

    await pool.query(
      `INSERT INTO cobrancas_pix (empresa, empresa_id, conta_receber_id, txid, valor, cliente_nome, status, pix_copia_e_cola, qr_image, expiracao)
       VALUES ($1,$2,$3,$4,$5,$6,'ATIVA',$7,$8,$9)
       ON CONFLICT (txid) DO NOTHING`,
      [empresaResolvida.nome, empresaResolvida.id, conta_receber_id || null,
       txid, Number(valor), cliente_nome || null, pixCopiaECola, qrImage, expiracao]
    );

    res.json({
      sucesso: true,
      txid,
      pix_copia_e_cola: pixCopiaECola,
      qr_image: qrImage,
      expiracao: expiracao.toISOString(),
      sandbox: config.pix_sandbox || !config.pix_client_id
    });
  } catch (error) {
    console.error('Erro ao gerar PIX:', error);
    jsonErro(res, 500, `Erro ao gerar cobrança PIX: ${error.message}`);
  }
});

// GET /pagamentos/pix/status/:txid
app.get('/pagamentos/pix/status/:txid', auth, async (req, res) => {
  try {
    const { txid } = req.params;
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const local = await pool.query(
      `SELECT * FROM cobrancas_pix WHERE txid = $1 AND (empresa_id = $2 OR empresa = $3)`,
      [txid, empresaResolvida.id, empresaResolvida.nome]
    );

    if (!local.rowCount) return jsonErro(res, 404, 'Cobrança não encontrada');
    const cobr = local.rows[0];

    // Sandbox: status sempre ATIVA (demo)
    if (cobr.status === 'CONCLUIDA') return res.json({ status: 'CONCLUIDA', pago_em: cobr.pago_em });

    const cfg = await pool.query(
      `SELECT * FROM configuracoes WHERE empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );
    const config = resolvePixConfig(cfg.rows[0] || {});

    if (config.pix_sandbox || !config.pix_client_id || txid.startsWith('SANDBOX_')) {
      return res.json({ status: 'ATIVA', sandbox: true });
    }

    const { accessToken, base, agentOpts } = await efiAuth(config);
    const checkRes = await httpsGet(`${base}/v2/cob/${txid}`,
      { 'Authorization': `Bearer ${accessToken}` }, agentOpts);

    if (checkRes.status === 200 && checkRes.body.status === 'CONCLUIDA') {
      await pool.query(`UPDATE cobrancas_pix SET status='CONCLUIDA', pago_em=NOW() WHERE txid=$1`, [txid]);
    }

    res.json({ status: checkRes.body.status || 'ATIVA' });
  } catch (error) {
    console.error('Erro ao verificar status PIX:', error);
    jsonErro(res, 500, 'Erro ao verificar status da cobrança');
  }
});

// ================= BOLETO ASAAS =================

const { resolverClienteAsaas, criarBoleto: criarBoletoAsaas, consultarBoleto: consultarBoletoAsaas } = require('./utils/asaas');
const { enviarEmailBoasVindas, getSaasSmtp, criarTransporter } = require('./utils/email');
const { dispararWebhookComRetry } = require('./utils/webhookContabil');

async function getAsaasConfig(empresaResolvida) {
  const cfg = await pool.query(
    `SELECT asaas_api_key, asaas_sandbox FROM configuracoes
     WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) LIMIT 1`,
    [empresaResolvida.id, empresaResolvida.nome]
  );
  const row = cfg.rows[0] || {};
  return {
    apiKey:  decryptField(row.asaas_api_key) || null,
    sandbox: row.asaas_sandbox !== false   // default true (sandbox)
  };
}

// GET /pagamentos/boleto/config
app.get('/pagamentos/boleto/config', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const cfg = await pool.query(
      `SELECT
         CASE WHEN asaas_api_key IS NOT NULL THEN '****' ELSE NULL END AS asaas_api_key,
         asaas_sandbox
       FROM configuracoes
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    res.json({ sucesso: true, ...(cfg.rows[0] || { asaas_sandbox: true }) });
  } catch (err) {
    console.error('[boleto] GET config:', err.message);
    jsonErro(res, 500, 'Erro ao buscar configuração Asaas');
  }
});

// PUT /pagamentos/boleto/config
app.put('/pagamentos/boleto/config', auth, writeRateLimiter, requirePermissao(pool, 'configuracoes', 'editar'), async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { asaas_api_key, asaas_sandbox } = req.body;
    const _asaasKeyParaSalvar = (asaas_api_key && asaas_api_key !== '****')
      ? encryptField(asaas_api_key)
      : (asaas_api_key || null);

    await pool.query(
      `UPDATE configuracoes
       SET asaas_api_key = COALESCE(NULLIF($3, '****'), asaas_api_key),
           asaas_sandbox = $4,
           atualizado_em = NOW()
       WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`,
      [empresaResolvida.id, empresaResolvida.nome, _asaasKeyParaSalvar, asaas_sandbox !== false]
    );

    res.json({ sucesso: true });
  } catch (err) {
    console.error('[boleto] PUT config:', err.message);
    jsonErro(res, 500, 'Erro ao salvar configuração Asaas');
  }
});

// POST /pagamentos/boleto/gerar
app.post('/pagamentos/boleto/gerar', auth, writeRateLimiter, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { conta_receber_id } = req.body;
    if (!conta_receber_id) return jsonErro(res, 400, 'conta_receber_id é obrigatório');

    // Busca a conta a receber
    const crResult = await pool.query(
      `SELECT cr.*, c.cpf, c.cpf_cnpj, c.telefone, c.email
       FROM contas_receber cr
       LEFT JOIN clientes c ON c.id = cr.cliente_id AND c.empresa_id = cr.empresa_id
       WHERE cr.id = $1 AND cr.empresa_id = $2`,
      [Number(conta_receber_id), empresaResolvida.id]
    );

    if (crResult.rowCount === 0) return jsonErro(res, 404, 'Conta a receber não encontrada');

    const cr = crResult.rows[0];

    if (['pago', 'parcial'].includes(String(cr.status || '').toLowerCase())) {
      return jsonErro(res, 400, 'Esta conta já foi paga ou está parcialmente paga');
    }

    // Boleto já emitido e válido
    if (cr.boleto_id && !cr.boleto_id.startsWith('DEMO_')) {
      const { apiKey, sandbox } = await getAsaasConfig(empresaResolvida);
      if (apiKey) {
        const boleto = await consultarBoletoAsaas(apiKey, sandbox, cr.boleto_id);
        if (boleto.status !== 'OVERDUE' && boleto.status !== 'CANCELLED') {
          return res.json({ sucesso: true, boleto, reaproveitado: true });
        }
      }
    }

    const { apiKey, sandbox } = await getAsaasConfig(empresaResolvida);

    // Cria ou busca cliente Asaas
    let customerId = null;
    if (apiKey && (cr.cliente_id || cr.cliente_nome)) {
      customerId = await resolverClienteAsaas(apiKey, sandbox, {
        nome:     cr.cliente_nome || 'Cliente',
        cpfCnpj:  cr.cpf || cr.cpf_cnpj || null,
        email:    cr.email || null,
        telefone: cr.telefone || null
      });
    }

    const vencimento = cr.data_vencimento || hoje();
    const descricao  = `Parcela ${cr.parcela || 1}/${cr.total_parcelas || 1} — ${cr.cliente_nome || 'Cliente'}`;

    const boleto = await criarBoletoAsaas(apiKey, sandbox, {
      customerId,
      valor:             Number(cr.valor_atualizado || cr.valor),
      vencimento,
      descricao,
      externalReference: String(cr.id)
    });

    // Persiste dados do boleto
    await pool.query(
      `UPDATE contas_receber
       SET boleto_id            = $1,
           boleto_url           = $2,
           boleto_linha_digitavel = $3,
           boleto_status        = $4,
           boleto_gerado_em     = NOW(),
           atualizado_em        = NOW()
       WHERE id = $5`,
      [
        boleto.id,
        boleto.invoiceUrl || boleto.bankSlipUrl || null,
        boleto.linhaDigitavel || null,
        boleto.status || 'PENDING',
        cr.id
      ]
    );

    res.json({ sucesso: true, boleto, sandbox: boleto.demo || sandbox || !apiKey });
  } catch (err) {
    console.error('[boleto] POST gerar:', err.message);
    jsonErro(res, 500, `Erro ao gerar boleto: ${err.message}`);
  }
});

// GET /pagamentos/boleto/status/:contaReceberID
app.get('/pagamentos/boleto/status/:contaReceberID', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const crId = Number(req.params.contaReceberID);
    const crResult = await pool.query(
      `SELECT boleto_id, boleto_url, boleto_linha_digitavel, boleto_status, boleto_gerado_em
       FROM contas_receber WHERE id = $1 AND empresa_id = $2`,
      [crId, empresaResolvida.id]
    );

    if (crResult.rowCount === 0) return jsonErro(res, 404, 'Conta não encontrada');

    const cr = crResult.rows[0];
    if (!cr.boleto_id) return jsonErro(res, 404, 'Nenhum boleto gerado para esta conta');

    const { apiKey, sandbox } = await getAsaasConfig(empresaResolvida);
    const boleto = await consultarBoletoAsaas(apiKey, sandbox, cr.boleto_id);

    // Atualiza status no banco se necessário
    if (boleto.status !== cr.boleto_status) {
      await pool.query(
        `UPDATE contas_receber SET boleto_status = $1, atualizado_em = NOW() WHERE id = $2`,
        [boleto.status, crId]
      );
    }

    // Se Asaas confirma pagamento, baixa automaticamente a conta
    if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(boleto.status)) {
      await pool.query(
        `UPDATE contas_receber
         SET status = 'pago', data_pagamento = COALESCE($1::date, CURRENT_DATE),
             atualizado_em = NOW()
         WHERE id = $2 AND LOWER(COALESCE(status,'pendente')) != 'pago'`,
        [boleto.dataPagamento, crId]
      );
    }

    res.json({ sucesso: true, boleto: { ...boleto, ...cr } });
  } catch (err) {
    console.error('[boleto] GET status:', err.message);
    jsonErro(res, 500, 'Erro ao consultar boleto');
  }
});

// Verifica o header asaas-access-token nos webhooks Asaas.
// Se ASAAS_WEBHOOK_TOKEN não estiver configurado, aceita com aviso (ativação gradual).
// Se estiver configurado, rejeita 401 qualquer requisição sem o token correto.
function verificarWebhookAsaas(req, res) {
  const token = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!token) {
    console.warn('[webhook-asaas] ASAAS_WEBHOOK_TOKEN nao configurado — validacao de origem desativada');
    return true;
  }
  const headerToken = req.headers['asaas-access-token'] || '';
  const bufA = Buffer.from(token);
  const bufB = Buffer.from(headerToken);
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    console.warn('[webhook-asaas] Token invalido — requisicao rejeitada IP:', req.ip);
    res.status(401).json({ erro: 'Unauthorized' });
    return false;
  }
  return true;
}

// POST /pagamentos/boleto/webhook — notificações Asaas (PAYMENT_RECEIVED, etc.)
app.post('/pagamentos/boleto/webhook', async (req, res) => {
  try {
    if (!verificarWebhookAsaas(req, res)) return;

    const { event, payment } = req.body || {};

    if (!payment?.externalReference) return res.status(200).json({ ok: true });

    const contaId = Number(payment.externalReference);

    if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event) && contaId > 0) {
      await pool.query(
        `UPDATE contas_receber
         SET status = 'pago', boleto_status = 'RECEIVED',
             data_pagamento = COALESCE($2::date, CURRENT_DATE), atualizado_em = NOW()
         WHERE id = $1 AND LOWER(COALESCE(status,'pendente')) != 'pago'`,
        [contaId, payment.paymentDate || null]
      );
    }

    if (event === 'PAYMENT_OVERDUE' && contaId > 0) {
      await pool.query(
        `UPDATE contas_receber SET boleto_status = 'OVERDUE', atualizado_em = NOW()
         WHERE id = $1`,
        [contaId]
      );
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[boleto] webhook:', err.message);
    res.status(200).json({ ok: true }); // Sempre 200 para Asaas não retentar
  }
});

// ================= CONCILIAÇÃO BANCÁRIA =================

function ofxTagVal(bloco, tag) {
  const m = new RegExp(`<${tag}>([^<\\n\\r]+)`, 'i').exec(bloco);
  return m ? m[1].trim() : null;
}

function parseOFXDate(str) {
  const s = String(str || '').slice(0, 8);
  if (s.length < 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function parseOFX(texto) {
  if (!texto || texto.length > 10 * 1024 * 1024)
    throw new Error('Arquivo OFX inválido ou excede 10 MB');
  const itens = [];
  const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const b = m[1];
    const dtposted = ofxTagVal(b, 'DTPOSTED');
    const trnamt   = ofxTagVal(b, 'TRNAMT');
    if (!dtposted || !trnamt) continue;
    const valor = parseFloat(trnamt.replace(',', '.'));
    if (isNaN(valor)) continue;
    itens.push({
      fitid:    ofxTagVal(b, 'FITID') || `${dtposted}_${trnamt}`,
      data:     parseOFXDate(dtposted),
      descricao:(ofxTagVal(b, 'MEMO') || ofxTagVal(b, 'NAME') || '').trim(),
      valor:    Math.abs(valor),
      tipo:     valor >= 0 ? 'credito' : 'debito'
    });
  }
  return itens;
}

function parseDataBR(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function parseDataISO(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test((s || '').trim()) ? s.trim() : null;
}

function parseCSV(texto) {
  if (!texto || texto.length > 10 * 1024 * 1024)
    throw new Error('Arquivo CSV inválido ou excede 10 MB');
  const linhas = texto.split('\n').map(l => l.trim()).filter(Boolean);
  const itens = [];
  for (let i = 0; i < linhas.length; i++) {
    const cols = linhas[i].split(/[;,]/).map(c => c.replace(/^["']|["']$/g, '').trim());
    if (cols.length < 3) continue;
    const data = parseDataBR(cols[0]) || parseDataISO(cols[0]);
    if (!data) continue;
    const desc = cols[1];
    const valorStr = cols[2].replace(/\./g, '').replace(',', '.');
    const valor = parseFloat(valorStr);
    if (isNaN(valor)) continue;
    itens.push({
      fitid:    `csv_${i}_${data}`,
      data,
      descricao: desc,
      valor:    Math.abs(valor),
      tipo:     valor >= 0 ? 'credito' : 'debito'
    });
  }
  return itens;
}

// POST /conciliacao/importar
app.post('/conciliacao/importar', jsonUpload, auth, writeRateLimiter, async (req, res) => {
  try {
    const { conteudo, tipo, nome, conta } = req.body;
    if (!conteudo || !tipo || !nome) return jsonErro(res, 400, 'Campos obrigatórios: conteudo, tipo, nome');

    const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    let itens = [];
    if (tipo === 'ofx') itens = parseOFX(conteudo);
    else if (tipo === 'csv') itens = parseCSV(conteudo);
    else return jsonErro(res, 400, 'Tipo inválido. Use ofx ou csv.');

    if (!itens.length) return jsonErro(res, 400, 'Nenhuma transação encontrada no arquivo.');

    const datas = itens.map(i => i.data).filter(Boolean).sort();
    const dataInicio = datas[0] || null;
    const dataFim    = datas[datas.length - 1] || null;

    const sessao = await pool.query(
      `INSERT INTO conciliacoes (empresa, empresa_id, nome, tipo, conta, data_inicio, data_fim, total_itens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [empresaResolvida.nome, empresaResolvida.id, nome, tipo, conta || null, dataInicio, dataFim, itens.length]
    );
    const conciliacaoId = sessao.rows[0].id;

    for (const it of itens) {
      await pool.query(
        `INSERT INTO conciliacao_itens (conciliacao_id, empresa, empresa_id, fitid, data, descricao, valor, tipo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [conciliacaoId, empresaResolvida.nome, empresaResolvida.id, it.fitid, it.data, it.descricao, it.valor, it.tipo]
      );
    }

    res.json({ sucesso: true, conciliacao_id: conciliacaoId, total: itens.length });
  } catch (error) {
    console.error('Erro ao importar conciliação:', error);
    jsonErro(res, 500, 'Erro ao importar arquivo');
  }
});

// GET /conciliacao
app.get('/conciliacao', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const result = await pool.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM conciliacao_itens ci WHERE ci.conciliacao_id = c.id AND ci.status = 'pendente') AS pendentes
       FROM conciliacoes c
       WHERE c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2)
       ORDER BY c.criado_em DESC LIMIT 50`,
      [empresaResolvida.id, empresaResolvida.nome]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar conciliações:', error);
    jsonErro(res, 500, 'Erro ao listar conciliações');
  }
});

// GET /conciliacao/:id/itens
app.get('/conciliacao/:id/itens', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const empresaResolvida = await validarAcessoEmpresa(req, req.query.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const status = req.query.status || '';
    let sql = `SELECT ci.*,
        lf.descricao AS lancamento_descricao, lf.categoria AS lancamento_categoria
      FROM conciliacao_itens ci
      LEFT JOIN lancamentos_financeiros lf ON lf.id = ci.lancamento_id
      WHERE ci.conciliacao_id = $1
        AND (ci.empresa_id = $2 OR (ci.empresa_id IS NULL AND ci.empresa = $3))`;
    const params = [id, empresaResolvida.id, empresaResolvida.nome];

    if (status) { params.push(status); sql += ` AND ci.status = $${params.length}`; }
    sql += ` ORDER BY ci.data, ci.id`;

    const result = await pool.query(sql, params);
    res.json(result.rows.map(r => ({ ...r, valor: Number(r.valor || 0) })));
  } catch (error) {
    console.error('Erro ao buscar itens de conciliação:', error);
    jsonErro(res, 500, 'Erro ao buscar itens');
  }
});

// POST /conciliacao/itens/:id/ignorar
app.post('/conciliacao/itens/:id/ignorar', auth, writeRateLimiter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const item = await pool.query(`SELECT * FROM conciliacao_itens WHERE id = $1`, [id]);
    if (!item.rowCount) return jsonErro(res, 404, 'Item não encontrado');

    const empresaResolvida = await validarAcessoEmpresa(req, item.rows[0].empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    await pool.query(`UPDATE conciliacao_itens SET status = 'ignorado' WHERE id = $1`, [id]);
    await pool.query(
      `UPDATE conciliacoes SET itens_ignorados = itens_ignorados + 1 WHERE id = $1`,
      [item.rows[0].conciliacao_id]
    );
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao ignorar item:', error);
    jsonErro(res, 500, 'Erro ao ignorar item');
  }
});

// POST /conciliacao/itens/:id/criar-lancamento
app.post('/conciliacao/itens/:id/criar-lancamento', auth, writeRateLimiter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const item = await pool.query(`SELECT * FROM conciliacao_itens WHERE id = $1`, [id]);
    if (!item.rowCount) return jsonErro(res, 404, 'Item não encontrado');
    if (item.rows[0].status === 'conciliado') return jsonErro(res, 400, 'Item já conciliado');

    const row = item.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, row.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { categoria, observacao } = req.body;
    const tipoLanc = row.tipo === 'credito' ? 'receita' : 'despesa';

    const lanc = await pool.query(
      `INSERT INTO lancamentos_financeiros
         (empresa, empresa_id, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, criado_por, criado_em, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'pago',$8,NOW(),NOW()) RETURNING id`,
      [
        empresaResolvida.nome, empresaResolvida.id,
        tipoLanc,
        categoria || (row.tipo === 'credito' ? 'Receita bancária' : 'Despesa bancária'),
        row.descricao,
        row.valor,
        row.data,
        req.user.id
      ]
    );
    const lancamentoId = lanc.rows[0].id;

    await pool.query(
      `UPDATE conciliacao_itens SET status = 'conciliado', lancamento_id = $1 WHERE id = $2`,
      [lancamentoId, id]
    );
    await pool.query(
      `UPDATE conciliacoes SET itens_conciliados = itens_conciliados + 1 WHERE id = $1`,
      [row.conciliacao_id]
    );
    res.json({ sucesso: true, lancamento_id: lancamentoId });
  } catch (error) {
    console.error('Erro ao criar lançamento da conciliação:', error);
    jsonErro(res, 500, 'Erro ao criar lançamento');
  }
});

// DELETE /conciliacao/:id
app.delete('/conciliacao/:id', auth, writeRateLimiter, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sess = await pool.query(`SELECT * FROM conciliacoes WHERE id = $1`, [id]);
    if (!sess.rowCount) return jsonErro(res, 404, 'Sessão não encontrada');

    const empresaResolvida = await validarAcessoEmpresa(req, sess.rows[0].empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    await pool.query(`DELETE FROM conciliacao_itens WHERE conciliacao_id = $1`, [id]);
    await pool.query(`DELETE FROM conciliacoes WHERE id = $1`, [id]);
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao excluir conciliação:', error);
    jsonErro(res, 500, 'Erro ao excluir conciliação');
  }
});

// ================= CONFIGURAÇÕES =================

// BUSCAR CONFIGURAÇÕES
app.get('/configuracoes/:empresa', auth, requirePermissao(pool, 'configuracoes', 'ver'), async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const result = await pool.query(
      `SELECT * FROM configuracoes WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) LIMIT 1`,
      [empresaResolvida.id, empresaResolvida.nome]
    );

    if (!result.rows.length) {
      const novo = await pool.query(
        `INSERT INTO configuracoes (empresa, empresa_id, nome_empresa) VALUES ($1, $2, $3) RETURNING *`,
        [empresaResolvida.nome, empresaResolvida.id, empresaResolvida.nome]
      );

      return res.json(novo.rows[0]);
    }

    // Mascarar credenciais sensíveis — gerenciadas via endpoints dedicados /pagamentos/*/config
    const row = { ...result.rows[0] };
    if (row.pix_client_secret !== undefined) row.pix_client_secret = row.pix_client_secret ? '****' : null;
    if (row.pix_certificado !== undefined)   row.pix_certificado   = row.pix_certificado   ? 'configurado' : null;
    if (row.asaas_api_key !== undefined)     row.asaas_api_key     = row.asaas_api_key     ? '****' : null;

    res.json(row);
  } catch (error) {
    console.error('Erro ao buscar configurações:', error);
    jsonErro(res, 500, 'Erro ao buscar configurações');
  }
});

// SALVAR CONFIGURAÇÕES
app.put('/configuracoes', auth, requirePermissao(pool, 'configuracoes', 'editar'), async (req, res) => {
  try {
    const { empresa, nome_empresa, taxa_multa, taxa_juros_dia } = req.body;

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return jsonErro(res, 403, 'Sem acesso');
    }

    const taxaMultaFinal =
      taxa_multa !== undefined ? Number(taxa_multa) : null;
    const taxaJurosDiaFinal =
      taxa_juros_dia !== undefined ? Number(taxa_juros_dia) : null;

    await pool.query(
      `
        UPDATE configuracoes
        SET nome_empresa = $1,
            taxa_multa = COALESCE($3, taxa_multa),
            taxa_juros_dia = COALESCE($4, taxa_juros_dia),
            atualizado_em = NOW()
        WHERE (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $5))
        `,
      [nome_empresa, empresaResolvida.id, taxaMultaFinal, taxaJurosDiaFinal, empresaResolvida.nome]
    );

    _configCache.delete(empresaResolvida.nome);

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao salvar configurações:', error);
    jsonErro(res, 500, 'Erro ao salvar configurações');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason, promise);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});

// ================= ALERTAS =================

app.get('/alertas/:empresa', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, req.params.empresa);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const dataHoje = hoje();

    const [estoqueResult, receberResult, pagarResult, planoResult] = await Promise.all([
      pool.query(
        `SELECT id, nome, estoque, estoque_minimo FROM produtos
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           AND deletado_em IS NULL
           AND estoque_minimo > 0
           AND estoque <= estoque_minimo
         ORDER BY estoque ASC LIMIT 10`,
        [empresaResolvida.id, empresaResolvida.nome]
      ),
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(valor_atualizado), SUM(valor)) AS valor_total
         FROM contas_receber
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           AND LOWER(COALESCE(status, 'pendente')) IN ('pendente', 'atrasado')
           AND data_vencimento IS NOT NULL AND data_vencimento < $3`,
        [empresaResolvida.id, empresaResolvida.nome, dataHoje]
      ),
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(valor), 0) AS valor_total
         FROM contas_pagar
         WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
           AND LOWER(COALESCE(status, 'pendente')) = 'pendente'
           AND data_vencimento IS NOT NULL AND data_vencimento < $3`,
        [empresaResolvida.id, empresaResolvida.nome, dataHoje]
      ),
      obterPlanoEmpresa(empresaResolvida.id, empresaResolvida.nome)
    ]);

    const alertas = [];

    if (estoqueResult.rows.length > 0) {
      alertas.push({
        tipo: 'estoque_baixo',
        nivel: 'warning',
        titulo: `${estoqueResult.rows.length} produto(s) com estoque baixo`,
        itens: estoqueResult.rows.map(p => ({ id: p.id, nome: p.nome, estoque: Number(p.estoque), minimo: Number(p.estoque_minimo) }))
      });
    }

    const totalReceber = Number(receberResult.rows[0].total || 0);
    if (totalReceber > 0) {
      alertas.push({
        tipo: 'contas_receber_vencidas',
        nivel: 'danger',
        titulo: `${totalReceber} conta(s) a receber vencida(s)`,
        valor_total: Number(receberResult.rows[0].valor_total || 0)
      });
    }

    const totalPagar = Number(pagarResult.rows[0].total || 0);
    if (totalPagar > 0) {
      alertas.push({
        tipo: 'contas_pagar_vencidas',
        nivel: 'danger',
        titulo: `${totalPagar} conta(s) a pagar vencida(s)`,
        valor_total: Number(pagarResult.rows[0].valor_total || 0)
      });
    }

    if (planoResult?.assinatura_status === 'trial' && planoResult?.trial_fim) {
      const diasRestantes = Math.ceil(
        (new Date(`${planoResult.trial_fim}T00:00:00`) - new Date(`${dataHoje}T00:00:00`)) / 86400000
      );
      if (diasRestantes <= 7 && diasRestantes >= 0) {
        alertas.push({
          tipo: 'trial_expirando',
          nivel: diasRestantes <= 2 ? 'danger' : 'warning',
          titulo: diasRestantes === 0 ? 'Trial expira hoje' : `Trial expira em ${diasRestantes} dia(s)`,
          dias_restantes: diasRestantes
        });
      }
    }

    res.json({ total: alertas.length, alertas });
  } catch (error) {
    console.error('Erro ao buscar alertas:', error);
    jsonErro(res, 500, 'Erro ao buscar alertas');
  }
});

// ================= BILLING DE ASSINATURAS SAAS =================

// Configuração Asaas do dono do SaaS (não das empresas-clientes)
async function getSaasAsaasConfig() {
  const r = await pool.query(`SELECT asaas_api_key, asaas_sandbox FROM saas_config LIMIT 1`);
  const row = r.rows[0] || {};
  return { apiKey: decryptField(row.asaas_api_key) || null, sandbox: row.asaas_sandbox !== false };
}

// GET /admin/billing/config — retorna config Asaas do SaaS owner
app.get('/admin/billing/config', auth, apenasAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT CASE WHEN asaas_api_key IS NOT NULL THEN '****' ELSE NULL END AS asaas_api_key, asaas_sandbox
       FROM saas_config LIMIT 1`
    );
    res.json({ sucesso: true, ...(r.rows[0] || { asaas_sandbox: true }) });
  } catch (err) {
    console.error('[billing] GET config:', err.message);
    jsonErro(res, 500, 'Erro ao buscar config de billing');
  }
});

// PUT /admin/billing/config
app.put('/admin/billing/config', auth, apenasAdmin, async (req, res) => {
  try {
    const { asaas_api_key, asaas_sandbox } = req.body;
    const _saasKeyParaSalvar = (asaas_api_key && asaas_api_key !== '****')
      ? encryptField(asaas_api_key)
      : (asaas_api_key || null);
    await pool.query(
      `UPDATE saas_config
       SET asaas_api_key = COALESCE(NULLIF($1,'****'), asaas_api_key),
           asaas_sandbox = $2, atualizado_em = NOW()`,
      [_saasKeyParaSalvar, asaas_sandbox !== false]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error('[billing] PUT config:', err.message);
    jsonErro(res, 500, 'Erro ao salvar config de billing');
  }
});

// POST /admin/billing/cobrar/:empresaId — gera cobrança de assinatura
app.post('/admin/billing/cobrar/:empresaId', auth, apenasAdmin, async (req, res) => {
  try {
    const empresaId = Number(req.params.empresaId);
    const empresaResult = await pool.query(
      `SELECT e.*, p.preco_mensal, p.nome AS plano_nome
       FROM empresas e
       LEFT JOIN planos p ON p.id = e.plano_id
       WHERE e.id = $1`,
      [empresaId]
    );
    if (empresaResult.rowCount === 0) return jsonErro(res, 404, 'Empresa não encontrada');

    const empresa = empresaResult.rows[0];
    const valor = Number(empresa.preco_mensal || req.body.valor || 0);
    if (valor <= 0) return jsonErro(res, 400, 'Plano sem preço configurado');

    const { apiKey, sandbox } = await getSaasAsaasConfig();

    // Cria/busca cliente Asaas para o responsável da empresa
    let customerId = empresa.asaas_customer_id;
    if (!customerId && apiKey) {
      customerId = await resolverClienteAsaas(apiKey, sandbox, {
        nome:     empresa.responsavel_nome || empresa.nome,
        cpfCnpj:  empresa.responsavel_cpf  || empresa.cnpj || null,
        email:    empresa.responsavel_email || empresa.email || null,
        telefone: empresa.telefone || null
      });
      await pool.query(
        `UPDATE empresas SET asaas_customer_id = $1 WHERE id = $2`,
        [customerId, empresaId]
      );
    }

    const vencimento = req.body.vencimento || addDias(hoje(), 5);
    const descricao  = `Assinatura ${empresa.plano_nome || 'LF ERP'} — ${empresa.nome}`;

    const boleto = await criarBoletoAsaas(apiKey, sandbox, {
      customerId,
      valor,
      vencimento,
      descricao,
      externalReference: `assinatura_${empresaId}`
    });

    await pool.query(
      `UPDATE empresas
       SET assinatura_boleto_id  = $1,
           assinatura_boleto_url = $2,
           assinatura_vencimento = $3,
           atualizado_em         = NOW()
       WHERE id = $4`,
      [boleto.id, boleto.invoiceUrl || boleto.bankSlipUrl || null, vencimento, empresaId]
    );

    res.json({
      sucesso: true,
      boleto,
      sandbox: boleto.demo || sandbox || !apiKey,
      mensagem: boleto.demo
        ? 'Cobrança em modo demo (configure API Asaas em Billing → Configuração)'
        : `Boleto gerado para ${empresa.nome} — vencimento ${vencimento}`
    });
  } catch (err) {
    console.error('[billing] cobrar:', err.message);
    jsonErro(res, 500, `Erro ao gerar cobrança: ${err.message}`);
  }
});

// GET /admin/billing/status/:empresaId — consulta status da cobrança
app.get('/admin/billing/status/:empresaId', auth, apenasAdmin, async (req, res) => {
  try {
    const empresaId = Number(req.params.empresaId);
    const r = await pool.query(
      `SELECT assinatura_boleto_id, assinatura_boleto_url, assinatura_status, assinatura_vencimento
       FROM empresas WHERE id = $1`,
      [empresaId]
    );
    if (r.rowCount === 0) return jsonErro(res, 404, 'Empresa não encontrada');

    const empresa = r.rows[0];
    if (!empresa.assinatura_boleto_id) {
      return res.json({ sucesso: true, status: 'sem_cobranca', empresa_id: empresaId });
    }

    const { apiKey, sandbox } = await getSaasAsaasConfig();
    const boleto = await consultarBoletoAsaas(apiKey, sandbox, empresa.assinatura_boleto_id);

    // Ativa empresa automaticamente se pagamento confirmado
    if (['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(boleto.status)) {
      await pool.query(
        `UPDATE empresas
         SET assinatura_status = 'ativo', bloqueada = false,
             trial_fim = NULL, atualizado_em = NOW()
         WHERE id = $1 AND assinatura_status != 'ativo'`,
        [empresaId]
      );
    }

    res.json({ sucesso: true, boleto: { ...boleto, ...empresa } });
  } catch (err) {
    console.error('[billing] status:', err.message);
    jsonErro(res, 500, 'Erro ao consultar cobrança');
  }
});

// POST /admin/billing/webhook-assinatura — Asaas notifica pagamento de assinatura
app.post('/admin/billing/webhook-assinatura', async (req, res) => {
  try {
    if (!verificarWebhookAsaas(req, res)) return;

    const { event, payment } = req.body || {};
    const ref = payment?.externalReference || '';

    if (ref.startsWith('assinatura_') && ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)) {
      const empresaId = Number(ref.replace('assinatura_', ''));
      if (empresaId > 0) {
        await pool.query(
          `UPDATE empresas
           SET assinatura_status = 'ativo', bloqueada = false,
               trial_fim = NULL, atualizado_em = NOW()
           WHERE id = $1`,
          [empresaId]
        );
      }
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[billing] webhook-assinatura:', err.message);
    res.status(200).json({ ok: true });
  }
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
    });
  } catch (error) {
    console.error('Erro ao iniciar backend:', error);
    process.exit(1);
  }
}

start();

function normalizarFormaPagamentoFluxo(value) {
  const forma = String(value || '')
    .trim()
    .toLowerCase();

  const mapa = {
    dinheiro: 'Dinheiro',
    pix: 'Pix',
    cartão: 'Cartão',
    cartao: 'Cartão',
    credito: 'Cartão',
    crédito: 'Cartão',
    debito: 'Cartão',
    débito: 'Cartão',
    boleto: 'Boleto',
    promissoria: 'Promissória',
    promissória: 'Promissória'
  };

  return mapa[forma] || 'Não informado';
}

// ================= ADMIN: LOGS DE AUDITORIA =================

app.get('/admin/logs', auth, apenasAdmin, async (req, res) => {
  try {
    const empresa = req.query.empresa || '';
    const modulo = req.query.modulo || '';
    const acao = req.query.acao || '';
    const { dataInicial, dataFinal } = obterPeriodo(req);

    const params = [];
    let where = 'WHERE 1=1';

    if (empresa) {
      params.push(empresa);
      where += ` AND (empresa = $${params.length} OR empresa_id = (SELECT id FROM empresas WHERE nome = $${params.length} LIMIT 1))`;
    }
    if (modulo) { params.push(modulo); where += ` AND modulo = $${params.length}`; }
    if (acao) { params.push(acao); where += ` AND acao = $${params.length}`; }

    where += adicionarFiltroPeriodo({ campo: 'criado_em', params, dataInicial, dataFinal });

    const result = await pool.query(
      `SELECT * FROM logs_auditoria ${where} ORDER BY criado_em DESC LIMIT 500`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar logs:', error);
    jsonErro(res, 500, 'Erro ao buscar logs de auditoria');
  }
});

// ================= ADMIN: GESTÃO DE PLANOS =================

app.get('/admin/planos', auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM planos ORDER BY id`);
    res.json(result.rows);
  } catch (error) {
    jsonErro(res, 500, 'Erro ao listar planos');
  }
});

app.post('/admin/planos', auth, apenasAdmin, async (req, res) => {
  try {
    const {
      codigo, nome, preco_mensal,
      limite_usuarios, limite_produtos, limite_clientes,
      limite_fornecedores, limite_vendas_mes,
      permite_relatorios_avancados, permite_suporte_prioritario
    } = req.body;

    if (!codigo || !nome) return jsonErro(res, 400, 'Código e nome são obrigatórios');

    const result = await pool.query(
      `INSERT INTO planos
        (codigo, nome, preco_mensal, limite_usuarios, limite_produtos, limite_clientes,
         limite_fornecedores, limite_vendas_mes, permite_relatorios_avancados, permite_suporte_prioritario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        codigo, nome, Number(preco_mensal || 0),
        Number(limite_usuarios || 0), Number(limite_produtos || 0),
        Number(limite_clientes || 0), Number(limite_fornecedores || 0),
        Number(limite_vendas_mes || 0),
        Boolean(permite_relatorios_avancados), Boolean(permite_suporte_prioritario)
      ]
    );

    res.status(201).json({ sucesso: true, plano: result.rows[0] });
  } catch (error) {
    console.error('Erro ao criar plano:', error);
    jsonErro(res, 500, 'Erro ao criar plano');
  }
});

app.put('/admin/planos/:id', auth, apenasAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      nome, preco_mensal,
      limite_usuarios, limite_produtos, limite_clientes,
      limite_fornecedores, limite_vendas_mes,
      permite_relatorios_avancados, permite_suporte_prioritario
    } = req.body;

    if (!id) return jsonErro(res, 400, 'ID inválido');

    await pool.query(
      `UPDATE planos SET
        nome = COALESCE($1, nome),
        preco_mensal = COALESCE($2, preco_mensal),
        limite_usuarios = COALESCE($3, limite_usuarios),
        limite_produtos = COALESCE($4, limite_produtos),
        limite_clientes = COALESCE($5, limite_clientes),
        limite_fornecedores = COALESCE($6, limite_fornecedores),
        limite_vendas_mes = COALESCE($7, limite_vendas_mes),
        permite_relatorios_avancados = COALESCE($8, permite_relatorios_avancados),
        permite_suporte_prioritario = COALESCE($9, permite_suporte_prioritario)
       WHERE id = $10`,
      [
        nome || null, preco_mensal !== undefined ? Number(preco_mensal) : null,
        limite_usuarios !== undefined ? Number(limite_usuarios) : null,
        limite_produtos !== undefined ? Number(limite_produtos) : null,
        limite_clientes !== undefined ? Number(limite_clientes) : null,
        limite_fornecedores !== undefined ? Number(limite_fornecedores) : null,
        limite_vendas_mes !== undefined ? Number(limite_vendas_mes) : null,
        permite_relatorios_avancados !== undefined ? Boolean(permite_relatorios_avancados) : null,
        permite_suporte_prioritario !== undefined ? Boolean(permite_suporte_prioritario) : null,
        id
      ]
    );

    _planoCache.delete(`id:${id}`);

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao atualizar plano:', error);
    jsonErro(res, 500, 'Erro ao atualizar plano');
  }
});

// ── Metas de vendas ───────────────────────────────────────────────────────────

// GET /metas-vendas?periodo=YYYY-MM — lista metas com progresso real
app.get('/metas-vendas', auth, async (req, res) => {
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
      dataFim = fim.toISOString().slice(0, 10);
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

    // Calcula progresso real via vendas do período
    const metasComProgresso = await Promise.all(
      metasResult.rows.map(async (meta) => {
        const vendasResult = await pool.query(
          `SELECT COALESCE(SUM(total), 0) AS realizado
           FROM vendas
           WHERE empresa_id = $1
             AND data >= $2 AND data <= $3
             ${meta.usuario_id ? 'AND criado_por = $4' : ''}`,
          meta.usuario_id
            ? [empresaResolvida.id, dataInicio, dataFim, meta.usuario_id]
            : [empresaResolvida.id, dataInicio, dataFim]
        );
        const realizado = Number(vendasResult.rows[0].realizado || 0);
        const meta_valor = Number(meta.valor_meta || 0);
        const percentual = meta_valor > 0 ? Math.min(100, Math.round((realizado / meta_valor) * 100)) : 0;
        return { ...meta, realizado, percentual, faltando: Math.max(0, meta_valor - realizado) };
      })
    );

    res.json({ sucesso: true, periodo, data_inicio: dataInicio, data_fim: dataFim, metas: metasComProgresso });
  } catch (err) {
    console.error('[metas] GET:', err.message);
    jsonErro(res, 500, 'Erro ao carregar metas');
  }
});

// POST /metas-vendas — criar ou atualizar meta
app.post('/metas-vendas', auth, writeRateLimiter, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const { usuario_id, periodo, valor_meta, descricao } = req.body;
    if (!periodo || !valor_meta) return jsonErro(res, 400, 'periodo e valor_meta são obrigatórios');
    if (!/^\d{4}-\d{2}$/.test(periodo)) return jsonErro(res, 400, 'periodo deve ser YYYY-MM');

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
app.delete('/metas-vendas/:id', auth, writeRateLimiter, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const r = await pool.query(
      `DELETE FROM metas_vendas WHERE id = $1 AND empresa_id = $2`,
      [Number(req.params.id), empresaResolvida.id]
    );
    if (r.rowCount === 0) return jsonErro(res, 404, 'Meta não encontrada');
    res.json({ sucesso: true });
  } catch (err) {
    jsonErro(res, 500, 'Erro ao excluir meta');
  }
});

// ── Multi-depósito ────────────────────────────────────────────────────────────

// GET /depositos — lista depósitos da empresa
app.get('/depositos', auth, async (req, res) => {
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
app.post('/depositos', auth, writeRateLimiter, async (req, res) => {
  try {
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
app.put('/depositos/:id', auth, writeRateLimiter, async (req, res) => {
  try {
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
app.delete('/depositos/:id', auth, writeRateLimiter, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = Number(req.params.id);

    // Verifica se tem estoque
    const temEstoque = await pool.query(
      `SELECT 1 FROM produto_estoque_deposito WHERE deposito_id = $1 AND estoque > 0 LIMIT 1`,
      [id]
    );
    if (temEstoque.rowCount > 0) {
      return jsonErro(res, 400, 'Não é possível excluir um depósito com estoque. Transfira ou zere o estoque primeiro.');
    }

    const deposito = await pool.query(
      `SELECT principal FROM depositos WHERE id = $1 AND empresa_id = $2`,
      [id, empresaResolvida.id]
    );
    if (deposito.rowCount === 0) return jsonErro(res, 404, 'Depósito não encontrado');
    if (deposito.rows[0].principal) return jsonErro(res, 400, 'O depósito principal não pode ser excluído');

    await pool.query(`DELETE FROM depositos WHERE id = $1 AND empresa_id = $2`, [id, empresaResolvida.id]);
    res.json({ sucesso: true, mensagem: 'Depósito excluído' });
  } catch (err) {
    console.error('[depositos] DELETE:', err.message);
    jsonErro(res, 500, 'Erro ao excluir depósito');
  }
});

// GET /depositos/:id/estoque — estoque de um depósito
app.get('/depositos/:id/estoque', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = Number(req.params.id);
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
app.post('/depositos/transferir', auth, writeRateLimiter, async (req, res) => {
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
app.get('/empresa/exportar-dados', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    const id = empresaResolvida.id;

    const [
      clientesResult, produtosResult, vendasResult,
      venda_itensResult, comprasResult, compra_itensResult,
      crResult, cpResult, movimResult, lancamentosResult
    ] = await Promise.all([
      pool.query(`SELECT id,nome,telefone,email,cpf,cpf_cnpj,endereco,criado_em FROM clientes WHERE empresa_id=$1 AND deletado_em IS NULL ORDER BY id`, [id]),
      pool.query(`SELECT id,nome,categoria,preco,custo_medio,estoque,estoque_minimo,codigo_barras,criado_em FROM produtos WHERE empresa_id=$1 AND deletado_em IS NULL ORDER BY id`, [id]),
      pool.query(`SELECT id,cliente_nome,subtotal,desconto,acrescimo,total,pagamento,status_pagamento,data,criado_em FROM vendas WHERE empresa_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT vi.venda_id,vi.produto_nome,vi.quantidade,vi.preco_unitario,vi.total FROM venda_itens vi JOIN vendas v ON v.id=vi.venda_id WHERE v.empresa_id=$1 ORDER BY vi.venda_id,vi.id`, [id]),
      pool.query(`SELECT id,fornecedor_id,data,total,pagamento,status,criado_em FROM compras WHERE empresa_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT ci.compra_id,ci.produto_nome,ci.quantidade,ci.custo_unitario FROM compra_itens ci JOIN compras c ON c.id=ci.compra_id WHERE c.empresa_id=$1 ORDER BY ci.compra_id`, [id]),
      pool.query(`SELECT id,cliente_nome,parcela,total_parcelas,valor,data_vencimento,data_pagamento,status,forma_pagamento FROM contas_receber WHERE empresa_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT id,fornecedor_id,descricao,valor,data_vencimento,data_pagamento,status FROM contas_pagar WHERE empresa_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT produto_id,tipo,quantidade,data_movimentacao FROM movimentacoes_estoque WHERE empresa_id=$1 ORDER BY data_movimentacao`, [id]),
      pool.query(`SELECT id,tipo,descricao,valor,data,categoria FROM lancamentos_financeiros WHERE empresa_id=$1 ORDER BY data`, [id])
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
    res.setHeader('Content-Disposition',
      `attachment; filename="lferp-dados-${empresaResolvida.nome.replace(/\s+/g,'_')}-${hoje()}.json"`
    );
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[lgpd] exportar-dados:', err.message);
    jsonErro(res, 500, 'Erro ao exportar dados');
  }
});

// ── Notificações in-app ───────────────────────────────────────────────────────
// GET /notificacoes — retorna notificações relevantes para a empresa logada
app.get('/notificacoes', auth, async (req, res) => {
  try {
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
         WHERE empresa_id = $1
           AND LOWER(COALESCE(status,'pendente')) NOT IN ('pago')
           AND data_vencimento <= $2`,
        [empresaResolvida.id, dataHoje]
      ),
      // Contas a pagar vencendo hoje ou amanhã
      pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(valor), 0) AS valor_total
         FROM contas_pagar
         WHERE empresa_id = $1
           AND LOWER(COALESCE(status,'pendente')) = 'pendente'
           AND data_vencimento <= $2`,
        [empresaResolvida.id, amanha]
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
app.get('/sse-notificacoes', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(req, null, null);
    if (!empresaResolvida) return jsonErro(res, 403, 'Sem acesso');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const empresaId = empresaResolvida.id;
    if (!_sseClients.has(empresaId)) _sseClients.set(empresaId, new Set());
    const clientes = _sseClients.get(empresaId);
    clientes.add(res);

    // Envio imediato
    await ssePush(res, empresaId);

    // Heartbeat a cada 25s (menor que timeout de proxy)
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
    }, 25000);

    // Refresh a cada 60s
    const refresh = setInterval(async () => {
      await ssePush(res, empresaId).catch(() => {});
    }, 60000);

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

app.put('/admin/smtp/config', auth, apenasAdmin, async (req, res) => {
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

app.post('/admin/smtp/testar', auth, apenasAdmin, async (req, res) => {
  try {
    const cfg = await getSaasSmtp(pool);
    const transporter = criarTransporter(cfg);
    if (!transporter) return jsonErro(res, 400, 'SMTP não configurado');

    await transporter.sendMail({
      from:    cfg.smtp_from || cfg.smtp_user,
      to:      req.body.email || req.user.email || req.user.usuario,
      subject: 'Teste de SMTP — LF ERP',
      text:    'Este é um email de teste do sistema LF ERP. Configuração funcionando!'
    });
    res.json({ sucesso: true, mensagem: 'Email de teste enviado com sucesso' });
  } catch (err) {
    jsonErro(res, 500, `Erro ao enviar teste: ${err.message}`);
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
          COUNT(*) FILTER (WHERE criado_em >= NOW() - INTERVAL '30 days') AS novos_30d,
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
        WHERE criado_em >= NOW() - INTERVAL '30 days'`),
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

    const [
      clientesR, produtosR, fornecedoresR, vendasR, vendaItensR,
      comprasR, compraItensR, crR, cpR, movimR, lancamentosR
    ] = await Promise.all([
      pool.query(`SELECT * FROM clientes WHERE empresa_id=$1 AND deletado_em IS NULL ORDER BY id`, [id]),
      pool.query(`SELECT * FROM produtos WHERE empresa_id=$1 AND deletado_em IS NULL ORDER BY id`, [id]),
      pool.query(`SELECT * FROM fornecedores WHERE empresa_id=$1 AND deletado_em IS NULL ORDER BY id`, [id]),
      pool.query(`SELECT * FROM vendas WHERE empresa_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT vi.* FROM venda_itens vi JOIN vendas v ON v.id=vi.venda_id WHERE v.empresa_id=$1 ORDER BY vi.venda_id,vi.id`, [id]),
      pool.query(`SELECT * FROM compras WHERE empresa_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT ci.* FROM compra_itens ci JOIN compras c ON c.id=ci.compra_id WHERE c.empresa_id=$1 ORDER BY ci.compra_id`, [id]),
      pool.query(`SELECT * FROM contas_receber WHERE empresa_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT * FROM contas_pagar WHERE empresa_id=$1 ORDER BY id`, [id]),
      pool.query(`SELECT * FROM movimentacoes_estoque WHERE empresa_id=$1 ORDER BY data_movimentacao`, [id]),
      pool.query(`SELECT * FROM lancamentos_financeiros WHERE empresa_id=$1 ORDER BY data`, [id])
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

    const nomeArquivo = `lferp-backup-${empresa.nome.replace(/\s+/g,'_')}-${hoje()}.json`;
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

// ── Self-service onboarding ───────────────────────────────────────────────────
// POST /registro — público, cria empresa + usuário admin em trial de 14 dias
app.post('/registro', loginRateLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { nome_empresa, nome_responsavel, email, telefone, usuario, senha } = req.body;

    if (!nome_empresa || !usuario || !senha) {
      return jsonErro(res, 400, 'nome_empresa, usuario e senha são obrigatórios');
    }
    if (String(senha).length < 6) {
      return jsonErro(res, 400, 'A senha deve ter ao menos 6 caracteres');
    }

    // Verifica unicidade de empresa e usuário
    const [empresaExiste, usuarioExiste] = await Promise.all([
      pool.query(`SELECT id FROM empresas WHERE LOWER(nome) = LOWER($1) LIMIT 1`, [nome_empresa.trim()]),
      pool.query(`SELECT id FROM usuarios WHERE LOWER(usuario) = LOWER($1) LIMIT 1`, [usuario.trim()])
    ]);
    if (empresaExiste.rowCount > 0) return jsonErro(res, 409, 'Já existe uma empresa com esse nome');
    if (usuarioExiste.rowCount > 0) return jsonErro(res, 409, 'Esse nome de usuário já está em uso');

    await client.query('BEGIN');

    // Cria empresa com plano starter em trial de 14 dias
    const planoResult = await client.query(`SELECT id FROM planos WHERE codigo = 'starter' LIMIT 1`);
    const planoId  = planoResult.rows[0]?.id || null;
    const trialFim = addDias(hoje(), 14);

    const empresaResult = await client.query(
      `INSERT INTO empresas
         (nome, email, telefone, plano_id, assinatura_status, trial_inicio, trial_fim, bloqueada, criado_em, atualizado_em)
       VALUES ($1,$2,$3,$4,'trial',$5,$6,false,NOW(),NOW())
       RETURNING *`,
      [nome_empresa.trim(), email || null, telefone || null, planoId, hoje(), trialFim]
    );
    const empresa = empresaResult.rows[0];

    // Cria configuração da empresa
    await client.query(
      `INSERT INTO configuracoes (empresa, empresa_id, nome_empresa, criado_em, atualizado_em)
       VALUES ($1,$2,$3,NOW(),NOW()) ON CONFLICT DO NOTHING`,
      [empresa.nome, empresa.id, empresa.nome]
    );

    // Cria usuário admin
    const hash = await bcrypt.hash(senha, 10);
    const userResult = await client.query(
      `INSERT INTO usuarios
         (usuario, senha, tipo, empresa, empresa_id, nome_completo, email, criado_em, atualizado_em)
       VALUES ($1,$2,'admin',$3,$4,$5,$6,NOW(),NOW())
       RETURNING id, usuario, tipo, empresa, empresa_id, nome_completo`,
      [usuario.trim(), hash, empresa.nome, empresa.id, nome_responsavel || usuario.trim(), email || null]
    );
    const user = userResult.rows[0];

    await client.query('COMMIT');

    // Gera token JWT — usuário já entra logado
    const token = jwt.sign(
      {
        id:              user.id,
        usuario:         user.usuario,
        tipo:            user.tipo,
        is_saas_owner:   false,
        empresa:         empresa.nome,
        empresa_id:      empresa.id,
        nome:            user.nome_completo,
        primeiro_acesso: true
      },
      SECRET,
      { expiresIn: '12h' }
    );

    // Envia email de boas-vindas em background (não bloqueia resposta)
    if (email) {
      enviarEmailBoasVindas(pool, {
        nomeEmpresa: empresa.nome,
        nomeUsuario: user.nome_completo || usuario,
        email,
        usuario,
        trialFim
      }).catch((e) => console.error('[registro] email:', e.message));
    }

    return res.status(201).json({
      sucesso:    true,
      token,
      empresa:    { id: empresa.id, nome: empresa.nome, trial_fim: trialFim },
      user:       { id: user.id, usuario: user.usuario, tipo: user.tipo, nome: user.nome_completo },
      mensagem:   `Bem-vindo ao LF ERP! Seu período de teste de 14 dias começou.`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[registro]', err.message);
    jsonErro(res, 500, 'Erro ao criar conta');
  } finally {
    client.release();
  }
});

app.post('/admin/empresas', auth, apenasAdmin, async (req, res) => {
  try {
    const { nome, plano_id, trial_dias = 30, email, telefone, cnpj } = req.body;

    if (!nome) {
      return jsonErro(res, 400, 'Nome da empresa é obrigatório');
    }

    const existe = await pool.query(`SELECT id FROM empresas WHERE LOWER(nome) = LOWER($1) LIMIT 1`, [nome]);
    if (existe.rowCount > 0) {
      return jsonErro(res, 400, 'Já existe uma empresa com esse nome');
    }

    const trialFim = addDias(hoje(), trial_dias);

    const empresaResult = await pool.query(
      `INSERT INTO empresas
        (nome, cnpj, telefone, email, plano_id, assinatura_status, trial_inicio, trial_fim, bloqueada, criado_em, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, 'trial', $6, $7, false, NOW(), NOW())
       RETURNING *`,
      [nome, cnpj || null, telefone || null, email || null, plano_id || null, hoje(), trialFim]
    );

    const empresa = empresaResult.rows[0];

    await pool.query(
      `INSERT INTO configuracoes (empresa, empresa_id, nome_empresa, criado_em, atualizado_em)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [empresa.nome, empresa.id, empresa.nome]
    );

    return res.status(201).json({ sucesso: true, empresa });
  } catch (error) {
    console.error('Erro ao criar empresa:', error);
    jsonErro(res, 500, 'Erro ao criar empresa');
  }
});

app.put('/admin/empresas/:id/status', auth, apenasAdmin, async (req, res) => {
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
    _configCache.delete(nomeEmpresa);

    return res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao atualizar status da empresa:', error);
    jsonErro(res, 500, 'Erro ao atualizar empresa');
  }
});
