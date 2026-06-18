const { requirePermissao } = require('../utils/permissoes');

module.exports = function ({
  auth,
  writeRateLimiter,
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

  function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
    return res.status(status).json({
      sucesso: false,
      erro: mensagem
    });
  }

  function normalizarFornecedor(row) {
    return {
      ...row,
      id: Number(row.id || 0),
      empresa_id: row.empresa_id ? Number(row.empresa_id) : null
    };
  }

  // ================= FORNECEDORES =================

  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'fornecedores', 'criar'), async (req, res) => {
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

  router.get('/:empresa', auth, requirePermissao(pool, 'fornecedores', 'ver'), async (req, res, next) => {
    if (req.params.empresa === 'admin') return next('route');
    try {
      const empresa = req.params.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const busca = (req.query.busca || '').trim().toLowerCase();

      let sql = `
        SELECT f.id, f.empresa_id, f.nome, f.cnpj, f.telefone, f.email, f.endereco,
               f.criado_em, f.atualizado_em,
               COALESCE(cs.total_compras, 0)       AS total_compras,
               COALESCE(cs.valor_total_compras, 0) AS valor_total_compras
        FROM fornecedores f
        LEFT JOIN (
          SELECT fornecedor_id,
                 COUNT(*)   AS total_compras,
                 SUM(total) AS valor_total_compras
          FROM compras
          WHERE empresa_id = $1
            AND LOWER(COALESCE(status, '')) != 'cancelada'
          GROUP BY fornecedor_id
        ) cs ON cs.fornecedor_id = f.id
        WHERE f.empresa_id = $1
        AND f.deletado_em IS NULL
      `;

      const params = [empresaResolvida.id];
      let idx = 2;

      if (busca) {
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        sql += `
          AND (
            LOWER(COALESCE(f.nome, '')) LIKE $${idx}
            OR LOWER(COALESCE(f.telefone, '')) LIKE $${idx}
            OR LOWER(COALESCE(f.email, '')) LIKE $${idx}
          )
        `;
        params.push(`%${buscaEsc}%`);
        idx++;
      }

      const limite = Math.min(Math.max(0, parseInt(req.query.limit, 10) || 100), 500);
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limIdx = idx;
      const offIdx = idx + 1;

      const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS contagem`;

      const [countResult, result] = await Promise.all([
        pool.query(countSql, params),
        pool.query(
          sql + ` ORDER BY f.nome ASC LIMIT $${limIdx} OFFSET $${offIdx}`,
          [...params, limite, offset]
        )
      ]);

      return res.json({
        sucesso: true,
        dados: result.rows.map(normalizarFornecedor),
        total: Number(countResult.rows[0]?.total || 0),
        limite,
        offset
      });
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
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        params.push(`%${buscaEsc}%`);
        where += `
          AND (
            LOWER(COALESCE(nome, '')) LIKE $${params.length}
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

      const pagina = Math.max(1, parseInt(req.query.page || '1', 10));
      const limite = Math.min(parseInt(req.query.limit || '100', 10), 500);
      const offset = (pagina - 1) * limite;

      const [countResult, result] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS total FROM fornecedores ${where}`, params),
        pool.query(
          `SELECT id, empresa_id, empresa, nome, cnpj, telefone, email, endereco, criado_em, atualizado_em FROM fornecedores ${where} ORDER BY empresa ASC, nome ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limite, offset]
        )
      ]);

      return res.json({
        sucesso: true,
        dados:  result.rows.map(normalizarFornecedor),
        total:  Number(countResult.rows[0]?.total || 0),
        pagina,
        limite
      });
    } catch (error) {
      console.error('Erro real ao buscar fornecedores admin:', error);
      return erro(res, 500, 'Erro ao buscar fornecedores');
    }
  });

  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'fornecedores', 'editar'), async (req, res) => {
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
        `SELECT * FROM fornecedores WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
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

  router.delete('/:id', auth, writeRateLimiter, requirePermissao(pool, 'fornecedores', 'deletar'), async (req, res) => {
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
        `SELECT * FROM fornecedores WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
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
