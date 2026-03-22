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
  return new Date().toISOString().slice(0, 10);
}

function ensureColumn(table, column, definition) {
  db.all(`PRAGMA table_info(${table})`, (err, columns) => {
    if (err) return;
    const exists = columns.some(col => col.name === column);
    if (!exists) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  });
}

function validarEmpresa(req, empresa) {
  if (req.user.tipo === "admin") return true;
  return req.user.empresa === empresa;
}

function podeGerenciarUsuarios(req) {
  return req.user.tipo === "admin" || req.user.tipo === "gerente";
}

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

  // Migrações
  ensureColumn("usuarios", "nome_completo", "TEXT");
  ensureColumn("usuarios", "cpf", "TEXT");
  ensureColumn("usuarios", "nascimento", "TEXT");

  ensureColumn("clientes", "cpf", "TEXT");

  // Admin fixo
  bcrypt.hash("Lfgl.1308.", 10, (err, hash) => {
    if (err) return;

    db.get(
      "SELECT * FROM usuarios WHERE usuario = ?",
      ["Lfelipeg"],
      (selectErr, user) => {
        if (selectErr) return;

        if (!user) {
          db.run(
            `INSERT INTO usuarios
            (usuario, senha, tipo, empresa, nome_completo, cpf, nascimento)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ["Lfelipeg", hash, "admin", null, "Lfelipeg", "", ""]
          );
        } else {
          db.run(
            `UPDATE usuarios
             SET senha = ?, tipo = ?, empresa = ?, nome_completo = COALESCE(nome_completo, ?)
             WHERE usuario = ?`,
            [hash, "admin", null, "Lfelipeg", "Lfelipeg"]
          );
        }
      }
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

// ================= LOGIN =================
app.post("/login", (req, res) => {
  const { usuario, senha } = req.body;

  db.get("SELECT * FROM usuarios WHERE usuario = ?", [usuario], async (err, user) => {
    if (err) return res.status(500).send("Erro no servidor");
    if (!user) return res.status(401).send("Usuário inválido");

    const ok = await bcrypt.compare(senha, user.senha);
    if (!ok) return res.status(401).send("Senha inválida");

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
  });
});

// ================= USUÁRIOS =================
app.post("/usuarios", auth, (req, res) => {
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

  bcrypt.hash(senha, 10, (err, hash) => {
    if (err) return res.status(500).send("Erro ao criptografar senha");

    db.run(
      `INSERT INTO usuarios
      (usuario, senha, tipo, empresa, nome_completo, cpf, nascimento)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        usuario,
        hash,
        tipo,
        tipo === "admin" ? null : empresa,
        nome_completo,
        cpf || "",
        nascimento || ""
      ],
      function (insertErr) {
        if (insertErr) return res.status(400).send("Erro ao criar usuário");
        res.json({ sucesso: true, id: this.lastID });
      }
    );
  });
});

app.get("/usuarios", auth, (req, res) => {
  if (!podeGerenciarUsuarios(req)) {
    return res.status(403).send("Sem permissão");
  }

  let sql = `
    SELECT id, usuario, tipo, empresa, nome_completo, cpf, nascimento
    FROM usuarios
  `;
  let params = [];

  if (req.user.tipo === "gerente") {
    sql += ` WHERE empresa = ? `;
    params.push(req.user.empresa);
  }

  sql += ` ORDER BY nome_completo COLLATE NOCASE ASC, usuario COLLATE NOCASE ASC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).send("Erro ao listar usuários");
    res.json(rows);
  });
});

app.put("/usuarios/:id", auth, (req, res) => {
  if (!podeGerenciarUsuarios(req)) {
    return res.status(403).send("Sem permissão");
  }

  const id = req.params.id;
  const {
    usuario,
    tipo,
    empresa,
    nome_completo,
    cpf,
    nascimento,
    senha
  } = req.body;

  db.get("SELECT * FROM usuarios WHERE id = ?", [id], async (err, alvo) => {
    if (err) return res.status(500).send("Erro ao buscar usuário");
    if (!alvo) return res.status(404).send("Usuário não encontrado");

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

    const senhaFinal = senha && senha.trim() !== ""
      ? await bcrypt.hash(senha, 10)
      : alvo.senha;

    db.run(
      `UPDATE usuarios
       SET usuario = ?, senha = ?, tipo = ?, empresa = ?, nome_completo = ?, cpf = ?, nascimento = ?
       WHERE id = ?`,
      [
        usuario,
        senhaFinal,
        tipo,
        tipo === "admin" ? null : empresa,
        nome_completo,
        cpf || "",
        nascimento || "",
        id
      ],
      function (updateErr) {
        if (updateErr) return res.status(400).send("Erro ao atualizar usuário");
        res.json({ sucesso: true });
      }
    );
  });
});

// ================= PRODUTOS =================
app.post("/produtos", auth, (req, res) => {
  const { empresa, nome, preco, estoque } = req.body;

  if (!validarEmpresa(req, empresa)) {
    return res.status(403).send("Sem acesso");
  }

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
  if (!validarEmpresa(req, req.params.empresa)) {
    return res.status(403).send("Sem acesso");
  }

  db.all(
    "SELECT * FROM produtos WHERE empresa = ? ORDER BY nome COLLATE NOCASE ASC",
    [req.params.empresa],
    (err, rows) => {
      if (err) return res.status(500).send("Erro ao buscar produtos");
      res.json(rows);
    }
  );
});

app.put("/produtos/:id", auth, (req, res) => {
  const id = req.params.id;
  const { empresa, nome, preco, estoque } = req.body;

  if (!validarEmpresa(req, empresa)) {
    return res.status(403).send("Sem acesso");
  }

  db.run(
    `UPDATE produtos
     SET nome = ?, preco = ?, estoque = ?
     WHERE id = ? AND empresa = ?`,
    [nome, preco, estoque, id, empresa],
    function (err) {
      if (err) return res.status(500).send("Erro ao atualizar produto");
      if (this.changes === 0) return res.status(404).send("Produto não encontrado");
      res.json({ sucesso: true });
    }
  );
});

// ================= CLIENTES =================
app.post("/clientes", auth, (req, res) => {
  const { empresa, nome, endereco, telefone, nascimento, cpf } = req.body;

  if (!validarEmpresa(req, empresa)) {
    return res.status(403).send("Sem acesso");
  }

  db.run(
    `INSERT INTO clientes (empresa, nome, endereco, telefone, nascimento, cpf)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [empresa, nome, endereco, telefone, nascimento, cpf || ""],
    function (err) {
      if (err) return res.status(500).send("Erro ao cadastrar cliente");
      res.json({ id: this.lastID });
    }
  );
});

app.get("/clientes/:empresa", auth, (req, res) => {
  if (!validarEmpresa(req, req.params.empresa)) {
    return res.status(403).send("Sem acesso");
  }

  db.all(
    "SELECT * FROM clientes WHERE empresa = ? ORDER BY nome COLLATE NOCASE ASC",
    [req.params.empresa],
    (err, rows) => {
      if (err) return res.status(500).send("Erro ao buscar clientes");
      res.json(rows);
    }
  );
});

app.put("/clientes/:id", auth, (req, res) => {
  const id = req.params.id;
  const { empresa, nome, endereco, telefone, nascimento, cpf } = req.body;

  if (!validarEmpresa(req, empresa)) {
    return res.status(403).send("Sem acesso");
  }

  db.run(
    `UPDATE clientes
     SET nome = ?, endereco = ?, telefone = ?, nascimento = ?, cpf = ?
     WHERE id = ? AND empresa = ?`,
    [nome, endereco, telefone, nascimento, cpf || "", id, empresa],
    function (err) {
      if (err) return res.status(500).send("Erro ao atualizar cliente");
      if (this.changes === 0) return res.status(404).send("Cliente não encontrado");
      res.json({ sucesso: true });
    }
  );
});

// ================= VENDAS =================
app.post("/vendas", auth, (req, res) => {
  const { produto_id, quantidade, empresa, cliente_id, pagamento } = req.body;

  if (!validarEmpresa(req, empresa)) {
    return res.status(403).send("Sem acesso");
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

      const concluirVenda = (clienteNome) => {
        const total = Number(produto.preco) * Number(quantidade);
        const data = hoje();

        db.run(
          "UPDATE produtos SET estoque = estoque - ? WHERE id = ?",
          [quantidade, produto_id],
          (updateErr) => {
            if (updateErr) return res.status(500).send("Erro ao atualizar estoque");

            db.run(
              `INSERT INTO vendas
              (empresa, produto, quantidade, total, cliente_nome, pagamento, data)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [empresa, produto.nome, quantidade, total, clienteNome, pagamento, data],
              function (insertErr) {
                if (insertErr) return res.status(500).send("Erro ao registrar venda");

                db.run(
                  "INSERT INTO financeiro (empresa, valor) VALUES (?, ?)",
                  [empresa, total],
                  (finErr) => {
                    if (finErr) return res.status(500).send("Erro ao registrar financeiro");
                    res.json({ sucesso: true, id: this.lastID });
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
            concluirVenda(cliente.nome);
          }
        );
      } else {
        concluirVenda("Consumidor Final");
      }
    }
  );
});

app.get("/vendas/:empresa", auth, (req, res) => {
  if (!validarEmpresa(req, req.params.empresa)) {
    return res.status(403).send("Sem acesso");
  }

  db.all(
    "SELECT * FROM vendas WHERE empresa = ? ORDER BY id DESC",
    [req.params.empresa],
    (err, rows) => {
      if (err) return res.status(500).send("Erro ao buscar vendas");
      res.json(rows);
    }
  );
});

app.put("/vendas/:id", auth, (req, res) => {
  const id = req.params.id;
  const { empresa, produto, quantidade, total, cliente_nome, pagamento, data } = req.body;

  if (!validarEmpresa(req, empresa)) {
    return res.status(403).send("Sem acesso");
  }

  db.get("SELECT * FROM vendas WHERE id = ? AND empresa = ?", [id, empresa], (err, venda) => {
    if (err) return res.status(500).send("Erro ao buscar venda");
    if (!venda) return res.status(404).send("Venda não encontrada");

    db.run(
      `UPDATE vendas
       SET produto = ?, quantidade = ?, total = ?, cliente_nome = ?, pagamento = ?, data = ?
       WHERE id = ? AND empresa = ?`,
      [produto, quantidade, total, cliente_nome, pagamento, data, id, empresa],
      function (updateErr) {
        if (updateErr) return res.status(500).send("Erro ao atualizar venda");

        const diferenca = Number(total) - Number(venda.total || 0);

        db.run(
          `UPDATE financeiro
           SET valor = valor + ?
           WHERE empresa = ?
           AND id = (
             SELECT id FROM financeiro
             WHERE empresa = ?
             ORDER BY id DESC
             LIMIT 1
           )`,
          [diferenca, empresa, empresa],
          () => {
            res.json({ sucesso: true });
          }
        );
      }
    );
  });
});

// ================= FINANCEIRO =================
app.get("/financeiro/:empresa", auth, (req, res) => {
  if (!validarEmpresa(req, req.params.empresa)) {
    return res.status(403).send("Sem acesso");
  }

  db.get(
    "SELECT SUM(valor) as total FROM financeiro WHERE empresa = ?",
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

  if (!validarEmpresa(req, empresa)) {
    return res.status(403).send("Sem acesso");
  }

  db.get(
    "SELECT COUNT(*) as vendas FROM vendas WHERE empresa = ?",
    [empresa],
    (err, v) => {
      if (err) return res.status(500).send("Erro dashboard vendas");

      db.get(
        "SELECT SUM(total) as faturamento FROM vendas WHERE empresa = ?",
        [empresa],
        (err2, f) => {
          if (err2) return res.status(500).send("Erro dashboard faturamento");

          db.get(
            "SELECT COUNT(*) as produtos FROM produtos WHERE empresa = ?",
            [empresa],
            (err3, p) => {
              if (err3) return res.status(500).send("Erro dashboard produtos");

              db.get(
                "SELECT COUNT(*) as clientes FROM clientes WHERE empresa = ?",
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

// ================= SERVIDOR =================
app.listen(PORT, () => console.log("Servidor com edição completa e controle por loja 🔐"));