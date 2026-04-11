const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================= UTIL ================= */

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function normalizarInt(v) {
  return parseInt(v || 0);
}

function normalizarDecimal(v) {
  return Number(v || 0);
}

function normalizarDataISO(v) {
  if (!v) return null;
  return new Date(v).toISOString().slice(0, 10);
}

/* ================= AUTH ================= */

function gerarToken(usuario) {
  return jwt.sign(usuario, process.env.JWT_SECRET || "segredo", {
    expiresIn: "7d"
  });
}

function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send("Sem token");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "segredo");
    req.user = decoded;
    next();
  } catch {
    return res.status(401).send("Token inválido");
  }
}

function apenasAdmin(req, res, next) {
  if (req.user.tipo !== "admin") {
    return res.status(403).send("Sem permissão");
  }
  next();
}

/* ================= INIT DB ================= */

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      usuario TEXT UNIQUE,
      senha TEXT,
      nome TEXT,
      tipo TEXT,
      empresa TEXT,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS produtos (
      id SERIAL PRIMARY KEY,
      empresa TEXT,
      nome TEXT,
      preco NUMERIC,
      custo NUMERIC,
      estoque INTEGER DEFAULT 0,
      estoque_minimo INTEGER DEFAULT 0,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      empresa TEXT,
      nome TEXT,
      telefone TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fornecedores (
      id SERIAL PRIMARY KEY,
      empresa TEXT,
      nome TEXT,
      telefone TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  /* ===== LIMPEZA TOTAL ===== */

  await pool.query(`DELETE FROM usuarios WHERE tipo <> 'admin'`);

  await pool.query(`
    DELETE FROM clientes;
    DELETE FROM fornecedores;
    DELETE FROM produtos;
  `);

  /* ===== ADMIN MASTER ===== */

  const senhaHash = await bcrypt.hash(
    process.env.DEFAULT_ADMIN_PASSWORD || "admin123",
    10
  );

  const usuario = process.env.DEFAULT_ADMIN_USER || "admin";
  const nome = process.env.DEFAULT_ADMIN_NAME || "Administrador Master";

  const existe = await pool.query(
    `SELECT * FROM usuarios WHERE tipo = 'admin' LIMIT 1`
  );

  if (existe.rowCount === 0) {
    await pool.query(
      `INSERT INTO usuarios (usuario, senha, nome, tipo)
       VALUES ($1,$2,$3,'admin')`,
      [usuario, senhaHash, nome]
    );
  } else {
    await pool.query(
      `UPDATE usuarios
       SET usuario = $1,
           senha = $2,
           nome = $3,
           empresa = NULL
       WHERE tipo = 'admin'`,
      [usuario, senhaHash, nome]
    );
  }
}

/* ================= LOGIN ================= */

app.post("/login", async (req, res) => {
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

  const token = gerarToken({
    id: user.id,
    tipo: user.tipo,
    nome: user.nome,
    empresa: user.empresa
  });

  res.json({
    token,
    usuario: {
      nome: user.nome,
      tipo: user.tipo,
      empresa: user.empresa
    }
  });
});
/* ================= USUÁRIOS ================= */

app.get("/usuarios", auth, apenasAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, usuario, nome, tipo, empresa, criado_em, atualizado_em
       FROM usuarios
       ORDER BY id ASC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao listar usuários");
  }
});

/* ================= PRODUTOS ================= */

app.get("/produtos/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    const result = await pool.query(
      `SELECT *
       FROM produtos
       WHERE empresa = $1
       ORDER BY nome ASC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao listar produtos");
  }
});

app.post("/produtos", auth, async (req, res) => {
  try {
    const {
      empresa,
      nome,
      preco,
      custo,
      estoque,
      estoque_minimo
    } = req.body;

    if (!empresa || !nome) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    const result = await pool.query(
      `INSERT INTO produtos
       (empresa, nome, preco, custo, estoque, estoque_minimo, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       RETURNING *`,
      [
        empresa,
        nome,
        normalizarDecimal(preco),
        normalizarDecimal(custo),
        normalizarInt(estoque),
        normalizarInt(estoque_minimo)
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao cadastrar produto");
  }
});

app.put("/produtos/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      nome,
      preco,
      custo,
      estoque_minimo
    } = req.body;

    const atual = await pool.query(
      `SELECT * FROM produtos WHERE id = $1`,
      [id]
    );

    if (atual.rowCount === 0) {
      return res.status(404).send("Produto não encontrado");
    }

    const produto = atual.rows[0];

    const result = await pool.query(
      `UPDATE produtos
       SET nome = $1,
           preco = $2,
           custo = $3,
           estoque_minimo = $4,
           atualizado_em = NOW()
       WHERE id = $5
       RETURNING *`,
      [
        nome || produto.nome,
        preco !== undefined ? normalizarDecimal(preco) : normalizarDecimal(produto.preco),
        custo !== undefined ? normalizarDecimal(custo) : normalizarDecimal(produto.custo),
        estoque_minimo !== undefined ? normalizarInt(estoque_minimo) : normalizarInt(produto.estoque_minimo),
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao atualizar produto");
  }
});

app.delete("/produtos/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(
      `DELETE FROM produtos WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Produto não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao excluir produto");
  }
});

/* ================= CLIENTES ================= */

app.get("/clientes/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    const result = await pool.query(
      `SELECT *
       FROM clientes
       WHERE empresa = $1
       ORDER BY nome ASC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao listar clientes");
  }
});

app.post("/clientes", auth, async (req, res) => {
  try {
    const { empresa, nome, telefone } = req.body;

    if (!empresa || !nome) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    const result = await pool.query(
      `INSERT INTO clientes
       (empresa, nome, telefone)
       VALUES ($1,$2,$3)
       RETURNING *`,
      [empresa, nome, telefone || ""]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao cadastrar cliente");
  }
});

app.put("/clientes/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nome, telefone } = req.body;

    const atual = await pool.query(
      `SELECT * FROM clientes WHERE id = $1`,
      [id]
    );

    if (atual.rowCount === 0) {
      return res.status(404).send("Cliente não encontrado");
    }

    const cliente = atual.rows[0];

    const result = await pool.query(
      `UPDATE clientes
       SET nome = $1,
           telefone = $2
       WHERE id = $3
       RETURNING *`,
      [
        nome || cliente.nome,
        telefone !== undefined ? telefone : cliente.telefone,
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao atualizar cliente");
  }
});

app.delete("/clientes/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(
      `DELETE FROM clientes WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Cliente não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao excluir cliente");
  }
});

/* ================= FORNECEDORES ================= */

app.get("/fornecedores/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    const result = await pool.query(
      `SELECT *
       FROM fornecedores
       WHERE empresa = $1
       ORDER BY nome ASC`,
      [empresa]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao listar fornecedores");
  }
});

app.post("/fornecedores", auth, async (req, res) => {
  try {
    const { empresa, nome, telefone } = req.body;

    if (!empresa || !nome) {
      return res.status(400).send("Preencha os campos obrigatórios");
    }

    const result = await pool.query(
      `INSERT INTO fornecedores
       (empresa, nome, telefone)
       VALUES ($1,$2,$3)
       RETURNING *`,
      [empresa, nome, telefone || ""]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao cadastrar fornecedor");
  }
});

app.put("/fornecedores/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nome, telefone } = req.body;

    const atual = await pool.query(
      `SELECT * FROM fornecedores WHERE id = $1`,
      [id]
    );

    if (atual.rowCount === 0) {
      return res.status(404).send("Fornecedor não encontrado");
    }

    const fornecedor = atual.rows[0];

    const result = await pool.query(
      `UPDATE fornecedores
       SET nome = $1,
           telefone = $2
       WHERE id = $3
       RETURNING *`,
      [
        nome || fornecedor.nome,
        telefone !== undefined ? telefone : fornecedor.telefone,
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao atualizar fornecedor");
  }
});

app.delete("/fornecedores/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(
      `DELETE FROM fornecedores WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Fornecedor não encontrado");
    }

    res.json({ sucesso: true });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao excluir fornecedor");
  }
});

/* ================= DASHBOARD LIMPO ================= */

app.get("/dashboard/:empresa", auth, async (req, res) => {
  try {
    const empresa = req.params.empresa;

    const [produtos, clientes, fornecedores] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM produtos WHERE empresa = $1`, [empresa]),
      pool.query(`SELECT COUNT(*)::int AS total FROM clientes WHERE empresa = $1`, [empresa]),
      pool.query(`SELECT COUNT(*)::int AS total FROM fornecedores WHERE empresa = $1`, [empresa])
    ]);

    res.json({
      total_produtos: produtos.rows[0]?.total || 0,
      total_clientes: clientes.rows[0]?.total || 0,
      total_fornecedores: fornecedores.rows[0]?.total || 0,
      estoque_baixo: 0,
      valor_estoque: 0,
      total_compras: 0,
      total_vendas: 0,
      faturamento: 0,
      lucro_estimado: 0,
      ticket_medio: 0,
      receber_pendente: 0,
      pagar_pendente: 0,
      contas_atrasadas: 0,
      ultimas_movimentacoes: [],
      produtos_alerta: []
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Erro ao carregar dashboard");
  }
});

/* ================= ROOT ================= */

app.get("/", (req, res) => {
  res.send("LF ERP backend limpo online 🚀");
});

/* ================= START ================= */

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Erro ao iniciar o backend:", error);
    process.exit(1);
  });