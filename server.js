const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = "lf_erp_secret";

// 🔗 PostgreSQL (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================= AUTH =================
function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(403).send("Sem token");

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
    return res.status(403).send("Apenas admin");
  }
  next();
}

// ================= LOGIN =================
app.post("/login", async (req, res) => {
  const { usuario, senha } = req.body;

  const result = await pool.query(
    "SELECT * FROM usuarios WHERE usuario=$1",
    [usuario]
  );

  if (!result.rows.length) return res.status(400).send("Usuário não encontrado");

  const user = result.rows[0];
  const valid = await bcrypt.compare(senha, user.senha);

  if (!valid) return res.status(400).send("Senha inválida");

  const token = jwt.sign({
    id: user.id,
    tipo: user.tipo,
    empresa: user.empresa,
    nome: user.nome
  }, SECRET);

  res.json({
    token,
    tipo: user.tipo,
    empresa: user.empresa,
    usuario: user.usuario,
    nome_completo: user.nome
  });
});

// ================= PRODUTOS =================
app.post("/produtos", auth, async (req, res) => {
  const { nome, preco, custo, estoque_minimo } = req.body;

  if (!nome) return res.status(400).send("Nome obrigatório");

  const result = await pool.query(
    `INSERT INTO produtos (empresa, nome, preco, custo, estoque, estoque_minimo)
     VALUES ($1,$2,$3,$4,0,$5) RETURNING *`,
    [req.user.empresa, nome, preco || 0, custo || 0, estoque_minimo || 0]
  );

  res.json(result.rows[0]);
});

app.get("/produtos/:empresa", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM produtos WHERE empresa=$1 ORDER BY id DESC",
    [req.params.empresa]
  );

  res.json(result.rows);
});

// ================= ADMIN PRODUTOS =================
app.get("/admin/produtos", auth, apenasAdmin, async (req, res) => {
  const result = await pool.query("SELECT * FROM produtos");
  res.json(result.rows);
});

// ================= FORNECEDORES =================
app.post("/fornecedores", auth, async (req, res) => {
  const { nome, telefone } = req.body;

  if (!nome) return res.status(400).send("Preencha os campos obrigatórios");

  const result = await pool.query(
    `INSERT INTO fornecedores (empresa,nome,telefone)
     VALUES ($1,$2,$3) RETURNING *`,
    [req.user.empresa, nome, telefone]
  );

  res.json(result.rows[0]);
});

app.get("/fornecedores/:empresa", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM fornecedores WHERE empresa=$1",
    [req.params.empresa]
  );

  res.json(result.rows);
});

// ================= COMPRAS =================
app.post("/compras", auth, async (req, res) => {
  const { fornecedor_id, itens } = req.body;

  let total = 0;
  itens.forEach(i => total += i.quantidade * i.custo_unitario);

  const compra = await pool.query(
    `INSERT INTO compras (empresa, fornecedor_id, total)
     VALUES ($1,$2,$3) RETURNING *`,
    [req.user.empresa, fornecedor_id, total]
  );

  for (let item of itens) {
    await pool.query(
      `UPDATE produtos SET estoque = estoque + $1 WHERE id=$2`,
      [item.quantidade, item.produto_id]
    );
  }

  res.json(compra.rows[0]);
});

app.get("/compras/:empresa", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT c.*, f.nome AS fornecedor_nome
     FROM compras c
     LEFT JOIN fornecedores f ON f.id=c.fornecedor_id
     WHERE c.empresa=$1`,
    [req.params.empresa]
  );

  res.json(result.rows);
});

// ================= START =================
app.get("/", (req, res) => {
  res.send("LF ERP online com PostgreSQL 🚀");
});

app.listen(3000, () => console.log("Servidor rodando"));