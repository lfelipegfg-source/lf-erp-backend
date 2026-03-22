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

// ================= HELPERS =================
function hoje() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function agora() {
  return new Date().toISOString().slice(0, 19).replace("T", " "); // YYYY-MM-DD HH:mm:ss
}

function ensureColumn(table, column, definition) {
  db.all(`PRAGMA table_info(${table})`, (err, columns) => {
    if (err) {
      console.error(`Erro ao verificar colunas da tabela ${table}:`, err.message);
      return;
    }

    const exists = columns.some(col => col.name === column);
    if (!exists) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, alterErr => {
        if (alterErr) {
          console.error(`Erro ao adicionar coluna ${column} em ${table}:`, alterErr.message);
        } else {
          console.log(`Coluna ${column} adicionada em ${table}`);
        }
      });
    }
  });
}

// ================= BANCO =================
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

  // Migrações automáticas para manter banco já existente
  ensureColumn("vendas", "produto_id", "INTEGER");
  ensureColumn("vendas", "cliente_id", "INTEGER");
  ensureColumn("vendas", "cliente_nome", "TEXT");
  ensureColumn("vendas", "pagamento", "TEXT");
  ensureColumn("vendas", "data_venda", "TEXT");
  ensureColumn("vendas", "data_hora", "TEXT");

  ensureColumn("financeiro", "descricao", "TEXT");
  ensureColumn("financeiro", "data_movimento", "TEXT");
  ensureColumn("financeiro", "pagamento", "TEXT");

  // Admin padrão
  bcrypt.hash("1234", 10, (err, hash) => {
    if (err) {
      console.error("Erro ao gerar hash do admin:", err.message);
      return;
    }

    db.run(
      "INSERT OR IGNORE INTO usuarios (usuario, senha, tipo) VALUES (?, ?, ?)",
      ["admin", hash, "admin"]
    );
  });
});

// ================= ROTA RAIZ =================
app.get("/", (req, res) => {
  res.send("LF ERP backend online 🚀");
});

// ================= AUTH =================
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

  db.get("SELECT * FROM usuarios WHERE usuario = ?", [usuario], async (err, user) => {
    if (err) return res.status(500).send("Erro no servidor");
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
  if (req.user.tipo !== "admin") {
    return res.status(403).send("Apenas admin");
  }

  const { usuario, senha, tipo } = req.body;

  bcrypt.hash(senha, 10, (err, hash) => {
    if (err) return res.status(500).send("Erro ao criptografar senha");

    db.run(
      "INSERT INTO usuarios (usuario, senha, tipo) VALUES (?, ?, ?)",
      [usuario, hash, tipo],
      function (insertErr) {
        if (insertErr) return res.status(400).send("Usuário já existe");
        res.json({ sucesso: true, id: this.lastID });
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
    function (err) {
      if (err) return res.status(500).send("Erro ao cadastrar produto");
      res.json({ id: this.lastID });
    }
  );
});

app.get("/produtos/:empresa", auth, (req, res) => {
  db.all(
    "SELECT * FROM produtos WHERE empresa = ? ORDER BY nome COLLATE NOCASE ASC",
    [req.params.empresa],
    (err, rows) => {
      if (err) return res.status(500).send("Erro ao buscar produtos");
      res.json(rows);
    }
  );
});

// ================= CLIENTES =================
app.post("/clientes", auth, (req, res) => {
  const { empresa, nome, endereco, telefone, nascimento } = req.body;

  db.run(
    "INSERT INTO clientes (empresa, nome, endereco, telefone, nascimento) VALUES (?, ?, ?, ?, ?)",
    [empresa, nome, endereco, telefone, nascimento],
    function (err) {
      if (err) return res.status(500).send("Erro ao cadastrar cliente");
      res.json({ id: this.lastID });
    }
  );
});

app.get("/clientes/:empresa", auth, (req, res) => {
  db.all(
    "SELECT * FROM clientes WHERE empresa = ? ORDER BY nome COLLATE NOCASE ASC",
    [req.params.empresa],
    (err, rows) => {
      if (err) return res.status(500).send("Erro ao buscar clientes");
      res.json(rows);
    }
  );
});

// ================= VENDAS =================
app.post("/vendas", auth, (req, res) => {
  const { produto_id, quantidade, empresa, cliente_id, pagamento } = req.body;

  if (!pagamento) {
    return res.status(400).send("Forma de pagamento obrigatória");
  }

  db.get(
    "SELECT * FROM produtos WHERE id = ? AND empresa = ?",
    [produto_id, empresa],
    (err, produto) => {
      if (err) return res.status(500).send("Erro ao buscar produto");
      if (!produto) return res.status(404).send("Produto não encontrado");
      if (produto.estoque < quantidade) {
        return res.status(400).send("Estoque insuficiente");
      }

      const finalizarVenda = (clienteNomeFinal, clienteIdFinal) => {
        const total = produto.preco * quantidade;
        const dataVenda = hoje();
        const dataHora = agora();

        db.run(
          "UPDATE produtos SET estoque = estoque - ? WHERE id = ?",
          [quantidade, produto_id],
          updateErr => {
            if (updateErr) return res.status(500).send("Erro ao atualizar estoque");

            db.run(
              `INSERT INTO vendas
              (empresa, produto, quantidade, total, produto_id, cliente_id, cliente_nome, pagamento, data_venda, data_hora)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                empresa,
                produto.nome,
                quantidade,
                total,
                produto.id,
                clienteIdFinal,
                clienteNomeFinal,
                pagamento,
                dataVenda,
                dataHora
              ],
              function (insertErr) {
                if (insertErr) return res.status(500).send("Erro ao registrar venda");

                db.run(
                  `INSERT INTO financeiro (empresa, tipo, valor, descricao, data_movimento, pagamento)
                   VALUES (?, 'entrada', ?, ?, ?, ?)`,
                  [empresa, total, `Venda de ${produto.nome}`, dataHora, pagamento],
                  financeiroErr => {
                    if (financeiroErr) return res.status(500).send("Erro ao lançar financeiro");

                    res.json({
                      sucesso: true,
                      id: this.lastID,
                      cliente: clienteNomeFinal,
                      total
                    });
                  }
                );
              }
            );
          }
        );
      };

      if (cliente_id) {
        db.get(
          "SELECT * FROM clientes WHERE id = ? AND empresa = ?",
          [cliente_id, empresa],
          (clienteErr, cliente) => {
            if (clienteErr) return res.status(500).send("Erro ao buscar cliente");
            if (!cliente) return res.status(404).send("Cliente não encontrado");

            finalizarVenda(cliente.nome, cliente.id);
          }
        );
      } else {
        finalizarVenda("Consumidor Final", null);
      }
    }
  );
});

app.get("/vendas/:empresa", auth, (req, res) => {
  db.all(
    "SELECT * FROM vendas WHERE empresa = ? ORDER BY id DESC",
    [req.params.empresa],
    (err, rows) => {
      if (err) return res.status(500).send("Erro ao buscar vendas");
      res.json(rows);
    }
  );
});

// ================= FINANCEIRO =================
app.get("/financeiro/:empresa", auth, (req, res) => {
  db.get(
    "SELECT SUM(valor) AS total FROM financeiro WHERE empresa = ? AND tipo = 'entrada'",
    [req.params.empresa],
    (err, row) => {
      if (err) return res.status(500).send("Erro ao buscar financeiro");
      res.json({ entrada: row?.total || 0 });
    }
  );
});

// ================= DASHBOARD =================
app.get("/dashboard/:empresa", auth, (req, res) => {
  const empresa = req.params.empresa;

  db.get(
    "SELECT COUNT(*) AS vendas FROM vendas WHERE empresa = ?",
    [empresa],
    (err, v) => {
      if (err) return res.status(500).send("Erro dashboard vendas");

      db.get(
        "SELECT SUM(total) AS faturamento FROM vendas WHERE empresa = ?",
        [empresa],
        (err2, f) => {
          if (err2) return res.status(500).send("Erro dashboard faturamento");

          db.get(
            "SELECT COUNT(*) AS produtos FROM produtos WHERE empresa = ?",
            [empresa],
            (err3, p) => {
              if (err3) return res.status(500).send("Erro dashboard produtos");

              db.get(
                "SELECT COUNT(*) AS clientes FROM clientes WHERE empresa = ?",
                [empresa],
                (err4, c) => {
                  if (err4) return res.status(500).send("Erro dashboard clientes");

                  res.json({
                    totalVendas: v?.vendas || 0,
                    faturamento: f?.faturamento || 0,
                    totalProdutos: p?.produtos || 0,
                    totalClientes: c?.clientes || 0
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

// ================= RELATÓRIO DIÁRIO =================
app.get("/relatorios/diario/:empresa", auth, (req, res) => {
  const empresa = req.params.empresa;
  const data = req.query.data || hoje();

  db.all(
    `SELECT id, data_hora, cliente_nome, produto, quantidade, total, pagamento
     FROM vendas
     WHERE empresa = ? AND data_venda = ?
     ORDER BY data_hora DESC, id DESC`,
    [empresa, data],
    (err, rows) => {
      if (err) return res.status(500).send("Erro ao gerar relatório");

      const faturamento = rows.reduce((acc, item) => acc + Number(item.total || 0), 0);

      res.json({
        data,
        quantidadeVendas: rows.length,
        faturamento,
        vendas: rows
      });
    }
  );
});

// ================= SERVIDOR =================
app.listen(PORT, () => {
  console.log("🔥 Backend rodando na porta " + PORT);
});