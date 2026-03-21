const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

const SECRET = "lf-erp-chave-super-secreta";

// ================= PORTA (IMPORTANTE PRO RENDER) =================
const PORT = process.env.PORT || 3001;

// ================= BANCO =================
const db = new sqlite3.Database("./loja.db");

db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      senha TEXT,
      tipo TEXT
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
    CREATE TABLE IF NOT EXISTS vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa TEXT,
      produto TEXT,
      quantidade INTEGER,
      total REAL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa TEXT,
      tipo TEXT,
      valor REAL
    )
  `);

  // ADMIN padrão seguro
  bcrypt.hash("1234", 10, (err, hash) => {
    db.run(
      "INSERT OR IGNORE INTO usuarios (usuario, senha, tipo) VALUES (?, ?, ?)",
      ["admin", hash, "admin"]
    );
  });

});

// ================= ROTA TESTE =================
app.get("/", (req, res) => {
  res.send("LF ERP backend online 🚀");
});

// ================= MIDDLEWARE =================
function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) return res.status(403).send("Acesso negado");

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(403).send("Token inválido");
  }
}

// ================= LOGIN =================
app.post("/login", (req, res) => {
  const { usuario, senha } = req.body;

  db.get("SELECT * FROM usuarios WHERE usuario=?", [usuario], async (err, user) => {

    if (!user) return res.status(401).send("Usuário não encontrado");

    const ok = await bcrypt.compare(senha, user.senha);
    if (!ok) return res.status(401).send("Senha incorreta");

    const token = jwt.sign(
      { id: user.id, tipo: user.tipo },
      SECRET,
      { expiresIn: "8h" }
    );

    res.json({ token, tipo: user.tipo });
  });
});

// ================= USUÁRIOS =================
app.post("/usuarios", auth, (req, res) => {

  if (req.user.tipo !== "admin")
    return res.status(403).send("Apenas admin");

  const { usuario, senha, tipo } = req.body;

  bcrypt.hash(senha, 10, (err, hash) => {
    db.run(
      "INSERT INTO usuarios (usuario, senha, tipo) VALUES (?, ?, ?)",
      [usuario, hash, tipo],
      function (err) {
        if (err) return res.status(400).send("Usuário já existe");
        res.json({ sucesso: true });
      }
    );
  });
});

// ================= PRODUTOS =================
app.post("/produtos", auth, (req, res) => {
  const { empresa, nome, preco, estoque } = req.body;

  db.run(
    "INSERT INTO produtos (empresa, nome, preco, estoque) VALUES (?, ?, ?, ?)",
    [empresa, nome, preco, estoque],
    function () {
      res.json({ id: this.lastID });
    }
  );
});

app.get("/produtos/:empresa", auth, (req, res) => {
  db.all(
    "SELECT * FROM produtos WHERE empresa=?",
    [req.params.empresa],
    (err, rows) => res.json(rows)
  );
});

// ================= VENDAS =================
app.post("/vendas", auth, (req, res) => {
  const { produto_id, quantidade, empresa } = req.body;

  db.get(
    "SELECT * FROM produtos WHERE id=? AND empresa=?",
    [produto_id, empresa],
    (err, produto) => {

      if (!produto) return res.status(404).send("Produto não encontrado");
      if (produto.estoque < quantidade)
        return res.status(400).send("Estoque insuficiente");

      const total = produto.preco * quantidade;

      db.run(
        "UPDATE produtos SET estoque = estoque - ? WHERE id=?",
        [quantidade, produto_id]
      );

      db.run(
        "INSERT INTO vendas (empresa, produto, quantidade, total) VALUES (?, ?, ?, ?)",
        [empresa, produto.nome, quantidade, total]
      );

      db.run(
        "INSERT INTO financeiro (empresa, tipo, valor) VALUES (?, 'entrada', ?)",
        [empresa, total]
      );

      res.json({ sucesso: true });
    }
  );
});

app.get("/vendas/:empresa", auth, (req, res) => {
  db.all(
    "SELECT * FROM vendas WHERE empresa=?",
    [req.params.empresa],
    (err, rows) => res.json(rows)
  );
});

// ================= FINANCEIRO =================
app.get("/financeiro/:empresa", auth, (req, res) => {
  db.get(
    "SELECT SUM(valor) as total FROM financeiro WHERE empresa=?",
    [req.params.empresa],
    (err, row) => res.json({ entrada: row.total || 0 })
  );
});

// ================= DASHBOARD =================
app.get("/dashboard/:empresa", auth, (req, res) => {
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
app.listen(PORT, () => console.log("🔥 Backend rodando na porta " + PORT));