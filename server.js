require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const financeiroRoutes = require('./routes/financeiro.routes');
const relatoriosRoutes = require('./routes/relatorios.routes');
const comprasRoutes = require('./routes/compras.routes');
const vendasRoutes = require('./routes/vendas.routes');
const produtosRoutes = require('./routes/produtos.routes');
const estoqueRoutes = require('./routes/estoque.routes');
const clientesRoutes = require('./routes/clientes.routes');
const fornecedoresRoutes = require('./routes/fornecedores.routes');

const app = express();
app.use(cors());
app.use(express.json());

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
const PORT = process.env.PORT || 3001;

if (!SECRET) {
  console.error('JWT_SECRET não definida.');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL não definida.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      status: 'ok',
      sistema: 'LF ERP',
      database: 'online',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro no health check:', error);

    res.status(500).json({
      status: 'erro',
      sistema: 'LF ERP',
      database: 'offline'
    });
  }
});

app.use(
  '/financeiro',
  financeiroRoutes({
    auth,
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
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    atualizarStatusContasReceberPorEmpresa,
    atualizarStatusContasPagarPorEmpresa
  })
);

app.use(
  '/compras',
  comprasRoutes({
    auth,
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
    registrarAuditoria
  })
);

app.use(
  '/produtos',
  produtosRoutes({
    auth,
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
    adicionarFiltroEmpresaSaaS,
    adicionarFiltroPeriodo
  })
);

app.use(
  '/estoque',
  estoqueRoutes({
    auth,
    pool,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    normalizarInt,
    obterPeriodo,
    adicionarFiltroPeriodo,
    adicionarFiltroEmpresaSaaS,
    registrarMovimentacaoEstoque
  })
);

app.use(
  '/clientes',
  clientesRoutes({
    auth,
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

function hoje() {
  return new Date().toISOString().slice(0, 10);
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
  await pool.query(
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
  );
}

function normalizarInt(valor) {
  const numero = parseInt(valor, 10);
  return Number.isFinite(numero) ? numero : 0;
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
  return d.toISOString().slice(0, 10);
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

async function resolverEmpresaRequest(req, empresaInformada = null) {
  const empresaIdInformada =
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

async function validarAcessoEmpresa(req, empresaInformada = null) {
  if (req.user.tipo === 'admin') {
    return await resolverEmpresaRequest(req, empresaInformada);
  }

  const empresaResolvida = await resolverEmpresaRequest(req, empresaInformada);

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

async function obterNomeEmpresaAcesso(req, empresaInformada = null) {
  const empresaResolvida = await validarAcessoEmpresa(req, empresaInformada);
  if (!empresaResolvida) return null;
  return empresaResolvida.nome;
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

function validarEmpresa(req, empresa) {
  // LEGADO: manter apenas para rotas antigas.
  // Novas rotas devem usar validarAcessoEmpresa(req, empresa).
  if (!req.user) return false;
  if (req.user.tipo === 'admin') return true;

  return Boolean(empresa && req.user.empresa && String(req.user.empresa) === String(empresa));
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

async function obterPlanoEmpresa(empresaId, empresaNome) {
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

  if (result.rowCount === 0) return null;
  return result.rows[0];
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
    `SELECT COUNT(*) AS total FROM ${config.tabela} WHERE empresa = $1`,
    [empresaResolvida.nome]
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
    WHERE empresa = $1
      AND data >= $2
      AND data <= $3
    `,
    [empresaResolvida.nome, inicioMes, hojeData]
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

  if (senhaInformada === senhaSalva) {
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

function auth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(403).send('Sem acesso');
  }

  let token = authHeader;

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (!token) {
    return res.status(403).send('Token inválido');
  }

  try {
    const decoded = jwt.verify(token, SECRET);

    req.user = decoded;

    req.empresa_id = decoded.empresa_id ? Number(decoded.empresa_id) : null;
    req.empresa_nome = decoded.empresa_nome || decoded.empresa || null;

    if (!req.user?.id || !req.user?.tipo) {
      return res.status(403).send('Token inválido');
    }

    if (req.user.tipo !== 'admin' && !req.empresa_id) {
      return res.status(403).send('Empresa não identificada no token');
    }

    next();
  } catch (error) {
    return res.status(403).send('Token inválido');
  }
}

function apenasAdmin(req, res, next) {
  if (req.user.tipo !== 'admin') {
    return res.status(403).send('Apenas admin pode acessar');
  }
  next();
}

async function registrarMovimentacaoEstoque({
  empresa,
  empresa_id,
  produto_id,
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
        tipo,
        quantidade,
        observacao,
        referencia_tipo,
        referencia_id,
        usuario_id,
        data_movimentacao
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [
      empresa,
      empresa_id || null,
      produto_id,
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

  await executor.query(
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
}

async function atualizarStatusContasReceberPorEmpresa(empresa) {
  await pool.query(
    `
    UPDATE contas_receber
    SET status = 'atrasado',
        dias_atraso = GREATEST(($2::date - data_vencimento::date), 0),
        multa = ROUND((valor * 0.02)::numeric, 2),
        juros = ROUND((valor * 0.00033 * GREATEST(($2::date - data_vencimento::date), 0))::numeric, 2),
        valor_atualizado = ROUND(
          (
            valor
            + (valor * 0.02)
            + (valor * 0.00033 * GREATEST(($2::date - data_vencimento::date), 0))
          )::numeric,
          2
        ),
        atualizado_em = NOW()
    WHERE empresa = $1
      AND LOWER(COALESCE(status, 'pendente')) IN ('pendente', 'atrasado')
      AND data_vencimento IS NOT NULL
      AND data_vencimento < $2
    `,
    [empresa, hoje()]
  );

  await pool.query(
    `
    UPDATE contas_receber
    SET dias_atraso = 0,
        multa = 0,
        juros = 0,
        valor_atualizado = valor,
        atualizado_em = NOW()
    WHERE empresa = $1
      AND LOWER(COALESCE(status, 'pendente')) = 'pendente'
      AND data_vencimento IS NOT NULL
      AND data_vencimento >= $2
    `,
    [empresa, hoje()]
  );
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

async function atualizarStatusContasPagarPorEmpresa(empresa) {
  await pool.query(
    `UPDATE contas_pagar
      SET status = 'atrasado',
          atualizado_em = NOW()
      WHERE empresa = $1
        AND status = 'pendente'
        AND data_vencimento IS NOT NULL
        AND data_vencimento < $2`,
    [empresa, hoje()]
  );
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

  if (parcelas <= 0) return [];

  const valorBase = Math.floor((valorTotal / parcelas) * 100) / 100;
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
        ? data_primeiro_vencimento
        : addDias(data_primeiro_vencimento, (i - 1) * normalizarInt(intervalo_dias || 30));

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
        data_vencimento,
        data_pagamento,
        status,
        forma_pagamento,
        observacao,
        criado_por,
        criado_em,
        atualizado_em
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 'pendente', $10, $11, $12, NOW(), NOW())
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

async function montarRelatorioEstoquePorEmpresa(empresa) {
  const estoqueBaixoParams = [];
  const [resumoResult, produtosResult, entradasSaidasResult] = await Promise.all([
    pool.query(
      `
        SELECT
          COUNT(*) AS total_produtos,
          COALESCE(SUM(estoque), 0) AS total_unidades,
          COALESCE(SUM(estoque * custo), 0) AS valor_total_estoque,
          COALESCE(SUM(CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN 1 ELSE 0 END), 0) AS produtos_alerta,
          COALESCE(SUM(CASE WHEN estoque = 0 THEN 1 ELSE 0 END), 0) AS produtos_zerados
        FROM produtos
        WHERE empresa = $1
        `,
      [empresa]
    ),
    pool.query(
      `
        SELECT
          id,
          empresa,
          nome,
          categoria,
          preco,
          custo,
          estoque,
          estoque_minimo,
          (estoque * custo) AS valor_estoque,
          CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN TRUE ELSE FALSE END AS alerta_estoque
        FROM produtos
        WHERE empresa = $1
        ORDER BY valor_estoque DESC, nome ASC
        `,
      [empresa]
    ),
    pool.query(
      `
        SELECT
          COALESCE(SUM(CASE WHEN tipo IN ('entrada_compra', 'ajuste_entrada', 'cadastro_inicial', 'estorno_venda') THEN quantidade ELSE 0 END), 0) AS total_entradas,
          COALESCE(SUM(CASE WHEN tipo IN ('saida_venda', 'ajuste_saida', 'perda', 'avaria') THEN quantidade ELSE 0 END), 0) AS total_saidas
        FROM movimentacoes_estoque
        WHERE empresa = $1
        `,
      [empresa]
    )
  ]);

  const produtos = produtosResult.rows.map((p) => ({
    ...p,
    preco: Number(p.preco || 0),
    custo: Number(p.custo || 0),
    estoque: Number(p.estoque || 0),
    estoque_minimo: Number(p.estoque_minimo || 0),
    valor_estoque: Number(p.valor_estoque || 0),
    alerta_estoque: Boolean(p.alerta_estoque)
  }));

  const topValorParado = [...produtos]
    .sort((a, b) => b.valor_estoque - a.valor_estoque)
    .slice(0, 10);

  const produtosAlerta = produtos
    .filter((p) => p.alerta_estoque)
    .sort((a, b) => a.estoque - b.estoque);

  return {
    resumo: {
      total_produtos: Number(resumoResult.rows[0].total_produtos || 0),
      total_unidades: Number(resumoResult.rows[0].total_unidades || 0),
      valor_total_estoque: Number(resumoResult.rows[0].valor_total_estoque || 0),
      produtos_alerta: Number(resumoResult.rows[0].produtos_alerta || 0),
      produtos_zerados: Number(resumoResult.rows[0].produtos_zerados || 0),
      total_entradas: Number(entradasSaidasResult.rows[0].total_entradas || 0),
      total_saidas: Number(entradasSaidasResult.rows[0].total_saidas || 0)
    },
    top_valor_parado: topValorParado,
    produtos_alerta: produtosAlerta,
    produtos
  };
}

async function montarRelatorioPerformancePorEmpresa(empresa) {
  const [produtosResult, vendasItensResult] = await Promise.all([
    pool.query(
      `
        SELECT
          id,
          empresa,
          nome,
          categoria,
          preco,
          custo,
          estoque,
          estoque_minimo,
          (estoque * custo) AS valor_estoque
        FROM produtos
        WHERE empresa = $1
        ORDER BY nome ASC
        `,
      [empresa]
    ),
    pool.query(
      `
        SELECT
          produto_id,
          produto_nome AS produto,
          COALESCE(SUM(quantidade), 0) AS quantidade_vendida,
          COALESCE(SUM(total), 0) AS faturamento
        FROM venda_itens
        WHERE empresa = $1
        GROUP BY produto_id, produto_nome
        `,
      [empresa]
    )
  ]);

  const mapaVendas = new Map();
  for (const row of vendasItensResult.rows) {
    mapaVendas.set(Number(row.produto_id), {
      quantidade_vendida: Number(row.quantidade_vendida || 0),
      faturamento: Number(row.faturamento || 0)
    });
  }

  const produtos = produtosResult.rows.map((p) => {
    const vendas = mapaVendas.get(Number(p.id)) || {
      quantidade_vendida: 0,
      faturamento: 0
    };

    const custo = Number(p.custo || 0);
    const lucro_bruto = Number((vendas.faturamento - vendas.quantidade_vendida * custo).toFixed(2));

    return {
      id: Number(p.id),
      empresa: p.empresa,
      nome: p.nome,
      categoria: p.categoria || '',
      preco: Number(p.preco || 0),
      custo,
      estoque: Number(p.estoque || 0),
      estoque_minimo: Number(p.estoque_minimo || 0),
      valor_estoque: Number(p.valor_estoque || 0),
      quantidade_vendida: vendas.quantidade_vendida,
      faturamento: vendas.faturamento,
      lucro_bruto
    };
  });

  const topFaturamento = [...produtos].sort((a, b) => b.faturamento - a.faturamento).slice(0, 10);

  const topLucro = [...produtos].sort((a, b) => b.lucro_bruto - a.lucro_bruto).slice(0, 10);

  const baixoGiro = [...produtos]
    .filter((p) => p.estoque > 0 && p.quantidade_vendida === 0)
    .sort((a, b) => b.valor_estoque - a.valor_estoque)
    .slice(0, 10);

  return {
    top_faturamento: topFaturamento,
    top_lucro: topLucro,
    baixo_giro: baixoGiro,
    produtos
  };
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
        assinatura_status = COALESCE(assinatura_status, 'trial'),
        trial_inicio = COALESCE(trial_inicio, $1),
        trial_fim = COALESCE(trial_fim, $2),
        atualizado_em = NOW()
    WHERE id = $3
    `,
    [hoje(), addDias(hoje(), 14), empresaSaaSId]
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
    CREATE INDEX IF NOT EXISTS idx_investimentos_empresa ON investimentos (empresa);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_empresa ON contas_receber (empresa);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_status ON contas_receber (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa ON contas_pagar (empresa);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_status ON contas_pagar (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_configuracoes_empresa ON configuracoes (empresa);
    CREATE INDEX IF NOT EXISTS idx_configuracoes_empresa_id ON configuracoes (empresa_id);
  `);

  // ================= USUÁRIO ADMIN PADRÃO =================
  const hash = await bcrypt.hash('Lfgl.1308.', 10);

  const existing = await pool.query(`SELECT id FROM usuarios WHERE usuario = $1`, ['Lfelipeg']);

  if (existing.rowCount === 0) {
    await pool.query(
      `INSERT INTO usuarios
      (usuario, senha, tipo, empresa, empresa_id, nome_completo, cpf, nascimento)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['Lfelipeg', hash, 'admin', 'LF ERP', empresaSaaSId, 'Lfelipeg', '', '']
    );
  } else {
    await pool.query(
      `UPDATE usuarios
      SET senha = $1,
          tipo = $2,
          empresa = $3,
          empresa_id = COALESCE(empresa_id, $4),
          nome_completo = COALESCE(nome_completo, $5),
          atualizado_em = NOW()
      WHERE usuario = $6`,
      [hash, 'admin', 'LF ERP', empresaSaaSId, 'Lfelipeg', 'Lfelipeg']
    );
  }

  await atualizarStatusContasReceberGlobal();
  await atualizarStatusContasPagarGlobal();
}

app.get('/', (req, res) => {
  res.send('LF ERP backend online 🚀');
});

app.post('/reset-dados', auth, async (req, res) => {
  try {
    if (req.user.tipo !== 'admin') {
      return res.status(403).send('Sem permissão');
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

    res.send('Dados resetados com sucesso');
  } catch (error) {
    console.error('Erro no reset:', error);
    res.status(500).send('Erro ao resetar dados');
  }
});

// ================= AUTH =================
app.post('/login', async (req, res) => {
  try {
    const { usuario, senha } = req.body;

    if (!usuario || !senha) {
      return res.status(400).send('Informe usuário e senha');
    }

    const result = await pool.query(
      `SELECT
        u.*,
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
      WHERE u.usuario = $1`,
      [usuario]
    );

    if (result.rowCount === 0) {
      return res.status(401).send('Usuário ou senha inválidos');
    }

    const user = result.rows[0];

    if (user.bloqueada) {
      return res.status(403).send('Empresa bloqueada. Entre em contato com o suporte.');
    }

    if (user.assinatura_status === 'inativo' || user.assinatura_status === 'cancelado') {
      return res.status(403).send('Assinatura inativa. Regularize o acesso para continuar.');
    }

    if (user.assinatura_status === 'trial' && user.trial_fim) {
      if (String(user.trial_fim) < hoje()) {
        return res.status(403).send('Período de teste expirado. Escolha um plano para continuar.');
      }
    }

    const senhaOk = await validarSenhaUsuario(senha, user);

    if (!senhaOk) {
      return res.status(401).send('Usuário ou senha inválidos');
    }

    const nomeCompleto = user.nome_completo || user.usuario;

    const token = jwt.sign(
      {
        id: user.id,
        usuario: user.usuario,
        tipo: user.tipo,
        empresa: user.empresa || null,
        empresa_id: user.empresa_id_real || user.empresa_id || null,
        empresa_nome: user.empresa_nome_real || user.empresa || null,
        nome_completo: nomeCompleto,
        plano_codigo: user.plano_codigo || null,
        plano_nome: user.plano_nome || null,
        assinatura_status: user.assinatura_status || null
      },
      SECRET,
      { expiresIn: '12h' }
    );

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
    res.status(500).send('Erro ao fazer login');
  }
});

app.get('/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
        u.id,
        u.usuario,
        u.tipo,
        u.empresa,
        u.empresa_id,
        u.nome_completo,
        u.cpf,
        u.nascimento,
        e.nome AS empresa_nome_real
      FROM usuarios u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      WHERE u.id = $1
      `,
      [req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).send('Usuário não encontrado');
    }

    const user = result.rows[0];
    const nomeCompleto = user.nome_completo || user.usuario;

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
      nascimento: user.nascimento || ''
    });
  } catch (error) {
    console.error('Erro ao validar sessão:', error);
    res.status(500).send('Erro ao validar sessão');
  }
});

app.get('/empresa/status', auth, async (req, res) => {
  try {
    const empresaResolvida = await validarAcessoEmpresa(
      req,
      req.user.empresa_nome || req.user.empresa
    );

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
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
      return res.status(404).send('Empresa não encontrada');
    }

    const empresa = result.rows[0];

    const [usuariosResult, produtosResult, clientesResult, fornecedoresResult, vendasMesResult] =
      await Promise.all([
        pool.query(`SELECT COUNT(*) AS total FROM usuarios WHERE empresa = $1`, [
          empresaResolvida.nome
        ]),
        pool.query(`SELECT COUNT(*) AS total FROM produtos WHERE empresa = $1`, [
          empresaResolvida.nome
        ]),
        pool.query(`SELECT COUNT(*) AS total FROM clientes WHERE empresa = $1`, [
          empresaResolvida.nome
        ]),
        pool.query(`SELECT COUNT(*) AS total FROM fornecedores WHERE empresa = $1`, [
          empresaResolvida.nome
        ]),
        pool.query(
          `
        SELECT COUNT(*) AS total
        FROM vendas
        WHERE empresa = $1
          AND data >= $2
          AND data <= $3
        `,
          [empresaResolvida.nome, hoje().slice(0, 8) + '01', hoje()]
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
    res.status(500).send('Erro ao carregar status da empresa');
  }
});

// ================= USUÁRIOS =================

// LISTAR USUÁRIOS
app.get('/usuarios/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send('Sem permissão para acessar usuários');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
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
        WHERE empresa = $1
        ORDER BY id DESC
        `,
      [empresaResolvida.nome]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    res.status(500).send('Erro ao listar usuários');
  }
});

// CRIAR USUÁRIO
app.post('/usuarios', auth, async (req, res) => {
  try {
    const { empresa, empresa_id, nome, usuario, senha, tipo } = req.body;

    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send('Sem permissão para cadastrar usuários');
    }

    if (!nome || !usuario || !senha || !tipo) {
      return res.status(400).send('Dados obrigatórios');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    const limitePlano = await validarLimitePlano({
      empresaResolvida,
      recurso: 'usuarios'
    });

    if (!limitePlano.permitido) {
      return res.status(403).send(limitePlano.mensagem);
    }

    const usuarioExiste = await pool.query(`SELECT id FROM usuarios WHERE usuario = $1`, [
      usuario.trim()
    ]);

    if (usuarioExiste.rowCount > 0) {
      return res.status(400).send('Usuário já existe');
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
    res.status(500).send('Erro ao criar usuário');
  }
});

// ATUALIZAR USUÁRIO
app.put('/usuarios/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { empresa, empresa_id, nome, usuario, senha, tipo } = req.body;

    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send('Sem permissão para editar usuários');
    }

    if (!nome || !usuario || !tipo) {
      return res.status(400).send('Dados obrigatórios');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    const atualResult = await pool.query(`SELECT * FROM usuarios WHERE id = $1 AND empresa = $2`, [
      id,
      empresaResolvida.nome
    ]);

    if (atualResult.rowCount === 0) {
      return res.status(404).send('Usuário não encontrado');
    }

    const usuarioDuplicado = await pool.query(
      `SELECT id FROM usuarios WHERE usuario = $1 AND id <> $2`,
      [usuario.trim(), id]
    );

    if (usuarioDuplicado.rowCount > 0) {
      return res.status(400).send('Já existe outro usuário com esse login');
    }

    if (senha && senha.trim()) {
      const senhaHash = await bcrypt.hash(senha.trim(), 10);

      await pool.query(
        `
          UPDATE usuarios
          SET nome_completo = $1,
              usuario = $2,
              senha = $3,
              tipo = $4,
              atualizado_em = NOW()
          WHERE id = $5 AND empresa = $6
          `,
        [nome.trim(), usuario.trim(), senhaHash, tipo, id, empresaResolvida.nome]
      );
    } else {
      await pool.query(
        `
          UPDATE usuarios
          SET nome_completo = $1,
              usuario = $2,
              tipo = $3,
              atualizado_em = NOW()
          WHERE id = $4 AND empresa = $5
          `,
        [nome.trim(), usuario.trim(), tipo, id, empresaResolvida.nome]
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro ao atualizar usuário:', error);
    res.status(500).send('Erro ao atualizar usuário');
  }
});

// EXCLUIR USUÁRIO
app.delete('/usuarios/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const empresa = req.query.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send('Sem permissão para excluir usuários');
    }

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    if (req.user.id === id) {
      return res.status(400).send('Você não pode excluir o próprio usuário');
    }

    const existe = await pool.query(`SELECT id FROM usuarios WHERE id = $1 AND empresa = $2`, [
      id,
      empresaResolvida.nome
    ]);

    if (existe.rowCount === 0) {
      return res.status(404).send('Usuário não encontrado');
    }

    await pool.query(`DELETE FROM usuarios WHERE id = $1 AND empresa = $2`, [
      id,
      empresaResolvida.nome
    ]);

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro ao excluir usuário:', error);
    res.status(500).send('Erro ao excluir usuário');
  }
});

// ================= COMPRAS =================
app.post('/compras', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!podeGerenciarCompras(req)) {
      return res.status(403).send('Sem permissão para compras');
    }

    const {
      empresa,
      empresa_id,
      fornecedor_id,
      data,
      pagamento,
      parcelas,
      observacao,
      primeiro_vencimento,
      itens
    } = req.body;

    if (!fornecedor_id || !data || !pagamento || !Array.isArray(itens) || itens.length === 0) {
      return res.status(400).send('Dados da compra incompletos');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    await client.query('BEGIN');

    const fornecedorResult = await client.query(
      `SELECT * FROM fornecedores WHERE id = $1 AND empresa = $2`,
      [fornecedor_id, empresaResolvida.nome]
    );

    if (fornecedorResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('Fornecedor não encontrado');
    }

    const fornecedor = fornecedorResult.rows[0];

    let totalCalculado = 0;

    for (const item of itens) {
      const produtoId = Number(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);
      const custoUnitario = normalizarDecimal(
        item.custo_unitario || item.preco_unitario || item.custo
      );
      const subtotal = Number((quantidade * custoUnitario).toFixed(2));

      if (!produtoId || quantidade <= 0 || custoUnitario < 0) {
        await client.query('ROLLBACK');
        return res.status(400).send('Itens da compra inválidos');
      }

      totalCalculado = Number((totalCalculado + subtotal).toFixed(2));
    }

    const geraContaPagar =
      pagamentoNormalizado === 'boleto' || pagamentoNormalizado === 'promissoria';
    const parcelasFinal = geraContaPagar ? Math.max(1, normalizarInt(parcelas || 1)) : 1;
    const pagamentoNormalizado = String(pagamento || 'dinheiro').toLowerCase();
    const compraResult = await client.query(
      `INSERT INTO compras
        (empresa, fornecedor_id, data, total, observacao, gerar_conta_pagar, pagamento, status, criado_por, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'finalizada', $8, NOW(), NOW())
        RETURNING *`,
      [
        empresaResolvida.nome,
        fornecedor_id,
        data,
        totalCalculado,
        observacao || '',
        geraContaPagar,
        pagamentoNormalizado,
        req.user.id
      ]
    );

    const compra = compraResult.rows[0];

    await client.query(
      `UPDATE compras
        SET empresa_id = $1
        WHERE id = $2`,
      [empresaResolvida.id, compra.id]
    );

    for (const item of itens) {
      const produtoId = Number(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);
      const custoUnitario = normalizarDecimal(
        item.custo_unitario || item.preco_unitario || item.custo
      );
      const subtotal = Number((quantidade * custoUnitario).toFixed(2));

      const produtoResult = await client.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa = $2`,
        [produtoId, empresaResolvida.nome]
      );

      if (produtoResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).send(`Produto ${produtoId} não encontrado`);
      }

      const produto = produtoResult.rows[0];
      const novoEstoque = normalizarInt(produto.estoque) + quantidade;

      await client.query(
        `INSERT INTO compra_itens
          (compra_id, produto_id, produto_nome, quantidade, custo_unitario, subtotal)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [compra.id, produto.id, produto.nome, quantidade, custoUnitario, subtotal]
      );

      await client.query(
        `UPDATE produtos
          SET estoque = $1,
              custo = $2,
              atualizado_em = NOW()
          WHERE id = $3 AND empresa = $4`,
        [novoEstoque, custoUnitario, produto.id, empresaResolvida.nome]
      );

      await registrarMovimentacaoEstoque({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        produto_id: produto.id,
        tipo: 'entrada_compra',
        quantidade,
        observacao: `Entrada por compra #${compra.id}`,
        referencia_tipo: 'compra',
        referencia_id: compra.id,
        usuario_id: req.user.id,
        client
      });
    }

    if (geraContaPagar) {
      const dataPrimeiroVencimento = normalizarDataISO(primeiro_vencimento || data) || data;
      const intervaloDias = 30;
      const valorBase = Math.floor((totalCalculado / parcelasFinal) * 100) / 100;
      let acumulado = 0;

      for (let i = 1; i <= parcelasFinal; i++) {
        let valorParcela = valorBase;

        if (i === parcelasFinal) {
          valorParcela = Number((totalCalculado - acumulado).toFixed(2));
        }

        acumulado = Number((acumulado + valorParcela).toFixed(2));

        const vencimento =
          i === 1
            ? dataPrimeiroVencimento
            : addDias(dataPrimeiroVencimento, (i - 1) * intervaloDias);

        await client.query(
          `INSERT INTO contas_pagar
            (
              empresa,
              fornecedor_id,
              fornecedor_nome,
              compra_id,
              descricao,
              parcela,
              total_parcelas,
              valor,
              data_vencimento,
              data_pagamento,
              status,
              forma_pagamento,
              observacao,
              criado_por,
              criado_em,
              atualizado_em
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 'pendente', $10, $11, $12, NOW(), NOW())`,
          [
            empresaResolvida.nome,
            fornecedor.id,
            fornecedor.nome,
            compra.id,
            `Parcela ${i}/${parcelasFinal} - Compra #${compra.id}`,
            i,
            parcelasFinal,
            valorParcela,
            vencimento,
            pagamento,
            observacao || '',
            req.user.id
          ]
        );
      }
    }

    await client.query('COMMIT');
    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);

    res.json({
      sucesso: true,
      compra_id: compra.id
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro real ao cadastrar compra:', error);
    res.status(500).send('Erro ao cadastrar compra');
  } finally {
    client.release();
  }
});

app.get('/compras/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    const busca = (req.query.busca || '').trim().toLowerCase();
    const fornecedorId = normalizarInt(req.query.fornecedor_id || 0);
    const { dataInicial, dataFinal } = obterPeriodo(req);

    let sql = `
        SELECT
          c.*,
          f.nome AS fornecedor_nome
        FROM compras c
        LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
        WHERE c.empresa = $1
      `;
    const params = [empresaResolvida.nome];
    let idx = 2;

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
    res.status(500).send('Erro ao buscar compras');
  }
});

app.delete('/compras/:id', auth, async (req, res) => {
  const empresa = req.query.empresa || req.body.empresa || null;
  const empresaResolvida = await validarAcessoEmpresa(req, empresa);

  if (!empresaResolvida) {
    return res.status(403).send('Sem acesso');
  }

  const client = await pool.connect();

  try {
    if (!podeGerenciarCompras(req)) {
      return res.status(403).send('Sem permissão para excluir compras');
    }

    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).send('Compra inválida');
    }

    await client.query('BEGIN');

    const compraResult = await client.query(
      `
      SELECT *
      FROM compras
      WHERE id = $1 AND empresa = $2
      `,
      [id, empresaResolvida.nome]
    );

    if (compraResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('Compra não encontrada');
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
        WHERE id = $1 AND empresa = $2
        `,
        [item.produto_id, empresaResolvida.nome]
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
          WHERE id = $2 AND empresa = $3
          `,
          [novoEstoque, item.produto_id, empresaResolvida.nome]
        );
      }
    }

    await client.query(
      `
      DELETE FROM movimentacoes_estoque
      WHERE referencia_tipo = 'compra'
        AND referencia_id = $1
        AND empresa = $2
      `,
      [id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM contas_pagar
      WHERE compra_id = $1
        AND empresa = $2
      `,
      [id, empresaResolvida.nome]
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
        AND empresa = $2
      `,
      [id, empresaResolvida.nome]
    );

    await client.query('COMMIT');
    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);

    res.json({ sucesso: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro real ao excluir compra:', error);
    res.status(500).send('Erro ao excluir compra');
  } finally {
    client.release();
  }
});

app.get('/compras-detalhe/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const compraResult = await pool.query(
      `
      SELECT
        c.*,
        f.nome AS fornecedor_nome
      FROM compras c
      LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
      WHERE c.id = $1
      `,
      [id]
    );

    if (compraResult.rowCount === 0) {
      return res.status(404).send('Compra não encontrada');
    }

    const compra = compraResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, compra.empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

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
    res.status(500).send('Erro ao buscar compra');
  }
});

// ================= LISTAGENS OPERACIONAIS AUXILIARES =================
app.get('/estoque/resumo/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaFinal = await obterNomeEmpresaAcesso(req, empresa);

    if (!empresaFinal) {
      return res.status(403).send('Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          COUNT(*) AS total_produtos,
          COALESCE(SUM(estoque), 0) AS total_unidades,
          COALESCE(SUM(estoque * custo), 0) AS valor_total_estoque,
          COALESCE(SUM(CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN 1 ELSE 0 END), 0) AS produtos_alerta
        FROM produtos
        WHERE empresa = $1
        `,
      [empresaFinal]
    );

    res.json({
      total_produtos: Number(result.rows[0].total_produtos || 0),
      total_unidades: Number(result.rows[0].total_unidades || 0),
      valor_total_estoque: Number(result.rows[0].valor_total_estoque || 0),
      produtos_alerta: Number(result.rows[0].produtos_alerta || 0)
    });
  } catch (error) {
    res.status(500).send('Erro ao buscar resumo de estoque');
  }
});

app.get('/compras-fornecedores/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send('Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          f.id,
          f.nome,
          COUNT(c.id) AS total_compras,
          COALESCE(SUM(c.total), 0) AS valor_total
        FROM fornecedores f
        LEFT JOIN compras c ON c.fornecedor_id = f.id AND c.empresa = f.empresa
        WHERE f.empresa = $1
        GROUP BY f.id, f.nome
        ORDER BY valor_total DESC, f.nome ASC
        `,
      [empresa]
    );

    res.json(
      result.rows.map((row) => ({
        ...row,
        total_compras: Number(row.total_compras || 0),
        valor_total: Number(row.valor_total || 0)
      }))
    );
  } catch (error) {
    res.status(500).send('Erro ao buscar resumo de compras por fornecedor');
  }
});

app.get('/vendas-clientes/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send('Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          COALESCE(cliente_nome, 'Sem cliente') AS cliente,
          COUNT(*) AS total_vendas,
          COALESCE(SUM(total), 0) AS valor_total
        FROM vendas
        WHERE empresa = $1
        GROUP BY COALESCE(cliente_nome, 'Sem cliente')
        ORDER BY valor_total DESC, cliente ASC
        `,
      [empresa]
    );

    res.json(
      result.rows.map((row) => ({
        ...row,
        total_vendas: Number(row.total_vendas || 0),
        valor_total: Number(row.valor_total || 0)
      }))
    );
  } catch (error) {
    res.status(500).send('Erro ao buscar resumo de vendas por cliente');
  }
});

// ================= CONTAS A RECEBER =================
app.get('/contas-receber-clientes/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send('Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          id,
          nome
        FROM clientes
        WHERE empresa = $1
        ORDER BY nome ASC
        `,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar clientes de contas a receber:', error);
    res.status(500).send('Erro ao buscar clientes');
  }
});

app.get('/contas-receber/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);

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
          WHEN cr.data_vencimento IS NOT NULL AND cr.data_vencimento < $2 THEN 'atrasado'
          ELSE 'pendente'
        END AS status_exibicao
      FROM contas_receber cr
      LEFT JOIN vendas v
        ON v.id = cr.venda_id
       AND v.empresa = cr.empresa
      WHERE cr.empresa = $1
    `;

    const params = [empresaResolvida.nome, hoje()];
    let idx = 3;

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

    sql += ` ORDER BY cr.id DESC`;

    const result = await pool.query(sql, params);

    const contas = result.rows.map((row) => ({
      ...row,
      valor: Number(row.valor || 0),
      parcela: Number(row.parcela || 1),
      total_parcelas: Number(row.total_parcelas || 1),
      venda_total: Number(row.venda_total || 0),
      status: row.status_exibicao
    }));

    const resumo = contas.reduce(
      (acc, conta) => {
        acc.total += conta.valor;

        if (conta.status === 'pago') {
          acc.total_pago += conta.valor;
          acc.qtd_pago++;
        } else if (conta.status === 'atrasado') {
          acc.total_atrasado += conta.valor;
          acc.qtd_atrasado++;
        } else {
          acc.total_pendente += conta.valor;
          acc.qtd_pendente++;
        }

        return acc;
      },
      {
        total: 0,
        total_pago: 0,
        total_pendente: 0,
        total_atrasado: 0,
        qtd_pago: 0,
        qtd_pendente: 0,
        qtd_atrasado: 0
      }
    );

    res.json({ contas, resumo });
  } catch (error) {
    console.error('Erro ao buscar contas a receber:', error);
    res.status(500).send('Erro ao buscar contas a receber');
  }
});

app.get('/contas-receber/detalhe/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = await pool.query(
      `
        SELECT
          cr.*,
          CASE
            WHEN LOWER(COALESCE(cr.status, 'pendente')) = 'pago' THEN 'pago'
            WHEN cr.data_vencimento IS NOT NULL AND cr.data_vencimento < $2 THEN 'atrasado'
            ELSE 'pendente'
          END AS status_exibicao
        FROM contas_receber cr
        WHERE cr.id = $1
        LIMIT 1
        `,
      [id, hoje()]
    );

    if (contaResult.rowCount === 0) {
      return res.status(404).send('Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      return res.status(403).send('Sem acesso');
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
    res.status(500).send('Erro ao buscar detalhe da conta');
  }
});

app.get('/contas-receber/origem-venda/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = await pool.query(`SELECT * FROM contas_receber WHERE id = $1 LIMIT 1`, [
      id
    ]);

    if (contaResult.rowCount === 0) {
      return res.status(404).send('Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      return res.status(403).send('Sem acesso');
    }

    if (!conta.venda_id) {
      return res.status(404).send('Esta conta não possui venda de origem');
    }

    const vendaResult = await pool.query(
      `
        SELECT *
        FROM vendas
        WHERE id = $1 AND empresa = $2
        LIMIT 1
        `,
      [conta.venda_id, conta.empresa]
    );

    if (vendaResult.rowCount === 0) {
      return res.status(404).send('Venda de origem não encontrada');
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
        AND p.empresa = vi.empresa
        WHERE vi.venda_id = $1 AND vi.empresa = $2
        ORDER BY vi.id ASC
        `,
      [conta.venda_id, conta.empresa]
    );

    const parcelasResult = await pool.query(
      `
        SELECT *
        FROM contas_receber
        WHERE venda_id = $1 AND empresa = $2
        ORDER BY parcela ASC, id ASC
        `,
      [conta.venda_id, conta.empresa]
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
    res.status(500).send('Erro ao buscar origem da venda');
  }
});

app.post('/contas-receber/pagar/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = await pool.query(`SELECT * FROM contas_receber WHERE id = $1`, [id]);

    if (contaResult.rowCount === 0) {
      return res.status(404).send('Conta não encontrada');
    }

    const conta = contaResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    if (String(conta.status || '').toLowerCase() === 'pago') {
      return res.status(400).send('Esta conta já está paga');
    }

    const dataPagamento = normalizarDataISO(req.body?.data_pagamento) || hoje();

    await pool.query(
      `
      UPDATE contas_receber
      SET status = 'pago',
          data_pagamento = $1,
          atualizado_em = NOW()
      WHERE id = $2
      `,
      [dataPagamento, id]
    );

    await registrarLogFinanceiro({
      empresa: empresaResolvida.nome,
      empresa_id: empresaResolvida.id,
      tipo: 'baixa',
      entidade: 'contas_receber',
      entidade_id: id,
      descricao: `Baixa da conta a receber #${id}`,
      valor: req.body?.valor_pago || conta.valor || 0,
      usuario_id: req.user?.id
    });

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);

    const contaAtualizadaResult = await pool.query(
      `
      SELECT
        *,
        CASE
          WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
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
      mensagem: 'Conta baixada com sucesso',
      conta: {
        ...contaAtualizada,
        valor: Number(contaAtualizada.valor || 0),
        parcela: Number(contaAtualizada.parcela || 1),
        total_parcelas: Number(contaAtualizada.total_parcelas || 1),
        status: contaAtualizada.status_exibicao
      }
    });
  } catch (error) {
    console.error('Erro ao baixar conta:', error);
    res.status(500).send('Erro ao baixar conta');
  }
});

app.post('/contas-receber/estornar/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = await pool.query(`SELECT * FROM contas_receber WHERE id = $1`, [id]);

    if (contaResult.rowCount === 0) {
      return res.status(404).send('Conta não encontrada');
    }

    const conta = contaResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    if (String(conta.status || '').toLowerCase() !== 'pago') {
      return res.status(400).send('Esta conta não está paga');
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
          atualizado_em = NOW()
      WHERE id = $2
      `,
      [novoStatus, id]
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

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);

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
    res.status(500).send('Erro ao estornar baixa de conta a receber');
  }
});

// ================= CONTAS A PAGAR =================
app.get('/contas-pagar-fornecedores/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send('Sem acesso');
    }

    const result = await pool.query(
      `
        SELECT
          id,
          nome
        FROM fornecedores
        WHERE empresa = $1
        ORDER BY nome ASC
        `,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar fornecedores de contas a pagar:', error);
    res.status(500).send('Erro ao buscar fornecedores');
  }
});

app.get('/contas-pagar/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);

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
    `;

    const params = [empresaResolvida.nome, hoje()];
    let idx = 3;

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

    sql += ` ORDER BY cp.id DESC`;

    const result = await pool.query(sql, params);

    const contas = result.rows.map((row) => ({
      ...row,
      valor: Number(row.valor || 0),
      parcela: Number(row.parcela || 1),
      total_parcelas: Number(row.total_parcelas || 1),
      compra_total: Number(row.compra_total || 0),
      status: row.status_exibicao
    }));

    const resumo = contas.reduce(
      (acc, conta) => {
        acc.total += conta.valor;

        if (conta.status === 'pago') {
          acc.total_pago += conta.valor;
          acc.qtd_pago++;
        } else if (conta.status === 'atrasado') {
          acc.total_atrasado += conta.valor;
          acc.qtd_atrasado++;
        } else {
          acc.total_pendente += conta.valor;
          acc.qtd_pendente++;
        }

        return acc;
      },
      {
        total: 0,
        total_pago: 0,
        total_pendente: 0,
        total_atrasado: 0,
        qtd_pago: 0,
        qtd_pendente: 0,
        qtd_atrasado: 0
      }
    );

    res.json({ contas, resumo });
  } catch (error) {
    console.error('Erro ao buscar contas a pagar:', error);
    res.status(500).send('Erro ao buscar contas a pagar');
  }
});

app.get('/contas-pagar/detalhe/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

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
        WHERE cp.id = $1
        LIMIT 1
        `,
      [id, hoje()]
    );

    if (contaResult.rowCount === 0) {
      return res.status(404).send('Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      return res.status(403).send('Sem acesso');
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
    res.status(500).send('Erro ao buscar detalhe da conta');
  }
});

app.get('/contas-pagar/origem-compra/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = await pool.query(`SELECT * FROM contas_pagar WHERE id = $1 LIMIT 1`, [id]);

    if (contaResult.rowCount === 0) {
      return res.status(404).send('Conta não encontrada');
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      return res.status(403).send('Sem acesso');
    }

    if (!conta.compra_id) {
      return res.status(404).send('Esta conta não possui compra de origem');
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
        WHERE c.id = $1 AND c.empresa = $2
        LIMIT 1
        `,
      [conta.compra_id, conta.empresa]
    );

    if (compraResult.rowCount === 0) {
      return res.status(404).send('Compra de origem não encontrada');
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
        WHERE compra_id = $1 AND empresa = $2
        ORDER BY parcela ASC, id ASC
        `,
      [conta.compra_id, conta.empresa]
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
    res.status(500).send('Erro ao buscar origem da compra');
  }
});

app.post('/contas-pagar/pagar/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const contaResult = await pool.query(`SELECT * FROM contas_pagar WHERE id = $1`, [id]);

    if (contaResult.rowCount === 0) {
      return res.status(404).send('Conta não encontrada');
    }

    const conta = contaResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, conta.empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    if (String(conta.status || '').toLowerCase() === 'pago') {
      return res.status(400).send('Esta conta já está paga');
    }

    const dataPagamento = normalizarDataISO(req.body?.data_pagamento) || hoje();

    await pool.query(
      `
      UPDATE contas_pagar
      SET status = 'pago',
          data_pagamento = $1,
          atualizado_em = NOW()
      WHERE id = $2
      `,
      [dataPagamento, id]
    );

    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);

    const contaAtualizadaResult = await pool.query(
      `
      SELECT
        *,
        CASE
          WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
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
      mensagem: 'Conta paga com sucesso',
      conta: {
        ...contaAtualizada,
        valor: Number(contaAtualizada.valor || 0),
        parcela: Number(contaAtualizada.parcela || 1),
        total_parcelas: Number(contaAtualizada.total_parcelas || 1),
        status: contaAtualizada.status_exibicao
      }
    });
  } catch (error) {
    console.error('Erro ao pagar conta:', error);
    res.status(500).send('Erro ao pagar conta');
  }
});

// ================= LANÇAMENTOS FINANCEIROS =================
app.post('/financeiro/lancamentos', auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send('Sem permissão');
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
      return res.status(400).send('Preencha os campos obrigatórios do lançamento');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    if (!['receita', 'despesa'].includes(String(tipo).toLowerCase())) {
      return res.status(400).send('Tipo de lançamento inválido');
    }

    const valorFinal = normalizarDecimal(valor);
    if (valorFinal <= 0) {
      return res.status(400).send('Valor inválido');
    }

    const result = await pool.query(
      `
      INSERT INTO lancamentos_financeiros
      (
        empresa,
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
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
      RETURNING *
      `,
      [
        empresaResolvida.nome,
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
    res.status(500).send('Erro ao cadastrar lançamento financeiro');
  }
});

app.get('/financeiro/lancamentos/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
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
      WHERE empresa = $1
    `;

    const params = [empresaResolvida.nome];
    let idx = 2;

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

    sql += ` ORDER BY id DESC`;

    const result = await pool.query(sql, params);

    res.json(
      result.rows.map((row) => ({
        ...row,
        valor: Number(row.valor || 0),
        recorrente: Boolean(row.recorrente)
      }))
    );
  } catch (error) {
    console.error('Erro ao buscar lançamentos financeiros:', error);
    res.status(500).send('Erro ao buscar lançamentos financeiros');
  }
});

app.get('/financeiro/lancamentos-detalhe/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1`, [id]);

    if (result.rowCount === 0) {
      return res.status(404).send('Lançamento não encontrado');
    }

    const item = result.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, item.empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    res.json({
      ...item,
      valor: Number(item.valor || 0),
      recorrente: Boolean(item.recorrente)
    });
  } catch (error) {
    console.error('Erro ao buscar detalhe do lançamento:', error);
    res.status(500).send('Erro ao buscar detalhe do lançamento');
  }
});

app.put('/financeiro/lancamentos/:id', auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send('Sem permissão');
    }

    const id = Number(req.params.id);

    const atualResult = await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1`, [
      id
    ]);

    if (atualResult.rowCount === 0) {
      return res.status(404).send('Lançamento não encontrado');
    }

    const atual = atualResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, atual.empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
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
      return res.status(400).send('Preencha os campos obrigatórios do lançamento');
    }

    if (!['receita', 'despesa'].includes(String(tipo).toLowerCase())) {
      return res.status(400).send('Tipo de lançamento inválido');
    }

    const valorFinal = normalizarDecimal(valor);
    if (valorFinal <= 0) {
      return res.status(400).send('Valor inválido');
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
      WHERE id = $12
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
        id
      ]
    );

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao atualizar lançamento financeiro:', error);
    res.status(500).send('Erro ao atualizar lançamento financeiro');
  }
});

app.post('/financeiro/lancamentos/pagar/:id', auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send('Sem permissão');
    }

    const id = Number(req.params.id);

    const atualResult = await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1`, [
      id
    ]);

    if (atualResult.rowCount === 0) {
      return res.status(404).send('Lançamento não encontrado');
    }

    const atual = atualResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, atual.empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    await pool.query(
      `
      UPDATE lancamentos_financeiros
      SET status = 'pago',
          pagamento_data = $1,
          atualizado_em = NOW()
      WHERE id = $2
      `,
      [normalizarDataISO(req.body?.pagamento_data) || hoje(), id]
    );

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao pagar lançamento financeiro:', error);
    res.status(500).send('Erro ao pagar lançamento financeiro');
  }
});

app.delete('/financeiro/lancamentos/:id', auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send('Sem permissão');
    }

    const id = Number(req.params.id);

    const atualResult = await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1`, [
      id
    ]);

    if (atualResult.rowCount === 0) {
      return res.status(404).send('Lançamento não encontrado');
    }

    const atual = atualResult.rows[0];
    const empresaResolvida = await validarAcessoEmpresa(req, atual.empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    await pool.query(`DELETE FROM lancamentos_financeiros WHERE id = $1`, [id]);

    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao excluir lançamento financeiro:', error);
    res.status(500).send('Erro ao excluir lançamento financeiro');
  }
});

// ================= INVESTIMENTOS =================
app.post('/investimentos', auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send('Sem permissão');
    }

    const { empresa, tipo_investimento, descricao, valor, data, forma_pagamento, observacao } =
      req.body;

    if (!empresa || !tipo_investimento || !descricao || !data) {
      return res.status(400).send('Dados do investimento incompletos');
    }

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send('Sem acesso');
    }

    const result = await pool.query(
      `INSERT INTO investimentos
        (empresa, tipo_investimento, descricao, valor, data, forma_pagamento, observacao, criado_por, criado_em, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
        RETURNING *`,
      [
        empresa,
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
    res.status(500).send('Erro ao cadastrar investimento');
  }
});

app.get('/investimentos/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    const tipo = (req.query.tipo_investimento || '').trim();
    const busca = (req.query.busca || '').trim().toLowerCase();
    const { dataInicial, dataFinal } = obterPeriodo(req);

    let sql = `SELECT * FROM investimentos WHERE empresa = $1`;
    const params = [empresaResolvida.nome];
    let idx = 2;

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
    res.status(500).send('Erro ao buscar investimentos');
  }
});

// ================= FLUXO DE CAIXA =================
app.get('/financeiro/fluxo-caixa/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const empresaResolvida = await validarAcessoEmpresa(req, empresa);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);
    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);

    const { dataInicial, dataFinal } = obterPeriodo(req);

    const paramsReceber = [empresaResolvida.nome];
    const paramsPagar = [empresaResolvida.nome];
    const paramsLanc = [empresaResolvida.nome];
    const paramsInvest = [empresaResolvida.nome];
    const paramsVendas = [empresaResolvida.nome];
    const paramsCompras = [empresaResolvida.nome];

    let whereReceber = `
      WHERE empresa = $1
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
    `;

    let wherePagar = `
      WHERE empresa = $1
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
        AND data_pagamento IS NOT NULL
    `;

    let whereLanc = `
      WHERE empresa = $1
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
        AND pagamento_data IS NOT NULL
    `;

    let whereInvest = `
      WHERE empresa = $1
    `;

    let whereVendas = `
      WHERE v.empresa = $1
        AND NOT EXISTS (
          SELECT 1 FROM contas_receber cr
          WHERE cr.venda_id = v.id
        )
    `;

    let whereCompras = `
      WHERE c.empresa = $1
        AND LOWER(COALESCE(c.status, 'finalizada')) = 'finalizada'
        AND NOT EXISTS (
          SELECT 1
          FROM contas_pagar cp
          WHERE cp.compra_id = c.id
            AND cp.empresa = c.empresa
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
    res.status(500).send('Erro ao calcular fluxo de caixa');
  }
});

app.get('/debug/vendas-colunas', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'vendas'
      ORDER BY ordinal_position
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar colunas de vendas:', error);
    res.status(500).send('Erro ao listar colunas de vendas');
  }
});

// ================= DASHBOARD =================
app.get('/dashboard', auth, async (req, res) => {
  try {
    const empresaInformada = req.query.empresa || null;
    const empresaResolvida = await validarAcessoEmpresa(req, empresaInformada);

    if (!empresaResolvida) {
      return res.status(403).send('Sem acesso');
    }

    await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);
    await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome);

    const { dataInicial, dataFinal } = obterPeriodo(req);

    const vendasParams = [];
    const comprasParams = [];
    const receberParams = [];
    const pagarParams = [];
    const clientesParams = [];
    const produtosParams = [];

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

    const topProdutosParams = [];
    const estoqueBaixoParams = [];

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

    const [
      vendasResult,
      comprasResult,
      receberResult,
      pagarResult,
      produtosResult,
      clientesResult,
      topProdutosResult,
      estoqueBaixoResult
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
      )
    ]);

    const vendasRow = vendasResult.rows[0];
    const comprasRow = comprasResult.rows[0];
    const receberRow = receberResult.rows[0];
    const pagarRow = pagarResult.rows[0];
    const produtosRow = produtosResult.rows[0];
    const clientesRow = clientesResult.rows[0];

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
      vendas: Number(vendasRow.total_vendas || 0),
      contas_receber: Number(receberRow.contas_receber || 0),
      contas_pagar: Number(pagarRow.contas_pagar || 0),
      estoque: Number(produtosRow.total_estoque || 0),
      clientes: Number(clientesRow.total_clientes || 0),
      total_produtos: Number(produtosRow.total_produtos || 0),
      total_compras: Number(comprasRow.total_compras || 0),
      total_compras_valor: Number(comprasRow.total_compras_valor || 0),
      top_produtos: topProdutosResult.rows.map((row) => ({
        nome: row.nome,
        quantidade: Number(row.quantidade || 0)
      })),
      alertas
    });
  } catch (error) {
    console.error('Erro real ao carregar dashboard:', error);
    res.status(500).send('Erro ao carregar dashboard');
  }
});

// ================= CONFIGURAÇÕES =================

// BUSCAR CONFIGURAÇÕES
app.get('/configuracoes/:empresa', auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send('Sem acesso');
    }

    const result = await pool.query(`SELECT * FROM configuracoes WHERE empresa = $1 LIMIT 1`, [
      empresa
    ]);

    if (!result.rows.length) {
      // cria padrão automático
      const novo = await pool.query(
        `
          INSERT INTO configuracoes (empresa, nome_empresa)
          VALUES ($1, $2)
          RETURNING *
          `,
        [empresa, empresa]
      );

      return res.json(novo.rows[0]);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar configurações:', error);
    res.status(500).send('Erro ao buscar configurações');
  }
});

// SALVAR CONFIGURAÇÕES
app.put('/configuracoes', auth, async (req, res) => {
  try {
    const { empresa, nome_empresa } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send('Sem acesso');
    }

    await pool.query(
      `
        UPDATE configuracoes
        SET nome_empresa = $1
        WHERE empresa = $2
        `,
      [nome_empresa, empresa]
    );

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro ao salvar configurações:', error);
    res.status(500).send('Erro ao salvar configurações');
  }
});

// ================= START =================
async function start() {
  try {
    await initDb();
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
