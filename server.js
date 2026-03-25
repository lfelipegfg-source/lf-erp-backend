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

function normalizarDecimal(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function buildDateRangeClause(dateColumn, empresa, inicio, fim, extraClauses = "", statusParams = []) {
  const params = [empresa];
  let sql = ` WHERE empresa = $1 `;
  if (inicio) {
    params.push(inicio);
    sql += ` AND ${dateColumn} >= $${params.length} `;
  }
  if (fim) {
    params.push(fim);
    sql += ` AND ${dateColumn} <= $${params.length} `;
  }
  if (extraClauses) {
    sql += " " + extraClauses + " ";
    params.push(...statusParams);
  }
  return { sql, params };
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
      nascimento TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS produtos (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      nome TEXT NOT NULL,
      preco NUMERIC(12,2) NOT NULL DEFAULT 0,
      estoque INTEGER NOT NULL DEFAULT 0
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
      cpf TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendas (
      id SERIAL PRIMARY KEY,
      empresa TEXT NOT NULL,
      produto TEXT NOT NULL,
      quantidade INTEGER NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      cliente_nome TEXT,
      pagamento TEXT,
      data TEXT
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
    CREATE INDEX IF NOT EXISTS idx_produtos_empresa ON produtos (empresa);
    CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes (empresa);
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa ON vendas (empresa);
    CREATE INDEX IF NOT EXISTS idx_vendas_empresa_data ON vendas (empresa, data);
    CREATE INDEX IF NOT EXISTS idx_financeiro_empresa ON financeiro (empresa);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa ON lancamentos_financeiros (empresa);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_status ON lancamentos_financeiros (empresa, status);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_pagamento ON lancamentos_financeiros (empresa, pagamento_data);
    CREATE INDEX IF NOT EXISTS idx_lancamentos_empresa_vencimento ON lancamentos_financeiros (empresa, vencimento);
    CREATE INDEX IF NOT EXISTS idx_investimentos_empresa ON investimentos (empresa);
    CREATE INDEX IF NOT EXISTS idx_investimentos_empresa_data ON investimentos (empresa, data);
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
       SET senha = $1, tipo = $2, empresa = $3, nome_completo = COALESCE(nome_completo, $4)
       WHERE usuario = $5`,
      [hash, "admin", null, "Lfelipeg", "Lfelipeg"]
    );
  }
}

app.get("/", async (req, res) => {
  res.send("LF ERP online com PostgreSQL 🚀");
});

function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(403).send("Sem acesso");

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(403).send("Token inválido");
  }
}

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
       SET usuario = $1, senha = $2, tipo = $3, empresa = $4, nome_completo = $5, cpf = $6, nascimento = $7
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

app.post("/produtos", auth, async (req, res) => {
  try {
    const { empresa, nome, preco, estoque } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `INSERT INTO produtos (empresa, nome, preco, estoque)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [empresa, nome, preco, estoque]
    );

    res.json({ id: result.rows[0].id });
  } catch (error) {
    res.status(500).send("Erro ao cadastrar produto");
  }
});

app.get("/produtos/:empresa", auth, async (req, res) => {
  try {
    if (!validarEmpresa(req, req.params.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `SELECT * FROM produtos WHERE empresa = $1 ORDER BY nome ASC`,
      [req.params.empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar produtos");
  }
});

app.put("/produtos/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const { empresa, nome, preco, estoque } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `UPDATE produtos
       SET nome = $1, preco = $2, estoque = $3
       WHERE id = $4 AND empresa = $5`,
      [nome, preco, estoque, id, empresa]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Produto não encontrado");
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

app.post("/clientes", auth, async (req, res) => {
  try {
    const { empresa, nome, endereco, telefone, nascimento, cpf } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `INSERT INTO clientes (empresa, nome, endereco, telefone, nascimento, cpf)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [empresa, nome, endereco, telefone, nascimento, cpf || ""]
    );

    res.json({ id: result.rows[0].id });
  } catch (error) {
    res.status(500).send("Erro ao cadastrar cliente");
  }
});

app.get("/clientes/:empresa", auth, async (req, res) => {
  try {
    if (!validarEmpresa(req, req.params.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `SELECT * FROM clientes WHERE empresa = $1 ORDER BY nome ASC`,
      [req.params.empresa]
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
       SET nome = $1, endereco = $2, telefone = $3, nascimento = $4, cpf = $5
       WHERE id = $6 AND empresa = $7`,
      [nome, endereco, telefone, nascimento, cpf || "", id, empresa]
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

app.post("/vendas", auth, async (req, res) => {
  try {
    const { produto_id, quantidade, empresa, cliente_id, pagamento } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const produtoResult = await pool.query(
      `SELECT * FROM produtos WHERE id = $1 AND empresa = $2`,
      [produto_id, empresa]
    );

    if (produtoResult.rowCount === 0) {
      return res.status(404).send("Produto não encontrado");
    }

    const produto = produtoResult.rows[0];
    if (Number(produto.estoque) < Number(quantidade)) {
      return res.status(400).send("Estoque insuficiente");
    }

    let clienteNome = "Consumidor Final";

    if (cliente_id) {
      const clienteResult = await pool.query(
        `SELECT * FROM clientes WHERE id = $1 AND empresa = $2`,
        [cliente_id, empresa]
      );

      if (clienteResult.rowCount === 0) {
        return res.status(404).send("Cliente não encontrado");
      }

      clienteNome = clienteResult.rows[0].nome;
    }

    const total = Number(produto.preco) * Number(quantidade);
    const data = hoje();

    await pool.query(
      `UPDATE produtos SET estoque = estoque - $1 WHERE id = $2`,
      [quantidade, produto_id]
    );

    const vendaResult = await pool.query(
      `INSERT INTO vendas
      (empresa, produto, quantidade, total, cliente_nome, pagamento, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
      [empresa, produto.nome, quantidade, total, clienteNome, pagamento, data]
    );

    await pool.query(
      `INSERT INTO financeiro (empresa, valor) VALUES ($1, $2)`,
      [empresa, total]
    );

    res.json({ sucesso: true, id: vendaResult.rows[0].id });
  } catch (error) {
    res.status(500).send("Erro ao registrar venda");
  }
});

app.get("/vendas/:empresa", auth, async (req, res) => {
  try {
    if (!validarEmpresa(req, req.params.empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const result = await pool.query(
      `SELECT * FROM vendas WHERE empresa = $1 ORDER BY id DESC`,
      [req.params.empresa]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).send("Erro ao buscar vendas");
  }
});

app.put("/vendas/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const { empresa, produto, quantidade, total, cliente_nome, pagamento, data } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const vendaResult = await pool.query(
      `SELECT * FROM vendas WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    if (vendaResult.rowCount === 0) {
      return res.status(404).send("Venda não encontrada");
    }

    const venda = vendaResult.rows[0];

    await pool.query(
      `UPDATE vendas
       SET produto = $1, quantidade = $2, total = $3, cliente_nome = $4, pagamento = $5, data = $6
       WHERE id = $7 AND empresa = $8`,
      [produto, quantidade, total, cliente_nome, pagamento, data, id, empresa]
    );

    const diferenca = Number(total) - Number(venda.total || 0);

    if (diferenca !== 0) {
      await pool.query(
        `INSERT INTO financeiro (empresa, valor) VALUES ($1, $2)`,
        [empresa, diferenca]
      );
    }

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao atualizar venda");
  }
});

app.delete("/vendas/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const empresa = req.query.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const vendaResult = await pool.query(
      `SELECT * FROM vendas WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    if (vendaResult.rowCount === 0) {
      return res.status(404).send("Venda não encontrada");
    }

    const venda = vendaResult.rows[0];

    await pool.query(
      `DELETE FROM vendas WHERE id = $1 AND empresa = $2`,
      [id, empresa]
    );

    await pool.query(
      `INSERT INTO financeiro (empresa, valor) VALUES ($1, $2)`,
      [empresa, -Number(venda.total || 0)]
    );

    res.json({ sucesso: true });
  } catch (error) {
    res.status(500).send("Erro ao excluir venda");
  }
});

app.get("/financeiro/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const saldoHistorico = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total FROM financeiro WHERE empresa = $1`,
      [empresa]
    );

    const recebimentos = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM vendas WHERE empresa = $1`,
      [empresa]
    );

    const custosPagos = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM lancamentos_financeiros
       WHERE empresa = $1 AND tipo = 'custo' AND status = 'pago'`,
      [empresa]
    );

    const despesasPagas = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM lancamentos_financeiros
       WHERE empresa = $1 AND tipo = 'despesa' AND status = 'pago'`,
      [empresa]
    );

    const investimentos = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total FROM investimentos WHERE empresa = $1`,
      [empresa]
    );

    const totalRecebido = Number(recebimentos.rows[0].total || 0);
    const totalCustos = Number(custosPagos.rows[0].total || 0);
    const totalDespesas = Number(despesasPagas.rows[0].total || 0);
    const totalInvestimentos = Number(investimentos.rows[0].total || 0);
    const saldoGerencial = totalRecebido - totalCustos - totalDespesas - totalInvestimentos;

    res.json({
      entrada: Number(saldoHistorico.rows[0].total || 0),
      receitas: totalRecebido,
      custos: totalCustos,
      despesas: totalDespesas,
      investimentos: totalInvestimentos,
      saldoGerencial
    });
  } catch (error) {
    res.status(500).send("Erro ao buscar financeiro");
  }
});

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
      `SELECT *
       FROM lancamentos_financeiros
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

    if (!["custo", "despesa"].includes(tipo)) {
      return res.status(400).send("Tipo inválido");
    }

    if (!["pendente", "pago"].includes(status || "pendente")) {
      return res.status(400).send("Status inválido");
    }

    const result = await pool.query(
      `INSERT INTO lancamentos_financeiros
      (empresa, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, forma_pagamento, recorrente, frequencia, observacao, criado_por, atualizado_em)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
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
    const { empresa, tipo, categoria, descricao, valor, vencimento, pagamento_data, status, forma_pagamento, recorrente, frequencia, observacao } = req.body;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const atual = await pool.query(`SELECT * FROM lancamentos_financeiros WHERE id = $1 AND empresa = $2`, [id, empresa]);
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
      (empresa, tipo_investimento, descricao, valor, data, forma_pagamento, observacao, criado_por, atualizado_em)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
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

    const atual = await pool.query(`SELECT * FROM investimentos WHERE id = $1 AND empresa = $2`, [id, empresa]);
    if (atual.rowCount === 0) {
      return res.status(404).send("Investimento não encontrado");
    }

    await pool.query(
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

app.get("/dre/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    if (!podeGerenciarFinanceiro(req)) {
      return res.status(403).send("Sem permissão");
    }

    const { inicio, fim } = req.query;
    const temPeriodo = Boolean(inicio && fim);

    const paramsVendas = [empresa];
    let filtroVendas = ` WHERE empresa = $1 `;

    if (temPeriodo) {
      paramsVendas.push(inicio, fim);
      filtroVendas += ` AND data >= $2 AND data <= $3 `;
    }

    const paramsLanc = [empresa];
    let filtroLanc = ` WHERE empresa = $1 `;

    if (temPeriodo) {
      paramsLanc.push(inicio, fim);
      filtroLanc += ` AND COALESCE(pagamento_data, vencimento, criado_em::date::text) >= $2 AND COALESCE(pagamento_data, vencimento, criado_em::date::text) <= $3 `;
    }

    const paramsInvest = [empresa];
    let filtroInvest = ` WHERE empresa = $1 `;

    if (temPeriodo) {
      paramsInvest.push(inicio, fim);
      filtroInvest += ` AND data >= $2 AND data <= $3 `;
    }

    const vendas = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM vendas ${filtroVendas}`,
      paramsVendas
    );

    const custos = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM lancamentos_financeiros
       ${filtroLanc} AND tipo = 'custo' AND status = 'pago'`,
      paramsLanc
    );

    const despesas = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM lancamentos_financeiros
       ${filtroLanc} AND tipo = 'despesa' AND status = 'pago'`,
      paramsLanc
    );

    const investimentos = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total FROM investimentos ${filtroInvest}`,
      paramsInvest
    );

    const pendentes = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM lancamentos_financeiros
       ${filtroLanc} AND status = 'pendente'`,
      paramsLanc
    );

    const receitaBruta = Number(vendas.rows[0].total || 0);
    const deducoes = 0;
    const receitaLiquida = receitaBruta - deducoes;
    const totalCustos = Number(custos.rows[0].total || 0);
    const lucroBruto = receitaLiquida - totalCustos;
    const despesasOperacionais = Number(despesas.rows[0].total || 0);
    const resultadoOperacional = lucroBruto - despesasOperacionais;
    const totalInvestimentos = Number(investimentos.rows[0].total || 0);
    const impactoFinalCaixa = resultadoOperacional - totalInvestimentos;
    const totalPendente = Number(pendentes.rows[0].total || 0);

    res.json({
      receitaBruta,
      deducoes,
      receitaLiquida,
      custos: totalCustos,
      lucroBruto,
      despesasOperacionais,
      resultadoOperacional,
      investimentos: totalInvestimentos,
      impactoFinalCaixa,
      pendente: totalPendente
    });
  } catch (error) {
    res.status(500).send("Erro ao calcular DRE");
  }
});

app.get("/dashboard/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const { inicio, fim } = req.query;
    const paramsVendas = [empresa];
    let filtroVendas = ` WHERE empresa = $1 `;

    if (inicio) {
      paramsVendas.push(inicio);
      filtroVendas += ` AND data >= $${paramsVendas.length} `;
    }

    if (fim) {
      paramsVendas.push(fim);
      filtroVendas += ` AND data <= $${paramsVendas.length} `;
    }

    const vendas = await pool.query(
      `SELECT COUNT(*) AS total FROM vendas ${filtroVendas}`,
      paramsVendas
    );

    const faturamento = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total FROM vendas ${filtroVendas}`,
      paramsVendas
    );

    const produtos = await pool.query(
      `SELECT COUNT(*) AS total FROM produtos WHERE empresa = $1`,
      [empresa]
    );

    const clientes = await pool.query(
      `SELECT COUNT(*) AS total FROM clientes WHERE empresa = $1`,
      [empresa]
    );

    const paramsFinanceiro = [empresa];
    let filtroFinanceiro = ` WHERE empresa = $1 `;

    if (inicio) {
      paramsFinanceiro.push(inicio);
      filtroFinanceiro += ` AND COALESCE(pagamento_data, vencimento, criado_em::date::text) >= $${paramsFinanceiro.length} `;
    }

    if (fim) {
      paramsFinanceiro.push(fim);
      filtroFinanceiro += ` AND COALESCE(pagamento_data, vencimento, criado_em::date::text) <= $${paramsFinanceiro.length} `;
    }

    const custos = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM lancamentos_financeiros
       ${filtroFinanceiro} AND tipo = 'custo' AND status = 'pago'`,
      paramsFinanceiro
    );

    const despesas = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total
       FROM lancamentos_financeiros
       ${filtroFinanceiro} AND tipo = 'despesa' AND status = 'pago'`,
      paramsFinanceiro
    );

    const paramsInvest = [empresa];
    let filtroInvest = ` WHERE empresa = $1 `;

    if (inicio) {
      paramsInvest.push(inicio);
      filtroInvest += ` AND data >= $${paramsInvest.length} `;
    }

    if (fim) {
      paramsInvest.push(fim);
      filtroInvest += ` AND data <= $${paramsInvest.length} `;
    }

    const investimentos = await pool.query(
      `SELECT COALESCE(SUM(valor), 0) AS total FROM investimentos ${filtroInvest}`,
      paramsInvest
    );

    res.json({
      totalVendas: Number(vendas.rows[0].total || 0),
      faturamento: Number(faturamento.rows[0].total || 0),
      totalProdutos: Number(produtos.rows[0].total || 0),
      totalClientes: Number(clientes.rows[0].total || 0),
      custos: Number(custos.rows[0].total || 0),
      despesas: Number(despesas.rows[0].total || 0),
      investimentos: Number(investimentos.rows[0].total || 0)
    });
  } catch (error) {
    res.status(500).send("Erro no dashboard");
  }
});

app.get("/dashboard-graficos/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    if (!validarEmpresa(req, empresa)) {
      return res.status(403).send("Sem acesso");
    }

    const { inicio, fim } = req.query;
    const params = [empresa];
    let filtro = ` WHERE empresa = $1 `;

    if (inicio) {
      params.push(inicio);
      filtro += ` AND data >= $${params.length} `;
    }

    if (fim) {
      params.push(fim);
      filtro += ` AND data <= $${params.length} `;
    }

    const vendasPorDia = await pool.query(
      `SELECT data, COALESCE(SUM(total), 0) AS total
       FROM vendas
       ${filtro}
       GROUP BY data
       ORDER BY data ASC`,
      params
    );

    const paramsFinanceiro = [empresa];
    let filtroFinanceiro = ` WHERE empresa = $1 `;

    if (inicio) {
      paramsFinanceiro.push(inicio);
      filtroFinanceiro += ` AND COALESCE(pagamento_data, vencimento, criado_em::date::text) >= $${paramsFinanceiro.length} `;
    }

    if (fim) {
      paramsFinanceiro.push(fim);
      filtroFinanceiro += ` AND COALESCE(pagamento_data, vencimento, criado_em::date::text) <= $${paramsFinanceiro.length} `;
    }

    const resumoFinanceiro = await pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN tipo = 'custo' AND status = 'pago' THEN valor ELSE 0 END), 0) AS custos,
        COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status = 'pago' THEN valor ELSE 0 END), 0) AS despesas
       FROM lancamentos_financeiros
       ${filtroFinanceiro}`,
      paramsFinanceiro
    );

    res.json({
      vendasPorDia: vendasPorDia.rows.map(item => ({
        data: item.data,
        total: Number(item.total || 0)
      })),
      resumo: {
        receitas: Number((await pool.query(`SELECT COALESCE(SUM(total), 0) AS total FROM vendas ${filtro}`, params)).rows[0].total || 0),
        custos: Number(resumoFinanceiro.rows[0].custos || 0),
        despesas: Number(resumoFinanceiro.rows[0].despesas || 0)
      }
    });
  } catch (error) {
    res.status(500).send("Erro ao gerar gráficos do dashboard");
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Servidor com PostgreSQL e financeiro gerencial completo 🔐");
    });
  })
  .catch((err) => {
    console.error("Erro ao iniciar banco:", err);
    process.exit(1);
  });