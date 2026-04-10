const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = process.env.JWT_SECRET || "lf-erp-chave-super-secreta";
const PORT = process.env.PORT || 3001;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não definida.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function normalizarDecimal(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
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
  if (typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) {
    return valor.trim();
  }
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function obterPeriodo(req) {
  return {
    dataInicial: normalizarDataISO(req.query.data_inicial || req.query.inicio || ""),
    dataFinal: normalizarDataISO(req.query.data_final || req.query.fim || "")
  };
}

function adicionarFiltroPeriodo({ campo, params, dataInicial, dataFinal, castDate = true }) {
  let sql = "";
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
  let sql = "";
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

function validarEmpresa(req, empresa) {
  if (req.user.tipo === "admin") return true;
  return req.user.empresa === empresa;
}

function podeGerenciarUsuarios(req) {
  return req.user.tipo === "admin" || req.user.tipo === "gerente";
}

function podeGerenciarFinanceiro(req) {
  return req.user.tipo === "admin" || req.user.tipo === "gerente";
}

function podeGerenciarCompras(req) {
  return req.user.tipo === "admin" || req.user.tipo === "gerente";
}

function podeGerenciarVendas(req) {
  return req.user.tipo === "admin" || req.user.tipo === "gerente" || req.user.tipo === "funcionario";
}

function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(403).send("Sem acesso");

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(403).send("Token inválido");
  }
}

function apenasAdmin(req, res, next) {
  if (req.user.tipo !== "admin") {
    return res.status(403).send("Apenas admin pode acessar");
  }
  next();
}

async function registrarMovimentacaoEstoque({
  empresa,
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
     (empresa, produto_id, tipo, quantidade, observacao, referencia_tipo, referencia_id, usuario_id, data_movimentacao)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      empresa,
      produto_id,
      tipo,
      quantidade,
      observacao || "",
      referencia_tipo || null,
      referencia_id || null,
      usuario_id || null
    ]
  );
}

async function atualizarStatusContasReceberPorEmpresa(empresa) {
  await pool.query(
    `UPDATE contas_receber
     SET status = 'atrasado',
         atualizado_em = NOW()
     WHERE empresa = $1
       AND status = 'pendente'
       AND data_vencimento IS NOT NULL
       AND data_vencimento < $2`,
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

    const vencimento = i === 1
      ? data_primeiro_vencimento
      : addDias(data_primeiro_vencimento, (i - 1) * normalizarInt(intervalo_dias || 30));

    const result = await client.query(
      `INSERT INTO contas_receber
       (
         empresa,
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 'pendente', $9, $10, $11, NOW(), NOW())
       RETURNING *`,
      [
        empresa,
        venda_id,
        cliente_id || null,
        cliente_nome || "",
        i,
        parcelas,
        valorParcela,
        vencimento,
        forma_pagamento || "Promissória",
        observacao || "",
        criado_por || null
      ]
    );

    parcelasGeradas.push(result.rows[0]);
  }

  return parcelasGeradas;
}

async function montarRelatorioEstoquePorEmpresa(empresa) {
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
    const venda = mapaVendas.get(Number(p.id)) || {
      quantidade_vendida: 0,
      faturamento: 0
    };

    const preco = Number(p.preco || 0);
    const custo = Number(p.custo || 0);
    const estoque = Number(p.estoque || 0);
    const estoqueMinimo = Number(p.estoque_minimo || 0);
    const valorEstoque = Number(p.valor_estoque || 0);
    const quantidadeVendida = Number(venda.quantidade_vendida || 0);
    const faturamento = Number(venda.faturamento || 0);

    const lucroUnitario = preco - custo;
    const margemPercentual = preco > 0 ? (lucroUnitario / preco) * 100 : 0;
    const lucroEstimadoVendido = lucroUnitario * quantidadeVendida;
    const semSaida = quantidadeVendida === 0;
    const baixoGiro = quantidadeVendida > 0 && quantidadeVendida <= 3;

    return {
      id: Number(p.id),
      empresa: p.empresa,
      nome: p.nome,
      categoria: p.categoria || "",
      preco,
      custo,
      estoque,
      estoque_minimo: estoqueMinimo,
      valor_estoque: valorEstoque,
      quantidade_vendida: quantidadeVendida,
      faturamento,
      lucro_unitario: lucroUnitario,
      margem_percentual: margemPercentual,
      lucro_estimado_vendido: lucroEstimadoVendido,
      sem_saida: semSaida,
      baixo_giro: baixoGiro,
      alerta_estoque: estoque <= estoqueMinimo && estoqueMinimo > 0
    };
  });

  const resumo = {
    total_produtos: produtos.length,
    produtos_sem_saida: produtos.filter((p) => p.sem_saida).length,
    produtos_baixo_giro: produtos.filter((p) => p.baixo_giro).length,
    valor_total_parado: produtos.reduce((acc, p) => acc + p.valor_estoque, 0),
    faturamento_total: produtos.reduce((acc, p) => acc + p.faturamento, 0),
    lucro_estimado_total: produtos.reduce((acc, p) => acc + p.lucro_estimado_vendido, 0)
  };

  const topFaturamento = [...produtos]
    .filter((p) => p.faturamento > 0)
    .sort((a, b) => b.faturamento - a.faturamento)
    .slice(0, 10);

  const topQuantidadeVendida = [...produtos]
    .filter((p) => p.quantidade_vendida > 0)
    .sort((a, b) => b.quantidade_vendida - a.quantidade_vendida)
    .slice(0, 10);

  const topValorParado = [...produtos]
    .sort((a, b) => b.valor_estoque - a.valor_estoque)
    .slice(0, 10);

  const semSaida = produtos
    .filter((p) => p.sem_saida)
    .sort((a, b) => b.valor_estoque - a.valor_estoque);

  const baixoGiro = produtos
    .filter((p) => p.baixo_giro)
    .sort((a, b) => a.quantidade_vendida - b.quantidade_vendida || b.valor_estoque - a.valor_estoque);

  return {
    resumo,
    top_faturamento: topFaturamento,
    top_quantidade_vendida: topQuantidadeVendida,
    top_valor_parado: topValorParado,
    produtos_sem_saida: semSaida,
    produtos_baixo_giro: baixoGiro,
    produtos
  };
}

async function montarFluxoCaixaPorEmpresa(empresa, dataInicial, dataFinal) {
  const paramsReceitas = [empresa];
  const paramsDespesas = [empresa];

  let whereReceitas = `WHERE empresa = $1 AND status = 'pago'`;
  let whereDespesas = `WHERE empresa = $1 AND status = 'pago'`;

  whereReceitas += adicionarFiltroPeriodo({
    campo: "pagamento_data",
    params: paramsReceitas,
    dataInicial,
    dataFinal
  });

  whereDespesas += adicionarFiltroPeriodo({
    campo: "pagamento_data",
    params: paramsDespesas,
    dataInicial,
    dataFinal
  });

  const [receitasResult, despesasResult] = await Promise.all([
    pool.query(
      `
      SELECT
        pagamento_data AS data,
        descricao,
        categoria,
        forma_pagamento,
        valor,
        'entrada' AS tipo
      FROM lancamentos_financeiros
      ${whereReceitas}
      AND tipo = 'receita'
      ORDER BY pagamento_data ASC, id ASC
      `,
      paramsReceitas
    ),
    pool.query(
      `
      SELECT
        pagamento_data AS data,
        descricao,
        categoria,
        forma_pagamento,
        valor,
        'saida' AS tipo
      FROM lancamentos_financeiros
      ${whereDespesas}
      AND tipo IN ('despesa', 'custo')
      ORDER BY pagamento_data ASC, id ASC
      `,
      paramsDespesas
    )
  ]);

  const entradas = receitasResult.rows.map((r) => ({
    ...r,
    valor: Number(r.valor || 0)
  }));

  const saidas = despesasResult.rows.map((r) => ({
    ...r,
    valor: Number(r.valor || 0)
  }));

  const lancamentos = [...entradas, ...saidas].sort((a, b) => {
    if (a.data === b.data) return a.tipo.localeCompare(b.tipo);
    return (a.data || "").localeCompare(b.data || "");
  });

  const resumoPorDiaMap = new Map();

  for (const item of lancamentos) {
    const data = item.data || hoje();

    if (!resumoPorDiaMap.has(data)) {
      resumoPorDiaMap.set(data, {
        data,
        entradas: 0,
        saidas: 0,
        saldo_dia: 0,
        saldo_acumulado: 0
      });
    }

    const dia = resumoPorDiaMap.get(data);

    if (item.tipo === "entrada") {
      dia.entradas += Number(item.valor || 0);
    } else {
      dia.saidas += Number(item.valor || 0);
    }

    dia.saldo_dia = Number((dia.entradas - dia.saidas).toFixed(2));
  }

  const resumoPorDia = [...resumoPorDiaMap.values()].sort((a, b) => a.data.localeCompare(b.data));

  let saldoAcumulado = 0;
  for (const dia of resumoPorDia) {
    saldoAcumulado = Number((saldoAcumulado + dia.saldo_dia).toFixed(2));
    dia.entradas = Number(dia.entradas.toFixed(2));
    dia.saidas = Number(dia.saidas.toFixed(2));
    dia.saldo_dia = Number(dia.saldo_dia.toFixed(2));
    dia.saldo_acumulado = saldoAcumulado;
  }

  const totalEntradas = entradas.reduce((acc, item) => acc + Number(item.valor || 0), 0);
  const totalSaidas = saidas.reduce((acc, item) => acc + Number(item.valor || 0), 0);
  const saldoFinal = totalEntradas - totalSaidas;

  return {
    periodo: {
      dataInicial: dataInicial || null,
      dataFinal: dataFinal || null
    },
    resumo: {
      total_entradas: Number(totalEntradas.toFixed(2)),
      total_saidas: Number(totalSaidas.toFixed(2)),
      saldo_final: Number(saldoFinal.toFixed(2)),
      quantidade_lancamentos: lancamentos.length
    },
    resumo_por_dia: resumoPorDia,
    lancamentos
  };
}

async function initDb() {
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
    CREATE TABLE IF NOT EXISTS vendas (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      cliente_id INTEGER,
      cliente_nome TEXT,
      total_itens INTEGER NOT NULL DEFAULT 0,
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
      desconto NUMERIC(12,2) NOT NULL DEFAULT 0,
      acrescimo NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      pagamento TEXT,
      status_pagamento TEXT NOT NULL DEFAULT 'pago',
      parcelas INTEGER NOT NULL DEFAULT 1,
      observacao TEXT,
      data TEXT,
      criado_por INTEGER,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
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
    CREATE TABLE IF NOT EXISTS financeiro (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      valor NUMERIC(12,2) NOT NULL DEFAULT 0
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
      forma_pagamento TEXT,
      status_pagamento TEXT NOT NULL DEFAULT 'pendente',
      vencimento TEXT,
      pagamento_data TEXT,
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
      compra_id INTEGER,
      lancamento_id INTEGER,
      fornecedor_id INTEGER,
      fornecedor_nome TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_produtos_empresa ON produtos (empresa);
    CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes (empresa);
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa ON vendas (empresa);
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa_data ON vendas (empresa, data);
    CREATE INDEX IF NOT EXISTS idx_venda_itens_venda ON venda_itens (venda_id);
    CREATE INDEX IF NOT EXISTS idx_venda_itens_empresa ON venda_itens (empresa);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa ON lancamentos_financeiros (empresa);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_status ON lancamentos_financeiros (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_pagamento ON lancamentos_financeiros (empresa, pagamento_data);
    CREATE INDEX IF NOT EXISTS idx_investimentos_empresa ON investimentos (empresa);
    CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa ON fornecedores (empresa);
    CREATE INDEX IF NOT EXISTS idx_compras_empresa ON compras (empresa);
    CREATE INDEX IF NOT EXISTS idx_compras_empresa_data ON compras (empresa, data);
    CREATE INDEX IF NOT EXISTS idx_compra_itens_compra ON compra_itens (compra_id);
    CREATE INDEX IF NOT EXISTS idx_mov_estoque_empresa ON movimentacoes_estoque (empresa);
    CREATE INDEX IF NOT EXISTS idx_mov_estoque_produto ON movimentacoes_estoque (produto_id);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_empresa ON contas_receber (empresa);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_status ON contas_receber (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_vencimento ON contas_receber (empresa, data_vencimento);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_pagamento ON contas_receber (empresa, data_pagamento);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_cliente ON contas_receber (empresa, cliente_id);
    CREATE INDEX IF NOT EXISTS idx_contas_receber_venda ON contas_receber (venda_id);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa ON contas_pagar (empresa);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_status ON contas_pagar (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento ON contas_pagar (empresa, data_vencimento);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_pagamento ON contas_pagar (empresa, data_pagamento);
    CREATE INDEX IF NOT EXISTS idx_contas_pagar_compra ON contas_pagar (compra_id);
  `);

  await pool.query(`
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS custo NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS estoque_minimo INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS codigo_barras TEXT;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS categoria TEXT;
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE produtos ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS cliente_id INTEGER;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS cliente_nome TEXT;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS total_itens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS desconto NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS acrescimo NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS total NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pagamento TEXT;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS status_pagamento TEXT NOT NULL DEFAULT 'pago';
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS parcelas INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS observacao TEXT;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS data TEXT;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS criado_por INTEGER;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS forma_pagamento TEXT;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS status_pagamento TEXT NOT NULL DEFAULT 'pendente';
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS vencimento TEXT;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS pagamento_data TEXT;
  `);

  await pool.query(`
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS venda_id INTEGER;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS cliente_id INTEGER;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS cliente_nome TEXT;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS parcela INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS total_parcelas INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS valor NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS data_vencimento TEXT;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS data_pagamento TEXT;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pendente';
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS forma_pagamento TEXT;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS observacao TEXT;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS criado_por INTEGER;
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
  `);

  await pool.query(`
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS compra_id INTEGER;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS lancamento_id INTEGER;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS fornecedor_id INTEGER;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS fornecedor_nome TEXT;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS descricao TEXT;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS parcela INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS total_parcelas INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS valor NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS data_vencimento TEXT;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS data_pagamento TEXT;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pendente';
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS forma_pagamento TEXT;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS observacao TEXT;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS criado_por INTEGER;
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
    ALTER TABLE contas_pagar ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP NOT NULL DEFAULT NOW();
  `);

  await pool.query(`
    INSERT INTO financeiro (empresa, valor)
    SELECT 'LF Tech', 0
    WHERE NOT EXISTS (SELECT 1 FROM financeiro WHERE empresa = 'LF Tech');

    INSERT INTO financeiro (empresa, valor)
    SELECT 'Lucileide Variedades', 0
    WHERE NOT EXISTS (SELECT 1 FROM financeiro WHERE empresa = 'Lucileide Variedades');
  `);

  const senhaAdmin = await bcrypt.hash("123456", 10);

  await pool.query(
    `INSERT INTO usuarios (usuario, senha, tipo, empresa, nome_completo, cpf, nascimento)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (usuario)
     DO UPDATE SET
       senha = EXCLUDED.senha,
       tipo = EXCLUDED.tipo,
       empresa = EXCLUDED.empresa,
       nome_completo = EXCLUDED.nome_completo,
       cpf = EXCLUDED.cpf,
       nascimento = EXCLUDED.nascimento,
       atualizado_em = NOW()`,
    [
      "Lfelipeg",
      senhaAdmin,
      "admin",
      "LF Tech",
      "Administrador Master",
      "",
      ""
    ]
  );
}

app.get("/", (req, res) => {
  res.send("LF ERP backend online 🚀");
});

app.post("/login", async (req, res) => {
  try {
    const { usuario, senha } = req.body;

    const result = await pool.query(
      `SELECT * FROM usuarios WHERE usuario = $1`,
      [usuario]
    );

    if (result.rowCount === 0) {
      return res.status(401).send("Usuário ou senha inválidos");
    }

    const user = result.rows[0];
    const senhaValida = await bcrypt.compare(senha, user.senha);

    if (!senhaValida) {
      return res.status(401).send("Usuário ou senha inválidos");
    }

    const token = jwt.sign(
      {
        id: user.id,
        usuario: user.usuario,
        tipo: user.tipo,
        empresa: user.empresa,
        nome_completo: user.nome_completo || ""
      },
      SECRET,
      { expiresIn: "12h" }
    );

    res.json({
      token,
      usuario: {
        id: user.id,
        usuario: user.usuario,
        tipo: user.tipo,
        empresa: user.empresa,
        nome_completo: user.nome_completo || ""
      }
    });
  } catch (error) {
    res.status(500).send("Erro no login");
  }
});

app.get("/usuarios", auth, async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send("Sem permissão");
    }

    let result;

    if (req.user.tipo === "admin") {
      result = await pool.query(
        `SELECT id, usuario, tipo, empresa, nome_completo, cpf, nascimento, criado_em, atualizado_em
         FROM usuarios
         ORDER BY empresa ASC, tipo ASC, usuario ASC`
      );
    } else {
      result = await pool.query(
        `SELECT id, usuario, tipo, empresa, nome_completo, cpf, nascimento, criado_em, atualizado_em
         FROM usuarios
         WHERE empresa = $1
         ORDER BY tipo ASC, usuario ASC`,
        [req.user.empresa]
      );
    }

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar usuários");
  }
});

app.post("/usuarios", auth, async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send("Sem permissão");
    }

    const {
      usuario,
      senha,
      tipo,
      empresa,
      nome_completo,
      cpf,
      nascimento
    } = req.body;

    if (!usuario || !senha || !tipo || !empresa || !nome_completo) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    if (req.user.tipo === "gerente") {
      if (empresa !== req.user.empresa) {
        return res.status(403).send("Gerente só pode cadastrar usuários da própria empresa");
      }

      if (tipo !== "funcionario") {
        return res.status(403).send("Gerente só pode cadastrar funcionário");
      }
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    const result = await pool.query(
      `INSERT INTO usuarios (usuario, senha, tipo, empresa, nome_completo, cpf, nascimento)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, usuario, tipo, empresa, nome_completo, cpf, nascimento, criado_em, atualizado_em`,
      [
        usuario,
        senhaHash,
        tipo,
        empresa,
        nome_completo,
        cpf || "",
        nascimento || ""
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).send("Usuário já existe");
    }
    res.status(500).send("Erro ao cadastrar usuário");
  }
});

app.put("/usuarios/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);
    const {
      usuario,
      senha,
      tipo,
      empresa,
      nome_completo,
      cpf,
      nascimento
    } = req.body;

    const usuarioAtualResult = await pool.query(
      `SELECT * FROM usuarios WHERE id = $1`,
      [id]
    );

    if (usuarioAtualResult.rowCount === 0) {
      return res.status(404).send("Usuário não encontrado");
    }

    const usuarioAtual = usuarioAtualResult.rows[0];

    if (req.user.tipo === "gerente") {
      if (usuarioAtual.empresa !== req.user.empresa) {
        return res.status(403).send("Sem permissão");
      }
      if (usuarioAtual.tipo !== "funcionario") {
        return res.status(403).send("Gerente só pode editar funcionário");
      }
      if (empresa !== req.user.empresa || tipo !== "funcionario") {
        return res.status(403).send("Gerente só pode manter funcionário na própria empresa");
      }
    }

    let senhaFinal = usuarioAtual.senha;
    if (senha && senha.trim()) {
      senhaFinal = await bcrypt.hash(senha, 10);
    }

    const result = await pool.query(
      `UPDATE usuarios
       SET usuario = $1,
           senha = $2,
           tipo = $3,
           empresa = $4,
           nome_completo = $5,
           cpf = $6,
           nascimento = $7,
           atualizado_em = NOW()
       WHERE id = $8
       RETURNING id, usuario, tipo, empresa, nome_completo, cpf, nascimento, criado_em, atualizado_em`,
      [
        usuario,
        senhaFinal,
        tipo,
        empresa,
        nome_completo,
        cpf || "",
        nascimento || "",
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(400).send("Usuário já existe");
    }
    res.status(500).send("Erro ao atualizar usuário");
  }
});

app.delete("/usuarios/:id", auth, async (req, res) => {
  try {
    if (req.user.tipo !== "admin") {
      return res.status(403).send("Apenas admin pode excluir usuário");
    }

    const id = Number(req.params.id);

    if (id === req.user.id) {
      return res.status(400).send("Você não pode excluir o próprio usuário");
    }

    const result = await pool.query(
      `DELETE FROM usuarios WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Usuário não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir usuário");
  }
});

app.post("/produtos", auth, async (req, res) => {
  try {
    const {
      empresa,
      nome,
      preco,
      estoque,
      custo,
      estoque_minimo,
      codigo_barras,
      categoria
    } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!empresa || !nome) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    const result = await pool.query(
      `INSERT INTO produtos
       (empresa, nome, preco, estoque, custo, estoque_minimo, codigo_barras, categoria)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        empresa,
        nome,
        normalizarDecimal(preco),
        normalizarInt(estoque),
        normalizarDecimal(custo),
        normalizarInt(estoque_minimo),
        codigo_barras || "",
        categoria || ""
      ]
    );

    if (normalizarInt(estoque) > 0) {
      await registrarMovimentacaoEstoque({
        empresa,
        produto_id: result.rows[0].id,
        tipo: "cadastro_inicial",
        quantidade: normalizarInt(estoque),
        observacao: "Estoque inicial do produto",
        referencia_tipo: "produto",
        referencia_id: result.rows[0].id,
        usuario_id: req.user.id
      });
    }

    res.json({ id: result.rows[0].id });
  } catch (error) {
    res.status(500).send("Erro ao cadastrar produto");
  }
});

app.get("/produtos/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `SELECT *,
              CASE WHEN estoque <= estoque_minimo THEN TRUE ELSE FALSE END AS alerta_estoque
       FROM produtos
       WHERE empresa = $1
       ORDER BY nome ASC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar produtos");
  }
});

app.get("/admin/produtos", auth, apenasAdmin, async (req, res) => {
  try {
    const params = [];
    let where = `WHERE 1=1`;

    const { dataInicial, dataFinal } = obterPeriodo(req);

    where += adicionarFiltroPeriodo({
      campo: "criado_em",
      params,
      dataInicial,
      dataFinal
    });

    const result = await pool.query(
      `SELECT *,
              CASE WHEN estoque <= estoque_minimo THEN TRUE ELSE FALSE END AS alerta_estoque
       FROM produtos
       ${where}
       ORDER BY empresa ASC, nome ASC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar produtos");
  }
});

app.post("/clientes", auth, async (req, res) => {
  try {
    const { empresa, nome, endereco, telefone, nascimento, cpf } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!empresa || !nome) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    const result = await pool.query(
      `INSERT INTO clientes (empresa, nome, endereco, telefone, nascimento, cpf)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [empresa, nome, endereco || "", telefone || "", nascimento || "", cpf || ""]
    );

    res.json({ id: result.rows[0].id });
  } catch (error) {
    res.status(500).send("Erro ao cadastrar cliente");
  }
});

app.get("/clientes/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `SELECT * FROM clientes WHERE empresa = $1 ORDER BY nome ASC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar clientes");
  }
});

app.get("/admin/clientes", auth, apenasAdmin, async (req, res) => {
  try {
    const params = [];
    let where = `WHERE 1=1`;

    const { dataInicial, dataFinal } = obterPeriodo(req);

    where += adicionarFiltroPeriodo({
      campo: "criado_em",
      params,
      dataInicial,
      dataFinal
    });

    const result = await pool.query(
      `SELECT * FROM clientes
       ${where}
       ORDER BY empresa ASC, nome ASC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar clientes");
  }
});

app.post("/fornecedores", auth, async (req, res) => {
  try {
    const { empresa, nome, contato, telefone, email, endereco, observacao } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!empresa || !nome) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    const result = await pool.query(
      `INSERT INTO fornecedores
       (empresa, nome, contato, telefone, email, endereco, observacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        empresa,
        nome,
        contato || "",
        telefone || "",
        email || "",
        endereco || "",
        observacao || ""
      ]
    );

    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (error) {
    res.status(500).send("Erro ao cadastrar fornecedor");
  }
});

app.get("/fornecedores/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `SELECT * FROM fornecedores WHERE empresa = $1 ORDER BY nome ASC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar fornecedores");
  }
});

app.get("/admin/fornecedores", auth, apenasAdmin, async (req, res) => {
  try {
    const params = [];
    let where = `WHERE 1=1`;

    const { dataInicial, dataFinal } = obterPeriodo(req);

    where += adicionarFiltroPeriodo({
      campo: "criado_em",
      params,
      dataInicial,
      dataFinal
    });

    const result = await pool.query(
      `SELECT * FROM fornecedores
       ${where}
       ORDER BY empresa ASC, nome ASC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar fornecedores");
  }
});

app.post("/compras", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!podeGerenciarCompras(req)) {
      return res.status(403).send("Sem permissão");
    }

    const {
      empresa,
      fornecedor_id,
      data,
      observacao,
      gerar_conta_pagar,
      forma_pagamento,
      status_pagamento,
      vencimento,
      itens
    } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!empresa || !fornecedor_id || !Array.isArray(itens) || itens.length === 0) {
      return res.status(400).send("Preencha os campos obrigatórios da compra");
    }

    await client.query("BEGIN");

    const fornecedorResult = await client.query(
      `SELECT * FROM fornecedores WHERE id = $1 AND empresa = $2`,
      [fornecedor_id, empresa]
    );

    if (fornecedorResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).send("Fornecedor não encontrado");
    }

    let total = 0;
    const itensValidados = [];

    for (const item of itens) {
      const produtoId = normalizarInt(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);
      const custoUnitario = normalizarDecimal(item.custo_unitario);

      if (!produtoId || quantidade <= 0 || custoUnitario <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).send("Itens da compra inválidos");
      }

      const produtoResult = await client.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa = $2 FOR UPDATE`,
        [produtoId, empresa]
      );

      if (produtoResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).send("Produto da compra não encontrado");
      }

      const produto = produtoResult.rows[0];
      const subtotal = quantidade * custoUnitario;
      total += subtotal;

      itensValidados.push({
        produto,
        quantidade,
        custoUnitario,
        subtotal
      });
    }

    const dataCompra = normalizarDataISO(data) || hoje();
    const gerarContaPagarBool = Boolean(gerar_conta_pagar);
    const formaPagamentoFinal = forma_pagamento || null;

    let statusPagamentoFinal = "pago";
    if (gerarContaPagarBool) statusPagamentoFinal = "pendente";
    if (status_pagamento === "pago" || status_pagamento === "pendente") {
      statusPagamentoFinal = status_pagamento;
    }
    if (!gerarContaPagarBool && statusPagamentoFinal !== "pago") {
      statusPagamentoFinal = "pago";
    }

    const vencimentoFinal = gerarContaPagarBool
      ? (normalizarDataISO(vencimento) || dataCompra)
      : null;

    const pagamentoDataFinal = statusPagamentoFinal === "pago"
      ? dataCompra
      : null;

    const compraResult = await client.query(
      `INSERT INTO compras
       (empresa, fornecedor_id, data, total, observacao, gerar_conta_pagar, forma_pagamento, status_pagamento, vencimento, pagamento_data, status, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'finalizada', $11)
       RETURNING id`,
      [
        empresa,
        fornecedor_id,
        dataCompra,
        total,
        observacao || "",
        gerarContaPagarBool,
        formaPagamentoFinal,
        statusPagamentoFinal,
        vencimentoFinal,
        pagamentoDataFinal,
        req.user.id
      ]
    );

    const compraId = compraResult.rows[0].id;

    for (const item of itensValidados) {
      await client.query(
        `INSERT INTO compra_itens
         (compra_id, produto_id, produto_nome, quantidade, custo_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          compraId,
          item.produto.id,
          item.produto.nome,
          item.quantidade,
          item.custoUnitario,
          item.subtotal
        ]
      );

      await client.query(
        `UPDATE produtos
         SET estoque = estoque + $1,
             custo = $2,
             atualizado_em = NOW()
         WHERE id = $3`,
        [
          item.quantidade,
          item.custoUnitario,
          item.produto.id
        ]
      );

      await registrarMovimentacaoEstoque({
        empresa,
        produto_id: item.produto.id,
        tipo: "entrada_compra",
        quantidade: item.quantidade,
        observacao: `Entrada por compra #${compraId}`,
        referencia_tipo: "compra",
        referencia_id: compraId,
        usuario_id: req.user.id,
        client
      });
    }

        const fornecedor = fornecedorResult.rows[0];

    const lancamentoResult = await client.query(
      `INSERT INTO lancamentos_financeiros
       (empresa, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, forma_pagamento, recorrente, frequencia, observacao, criado_por)
       VALUES ($1, 'custo', 'Compra de mercadoria', $2, $3, $4, $5, $6, FALSE, NULL, $7, $8)
       RETURNING id`,
      [
        empresa,
        `Compra #${compraId} - ${fornecedor.nome}`,
        total,
        vencimentoFinal,
        pagamentoDataFinal,
        statusPagamentoFinal,
        formaPagamentoFinal,
        observacao || "",
        req.user.id
      ]
    );

    const lancamentoId = lancamentoResult.rows[0].id;

    if (gerarContaPagarBool) {
      await client.query(
        `INSERT INTO contas_pagar
         (
           empresa,
           compra_id,
           lancamento_id,
           fornecedor_id,
           fornecedor_nome,
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
         VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())`,
        [
          empresa,
          compraId,
          lancamentoId,
          fornecedor.id,
          fornecedor.nome,
          `Compra #${compraId} - ${fornecedor.nome}`,
          total,
          vencimentoFinal,
          pagamentoDataFinal,
          statusPagamentoFinal,
          formaPagamentoFinal,
          observacao || "",
          req.user.id
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ sucesso: true, id: compraId });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao registrar compra");
  } finally {
    client.release();
  }
});

app.get("/compras/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [empresa];

    const filtroPeriodo = adicionarFiltroPeriodo({
      campo: "c.data",
      params,
      dataInicial,
      dataFinal
    });

    const result = await pool.query(
      `SELECT c.*,
              f.nome AS fornecedor_nome
       FROM compras c
       INNER JOIN fornecedores f ON f.id = c.fornecedor_id
       WHERE c.empresa = $1
       ${filtroPeriodo}
       ORDER BY c.data DESC, c.id DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar compras");
  }
});

app.get("/admin/compras", auth, apenasAdmin, async (req, res) => {
  try {
    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [];
    let where = `WHERE 1=1`;

    where += adicionarFiltroPeriodo({
      campo: "c.data",
      params,
      dataInicial,
      dataFinal
    });

    const result = await pool.query(
      `SELECT c.*,
              f.nome AS fornecedor_nome
       FROM compras c
       INNER JOIN fornecedores f ON f.id = c.fornecedor_id
       ${where}
       ORDER BY c.empresa ASC, c.data DESC, c.id DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar compras");
  }
});

app.post("/vendas", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!podeGerenciarVendas(req)) {
      return res.status(403).send("Sem permissão");
    }

    const {
      empresa,
      cliente_id,
      cliente_nome,
      itens,
      pagamento,
      parcelas,
      desconto,
      acrescimo,
      observacao,
      data,
      data_primeiro_vencimento,
      intervalo_dias
    } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!empresa || !Array.isArray(itens) || itens.length === 0) {
      return res.status(400).send("Venda inválida");
    }

    await client.query("BEGIN");

    let subtotal = 0;
    let totalItens = 0;
    const itensValidados = [];

    for (const item of itens) {
      const produtoId = normalizarInt(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);
      const precoUnitario = normalizarDecimal(item.preco_unitario);

      if (!produtoId || quantidade <= 0 || precoUnitario < 0) {
        await client.query("ROLLBACK");
        return res.status(400).send("Itens da venda inválidos");
      }

      const produtoResult = await client.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa = $2 FOR UPDATE`,
        [produtoId, empresa]
      );

      if (produtoResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).send("Produto não encontrado");
      }

      const produto = produtoResult.rows[0];

      if (normalizarInt(produto.estoque) < quantidade) {
        await client.query("ROLLBACK");
        return res.status(400).send(`Estoque insuficiente para ${produto.nome}`);
      }

      const itemTotal = quantidade * precoUnitario;
      subtotal += itemTotal;
      totalItens += quantidade;

      itensValidados.push({
        produto,
        quantidade,
        precoUnitario,
        custoUnitario: normalizarDecimal(produto.custo),
        total: itemTotal
      });
    }

    const descontoFinal = normalizarDecimal(desconto);
    const acrescimoFinal = normalizarDecimal(acrescimo);
    const totalFinal = Number((subtotal - descontoFinal + acrescimoFinal).toFixed(2));
    const parcelasFinal = Math.max(normalizarInt(parcelas), 1);
    const dataVenda = normalizarDataISO(data) || hoje();

    let statusPagamento = "pago";
    if (pagamento === "Promissória" || pagamento === "Crédito Parcelado") {
      statusPagamento = parcelasFinal > 1 ? "pendente" : "pago";
    }

    const vendaResult = await client.query(
      `INSERT INTO vendas
       (
         empresa,
         cliente_id,
         cliente_nome,
         total_itens,
         subtotal,
         desconto,
         acrescimo,
         total,
         pagamento,
         status_pagamento,
         parcelas,
         observacao,
         data,
         criado_por,
         criado_em
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       RETURNING id`,
      [
        empresa,
        cliente_id || null,
        cliente_nome || "",
        totalItens,
        subtotal,
        descontoFinal,
        acrescimoFinal,
        totalFinal,
        pagamento || "",
        statusPagamento,
        parcelasFinal,
        observacao || "",
        dataVenda,
        req.user.id
      ]
    );

    const vendaId = vendaResult.rows[0].id;

    for (const item of itensValidados) {
      await client.query(
        `INSERT INTO venda_itens
         (venda_id, empresa, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          vendaId,
          empresa,
          item.produto.id,
          item.produto.nome,
          item.quantidade,
          item.precoUnitario,
          item.custoUnitario,
          item.total
        ]
      );

      await client.query(
        `UPDATE produtos
         SET estoque = estoque - $1,
             atualizado_em = NOW()
         WHERE id = $2 AND empresa = $3`,
        [item.quantidade, item.produto.id, empresa]
      );

      await registrarMovimentacaoEstoque({
        client,
        empresa,
        produto_id: item.produto.id,
        tipo: "saida_venda",
        quantidade: item.quantidade,
        observacao: `Saída por venda #${vendaId}`,
        referencia_tipo: "venda",
        referencia_id: vendaId,
        usuario_id: req.user.id
      });
    }

    if (statusPagamento === "pago") {
      await client.query(
        `INSERT INTO lancamentos_financeiros
         (empresa, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, forma_pagamento, recorrente, frequencia, observacao, criado_por)
         VALUES ($1, 'receita', 'Venda', $2, $3, $4, 'pago', $5, FALSE, NULL, $6, $7)`,
        [
          empresa,
          `Venda #${vendaId} - ${cliente_nome || "Cliente não informado"}`,
          totalFinal,
          dataVenda,
          dataVenda,
          pagamento || "",
          observacao || "",
          req.user.id
        ]
      );
    } else {
      const primeiroVencimento = normalizarDataISO(data_primeiro_vencimento) || dataVenda;

      await criarParcelasContasReceber({
        client,
        empresa,
        venda_id: vendaId,
        cliente_id: cliente_id || null,
        cliente_nome: cliente_nome || "",
        total: totalFinal,
        quantidade_parcelas: parcelasFinal,
        data_primeiro_vencimento: primeiroVencimento,
        intervalo_dias: normalizarInt(intervalo_dias || 30),
        observacao: observacao || "",
        criado_por: req.user.id,
        forma_pagamento: pagamento || "Promissória"
      });
    }

    await client.query("COMMIT");
    res.json({ sucesso: true, id: vendaId });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao registrar venda");
  } finally {
    client.release();
  }
});

app.get("/vendas/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [empresa];

    const filtroPeriodo = adicionarFiltroPeriodo({
      campo: "data",
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const result = await pool.query(
      `SELECT * FROM vendas
       WHERE empresa = $1
       ${filtroPeriodo}
       ORDER BY id DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar vendas");
  }
});

app.get("/admin/vendas", auth, apenasAdmin, async (req, res) => {
  try {
    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [];
    let where = `WHERE 1=1`;

    where += adicionarFiltroPeriodo({
      campo: "data",
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const result = await pool.query(
      `SELECT * FROM vendas
       ${where}
       ORDER BY empresa ASC, id DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar vendas");
  }
});

app.get("/venda-itens/:vendaId", auth, async (req, res) => {
  try {
    const vendaId = Number(req.params.vendaId);

    const vendaResult = await pool.query(
      `SELECT * FROM vendas WHERE id = $1`,
      [vendaId]
    );

    if (vendaResult.rowCount === 0) {
      return res.status(404).send("Venda não encontrada");
    }

    const venda = vendaResult.rows[0];

    if (!validarEmpresa(req, venda.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `SELECT * FROM venda_itens WHERE venda_id = $1 ORDER BY id ASC`,
      [vendaId]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar itens da venda");
  }
});

app.post("/movimentacoes-estoque", auth, async (req, res) => {
  try {
    const { empresa, produto_id, tipo, quantidade, observacao } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const quantidadeFinal = normalizarInt(quantidade);

    if (!empresa || !produto_id || !tipo || quantidadeFinal <= 0) {
      return res.status(400).send("Dados inválidos");
    }

    const produtoResult = await pool.query(
      `SELECT * FROM produtos WHERE id = $1 AND empresa = $2`,
      [produto_id, empresa]
    );

    if (produtoResult.rowCount === 0) {
      return res.status(404).send("Produto não encontrado");
    }

    const produto = produtoResult.rows[0];

    let novoEstoque = normalizarInt(produto.estoque);

    if (["ajuste_entrada", "entrada_manual", "estorno_venda"].includes(tipo)) {
      novoEstoque += quantidadeFinal;
    } else {
      if (novoEstoque < quantidadeFinal) {
        return res.status(400).send("Estoque insuficiente");
      }
      novoEstoque -= quantidadeFinal;
    }

    await pool.query(
      `UPDATE produtos
       SET estoque = $1,
           atualizado_em = NOW()
       WHERE id = $2 AND empresa = $3`,
      [novoEstoque, produto_id, empresa]
    );

    await registrarMovimentacaoEstoque({
      empresa,
      produto_id,
      tipo,
      quantidade: quantidadeFinal,
      observacao: observacao || "",
      referencia_tipo: "manual",
      referencia_id: null,
      usuario_id: req.user.id
    });

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao lançar movimentação");
  }
});

app.get("/movimentacoes-estoque/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [empresa];

    const filtroPeriodo = adicionarFiltroPeriodo({
      campo: "m.data_movimentacao",
      params,
      dataInicial,
      dataFinal
    });

    const result = await pool.query(
      `SELECT
         m.*,
         p.nome AS produto_nome
       FROM movimentacoes_estoque m
       INNER JOIN produtos p ON p.id = m.produto_id
       WHERE m.empresa = $1
       ${filtroPeriodo}
       ORDER BY m.data_movimentacao DESC, m.id DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar movimentações");
  }
});

app.get("/admin/movimentacoes-estoque", auth, apenasAdmin, async (req, res) => {
  try {
    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [];
    let where = `WHERE 1=1`;

    where += adicionarFiltroPeriodo({
      campo: "m.data_movimentacao",
      params,
      dataInicial,
      dataFinal
    });

    const result = await pool.query(
      `SELECT
         m.*,
         p.nome AS produto_nome
       FROM movimentacoes_estoque m
       INNER JOIN produtos p ON p.id = m.produto_id
       ${where}
       ORDER BY m.empresa ASC, m.data_movimentacao DESC, m.id DESC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar movimentações");
  }
});

app.post("/ajuste-estoque", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { empresa, produto_id, novo_estoque, observacao } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const novoEstoque = normalizarInt(novo_estoque);

    await client.query("BEGIN");

    const produtoResult = await client.query(
      `SELECT * FROM produtos WHERE id = $1 AND empresa = $2 FOR UPDATE`,
      [produto_id, empresa]
    );

    if (produtoResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).send("Produto não encontrado");
    }

    const produto = produtoResult.rows[0];
    const estoqueAtual = normalizarInt(produto.estoque);
    const diferenca = novoEstoque - estoqueAtual;

    await client.query(
      `UPDATE produtos
       SET estoque = $1,
           atualizado_em = NOW()
       WHERE id = $2 AND empresa = $3`,
      [novoEstoque, produto_id, empresa]
    );

    if (diferenca !== 0) {
      await registrarMovimentacaoEstoque({
        client,
        empresa,
        produto_id,
        tipo: diferenca > 0 ? "ajuste_entrada" : "ajuste_saida",
        quantidade: Math.abs(diferenca),
        observacao: observacao || "Ajuste manual de estoque",
        referencia_tipo: "ajuste",
        referencia_id: null,
        usuario_id: req.user.id
      });
    }

    await client.query("COMMIT");
    res.json({ sucesso: true });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao ajustar estoque");
  } finally {
    client.release();
  }
});

app.get("/contas-receber/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    await atualizarStatusContasReceberPorEmpresa(empresa);

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [empresa];

    const filtroPeriodo = adicionarFiltroPeriodoRange({
      campoInicial: "data_vencimento",
      campoFinal: "data_pagamento",
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const result = await pool.query(
      `SELECT * FROM contas_receber
       WHERE empresa = $1
       ${filtroPeriodo}
       ORDER BY
         CASE status
           WHEN 'atrasado' THEN 1
           WHEN 'pendente' THEN 2
           WHEN 'pago' THEN 3
           ELSE 4
         END,
         data_vencimento ASC,
         id ASC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar contas a receber");
  }
});

app.get("/admin/contas-receber", auth, apenasAdmin, async (req, res) => {
  try {
    await atualizarStatusContasReceberGlobal();

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [];
    let where = `WHERE 1=1`;

    where += adicionarFiltroPeriodoRange({
      campoInicial: "data_vencimento",
      campoFinal: "data_pagamento",
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const result = await pool.query(
      `SELECT * FROM contas_receber
       ${where}
       ORDER BY empresa ASC, data_vencimento ASC, id ASC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar contas a receber");
  }
});

app.put("/contas-receber/:id/pagar", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { data_pagamento, forma_pagamento, observacao } = req.body;

    await client.query("BEGIN");

    const contaResult = await client.query(
      `SELECT * FROM contas_receber WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (contaResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).send("Conta não encontrada");
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      await client.query("ROLLBACK");
      return res.status(403).send("Sem acesso");
    }

    const dataPagamento = normalizarDataISO(data_pagamento) || hoje();
    const formaPagamentoFinal = forma_pagamento || conta.forma_pagamento || "";

    await client.query(
      `UPDATE contas_receber
       SET status = 'pago',
           data_pagamento = $1,
           forma_pagamento = $2,
           observacao = $3,
           atualizado_em = NOW()
       WHERE id = $4`,
      [
        dataPagamento,
        formaPagamentoFinal,
        observacao || conta.observacao || "",
        id
      ]
    );

    await client.query(
      `INSERT INTO lancamentos_financeiros
       (empresa, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, forma_pagamento, recorrente, frequencia, observacao, criado_por)
       VALUES ($1, 'receita', 'Contas a Receber', $2, $3, $4, 'pago', $5, FALSE, NULL, $6, $7)`,
      [
        conta.empresa,
        `Recebimento venda #${conta.venda_id || ""} - ${conta.cliente_nome || "Cliente"}`.trim(),
        conta.valor,
        conta.data_vencimento,
        dataPagamento,
        formaPagamentoFinal,
        observacao || conta.observacao || "",
        req.user.id
      ]
    );

    await client.query("COMMIT");
    res.json({ sucesso: true });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao baixar conta a receber");
  } finally {
    client.release();
  }
});

app.put("/contas-receber/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);
    const {
      cliente_nome,
      valor,
      data_vencimento,
      forma_pagamento,
      observacao,
      status
    } = req.body;

    const contaResult = await pool.query(
      `SELECT * FROM contas_receber WHERE id = $1`,
      [id]
    );

    if (contaResult.rowCount === 0) {
      return res.status(404).send("Conta não encontrada");
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const statusFinal = ["pendente", "pago", "atrasado"].includes(status) ? status : conta.status;

    const result = await pool.query(
      `UPDATE contas_receber
       SET cliente_nome = $1,
           valor = $2,
           data_vencimento = $3,
           forma_pagamento = $4,
           observacao = $5,
           status = $6,
           atualizado_em = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        cliente_nome || conta.cliente_nome || "",
        normalizarDecimal(valor),
        normalizarDataISO(data_vencimento) || conta.data_vencimento,
        forma_pagamento || conta.forma_pagamento || "",
        observacao || "",
        statusFinal,
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).send("Erro ao atualizar conta a receber");
  }
});

app.delete("/contas-receber/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);

    const contaResult = await pool.query(
      `SELECT * FROM contas_receber WHERE id = $1`,
      [id]
    );

    if (contaResult.rowCount === 0) {
      return res.status(404).send("Conta não encontrada");
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    await pool.query(`DELETE FROM contas_receber WHERE id = $1`, [id]);

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir conta a receber");
  }
});

app.get("/contas-pagar/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    await atualizarStatusContasPagarPorEmpresa(empresa);

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [empresa];

    const filtroPeriodo = adicionarFiltroPeriodoRange({
      campoInicial: "data_vencimento",
      campoFinal: "data_pagamento",
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const result = await pool.query(
      `SELECT * FROM contas_pagar
       WHERE empresa = $1
       ${filtroPeriodo}
       ORDER BY
         CASE status
           WHEN 'atrasado' THEN 1
           WHEN 'pendente' THEN 2
           WHEN 'pago' THEN 3
           ELSE 4
         END,
         data_vencimento ASC,
         id ASC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar contas a pagar");
  }
});

app.get("/admin/contas-pagar", auth, apenasAdmin, async (req, res) => {
  try {
    await atualizarStatusContasPagarGlobal();

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const params = [];
    let where = `WHERE 1=1`;

    where += adicionarFiltroPeriodoRange({
      campoInicial: "data_vencimento",
      campoFinal: "data_pagamento",
      params,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const result = await pool.query(
      `SELECT * FROM contas_pagar
       ${where}
       ORDER BY empresa ASC, data_vencimento ASC, id ASC`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar contas a pagar");
  }
});

app.put("/contas-pagar/:id/pagar", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);
    const { data_pagamento, forma_pagamento, observacao } = req.body;

    await client.query("BEGIN");

    const contaResult = await client.query(
      `SELECT * FROM contas_pagar WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (contaResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).send("Conta não encontrada");
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      await client.query("ROLLBACK");
      return res.status(403).send("Sem acesso");
    }

    const dataPagamento = normalizarDataISO(data_pagamento) || hoje();
    const formaPagamentoFinal = forma_pagamento || conta.forma_pagamento || "";

    await client.query(
      `UPDATE contas_pagar
       SET status = 'pago',
           data_pagamento = $1,
           forma_pagamento = $2,
           observacao = $3,
           atualizado_em = NOW()
       WHERE id = $4`,
      [
        dataPagamento,
        formaPagamentoFinal,
        observacao || conta.observacao || "",
        id
      ]
    );

    if (conta.lancamento_id) {
      await client.query(
        `UPDATE lancamentos_financeiros
         SET pagamento_data = $1,
             status = 'pago',
             forma_pagamento = $2,
             observacao = $3,
             atualizado_em = NOW()
         WHERE id = $4`,
        [
          dataPagamento,
          formaPagamentoFinal,
          observacao || conta.observacao || "",
          conta.lancamento_id
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ sucesso: true });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao baixar conta a pagar");
  } finally {
    client.release();
  }
});

app.put("/contas-pagar/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);
    const {
      fornecedor_nome,
      descricao,
      valor,
      data_vencimento,
      forma_pagamento,
      observacao,
      status
    } = req.body;

    const contaResult = await pool.query(
      `SELECT * FROM contas_pagar WHERE id = $1`,
      [id]
    );

    if (contaResult.rowCount === 0) {
      return res.status(404).send("Conta não encontrada");
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const statusFinal = ["pendente", "pago", "atrasado"].includes(status) ? status : conta.status;

    const result = await pool.query(
      `UPDATE contas_pagar
       SET fornecedor_nome = $1,
           descricao = $2,
           valor = $3,
           data_vencimento = $4,
           forma_pagamento = $5,
           observacao = $6,
           status = $7,
           atualizado_em = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        fornecedor_nome || conta.fornecedor_nome || "",
        descricao || conta.descricao || "",
        normalizarDecimal(valor),
        normalizarDataISO(data_vencimento) || conta.data_vencimento,
        forma_pagamento || conta.forma_pagamento || "",
        observacao || "",
        statusFinal,
        id
      ]
    );

    if (conta.lancamento_id) {
      await pool.query(
        `UPDATE lancamentos_financeiros
         SET descricao = $1,
             valor = $2,
             vencimento = $3,
             forma_pagamento = $4,
             observacao = $5,
             status = $6,
             atualizado_em = NOW()
         WHERE id = $7`,
        [
          descricao || conta.descricao || "",
          normalizarDecimal(valor),
          normalizarDataISO(data_vencimento) || conta.data_vencimento,
          forma_pagamento || conta.forma_pagamento || "",
          observacao || "",
          statusFinal,
          conta.lancamento_id
        ]
      );
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).send("Erro ao atualizar conta a pagar");
  }
});

app.delete("/contas-pagar/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);

    const contaResult = await pool.query(
      `SELECT * FROM contas_pagar WHERE id = $1`,
      [id]
    );

    if (contaResult.rowCount === 0) {
      return res.status(404).send("Conta não encontrada");
    }

    const conta = contaResult.rows[0];

    if (!validarEmpresa(req, conta.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (conta.lancamento_id) {
      await pool.query(`DELETE FROM lancamentos_financeiros WHERE id = $1`, [conta.lancamento_id]);
    }

    await pool.query(`DELETE FROM contas_pagar WHERE id = $1`, [id]);

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir conta a pagar");
  }
});

app.get("/dashboard/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    await atualizarStatusContasReceberPorEmpresa(empresa);
    await atualizarStatusContasPagarPorEmpresa(empresa);

    const { dataInicial, dataFinal } = obterPeriodo(req);

    const produtosResult = await pool.query(
      `SELECT
         COUNT(*) AS total_produtos,
         COALESCE(SUM(CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN 1 ELSE 0 END), 0) AS estoque_baixo,
         COALESCE(SUM(estoque * custo), 0) AS valor_estoque
       FROM produtos
       WHERE empresa = $1`,
      [empresa]
    );

    const fornecedoresResult = await pool.query(
      `SELECT COUNT(*) AS total_fornecedores
       FROM fornecedores
       WHERE empresa = $1`,
      [empresa]
    );

    const comprasParams = [empresa];
    const vendasParams = [empresa];
    const contasReceberParams = [empresa];
    const contasPagarParams = [empresa];

    let comprasWhere = `WHERE empresa = $1`;
    let vendasWhere = `WHERE empresa = $1`;
    let contasReceberWhere = `WHERE empresa = $1 AND status IN ('pendente', 'atrasado')`;
    let contasPagarWhere = `WHERE empresa = $1 AND status IN ('pendente', 'atrasado')`;

    comprasWhere += adicionarFiltroPeriodo({
      campo: "data",
      params: comprasParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    vendasWhere += adicionarFiltroPeriodo({
      campo: "data",
      params: vendasParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    contasReceberWhere += adicionarFiltroPeriodoRange({
      campoInicial: "data_vencimento",
      campoFinal: "data_pagamento",
      params: contasReceberParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    contasPagarWhere += adicionarFiltroPeriodoRange({
      campoInicial: "data_vencimento",
      campoFinal: "data_pagamento",
      params: contasPagarParams,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const [
      comprasResult,
      vendasResult,
      contasReceberResult,
      contasPagarResult,
      ultimasMovResult,
      alertasResult
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total_compras
         FROM compras
         ${comprasWhere}`,
        comprasParams
      ),
      pool.query(
        `SELECT
           COUNT(*) AS total_vendas,
           COALESCE(SUM(total), 0) AS faturamento,
           COALESCE(SUM((subtotal - (SELECT COALESCE(SUM(custo_unitario * quantidade), 0) FROM venda_itens WHERE venda_id = vendas.id)) - desconto + acrescimo), 0) AS lucro_estimado
         FROM vendas
         ${vendasWhere}`,
        vendasParams
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor ELSE 0 END), 0) AS receber_pendente,
           COALESCE(SUM(CASE WHEN status = 'atrasado' THEN valor ELSE 0 END), 0) AS receber_atrasado
         FROM contas_receber
         ${contasReceberWhere}`,
        contasReceberParams
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor ELSE 0 END), 0) AS pagar_pendente,
           COALESCE(SUM(CASE WHEN status = 'atrasado' THEN valor ELSE 0 END), 0) AS pagar_atrasado
         FROM contas_pagar
         ${contasPagarWhere}`,
        contasPagarParams
      ),
      pool.query(
        `SELECT
           m.*,
           p.nome AS produto_nome
         FROM movimentacoes_estoque m
         INNER JOIN produtos p ON p.id = m.produto_id
         WHERE m.empresa = $1
         ORDER BY m.data_movimentacao DESC, m.id DESC
         LIMIT 10`,
        [empresa]
      ),
      pool.query(
        `SELECT
           empresa,
           nome,
           estoque,
           estoque_minimo
         FROM produtos
         WHERE empresa = $1
           AND estoque <= estoque_minimo
           AND estoque_minimo > 0
         ORDER BY estoque ASC, nome ASC
         LIMIT 10`,
        [empresa]
      )
    ]);

    const totalVendas = Number(vendasResult.rows[0].total_vendas || 0);
    const faturamento = Number(vendasResult.rows[0].faturamento || 0);

    res.json({
      total_produtos: Number(produtosResult.rows[0].total_produtos || 0),
      estoque_baixo: Number(produtosResult.rows[0].estoque_baixo || 0),
      valor_estoque: Number(produtosResult.rows[0].valor_estoque || 0),
      total_fornecedores: Number(fornecedoresResult.rows[0].total_fornecedores || 0),
      total_compras: Number(comprasResult.rows[0].total_compras || 0),
      total_vendas: totalVendas,
      faturamento,
      lucro_estimado: Number(vendasResult.rows[0].lucro_estimado || 0),
      ticket_medio: totalVendas > 0 ? faturamento / totalVendas : 0,
      receber_pendente: Number(contasReceberResult.rows[0].receber_pendente || 0),
      pagar_pendente: Number(contasPagarResult.rows[0].pagar_pendente || 0),
      contas_atrasadas:
        Number(contasReceberResult.rows[0].receber_atrasado || 0) +
        Number(contasPagarResult.rows[0].pagar_atrasado || 0),
      ultimas_movimentacoes: ultimasMovResult.rows,
      produtos_alerta: alertasResult.rows
    });
  } catch (error) {
    res.status(500).send("Erro ao carregar dashboard");
  }
});

app.get("/admin/dashboard", auth, apenasAdmin, async (req, res) => {
  try {
    await atualizarStatusContasReceberGlobal();
    await atualizarStatusContasPagarGlobal();

    const { dataInicial, dataFinal } = obterPeriodo(req);

    const paramsCompras = [];
    const paramsVendas = [];
    const paramsContasReceber = [];
    const paramsContasPagar = [];

    let whereCompras = `WHERE 1=1`;
    let whereVendas = `WHERE 1=1`;
    let whereContasReceber = `WHERE status IN ('pendente', 'atrasado')`;
    let whereContasPagar = `WHERE status IN ('pendente', 'atrasado')`;

    whereCompras += adicionarFiltroPeriodo({
      campo: "data",
      params: paramsCompras,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereVendas += adicionarFiltroPeriodo({
      campo: "data",
      params: paramsVendas,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereContasReceber += adicionarFiltroPeriodoRange({
      campoInicial: "data_vencimento",
      campoFinal: "data_pagamento",
      params: paramsContasReceber,
      dataInicial,
      dataFinal,
      castDate: false
    });

    whereContasPagar += adicionarFiltroPeriodoRange({
      campoInicial: "data_vencimento",
      campoFinal: "data_pagamento",
      params: paramsContasPagar,
      dataInicial,
      dataFinal,
      castDate: false
    });

    const [
      produtosResult,
      fornecedoresResult,
      comprasResult,
      vendasResult,
      contasReceberResult,
      contasPagarResult,
      ultimasMovResult,
      alertasResult
    ] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) AS total_produtos,
           COALESCE(SUM(CASE WHEN estoque <= estoque_minimo AND estoque_minimo > 0 THEN 1 ELSE 0 END), 0) AS estoque_baixo,
           COALESCE(SUM(estoque * custo), 0) AS valor_estoque
         FROM produtos`
      ),
      pool.query(`SELECT COUNT(*) AS total_fornecedores FROM fornecedores`),
      pool.query(
        `SELECT COUNT(*) AS total_compras
         FROM compras
         ${whereCompras}`,
        paramsCompras
      ),
      pool.query(
        `SELECT
           COUNT(*) AS total_vendas,
           COALESCE(SUM(total), 0) AS faturamento,
           COALESCE(SUM((subtotal - (SELECT COALESCE(SUM(custo_unitario * quantidade), 0) FROM venda_itens WHERE venda_id = vendas.id)) - desconto + acrescimo), 0) AS lucro_estimado
         FROM vendas
         ${whereVendas}`,
        paramsVendas
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor ELSE 0 END), 0) AS receber_pendente,
           COALESCE(SUM(CASE WHEN status = 'atrasado' THEN valor ELSE 0 END), 0) AS receber_atrasado
         FROM contas_receber
         ${whereContasReceber}`,
        paramsContasReceber
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor ELSE 0 END), 0) AS pagar_pendente,
           COALESCE(SUM(CASE WHEN status = 'atrasado' THEN valor ELSE 0 END), 0) AS pagar_atrasado
         FROM contas_pagar
         ${whereContasPagar}`,
        paramsContasPagar
      ),
      pool.query(
        `SELECT
           m.*,
           p.nome AS produto_nome
         FROM movimentacoes_estoque m
         INNER JOIN produtos p ON p.id = m.produto_id
         ORDER BY m.data_movimentacao DESC, m.id DESC
         LIMIT 20`
      ),
      pool.query(
        `SELECT
           empresa,
           nome,
           estoque,
           estoque_minimo
         FROM produtos
         WHERE estoque <= estoque_minimo
           AND estoque_minimo > 0
         ORDER BY empresa ASC, estoque ASC, nome ASC
         LIMIT 20`
      )
    ]);

    const totalVendas = Number(vendasResult.rows[0].total_vendas || 0);
    const faturamento = Number(vendasResult.rows[0].faturamento || 0);

    res.json({
      total_produtos: Number(produtosResult.rows[0].total_produtos || 0),
      estoque_baixo: Number(produtosResult.rows[0].estoque_baixo || 0),
      valor_estoque: Number(produtosResult.rows[0].valor_estoque || 0),
      total_fornecedores: Number(fornecedoresResult.rows[0].total_fornecedores || 0),
      total_compras: Number(comprasResult.rows[0].total_compras || 0),
      total_vendas: totalVendas,
      faturamento,
      lucro_estimado: Number(vendasResult.rows[0].lucro_estimado || 0),
      ticket_medio: totalVendas > 0 ? faturamento / totalVendas : 0,
      receber_pendente: Number(contasReceberResult.rows[0].receber_pendente || 0),
      pagar_pendente: Number(contasPagarResult.rows[0].pagar_pendente || 0),
      contas_atrasadas:
        Number(contasReceberResult.rows[0].receber_atrasado || 0) +
        Number(contasPagarResult.rows[0].pagar_atrasado || 0),
      ultimas_movimentacoes: ultimasMovResult.rows,
      produtos_alerta: alertasResult.rows
    });
  } catch (error) {
    res.status(500).send("Erro ao carregar dashboard admin");
  }
});

app.get("/relatorio-estoque/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const relatorio = await montarRelatorioEstoquePorEmpresa(empresa);
    res.json(relatorio);
  } catch (error) {
    res.status(500).send("Erro ao gerar relatório de estoque");
  }
});

app.get("/admin/relatorio-estoque", auth, apenasAdmin, async (req, res) => {
  try {
    const empresasResult = await pool.query(`SELECT DISTINCT empresa FROM produtos ORDER BY empresa ASC`);

    const resultados = [];
    for (const row of empresasResult.rows) {
      const relatorio = await montarRelatorioEstoquePorEmpresa(row.empresa);
      resultados.push({
        empresa: row.empresa,
        relatorio
      });
    }

    res.json(resultados);
  } catch (error) {
    res.status(500).send("Erro ao gerar relatório de estoque admin");
  }
});

app.get("/relatorio-performance/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const relatorio = await montarRelatorioPerformancePorEmpresa(empresa);
    res.json(relatorio);
  } catch (error) {
    res.status(500).send("Erro ao gerar relatório de performance");
  }
});

app.get("/admin/relatorio-performance", auth, apenasAdmin, async (req, res) => {
  try {
    const empresasResult = await pool.query(`SELECT DISTINCT empresa FROM produtos ORDER BY empresa ASC`);

    const resultados = [];
    for (const row of empresasResult.rows) {
      const relatorio = await montarRelatorioPerformancePorEmpresa(row.empresa);
      resultados.push({
        empresa: row.empresa,
        relatorio
      });
    }

    res.json(resultados);
  } catch (error) {
    res.status(500).send("Erro ao gerar relatório de performance admin");
  }
});

app.get("/fluxo-caixa/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const { dataInicial, dataFinal } = obterPeriodo(req);
    const fluxo = await montarFluxoCaixaPorEmpresa(empresa, dataInicial, dataFinal);

    res.json(fluxo);
  } catch (error) {
    res.status(500).send("Erro ao gerar fluxo de caixa");
  }
});

app.get("/admin/fluxo-caixa", auth, apenasAdmin, async (req, res) => {
  try {
    const { dataInicial, dataFinal } = obterPeriodo(req);
    const empresasResult = await pool.query(
      `SELECT DISTINCT empresa FROM lancamentos_financeiros ORDER BY empresa ASC`
    );

    const resultados = [];
    for (const row of empresasResult.rows) {
      const fluxo = await montarFluxoCaixaPorEmpresa(row.empresa, dataInicial, dataFinal);
      resultados.push({
        empresa: row.empresa,
        fluxo
      });
    }

    res.json(resultados);
  } catch (error) {
    res.status(500).send("Erro ao gerar fluxo de caixa admin");
  }
});

app.put("/produtos/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      empresa,
      nome,
      preco,
      custo,
      estoque_minimo,
      codigo_barras,
      categoria
    } = req.body;

    const produtoResult = await pool.query(`SELECT * FROM produtos WHERE id = $1`, [id]);

    if (produtoResult.rowCount === 0) {
      return res.status(404).send("Produto não encontrado");
    }

    const produto = produtoResult.rows[0];

    if (!validarEmpresa(req, produto.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const empresaFinal = req.user.tipo === "admin" ? (empresa || produto.empresa) : produto.empresa;

    const result = await pool.query(
      `UPDATE produtos
       SET empresa = $1,
           nome = $2,
           preco = $3,
           custo = $4,
           estoque_minimo = $5,
           codigo_barras = $6,
           categoria = $7,
           atualizado_em = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        empresaFinal,
        nome || produto.nome,
        normalizarDecimal(preco),
        normalizarDecimal(custo),
        normalizarInt(estoque_minimo),
        codigo_barras || "",
        categoria || "",
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).send("Erro ao atualizar produto");
  }
});

app.delete("/produtos/:id", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);

    await client.query("BEGIN");

    const produtoResult = await client.query(`SELECT * FROM produtos WHERE id = $1 FOR UPDATE`, [id]);

    if (produtoResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).send("Produto não encontrado");
    }

    const produto = produtoResult.rows[0];

    if (!validarEmpresa(req, produto.empresa)) {
      await client.query("ROLLBACK");
      return res.status(403).send("Sem acesso");
    }

    const vendasComProduto = await client.query(
      `SELECT 1 FROM venda_itens WHERE produto_id = $1 LIMIT 1`,
      [id]
    );

    const comprasComProduto = await client.query(
      `SELECT 1 FROM compra_itens WHERE produto_id = $1 LIMIT 1`,
      [id]
    );

    if (vendasComProduto.rowCount > 0 || comprasComProduto.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(400).send("Produto já possui histórico e não pode ser excluído");
    }

    await client.query(`DELETE FROM movimentacoes_estoque WHERE produto_id = $1`, [id]);
    await client.query(`DELETE FROM produtos WHERE id = $1`, [id]);

    await client.query("COMMIT");
    res.json({ sucesso: true });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao excluir produto");
  } finally {
    client.release();
  }
});

app.put("/clientes/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nome, endereco, telefone, nascimento, cpf } = req.body;

    const clienteResult = await pool.query(`SELECT * FROM clientes WHERE id = $1`, [id]);

    if (clienteResult.rowCount === 0) {
      return res.status(404).send("Cliente não encontrado");
    }

    const cliente = clienteResult.rows[0];

    if (!validarEmpresa(req, cliente.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `UPDATE clientes
       SET nome = $1,
           endereco = $2,
           telefone = $3,
           nascimento = $4,
           cpf = $5,
           atualizado_em = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        nome || cliente.nome,
        endereco || "",
        telefone || "",
        nascimento || "",
        cpf || "",
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).send("Erro ao atualizar cliente");
  }
});

app.delete("/clientes/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const clienteResult = await pool.query(`SELECT * FROM clientes WHERE id = $1`, [id]);

    if (clienteResult.rowCount === 0) {
      return res.status(404).send("Cliente não encontrado");
    }

    const cliente = clienteResult.rows[0];

    if (!validarEmpresa(req, cliente.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const vinculadoVenda = await pool.query(
      `SELECT 1 FROM vendas WHERE cliente_id = $1 LIMIT 1`,
      [id]
    );

    if (vinculadoVenda.rowCount > 0) {
      return res.status(400).send("Cliente possui vendas vinculadas e não pode ser excluído");
    }

    await pool.query(`DELETE FROM clientes WHERE id = $1`, [id]);

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir cliente");
  }
});

app.put("/fornecedores/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nome, contato, telefone, email, endereco, observacao } = req.body;

    const fornecedorResult = await pool.query(`SELECT * FROM fornecedores WHERE id = $1`, [id]);

    if (fornecedorResult.rowCount === 0) {
      return res.status(404).send("Fornecedor não encontrado");
    }

    const fornecedor = fornecedorResult.rows[0];

    if (!validarEmpresa(req, fornecedor.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `UPDATE fornecedores
       SET nome = $1,
           contato = $2,
           telefone = $3,
           email = $4,
           endereco = $5,
           observacao = $6,
           atualizado_em = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        nome || fornecedor.nome,
        contato || "",
        telefone || "",
        email || "",
        endereco || "",
        observacao || "",
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).send("Erro ao atualizar fornecedor");
  }
});

app.delete("/fornecedores/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const fornecedorResult = await pool.query(`SELECT * FROM fornecedores WHERE id = $1`, [id]);

    if (fornecedorResult.rowCount === 0) {
      return res.status(404).send("Fornecedor não encontrado");
    }

    const fornecedor = fornecedorResult.rows[0];

    if (!validarEmpresa(req, fornecedor.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const vinculadoCompra = await pool.query(
      `SELECT 1 FROM compras WHERE fornecedor_id = $1 LIMIT 1`,
      [id]
    );

    if (vinculadoCompra.rowCount > 0) {
      return res.status(400).send("Fornecedor possui compras vinculadas e não pode ser excluído");
    }

    await pool.query(`DELETE FROM fornecedores WHERE id = $1`, [id]);

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir fornecedor");
  }
});

app.put("/compras/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarCompras(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);
    const {
      data,
      observacao,
      forma_pagamento,
      status_pagamento,
      vencimento
    } = req.body;

    const compraResult = await pool.query(
      `SELECT * FROM compras WHERE id = $1`,
      [id]
    );

    if (compraResult.rowCount === 0) {
      return res.status(404).send("Compra não encontrada");
    }

    const compra = compraResult.rows[0];

    if (!validarEmpresa(req, compra.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const dataFinal = normalizarDataISO(data) || compra.data;
    const vencimentoFinal = normalizarDataISO(vencimento) || compra.vencimento;
    const statusPagamentoFinal = ["pago", "pendente"].includes(status_pagamento)
      ? status_pagamento
      : compra.status_pagamento;

    const pagamentoDataFinal = statusPagamentoFinal === "pago"
      ? (compra.pagamento_data || dataFinal)
      : null;

    const result = await pool.query(
      `UPDATE compras
       SET data = $1,
           observacao = $2,
           forma_pagamento = $3,
           status_pagamento = $4,
           vencimento = $5,
           pagamento_data = $6,
           atualizado_em = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        dataFinal,
        observacao || "",
        forma_pagamento || "",
        statusPagamentoFinal,
        vencimentoFinal,
        pagamentoDataFinal,
        id
      ]
    );

    if (compra.gerar_conta_pagar) {
      await pool.query(
        `UPDATE contas_pagar
         SET data_vencimento = $1,
             data_pagamento = $2,
             status = $3,
             forma_pagamento = $4,
             observacao = $5,
             atualizado_em = NOW()
         WHERE compra_id = $6`,
        [
          vencimentoFinal,
          pagamentoDataFinal,
          statusPagamentoFinal,
          forma_pagamento || "",
          observacao || "",
          id
        ]
      );
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).send("Erro ao atualizar compra");
  }
});

app.delete("/compras/:id", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!podeGerenciarCompras(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);

    await client.query("BEGIN");

    const compraResult = await client.query(
      `SELECT * FROM compras WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (compraResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).send("Compra não encontrada");
    }

    const compra = compraResult.rows[0];

    if (!validarEmpresa(req, compra.empresa)) {
      await client.query("ROLLBACK");
      return res.status(403).send("Sem acesso");
    }

    const itensResult = await client.query(
      `SELECT * FROM compra_itens WHERE compra_id = $1`,
      [id]
    );

    for (const item of itensResult.rows) {
      const produtoResult = await client.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa = $2 FOR UPDATE`,
        [item.produto_id, compra.empresa]
      );

      if (produtoResult.rowCount > 0) {
        const produto = produtoResult.rows[0];
        const estoqueAtual = normalizarInt(produto.estoque);
        const novoEstoque = Math.max(0, estoqueAtual - normalizarInt(item.quantidade));

        await client.query(
          `UPDATE produtos
           SET estoque = $1,
               atualizado_em = NOW()
           WHERE id = $2 AND empresa = $3`,
          [novoEstoque, item.produto_id, compra.empresa]
        );

        await registrarMovimentacaoEstoque({
          client,
          empresa: compra.empresa,
          produto_id: item.produto_id,
          tipo: "ajuste_saida",
          quantidade: normalizarInt(item.quantidade),
          observacao: `Estorno da compra #${id}`,
          referencia_tipo: "compra_excluida",
          referencia_id: id,
          usuario_id: req.user.id
        });
      }
    }

    await client.query(`DELETE FROM compra_itens WHERE compra_id = $1`, [id]);
    await client.query(`DELETE FROM contas_pagar WHERE compra_id = $1`, [id]);
    await client.query(`DELETE FROM lancamentos_financeiros WHERE descricao LIKE $1`, [`Compra #${id}%`]);
    await client.query(`DELETE FROM compras WHERE id = $1`, [id]);

    await client.query("COMMIT");
    res.json({ sucesso: true });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao excluir compra");
  } finally {
    client.release();
  }
});

app.put("/vendas/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarVendas(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);
    const {
      cliente_nome,
      pagamento,
      parcelas,
      desconto,
      acrescimo,
      observacao,
      data
    } = req.body;

    const vendaResult = await pool.query(
      `SELECT * FROM vendas WHERE id = $1`,
      [id]
    );

    if (vendaResult.rowCount === 0) {
      return res.status(404).send("Venda não encontrada");
    }

    const venda = vendaResult.rows[0];

    if (!validarEmpresa(req, venda.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const statusPagamentoFinal =
      (pagamento === "Promissória" || pagamento === "Crédito Parcelado") &&
      Math.max(normalizarInt(parcelas), 1) > 1
        ? "pendente"
        : "pago";

    const result = await pool.query(
      `UPDATE vendas
       SET cliente_nome = $1,
           pagamento = $2,
           parcelas = $3,
           desconto = $4,
           acrescimo = $5,
           observacao = $6,
           data = $7,
           status_pagamento = $8
       WHERE id = $9
       RETURNING *`,
      [
        cliente_nome || venda.cliente_nome || "",
        pagamento || venda.pagamento || "",
        Math.max(normalizarInt(parcelas), 1),
        normalizarDecimal(desconto),
        normalizarDecimal(acrescimo),
        observacao || "",
        normalizarDataISO(data) || venda.data,
        statusPagamentoFinal,
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).send("Erro ao atualizar venda");
  }
});

app.delete("/vendas/:id", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!podeGerenciarVendas(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = Number(req.params.id);

    await client.query("BEGIN");

    const vendaResult = await client.query(
      `SELECT * FROM vendas WHERE id = $1 FOR UPDATE`,
      [id]
    );

    if (vendaResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).send("Venda não encontrada");
    }

    const venda = vendaResult.rows[0];

    if (!validarEmpresa(req, venda.empresa)) {
      await client.query("ROLLBACK");
      return res.status(403).send("Sem acesso");
    }

    const itensResult = await client.query(
      `SELECT * FROM venda_itens WHERE venda_id = $1`,
      [id]
    );

    for (const item of itensResult.rows) {
      await client.query(
        `UPDATE produtos
         SET estoque = estoque + $1,
             atualizado_em = NOW()
         WHERE id = $2 AND empresa = $3`,
        [normalizarInt(item.quantidade), item.produto_id, venda.empresa]
      );

      await registrarMovimentacaoEstoque({
        client,
        empresa: venda.empresa,
        produto_id: item.produto_id,
        tipo: "estorno_venda",
        quantidade: normalizarInt(item.quantidade),
        observacao: `Estorno da venda #${id}`,
        referencia_tipo: "venda_excluida",
        referencia_id: id,
        usuario_id: req.user.id
      });
    }

    await client.query(`DELETE FROM venda_itens WHERE venda_id = $1`, [id]);
    await client.query(`DELETE FROM contas_receber WHERE venda_id = $1`, [id]);
    await client.query(`DELETE FROM lancamentos_financeiros WHERE descricao LIKE $1`, [`Venda #${id}%`]);
    await client.query(`DELETE FROM vendas WHERE id = $1`, [id]);

    await client.query("COMMIT");
    res.json({ sucesso: true });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao excluir venda");
  } finally {
    client.release();
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor LF ERP rodando na porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Erro ao iniciar banco:", error);
    process.exit(1);
  });