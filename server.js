const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = "lf-erp-chave-super-secreta";
const PORT = process.env.PORT || 3001;

const db = new sqlite3.Database("./loja.db");

// ================= BANCO =================
db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      senha TEXT,
      tipo TEXT,
      empresa TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa TEXT,
      nome TEXT,
      preco REAL,
      estoque INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa TEXT,
      nome TEXT,
      endereco TEXT,
      telefone TEXT,
      nascimento TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa TEXT,
      produto TEXT,
      quantidade INTEGER,
      total REAL,
      cliente_nome TEXT,
      pagamento TEXT,
      data TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa TEXT,
      valor REAL
    )
  `);

  // ADMIN FIXO
  bcrypt.hash("Lfgl.1308.", 10, (err, hash) => {
    db.run(
      "INSERT OR IGNORE INTO usuarios (usuario, senha, tipo, empresa) VALUES (?, ?, ?, ?)",
      ["Lfelipeg", hash, "admin", null]
    );
  });

});

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("LF ERP online 🚀");
});

// ================= AUTH =================
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

// ================= VALIDAÇÃO DE LOJA =================
function validarEmpresa(req, empresa) {
  if (req.user.tipo === "admin") return true;
  return req.user.empresa === empresa;
}

// ================= LOGIN =================
app.post("/login", (req, res) => {
  const { usuario, senha } = req.body;

  db.get("SELECT * FROM usuarios WHERE usuario=?", [usuario], async (err, user) => {

    if (!user) return res.status(401).send("Usuário inválido");

    const ok = await bcrypt.compare(senha, user.senha);
    if (!ok) return res.status(401).send("Senha inválida");

    const token = jwt.sign({
      id: user.id,
      tipo: user.tipo,
      empresa: user.empresa
    }, SECRET);

    res.json({
      token,
      tipo: user.tipo,
      empresa: user.empresa
    });

  });
});

// ================= USUÁRIOS =================
app.post("/usuarios", auth, (req, res) => {

  if (req.user.tipo !== "admin")
    return res.status(403).send("Apenas admin");

  const { usuario, senha, tipo, empresa } = req.body;

  bcrypt.hash(senha, 10, (err, hash) => {
    db.run(
      "INSERT INTO usuarios (usuario, senha, tipo, empresa) VALUES (?, ?, ?, ?)",
      [usuario, hash, tipo, empresa],
      function (err) {
        if (err) return res.status(400).send("Erro ao criar usuário");
        res.json({ sucesso: true });
      }
    );
  });
});

// ================= PRODUTOS =================
app.get("/produtos/:empresa", auth, (req, res) => {

  if (!validarEmpresa(req, req.params.empresa))
    return res.status(403).send("Sem acesso");

  db.all(
    "SELECT * FROM produtos WHERE empresa=?",
    [req.params.empresa],
    (err, rows) => res.json(rows)
  );
});

// ================= CLIENTES =================
app.get("/clientes/:empresa", auth, (req, res) => {

  if (!validarEmpresa(req, req.params.empresa))
    return res.status(403).send("Sem acesso");

  db.all(
    "SELECT * FROM clientes WHERE empresa=? ORDER BY nome ASC",
    [req.params.empresa],
    (err, rows) => res.json(rows)
  );
});

// ================= DASHBOARD =================
app.get("/dashboard/:empresa", auth, (req, res) => {

  if (!validarEmpresa(req, req.params.empresa))
    return res.status(403).send("Sem acesso");

  const empresa = req.params.empresa;

  db.get("SELECT COUNT(*) as vendas FROM vendas WHERE empresa=?", [empresa], (err, v) => {
    db.get("SELECT SUM(total) as faturamento FROM vendas WHERE empresa=?", [empresa], (err, f) => {
      db.get("SELECT COUNT(*) as produtos FROM produtos WHERE empresa=?", [empresa], (err, p) => {

        res.json({
          totalVendas: v.vendas,
          faturamento: f.faturamento || 0,
          totalProdutos: p.produtos
        });

      });
    });
  });
});

// ================= SERVIDOR =================
app.listen(PORT, () => console.log("Servidor com controle por loja 🔐"));