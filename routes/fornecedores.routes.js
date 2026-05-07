const pool = require('../db');

const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');

module.exports = function ({
  auth,
  apenasAdmin,
  pool,
  validarAcessoEmpresa,
  adicionarFiltroEmpresaSaaS,
  validarLimitePlano,
  obterPeriodo,
  adicionarFiltroPeriodo,
  registrarAuditoria
}) {
  const router = require('express').Router();

  function ok(res, dados = {}, status = 200) {
    return res.status(status).json({
      sucesso: true,
      ...dados
    });
  }

  function apenasAdmin(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        sucesso: false,
        erro: 'Não autenticado'
      });
    }

    if (req.user.tipo !== 'admin') {
      return res.status(403).json({
        sucesso: false,
        erro: 'Acesso permitido apenas para administradores'
      });
    }

    next();
  }

  function normalizarFornecedor(row) {
    return {
      ...row,
      id: Number(row.id || 0),
      empresa_id: row.empresa_id ? Number(row.empresa_id) : null
    };
  }

  // ================= FORNECEDORES =================

  router.post('/', auth, async (req, res) => {
    try {
      const { empresa, nome, cnpj, telefone, email, endereco, observacao } = req.body;

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do fornecedor');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const limitePlano = await validarLimitePlano({
        empresaResolvida,
        recurso: 'fornecedores'
      });

      if (!limitePlano.permitido) {
        return erro(res, 403, limitePlano.mensagem);
      }

      const result = await pool.query(
        `INSERT INTO fornecedores
        (empresa, empresa_id, nome, cnpj, telefone, email, endereco, observacao, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING id`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          nome,
          cnpj || '',
          telefone || '',
          email || '',
          endereco || '',
          observacao || ''
        ]
      );

      const fornecedorId = result.rows[0].id;

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'fornecedores',
        acao: 'cadastro',
        referencia_id: fornecedorId,
        dados_novos: {
          nome,
          cnpj,
          telefone,
          email,
          endereco,
          observacao
        },
        req
      });

      return ok(res, {
        id: fornecedorId,
        dados: {
          id: fornecedorId
        }
      });
    } catch (error) {
      console.error('Erro real ao cadastrar fornecedor:', error);
      return erro(res, 500, 'Erro ao cadastrar fornecedor');
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
        FROM fornecedores
        WHERE empresa_id = $1
        AND deletado_em IS NULL
      `;

      const params = [empresaResolvida.id];
      let idx = 2;

      if (busca) {
        sql += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${idx}
            OR LOWER(COALESCE(contato, '')) LIKE $${idx}
            OR LOWER(COALESCE(telefone, '')) LIKE $${idx}
            OR LOWER(COALESCE(email, '')) LIKE $${idx}
          )
        `;
        params.push(`%${busca}%`);
        idx++;
      }

      sql += ` ORDER BY nome ASC`;

      const result = await pool.query(sql, params);

      return res.json(result.rows.map(normalizarFornecedor));
    } catch (error) {
      console.error('Erro real ao buscar fornecedores:', error);
      return erro(res, 500, 'Erro ao buscar fornecedores');
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
            OR LOWER(COALESCE(contato, '')) LIKE $${params.length}
            OR LOWER(COALESCE(telefone, '')) LIKE $${params.length}
            OR LOWER(COALESCE(email, '')) LIKE $${params.length}
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
        FROM fornecedores
        ${where}
        ORDER BY empresa ASC, nome ASC`,
        params
      );

      return res.json(result.rows.map(normalizarFornecedor));
    } catch (error) {
      console.error('Erro real ao buscar fornecedores admin:', error);
      return erro(res, 500, 'Erro ao buscar fornecedores');
    }
  });

  router.put('/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);

      const { empresa, nome, cnpj, telefone, email, endereco, observacao } = req.body;

      if (!id) {
        return erro(res, 400, 'Fornecedor inválido');
      }

      if (!nome) {
        return erro(res, 400, 'Preencha os campos obrigatórios do fornecedor');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const atualResult = await pool.query(
        `SELECT * FROM fornecedores WHERE id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      if (atualResult.rowCount === 0) {
        return erro(res, 404, 'Fornecedor não encontrado');
      }

      await pool.query(
        `UPDATE fornecedores
        SET nome = $1,
            cnpj = $2,
            telefone = $3,
            email = $4,
            endereco = $5,
            observacao = $6,
            atualizado_em = NOW()
        WHERE id = $7 AND empresa_id = $8`,
        [
          nome,
          cnpj || '',
          telefone || '',
          email || '',
          endereco || '',
          observacao || '',
          id,
          empresaResolvida.id
        ]
      );

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'fornecedores',
        acao: 'edicao',
        referencia_id: id,
        dados_anteriores: atualResult.rows[0],
        dados_novos: {
          nome,
          cnpj,
          telefone,
          email,
          endereco,
          observacao
        },
        req
      });

      return ok(res, {
        mensagem: 'Fornecedor atualizado com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao atualizar fornecedor:', error);
      return erro(res, 500, 'Erro ao atualizar fornecedor');
    }
  });

  router.delete('/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const empresa = req.query.empresa || req.body.empresa || null;

      if (!id) {
        return erro(res, 400, 'Fornecedor inválido');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const fornecedorResult = await pool.query(
        `SELECT * FROM fornecedores WHERE id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      if (fornecedorResult.rowCount === 0) {
        return erro(res, 404, 'Fornecedor não encontrado');
      }

      const compraResult = await pool.query(
        `SELECT COUNT(*) AS total FROM compras WHERE fornecedor_id = $1 AND empresa_id = $2`,
        [id, empresaResolvida.id]
      );

      if (Number(compraResult.rows[0].total || 0) > 0) {
        return erro(res, 400, 'Fornecedor já possui compras vinculadas e não pode ser excluído');
      }

      await pool.query(
        `UPDATE fornecedores
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
        modulo: 'fornecedores',
        acao: 'soft_delete',
        referencia_id: id,
        dados_anteriores: fornecedorResult.rows[0],
        dados_novos: {
          deletado_em: new Date()
        },
        req
      });

      return ok(res, {
        mensagem: 'Fornecedor excluído com sucesso'
      });
    } catch (error) {
      console.error('Erro real ao excluir fornecedor:', error);
      return erro(res, 500, 'Erro ao excluir fornecedor');
    }
  });

  return router;
};
