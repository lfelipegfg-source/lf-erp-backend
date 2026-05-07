module.exports = ({
  auth,
  apenasAdmin,
  pool,
  validarAcessoEmpresa,
  validarLimitePlano,
  obterPeriodo,
  adicionarFiltroPeriodo,
  registrarAuditoria
}) => {
  const router = require('express').Router();

  function ok(res, dados = {}, status = 200) {
    return res.status(status).json({
      sucesso: true,
      ...dados
    });
  }

  function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
    return res.status(status).json({
      sucesso: false,
      erro: mensagem
    });
  }

  function normalizarCliente(row) {
    return {
      ...row,
      id: Number(row.id || 0),
      empresa_id: row.empresa_id ? Number(row.empresa_id) : null
    };
  }

  // ================= CLIENTES =================

  router.post('/', auth, async (req, res) => {
    try {
      const { empresa, nome, endereco, telefone, nascimento, cpf } = req.body;

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do cliente');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const limitePlano = await validarLimitePlano({
        empresaResolvida,
        recurso: 'clientes'
      });

      if (!limitePlano.permitido) {
        return erro(res, 403, limitePlano.mensagem);
      }

      const result = await pool.query(
        `INSERT INTO clientes
        (empresa, empresa_id, nome, endereco, telefone, nascimento, cpf, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING id`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          nome,
          endereco || '',
          telefone || '',
          nascimento || '',
          cpf || ''
        ]
      );

      const clienteId = result.rows[0].id;

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'clientes',
        acao: 'cadastro',
        referencia_id: clienteId,
        dados_novos: {
          nome,
          endereco,
          telefone,
          nascimento,
          cpf
        },
        req
      });

      return ok(res, {
        id: clienteId,
        dados: {
          id: clienteId
        }
      });
    } catch (error) {
      console.error('Erro real ao cadastrar cliente:', error);
      return erro(res, 500, 'Erro ao cadastrar cliente');
    }
  });

  router.get('/:empresa', auth, async (req, res) => {
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const busca = (req.query.busca || '').trim().toLowerCase();

      let sql = `
        SELECT *
        FROM clientes
        WHERE empresa_id = $1
        AND deletado_em IS NULL
      `;

      const params = [empresaResolvida.id];
      let idx = 2;

      if (busca) {
        sql += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${idx}
            OR LOWER(COALESCE(cpf, '')) LIKE $${idx}
            OR LOWER(COALESCE(telefone, '')) LIKE $${idx}
          )
        `;
        params.push(`%${busca}%`);
        idx++;
      }

      sql += ` ORDER BY nome ASC`;

      const result = await pool.query(sql, params);

      return res.json(result.rows.map(normalizarCliente));
    } catch (error) {
      console.error('Erro real ao buscar clientes:', error);
      return erro(res, 500, 'Erro ao buscar clientes');
    }
  });

  router.get('/admin/lista', auth, apenasAdmin, async (req, res) => {
    try {
      const params = [];
      let where = `WHERE deletado_em IS NULL`;

      const empresa = req.query.empresa || '';
      const busca = (req.query.busca || '').trim().toLowerCase();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      if (empresa) {
        const empresaResolvida = await validarAcessoEmpresa(req, empresa);

        if (!empresaResolvida) {
          return erro(res, 403, 'Sem acesso');
        }

        params.push(empresaResolvida.id);
        where += ` AND empresa_id = $${params.length}`;
      }

      if (busca) {
        params.push(`%${busca}%`);
        where += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${params.length}
            OR LOWER(COALESCE(cpf, '')) LIKE $${params.length}
            OR LOWER(COALESCE(telefone, '')) LIKE $${params.length}
          )
        `;
      }

      where += adicionarFiltroPeriodo({
        campo: 'criado_em',
        params,
        dataInicial,
        dataFinal
      });

      const result = await pool.query(
        `SELECT *
        FROM clientes
        ${where}
        ORDER BY empresa ASC, nome ASC`,
        params
      );

      return res.json(result.rows.map(normalizarCliente));
    } catch (error) {
      console.error('Erro real ao buscar clientes admin:', error);
      return erro(res, 500, 'Erro ao buscar clientes');
    }
  });

  router.put('/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { empresa, nome, endereco, telefone, nascimento, cpf } = req.body;

      if (!id) {
        return erro(res, 400, 'Cliente inválido');
      }

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do cliente');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const atualResult = await pool.query(
        `SELECT * FROM clientes WHERE id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      if (atualResult.rowCount === 0) {
        return erro(res, 404, 'Cliente não encontrado');
      }

      await pool.query(
        `UPDATE clientes
        SET nome = $1,
            endereco = $2,
            telefone = $3,
            nascimento = $4,
            cpf = $5,
            atualizado_em = NOW()
        WHERE id = $6 AND empresa_id = $7`,
        [nome, endereco || '', telefone || '', nascimento || '', cpf || '', id, empresaResolvida.id]
      );

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'clientes',
        acao: 'edicao',
        referencia_id: id,
        dados_anteriores: atualResult.rows[0],
        dados_novos: {
          nome,
          endereco,
          telefone,
          nascimento,
          cpf
        },
        req
      });

      return ok(res, {
        mensagem: 'Cliente atualizado com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao atualizar cliente:', error);
      return erro(res, 500, 'Erro ao atualizar cliente');
    }
  });

  router.delete('/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresa = req.query.empresa || req.body.empresa || null;

      if (!id) {
        return erro(res, 400, 'Cliente inválido');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const clienteResult = await pool.query(
        `SELECT * FROM clientes WHERE id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      if (clienteResult.rowCount === 0) {
        return erro(res, 404, 'Cliente não encontrado');
      }

      const vendaResult = await pool.query(
        `SELECT COUNT(*) AS total FROM vendas WHERE cliente_id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      if (Number(vendaResult.rows[0].total || 0) > 0) {
        return erro(res, 400, 'Cliente já possui vendas vinculadas e não pode ser excluído');
      }

      await pool.query(
        `UPDATE clientes
        SET deletado_em = NOW(),
            atualizado_em = NOW()
        WHERE id = $1
        AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'clientes',
        acao: 'soft_delete',
        referencia_id: id,
        dados_anteriores: clienteResult.rows[0],
        dados_novos: {
          deletado_em: new Date()
        },
        req
      });

      return ok(res, {
        mensagem: 'Cliente excluído com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao excluir cliente:', error);
      return erro(res, 500, 'Erro ao excluir cliente');
    }
  });

  return router;
};
