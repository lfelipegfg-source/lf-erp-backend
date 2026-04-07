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
  usuario_id
}) {
  await pool.query(
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
  const [produtosResult, vendasResult] = await Promise.all([
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
        produto,
        COALESCE(SUM(quantidade), 0) AS quantidade_vendida,
        COALESCE(SUM(total), 0) AS faturamento
      FROM vendas
      WHERE empresa = $1
      GROUP BY produto_id, produto
      `,
      [empresa]
    )
  ]);

  const mapaVendas = new Map();
  for (const row of vendasResult.rows) {
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
      produto_id INTEGER,
      produto TEXT NOT NULL,
      quantidade INTEGER NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      cliente_nome TEXT,
      pagamento TEXT,
      data TEXT,
      criado_por INTEGER,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
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
    CREATE INDEX IF NOT EXISTS idx_produtos_empresa ON produtos (empresa);
    CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes (empresa);
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa ON vendas (empresa);
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa_data ON vendas (empresa, data);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa ON lancamentos_financeiros (empresa);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_status ON lancamentos_financeiros (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_investimentos_empresa ON investimentos (empresa);
    CREATE INDEX IF NOT EXISTS idx_fornecedores_empresa ON fornecedores (empresa);
    CREATE INDEX IF NOT EXISTS idx_compras_empresa ON compras (empresa);
    CREATE INDEX IF NOT EXISTS idx_compra_itens_compra ON compra_itens (compra_id);
    CREATE INDEX IF NOT EXISTS idx_mov_estoque_empresa ON movimentacoes_estoque (empresa);
    CREATE INDEX IF NOT EXISTS idx_mov_estoque_produto ON movimentacoes_estoque (produto_id);
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
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS produto_id INTEGER;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS criado_por INTEGER;
    ALTER TABLE vendas ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP NOT NULL DEFAULT NOW();
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
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS forma_pagamento TEXT;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS status_pagamento TEXT NOT NULL DEFAULT 'pendente';
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS vencimento TEXT;
    ALTER TABLE compras ADD COLUMN IF NOT EXISTS pagamento_data TEXT;
  `);

  const hash = await bcrypt.hash("Lfgl.1308.", 10);
  const existing = await pool.query(
    `SELECT id FROM usuarios WHERE usuario = $1`,
    ["Lfelipeg"]
  );

  if (existing.rowCount === 0) {
    await pool.query(
      `INSERT INTO usuarios
      (usuario, senha, tipo, empresa, nome_completo, cpf, nascimento)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["Lfelipeg", hash, "admin", null, "Lfelipeg", "", ""]
    );
  } else {
    await pool.query(
      `UPDATE usuarios
       SET senha = $1,
           tipo = $2,
           empresa = $3,
           nome_completo = COALESCE(nome_completo, $4),
           atualizado_em = NOW()
       WHERE usuario = $5`,
      [hash, "admin", null, "Lfelipeg", "Lfelipeg"]
    );
  }
}

app.get("/", async (req, res) => {
  res.send("LF ERP online com PostgreSQL 🚀");
});

// ================= LOGIN =================
app.post("/login", async (req, res) => {
  try {
    const { usuario, senha } = req.body;

    const result = await pool.query(
      `SELECT * FROM usuarios WHERE usuario = $1`,
      [usuario]
    );

    if (result.rowCount === 0) {
      return res.status(401).send("Usuário inválido");
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(senha, user.senha);

    if (!ok) {
      return res.status(401).send("Senha inválida");
    }

    const token = jwt.sign(
      {
        id: user.id,
        tipo: user.tipo,
        empresa: user.empresa || null,
        usuario: user.usuario,
        nome_completo: user.nome_completo || ""
      },
      SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      tipo: user.tipo,
      empresa: user.empresa || null,
      usuario: user.usuario,
      nome_completo: user.nome_completo || ""
    });
  } catch (error) {
    res.status(500).send("Erro no servidor");
  }
});

// ================= USUÁRIOS =================
app.post("/usuarios", auth, async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send("Sem permissão");
    }

    const { usuario, senha, tipo, empresa, nome_completo, cpf, nascimento } = req.body;

    if (!usuario || !senha || !tipo || !nome_completo) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    if (tipo === "admin" && req.user.tipo !== "admin") {
      return res.status(403).send("Apenas admin pode criar admin");
    }

    if ((tipo === "gerente" || tipo === "funcionario") && !empresa) {
      return res.status(400).send("Loja obrigatória");
    }

    if (req.user.tipo === "gerente") {
      if (empresa !== req.user.empresa) {
        return res.status(403).send("Gerente só pode cadastrar usuários da própria loja");
      }
      if (tipo === "admin") {
        return res.status(403).send("Gerente não pode criar admin");
      }
    }

    const hash = await bcrypt.hash(senha, 10);

    const result = await pool.query(
      `INSERT INTO usuarios
      (usuario, senha, tipo, empresa, nome_completo, cpf, nascimento)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
      [
        usuario,
        hash,
        tipo,
        tipo === "admin" ? null : empresa,
        nome_completo,
        cpf || "",
        nascimento || ""
      ]
    );

    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (error) {
    res.status(400).send("Erro ao criar usuário");
  }
});

app.get("/usuarios", auth, async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send("Sem permissão");
    }

    let sql = `
      SELECT id, usuario, tipo, empresa, nome_completo, cpf, nascimento
      FROM usuarios
    `;
    const params = [];

    if (req.user.tipo === "gerente") {
      sql += ` WHERE empresa = $1 `;
      params.push(req.user.empresa);
    }

    sql += ` ORDER BY nome_completo ASC NULLS LAST, usuario ASC`;

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao listar usuários");
  }
});

app.put("/usuarios/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarUsuarios(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = req.params.id;
    const { usuario, tipo, empresa, nome_completo, cpf, nascimento, senha } = req.body;

    const alvoResult = await pool.query(`SELECT * FROM usuarios WHERE id = $1`, [id]);
    if (alvoResult.rowCount === 0) {
      return res.status(404).send("Usuário não encontrado");
    }

    const alvo = alvoResult.rows[0];

    if (req.user.tipo === "gerente") {
      if (alvo.empresa !== req.user.empresa) {
        return res.status(403).send("Gerente só pode editar usuários da própria loja");
      }
      if (tipo === "admin") {
        return res.status(403).send("Gerente não pode transformar usuário em admin");
      }
      if (empresa !== req.user.empresa) {
        return res.status(403).send("Gerente não pode mover usuário para outra loja");
      }
    }

    if (tipo === "admin" && req.user.tipo !== "admin") {
      return res.status(403).send("Apenas admin pode definir admin");
    }

    const senhaFinal = senha && senha.trim() !== "" ? await bcrypt.hash(senha, 10) : alvo.senha;

    await pool.query(
      `UPDATE usuarios
       SET usuario = $1,
           senha = $2,
           tipo = $3,
           empresa = $4,
           nome_completo = $5,
           cpf = $6,
           nascimento = $7,
           atualizado_em = NOW()
       WHERE id = $8`,
      [
        usuario,
        senhaFinal,
        tipo,
        tipo === "admin" ? null : empresa,
        nome_completo,
        cpf || "",
        nascimento || "",
        id
      ]
    );

    res.json({ sucesso: true });
  } catch (error) {
    res.status(400).send("Erro ao atualizar usuário");
  }
});

app.delete("/usuarios/:id", auth, async (req, res) => {
  try {
    if (req.user.tipo !== "admin") {
      return res.status(403).send("Apenas admin pode excluir usuário");
    }

    const id = req.params.id;
    const result = await pool.query(`SELECT * FROM usuarios WHERE id = $1`, [id]);

    if (result.rowCount === 0) {
      return res.status(404).send("Usuário não encontrado");
    }

    if (result.rows[0].usuario === "Lfelipeg") {
      return res.status(400).send("Não é permitido excluir o admin principal");
    }

    await pool.query(`DELETE FROM usuarios WHERE id = $1`, [id]);
    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir usuário");
  }
});

// ================= PRODUTOS =================
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

app.put("/produtos/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
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

    const anterior = await pool.query(
      `SELECT * FROM produtos WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    if (anterior.rowCount === 0) {
      return res.status(404).send("Produto não encontrado");
    }

    const produtoAnterior = anterior.rows[0];
    const estoqueNovo = normalizarInt(estoque);
    const estoqueAnterior = normalizarInt(produtoAnterior.estoque);

    await pool.query(
      `UPDATE produtos
       SET nome = $1,
           preco = $2,
           estoque = $3,
           custo = $4,
           estoque_minimo = $5,
           codigo_barras = $6,
           categoria = $7,
           atualizado_em = NOW()
       WHERE id = $8 AND empresa = $9`,
      [
        nome,
        normalizarDecimal(preco),
        estoqueNovo,
        normalizarDecimal(custo),
        normalizarInt(estoque_minimo),
        codigo_barras || "",
        categoria || "",
        id,
        empresa
      ]
    );

    const diferenca = estoqueNovo - estoqueAnterior;
    if (diferenca !== 0) {
      await registrarMovimentacaoEstoque({
        empresa,
        produto_id: Number(id),
        tipo: diferenca > 0 ? "ajuste_entrada" : "ajuste_saida",
        quantidade: Math.abs(diferenca),
        observacao: "Ajuste manual no cadastro do produto",
        referencia_tipo: "produto",
        referencia_id: Number(id),
        usuario_id: req.user.id
      });
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao atualizar produto");
  }
});

app.delete("/produtos/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const empresa = req.query.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const itensCompra = await pool.query(
      `SELECT id FROM compra_itens WHERE produto_id = $1 LIMIT 1`,
      [id]
    );
    if (itensCompra.rowCount > 0) {
      return res.status(400).send("Produto vinculado a compras. Não pode ser excluído.");
    }

    const vendas = await pool.query(
      `SELECT id FROM vendas WHERE produto_id = $1 LIMIT 1`,
      [id]
    );
    if (vendas.rowCount > 0) {
      return res.status(400).send("Produto vinculado a vendas. Não pode ser excluído.");
    }

    const result = await pool.query(
      `DELETE FROM produtos WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Produto não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir produto");
  }
});

// ================= CLIENTES =================
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

app.put("/clientes/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const { empresa, nome, endereco, telefone, nascimento, cpf } = req.body;

    if (!validarEmpresa(req, empresa)) {
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
       WHERE id = $6 AND empresa = $7`,
      [nome, endereco || "", telefone || "", nascimento || "", cpf || "", id, empresa]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Cliente não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao atualizar cliente");
  }
});

app.delete("/clientes/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const empresa = req.query.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `DELETE FROM clientes WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Cliente não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir cliente");
  }
});

// ================= FORNECEDORES =================
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

app.put("/fornecedores/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const { empresa, nome, contato, telefone, email, endereco, observacao } = req.body;

    if (!validarEmpresa(req, empresa)) {
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
       WHERE id = $7 AND empresa = $8`,
      [nome, contato || "", telefone || "", email || "", endereco || "", observacao || "", id, empresa]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Fornecedor não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao atualizar fornecedor");
  }
});

app.delete("/fornecedores/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const empresa = req.query.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const compras = await pool.query(`SELECT id FROM compras WHERE fornecedor_id = $1 LIMIT 1`, [id]);
    if (compras.rowCount > 0) {
      return res.status(400).send("Fornecedor vinculado a compras. Não pode ser excluído.");
    }

    const result = await pool.query(
      `DELETE FROM fornecedores WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Fornecedor não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir fornecedor");
  }
});

// ================= VENDAS =================
app.post("/vendas", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { empresa, produto_id, quantidade, cliente_nome, pagamento, data } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const qtd = normalizarInt(quantidade);
    if (!empresa || !produto_id || qtd <= 0) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

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
    if (normalizarInt(produto.estoque) < qtd) {
      await client.query("ROLLBACK");
      return res.status(400).send("Estoque insuficiente");
    }

    const total = normalizarDecimal(produto.preco) * qtd;
    const dataVenda = data || hoje();

    const venda = await client.query(
      `INSERT INTO vendas
       (empresa, produto_id, produto, quantidade, total, cliente_nome, pagamento, data, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        empresa,
        produto_id,
        produto.nome,
        qtd,
        total,
        cliente_nome || "",
        pagamento || "",
        dataVenda,
        req.user.id
      ]
    );

    const novoEstoque = normalizarInt(produto.estoque) - qtd;

    await client.query(
      `UPDATE produtos
       SET estoque = $1, atualizado_em = NOW()
       WHERE id = $2 AND empresa = $3`,
      [novoEstoque, produto_id, empresa]
    );

    await client.query(
      `INSERT INTO movimentacoes_estoque
       (empresa, produto_id, tipo, quantidade, observacao, referencia_tipo, referencia_id, usuario_id, data_movimentacao)
       VALUES ($1, $2, 'saida_venda', $3, $4, 'venda', $5, $6, NOW())`,
      [
        empresa,
        produto_id,
        qtd,
        `Venda do produto ${produto.nome}`,
        venda.rows[0].id,
        req.user.id
      ]
    );

    await client.query("COMMIT");
    res.json({ sucesso: true, id: venda.rows[0].id });
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

    const result = await pool.query(
      `SELECT * FROM vendas WHERE empresa = $1 ORDER BY data DESC, id DESC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar vendas");
  }
});

app.put("/vendas/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const { empresa, cliente_nome, pagamento, data } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `UPDATE vendas
       SET cliente_nome = $1,
           pagamento = $2,
           data = $3
       WHERE id = $4 AND empresa = $5`,
      [cliente_nome || "", pagamento || "", data || hoje(), id, empresa]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Venda não encontrada");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao atualizar venda");
  }
});

app.delete("/vendas/:id", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = req.params.id;
    const empresa = req.query.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    await client.query("BEGIN");

    const vendaResult = await client.query(
      `SELECT * FROM vendas WHERE id = $1 AND empresa = $2 FOR UPDATE`,
      [id, empresa]
    );

    if (vendaResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).send("Venda não encontrada");
    }

    const venda = vendaResult.rows[0];

    if (venda.produto_id) {
      const produtoResult = await client.query(
        `SELECT * FROM produtos WHERE id = $1 AND empresa = $2 FOR UPDATE`,
        [venda.produto_id, empresa]
      );

      if (produtoResult.rowCount > 0) {
        const produto = produtoResult.rows[0];
        const novoEstoque = normalizarInt(produto.estoque) + normalizarInt(venda.quantidade);

        await client.query(
          `UPDATE produtos
           SET estoque = $1, atualizado_em = NOW()
           WHERE id = $2 AND empresa = $3`,
          [novoEstoque, venda.produto_id, empresa]
        );

        await client.query(
          `INSERT INTO movimentacoes_estoque
           (empresa, produto_id, tipo, quantidade, observacao, referencia_tipo, referencia_id, usuario_id, data_movimentacao)
           VALUES ($1, $2, 'estorno_venda', $3, $4, 'venda', $5, $6, NOW())`,
          [
            empresa,
            venda.produto_id,
            normalizarInt(venda.quantidade),
            `Estorno da venda #${venda.id}`,
            venda.id,
            req.user.id
          ]
        );
      }
    }

    await client.query(`DELETE FROM vendas WHERE id = $1 AND empresa = $2`, [id, empresa]);
    await client.query("COMMIT");

    res.json({ sucesso: true });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao excluir venda");
  } finally {
    client.release();
  }
});

// ================= COMPRAS =================
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

    const dataCompra = data || hoje();
    const gerarContaPagarBool = Boolean(gerar_conta_pagar);
    const formaPagamentoFinal = forma_pagamento || null;

    let statusPagamentoFinal = "pago";
    if (gerarContaPagarBool) {
      statusPagamentoFinal = "pendente";
    }
    if (status_pagamento === "pago" || status_pagamento === "pendente") {
      statusPagamentoFinal = status_pagamento;
    }
    if (!gerarContaPagarBool && statusPagamentoFinal !== "pago") {
      statusPagamentoFinal = "pago";
    }

    const vencimentoFinal = gerarContaPagarBool
      ? (vencimento || dataCompra)
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

      const estoqueAnterior = normalizarInt(item.produto.estoque);
      const custoAnterior = normalizarDecimal(item.produto.custo);
      const quantidadeEntrada = normalizarInt(item.quantidade);
      const estoqueNovo = estoqueAnterior + quantidadeEntrada;

      let custoMedioNovo = item.custoUnitario;
      if (estoqueNovo > 0) {
        custoMedioNovo =
          ((estoqueAnterior * custoAnterior) + (quantidadeEntrada * item.custoUnitario)) / estoqueNovo;
      }

      await client.query(
        `UPDATE produtos
         SET estoque = $1,
             custo = $2,
             atualizado_em = NOW()
         WHERE id = $3 AND empresa = $4`,
        [estoqueNovo, custoMedioNovo, item.produto.id, empresa]
      );

      await client.query(
        `INSERT INTO movimentacoes_estoque
         (empresa, produto_id, tipo, quantidade, observacao, referencia_tipo, referencia_id, usuario_id, data_movimentacao)
         VALUES ($1, $2, 'entrada_compra', $3, $4, 'compra', $5, $6, NOW())`,
        [
          empresa,
          item.produto.id,
          quantidadeEntrada,
          `Entrada por compra #${compraId}`,
          compraId,
          req.user.id
        ]
      );
    }

    const fornecedor = fornecedorResult.rows[0];

    await client.query(
      `INSERT INTO lancamentos_financeiros
       (empresa, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, forma_pagamento, recorrente, frequencia, observacao, criado_por)
       VALUES ($1, 'custo', 'Compra de mercadoria', $2, $3, $4, $5, $6, FALSE, NULL, $7, $8)`,
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

    const result = await pool.query(
      `SELECT c.*,
              f.nome AS fornecedor_nome
       FROM compras c
       INNER JOIN fornecedores f ON f.id = c.fornecedor_id
       WHERE c.empresa = $1
       ORDER BY c.data DESC, c.id DESC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar compras");
  }
});

app.get("/compras/:empresa/:id", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const id = req.params.id;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const compraResult = await pool.query(
      `SELECT c.*,
              f.nome AS fornecedor_nome
       FROM compras c
       INNER JOIN fornecedores f ON f.id = c.fornecedor_id
       WHERE c.empresa = $1 AND c.id = $2`,
      [empresa, id]
    );

    if (compraResult.rowCount === 0) {
      return res.status(404).send("Compra não encontrada");
    }

    const itensResult = await pool.query(
      `SELECT * FROM compra_itens WHERE compra_id = $1 ORDER BY id ASC`,
      [id]
    );

    res.json({
      ...compraResult.rows[0],
      itens: itensResult.rows
    });
  } catch (error) {
    res.status(500).send("Erro ao buscar detalhes da compra");
  }
});

// ================= MOVIMENTAÇÕES DE ESTOQUE =================
app.get("/movimentacoes-estoque/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `SELECT m.*,
              p.nome AS produto_nome
       FROM movimentacoes_estoque m
       INNER JOIN produtos p ON p.id = m.produto_id
       WHERE m.empresa = $1
       ORDER BY m.data_movimentacao DESC, m.id DESC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar movimentações de estoque");
  }
});

app.post("/movimentacoes-estoque/ajuste", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!podeGerenciarCompras(req)) {
      return res.status(403).send("Sem permissão");
    }

    const { empresa, produto_id, tipo, quantidade, observacao } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const qtd = normalizarInt(quantidade);
    if (!empresa || !produto_id || qtd <= 0) {
      return res.status(400).send("Dados inválidos");
    }

    if (!["ajuste_entrada", "ajuste_saida", "perda", "avaria"].includes(tipo)) {
      return res.status(400).send("Tipo de ajuste inválido");
    }

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
    let novoEstoque = normalizarInt(produto.estoque);

    if (tipo === "ajuste_entrada") {
      novoEstoque += qtd;
    } else {
      if (novoEstoque < qtd) {
        await client.query("ROLLBACK");
        return res.status(400).send("Estoque insuficiente para o ajuste");
      }
      novoEstoque -= qtd;
    }

    await client.query(
      `UPDATE produtos
       SET estoque = $1, atualizado_em = NOW()
       WHERE id = $2 AND empresa = $3`,
      [novoEstoque, produto_id, empresa]
    );

    await client.query(
      `INSERT INTO movimentacoes_estoque
       (empresa, produto_id, tipo, quantidade, observacao, referencia_tipo, referencia_id, usuario_id, data_movimentacao)
       VALUES ($1, $2, $3, $4, $5, 'ajuste', NULL, $6, NOW())`,
      [empresa, produto_id, tipo, qtd, observacao || "", req.user.id]
    );

    await client.query("COMMIT");
    res.json({ sucesso: true });
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).send("Erro ao registrar ajuste de estoque");
  } finally {
    client.release();
  }
});

// ================= FINANCEIRO =================
app.get("/lancamentos-financeiros/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const result = await pool.query(
      `SELECT * FROM lancamentos_financeiros
       WHERE empresa = $1
       ORDER BY COALESCE(pagamento_data, vencimento, criado_em::text) DESC, id DESC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar lançamentos financeiros");
  }
});

app.post("/lancamentos-financeiros", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const {
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
      observacao
    } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!empresa || !tipo || !categoria || !descricao || !valor) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    const result = await pool.query(
      `INSERT INTO lancamentos_financeiros
       (empresa, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, forma_pagamento, recorrente, frequencia, observacao, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        empresa,
        tipo,
        categoria,
        descricao,
        normalizarDecimal(valor),
        vencimento || null,
        pagamento_data || null,
        status || "pendente",
        forma_pagamento || null,
        Boolean(recorrente),
        frequencia || null,
        observacao || null,
        req.user.id
      ]
    );

    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (error) {
    res.status(500).send("Erro ao cadastrar lançamento financeiro");
  }
});

app.put("/lancamentos-financeiros/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = req.params.id;
    const {
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
      observacao
    } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const atual = await pool.query(
      `SELECT * FROM lancamentos_financeiros WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    if (atual.rowCount === 0) {
      return res.status(404).send("Lançamento não encontrado");
    }

    await pool.query(
      `UPDATE lancamentos_financeiros
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
       WHERE id = $12 AND empresa = $13`,
      [
        tipo,
        categoria,
        descricao,
        normalizarDecimal(valor),
        vencimento || null,
        pagamento_data || null,
        status || "pendente",
        forma_pagamento || null,
        Boolean(recorrente),
        frequencia || null,
        observacao || null,
        id,
        empresa
      ]
    );

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao atualizar lançamento financeiro");
  }
});

app.delete("/lancamentos-financeiros/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = req.params.id;
    const empresa = req.query.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `DELETE FROM lancamentos_financeiros WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Lançamento não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir lançamento financeiro");
  }
});

// ================= INVESTIMENTOS =================
app.get("/investimentos/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const result = await pool.query(
      `SELECT * FROM investimentos WHERE empresa = $1 ORDER BY data DESC, id DESC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar investimentos");
  }
});

app.post("/investimentos", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const { empresa, tipo_investimento, descricao, valor, data, forma_pagamento, observacao } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!empresa || !tipo_investimento || !descricao || !valor || !data) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    const result = await pool.query(
      `INSERT INTO investimentos
       (empresa, tipo_investimento, descricao, valor, data, forma_pagamento, observacao, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        empresa,
        tipo_investimento,
        descricao,
        normalizarDecimal(valor),
        data,
        forma_pagamento || null,
        observacao || null,
        req.user.id
      ]
    );

    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (error) {
    res.status(500).send("Erro ao cadastrar investimento");
  }
});

app.put("/investimentos/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = req.params.id;
    const { empresa, tipo_investimento, descricao, valor, data, forma_pagamento, observacao } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `UPDATE investimentos
       SET tipo_investimento = $1,
           descricao = $2,
           valor = $3,
           data = $4,
           forma_pagamento = $5,
           observacao = $6,
           atualizado_em = NOW()
       WHERE id = $7 AND empresa = $8`,
      [
        tipo_investimento,
        descricao,
        normalizarDecimal(valor),
        data,
        forma_pagamento || null,
        observacao || null,
        id,
        empresa
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Investimento não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao atualizar investimento");
  }
});

app.delete("/investimentos/:id", auth, async (req, res) => {
  try {
    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const id = req.params.id;
    const empresa = req.query.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `DELETE FROM investimentos WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Investimento não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir investimento");
  }
});

// ================= DASHBOARD =================
app.get("/dashboard/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const [
      vendas,
      produtos,
      clientes,
      lancamentos,
      investimentos,
      alertas,
      fornecedores,
      comprasResumo,
      estoqueResumo
    ] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total),0) AS faturamento, COUNT(*) AS total_vendas FROM vendas WHERE empresa = $1`, [empresa]),
      pool.query(`SELECT COUNT(*) AS total_produtos FROM produtos WHERE empresa = $1`, [empresa]),
      pool.query(`SELECT COUNT(*) AS total_clientes FROM clientes WHERE empresa = $1`, [empresa]),
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN tipo = 'custo' AND status = 'pago' THEN valor ELSE 0 END),0) AS custos_pagos,
          COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status = 'pago' THEN valor ELSE 0 END),0) AS despesas_pagas,
          COALESCE(SUM(CASE WHEN status = 'pendente' THEN valor ELSE 0 END),0) AS pendentes_total
        FROM lancamentos_financeiros
        WHERE empresa = $1
      `, [empresa]),
      pool.query(`SELECT COALESCE(SUM(valor),0) AS total_investimentos FROM investimentos WHERE empresa = $1`, [empresa]),
      pool.query(`SELECT COUNT(*) AS produtos_alerta FROM produtos WHERE empresa = $1 AND estoque <= estoque_minimo`, [empresa]),
      pool.query(`SELECT COUNT(*) AS total_fornecedores FROM fornecedores WHERE empresa = $1`, [empresa]),
      pool.query(`SELECT COUNT(*) AS total_compras, COALESCE(SUM(total),0) AS valor_total_compras FROM compras WHERE empresa = $1`, [empresa]),
      pool.query(`SELECT COALESCE(SUM(estoque * custo),0) AS valor_estoque FROM produtos WHERE empresa = $1`, [empresa])
    ]);

    res.json({
      faturamento: Number(vendas.rows[0].faturamento || 0),
      total_vendas: Number(vendas.rows[0].total_vendas || 0),
      total_produtos: Number(produtos.rows[0].total_produtos || 0),
      total_clientes: Number(clientes.rows[0].total_clientes || 0),
      custos_pagos: Number(lancamentos.rows[0].custos_pagos || 0),
      despesas_pagas: Number(lancamentos.rows[0].despesas_pagas || 0),
      pendentes_total: Number(lancamentos.rows[0].pendentes_total || 0),
      total_investimentos: Number(investimentos.rows[0].total_investimentos || 0),
      produtos_alerta: Number(alertas.rows[0].produtos_alerta || 0),
      total_fornecedores: Number(fornecedores.rows[0].total_fornecedores || 0),
      total_compras: Number(comprasResumo.rows[0].total_compras || 0),
      valor_total_compras: Number(comprasResumo.rows[0].valor_total_compras || 0),
      valor_estoque: Number(estoqueResumo.rows[0].valor_estoque || 0)
    });
  } catch (error) {
    res.status(500).send("Erro ao carregar dashboard");
  }
});

// ================= RELATÓRIO GERENCIAL DE ESTOQUE =================
app.get("/relatorio-estoque/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const relatorio = await montarRelatorioEstoquePorEmpresa(empresa);
    res.json(relatorio);
  } catch (error) {
    res.status(500).send("Erro ao carregar relatório de estoque");
  }
});

// ================= RELATÓRIO DE PERFORMANCE =================
app.get("/relatorio-performance/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const relatorio = await montarRelatorioPerformancePorEmpresa(empresa);
    res.json(relatorio);
  } catch (error) {
    res.status(500).send("Erro ao carregar relatório de performance");
  }
});

// ================= DRE =================
app.get("/dre/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;
    const inicio = req.query.inicio || "2000-01-01";
    const fim = req.query.fim || "2999-12-31";

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const vendas = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS receita_bruta
       FROM vendas
       WHERE empresa = $1 AND data BETWEEN $2 AND $3`,
      [empresa, inicio, fim]
    );

    const lancamentos = await pool.query(
      `SELECT
          COALESCE(SUM(CASE WHEN tipo = 'custo' AND status = 'pago' AND COALESCE(pagamento_data, vencimento, criado_em::text) BETWEEN $2 AND $3 THEN valor ELSE 0 END),0) AS custos,
          COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status = 'pago' AND COALESCE(pagamento_data, vencimento, criado_em::text) BETWEEN $2 AND $3 THEN valor ELSE 0 END),0) AS despesas
       FROM lancamentos_financeiros
       WHERE empresa = $1`,
      [empresa, inicio, fim]
    );

    const receitaBruta = Number(vendas.rows[0].receita_bruta || 0);
    const deducoes = 0;
    const receitaLiquida = receitaBruta - deducoes;
    const custos = Number(lancamentos.rows[0].custos || 0);
    const lucroBruto = receitaLiquida - custos;
    const despesas = Number(lancamentos.rows[0].despesas || 0);
    const resultadoOperacional = lucroBruto - despesas;

    res.json({
      receita_bruta: receitaBruta,
      deducoes,
      receita_liquida: receitaLiquida,
      custos,
      lucro_bruto: lucroBruto,
      despesas,
      resultado_operacional: resultadoOperacional
    });
  } catch (error) {
    res.status(500).send("Erro ao carregar DRE");
  }
});

// ================= ROTAS ADMIN CONSOLIDADAS =================
app.get("/admin/empresas", auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT empresa FROM (
        SELECT DISTINCT empresa FROM usuarios WHERE empresa IS NOT NULL AND empresa <> ''
        UNION
        SELECT DISTINCT empresa FROM produtos WHERE empresa IS NOT NULL AND empresa <> ''
        UNION
        SELECT DISTINCT empresa FROM fornecedores WHERE empresa IS NOT NULL AND empresa <> ''
        UNION
        SELECT DISTINCT empresa FROM compras WHERE empresa IS NOT NULL AND empresa <> ''
        UNION
        SELECT DISTINCT empresa FROM clientes WHERE empresa IS NOT NULL AND empresa <> ''
      ) t
      ORDER BY empresa ASC
    `);

    res.json(result.rows.map((r) => r.empresa));
  } catch (error) {
    res.status(500).send("Erro ao buscar empresas");
  }
});

app.get("/admin/produtos", auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *,
              CASE WHEN estoque <= estoque_minimo THEN TRUE ELSE FALSE END AS alerta_estoque
       FROM produtos
       ORDER BY empresa ASC, nome ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar produtos do admin");
  }
});

app.get("/admin/fornecedores", auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM fornecedores ORDER BY empresa ASC, nome ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar fornecedores do admin");
  }
});

app.get("/admin/compras", auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*,
              f.nome AS fornecedor_nome
       FROM compras c
       INNER JOIN fornecedores f ON f.id = c.fornecedor_id
       ORDER BY c.data DESC, c.id DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar compras do admin");
  }
});

app.get("/admin/movimentacoes-estoque", auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*,
              p.nome AS produto_nome
       FROM movimentacoes_estoque m
       INNER JOIN produtos p ON p.id = m.produto_id
       ORDER BY m.data_movimentacao DESC, m.id DESC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar movimentações do admin");
  }
});

app.get("/admin/dashboard", auth, apenasAdmin, async (req, res) => {
  try {
    const [produtos, fornecedores, compras, alertas, estoqueResumo] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_produtos FROM produtos`),
      pool.query(`SELECT COUNT(*) AS total_fornecedores FROM fornecedores`),
      pool.query(`SELECT COUNT(*) AS total_compras, COALESCE(SUM(total),0) AS valor_total_compras FROM compras`),
      pool.query(`SELECT COUNT(*) AS produtos_alerta FROM produtos WHERE estoque <= estoque_minimo`),
      pool.query(`SELECT COALESCE(SUM(estoque * custo),0) AS valor_estoque FROM produtos`)
    ]);

    res.json({
      total_produtos: Number(produtos.rows[0].total_produtos || 0),
      total_fornecedores: Number(fornecedores.rows[0].total_fornecedores || 0),
      total_compras: Number(compras.rows[0].total_compras || 0),
      valor_total_compras: Number(compras.rows[0].valor_total_compras || 0),
      produtos_alerta: Number(alertas.rows[0].produtos_alerta || 0),
      valor_estoque: Number(estoqueResumo.rows[0].valor_estoque || 0)
    });
  } catch (error) {
    res.status(500).send("Erro ao carregar dashboard admin");
  }
});

app.get("/admin/relatorio-estoque", auth, apenasAdmin, async (req, res) => {
  try {
    const empresasResult = await pool.query(`
      SELECT empresa FROM (
        SELECT DISTINCT empresa FROM produtos WHERE empresa IS NOT NULL AND empresa <> ''
      ) t
      ORDER BY empresa ASC
    `);

    const empresas = empresasResult.rows.map((r) => r.empresa);
    const relatorios = [];

    for (const empresa of empresas) {
      const relatorio = await montarRelatorioEstoquePorEmpresa(empresa);
      relatorios.push({
        empresa,
        ...relatorio
      });
    }

    res.json(relatorios);
  } catch (error) {
    res.status(500).send("Erro ao carregar relatório consolidado de estoque");
  }
});

app.get("/admin/relatorio-performance", auth, apenasAdmin, async (req, res) => {
  try {
    const empresasResult = await pool.query(`
      SELECT empresa FROM (
        SELECT DISTINCT empresa FROM produtos WHERE empresa IS NOT NULL AND empresa <> ''
      ) t
      ORDER BY empresa ASC
    `);

    const empresas = empresasResult.rows.map((r) => r.empresa);
    const relatorios = [];

    for (const empresa of empresas) {
      const relatorio = await montarRelatorioPerformancePorEmpresa(empresa);
      relatorios.push({
        empresa,
        ...relatorio
      });
    }

    res.json(relatorios);
  } catch (error) {
    res.status(500).send("Erro ao carregar relatório consolidado de performance");
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`LF ERP backend online na porta ${PORT} 🚀`);
    });
  })
  .catch((error) => {
    console.error("Erro ao iniciar banco:", error);
    process.exit(1);
  });