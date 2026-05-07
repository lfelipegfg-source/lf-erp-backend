module.exports = ({
  auth,
  pool,
  validarAcessoEmpresa,
  podeGerenciarVendas,
  validarLimiteVendasMes,
  normalizarDecimal,
  normalizarInt,
  normalizarDataISO,
  hoje,
  registrarMovimentacaoEstoque,
  criarParcelasContasReceber,
  atualizarStatusContasReceberPorEmpresa,
  obterPeriodo,
  adicionarFiltroEmpresaSaaS,
  adicionarFiltroPeriodo,
  registrarAuditoria
}) => {
  const router = require('express').Router();

  console.log('🔥 ROTA DE VENDAS CARREGADA COM PUT 🔥');

  function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
    return res.status(status).json({
      sucesso: false,
      erro: mensagem
    });
  }

  function normalizarTexto(valor) {
    return String(valor || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function deveGerarFinanceiroVenda({ conta_receber, pagamento, status_pagamento, parcelas }) {
    const pagamentoNormalizado = normalizarTexto(pagamento);
    const statusPagamentoNormalizado = normalizarTexto(status_pagamento);

    return (
      Boolean(conta_receber) ||
      pagamentoNormalizado === 'promissoria' ||
      pagamentoNormalizado === 'boleto' ||
      statusPagamentoNormalizado === 'pendente' ||
      normalizarInt(parcelas || 1) > 1
    );
  }

  async function validarVendaPertenceEmpresa({ client, venda, empresaResolvida }) {
    const vendaEmpresaId = venda.empresa_id ? Number(venda.empresa_id) : null;
    const vendaEmpresaNome = venda.empresa || null;

    const pertenceEmpresa =
      (vendaEmpresaId && vendaEmpresaId === Number(empresaResolvida.id)) ||
      (!vendaEmpresaId && vendaEmpresaNome === empresaResolvida.nome);

    if (!pertenceEmpresa) {
      return false;
    }

    if (!vendaEmpresaId) {
      await client.query(
        `
        UPDATE vendas
        SET empresa_id = $1,
            empresa = $2,
            atualizado_em = NOW()
        WHERE id = $3
        `,
        [empresaResolvida.id, empresaResolvida.nome, venda.id]
      );
    }

    return true;
  }

  async function vendaPossuiParcelaPaga({ client, vendaId, empresaResolvida }) {
    const result = await client.query(
      `
      SELECT COUNT(*) AS total
      FROM contas_receber
      WHERE venda_id = $1
        AND (
          empresa_id = $2
          OR empresa = $3
          OR empresa_id IS NULL
        )
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    return Number(result.rows[0].total || 0) > 0;
  }

  async function estornarEstoqueVenda({ client, vendaId, empresaResolvida, usuarioId, motivo }) {
    const itensResult = await client.query(
      `
      SELECT *
      FROM venda_itens
      WHERE venda_id = $1
      ORDER BY id ASC
      `,
      [vendaId]
    );

    for (const item of itensResult.rows) {
      const produtoId = Number(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);

      if (!produtoId || quantidade <= 0) continue;

      const produtoResult = await client.query(
        `
        SELECT *
        FROM produtos
        WHERE id = $1 AND empresa_id = $2
        LIMIT 1
        `,
        [produtoId, empresaResolvida.id]
      );

      if (produtoResult.rowCount === 0) continue;

      const produto = produtoResult.rows[0];
      const estoqueAtual = normalizarInt(produto.estoque);
      const novoEstoque = estoqueAtual + quantidade;

      await client.query(
        `
        UPDATE produtos
        SET estoque = $1,
            atualizado_em = NOW()
        WHERE id = $2 AND empresa_id = $3
        `,
        [novoEstoque, produtoId, empresaResolvida.id]
      );

      await registrarMovimentacaoEstoque({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        produto_id: produtoId,
        tipo: 'estorno_venda',
        quantidade,
        observacao: motivo || `Estorno da venda #${vendaId}`,
        referencia_tipo: 'venda_estornada',
        referencia_id: vendaId,
        usuario_id: usuarioId,
        client
      });
    }
  }

  async function removerDadosDependentesVenda({ client, vendaId, empresaResolvida }) {
    await client.query(
      `
      DELETE FROM contas_receber
      WHERE venda_id = $1
        AND (
          empresa_id = $2
          OR empresa = $3
          OR empresa_id IS NULL
        )
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM movimentacoes_estoque
      WHERE referencia_tipo = 'venda'
        AND referencia_id = $1
        AND empresa = $2
      `,
      [vendaId, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM venda_itens
      WHERE venda_id = $1
      `,
      [vendaId]
    );
  }

  async function inserirItensVendaEBaixarEstoque({
    client,
    vendaId,
    empresaResolvida,
    itens,
    usuarioId
  }) {
    for (const item of itens) {
      const produtoId = Number(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);

      if (!produtoId || quantidade <= 0) {
        throw new Error('Itens da venda inválidos');
      }

      const produtoResult = await client.query(
        `
        SELECT *
        FROM produtos
        WHERE id = $1 AND empresa_id = $2
        LIMIT 1
        `,
        [produtoId, empresaResolvida.id]
      );

      if (produtoResult.rowCount === 0) {
        throw new Error(`Produto ${produtoId} não encontrado`);
      }

      const produto = produtoResult.rows[0];
      const estoqueAtual = normalizarInt(produto.estoque);

      if (estoqueAtual < quantidade) {
        throw new Error(`Estoque insuficiente para ${produto.nome}`);
      }

      const precoUnitario = normalizarDecimal(item.preco_unitario || produto.preco);
      const custoUnitario = normalizarDecimal(item.custo_unitario || produto.custo);
      const totalItem = Number((quantidade * precoUnitario).toFixed(2));

      await client.query(
        `
        INSERT INTO venda_itens
(venda_id, empresa, empresa_id, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          vendaId,
          empresaResolvida.nome,
          empresaResolvida.id,
          produto.id,
          produto.nome,
          quantidade,
          precoUnitario,
          custoUnitario,
          totalItem
        ]
      );

      await client.query(
        `
        UPDATE produtos
        SET estoque = $1,
            atualizado_em = NOW()
        WHERE id = $2 AND empresa_id = $3
        `,
        [estoqueAtual - quantidade, produto.id, empresaResolvida.id]
      );

      await registrarMovimentacaoEstoque({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        produto_id: produto.id,
        tipo: 'saida_venda',
        quantidade,
        observacao: `Saída por venda #${vendaId}`,
        referencia_tipo: 'venda',
        referencia_id: vendaId,
        usuario_id: usuarioId,
        client
      });
    }
  }

  router.post('/', auth, async (req, res) => {
    const client = await pool.connect();

    try {
      if (!podeGerenciarVendas(req)) {
        return erro(res, 403, 'Sem permissão para vendas');
      }

      const {
        empresa,
        cliente_id,
        cliente_nome,
        subtotal,
        desconto,
        acrescimo,
        total,
        pagamento,
        parcelas,
        status_pagamento,
        data,
        observacao,
        conta_receber,
        itens
      } = req.body;

      if (!Array.isArray(itens) || itens.length === 0) {
        return erro(res, 400, 'Dados da venda incompletos');
      }

      const empresaResolvida = await validarAcessoEmpresa(req, empresa);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const limiteVendas = await validarLimiteVendasMes(empresaResolvida);

      if (!limiteVendas.permitido) {
        return erro(res, 403, limiteVendas.mensagem);
      }

      await client.query('BEGIN');

      let clienteNomeFinal = cliente_nome || '';
      let clienteIdFinal = cliente_id || null;

      if (clienteIdFinal) {
        const clienteResult = await client.query(
          `SELECT * FROM clientes WHERE id = $1 AND empresa_id = $2`,
          [clienteIdFinal, empresaResolvida.id]
        );

        if (clienteResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 404, 'Cliente não encontrado');
        }

        clienteNomeFinal = clienteResult.rows[0].nome;
      }

      const subtotalFinal = normalizarDecimal(subtotal);
      const descontoFinal = normalizarDecimal(desconto);
      const acrescimoFinal = normalizarDecimal(acrescimo);
      const totalFinal = normalizarDecimal(total);

      const vendaResult = await client.query(
        `INSERT INTO vendas
        (empresa, empresa_id, cliente_id, cliente_nome, subtotal, desconto, acrescimo, total, pagamento, parcelas, status_pagamento, data, observacao, criado_por, criado_em, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
        RETURNING *`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          clienteIdFinal,
          clienteNomeFinal,
          subtotalFinal,
          descontoFinal,
          acrescimoFinal,
          totalFinal,
          pagamento || 'Dinheiro',
          Math.max(1, normalizarInt(parcelas || 1)),
          status_pagamento || 'pago',
          normalizarDataISO(data) || hoje(),
          observacao || '',
          req.user.id
        ]
      );

      const venda = vendaResult.rows[0];

      await inserirItensVendaEBaixarEstoque({
        client,
        vendaId: venda.id,
        empresaResolvida,
        itens,
        usuarioId: req.user.id
      });

      if (
        deveGerarFinanceiroVenda({
          conta_receber,
          pagamento,
          status_pagamento,
          parcelas
        })
      ) {
        await criarParcelasContasReceber({
          client,
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          venda_id: venda.id,
          cliente_id: clienteIdFinal,
          cliente_nome: clienteNomeFinal,
          total: totalFinal,
          quantidade_parcelas: Math.max(1, normalizarInt(parcelas || 1)),
          data_primeiro_vencimento: normalizarDataISO(data) || hoje(),
          intervalo_dias: 30,
          observacao: observacao || '',
          criado_por: req.user.id,
          forma_pagamento: pagamento || 'Promissória'
        });
      }

      await client.query('COMMIT');

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'vendas',
        acao: 'cadastro',
        referencia_id: venda.id,
        dados_novos: {
          cliente_id: clienteIdFinal,
          cliente_nome: clienteNomeFinal,
          subtotal: subtotalFinal,
          desconto: descontoFinal,
          acrescimo: acrescimoFinal,
          total: totalFinal,
          pagamento: pagamento || 'Dinheiro',
          parcelas: Math.max(1, normalizarInt(parcelas || 1)),
          status_pagamento: status_pagamento || 'pago',
          itens: itens.map((i) => ({
            produto_id: i.produto_id,
            quantidade: i.quantidade,
            preco_unitario: i.preco_unitario
          }))
        },
        req
      });

      await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);

      return res.json({
        sucesso: true,
        dados: { venda_id: venda.id }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('ERRO REAL AO REGISTRAR VENDA:', error);
      return erro(res, 500, error.message || 'Erro ao registrar venda');
    } finally {
      client.release();
    }
  });

  router.put('/:id', auth, async (req, res) => {
    const client = await pool.connect();

    try {
      if (!podeGerenciarVendas(req)) {
        return erro(res, 403, 'Sem permissão para editar vendas');
      }

      const id = Number(req.params.id);

      if (!id) {
        return erro(res, 400, 'Venda inválida');
      }

      const {
        empresa,
        cliente_id,
        cliente_nome,
        subtotal,
        desconto,
        acrescimo,
        total,
        pagamento,
        parcelas,
        status_pagamento,
        data,
        observacao,
        conta_receber,
        itens
      } = req.body;

      if (!Array.isArray(itens) || itens.length === 0) {
        return erro(res, 400, 'Dados da venda incompletos');
      }

      await client.query('BEGIN');

      const vendaResult = await client.query(
        `
        SELECT *
        FROM vendas
        WHERE id = $1
        LIMIT 1
        `,
        [id]
      );

      if (vendaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Venda não encontrada');
      }

      const vendaAtual = vendaResult.rows[0];

      const empresaBase = empresa || vendaAtual.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresaBase);

      if (!empresaResolvida) {
        await client.query('ROLLBACK');
        return erro(res, 403, 'Sem acesso');
      }

      const pertenceEmpresa = await validarVendaPertenceEmpresa({
        client,
        venda: vendaAtual,
        empresaResolvida
      });

      if (!pertenceEmpresa) {
        await client.query('ROLLBACK');
        return erro(res, 403, 'Venda não pertence à empresa autenticada');
      }

      const possuiParcelaPaga = await vendaPossuiParcelaPaga({
        client,
        vendaId: id,
        empresaResolvida
      });

      if (possuiParcelaPaga) {
        await client.query('ROLLBACK');
        return erro(
          res,
          400,
          'Esta venda possui conta a receber paga. Estorne o recebimento antes de editar.'
        );
      }

      let clienteNomeFinal = cliente_nome || '';
      let clienteIdFinal = cliente_id || null;

      if (clienteIdFinal) {
        const clienteResult = await client.query(
          `
          SELECT *
          FROM clientes
          WHERE id = $1 AND empresa_id = $2
          LIMIT 1
          `,
          [clienteIdFinal, empresaResolvida.id]
        );

        if (clienteResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return erro(res, 404, 'Cliente não encontrado');
        }

        clienteNomeFinal = clienteResult.rows[0].nome;
      }

      const subtotalFinal = normalizarDecimal(subtotal);
      const descontoFinal = normalizarDecimal(desconto);
      const acrescimoFinal = normalizarDecimal(acrescimo);
      const totalFinal = normalizarDecimal(total);
      const parcelasFinal = Math.max(1, normalizarInt(parcelas || 1));
      const dataFinal = normalizarDataISO(data) || hoje();

      await estornarEstoqueVenda({
        client,
        vendaId: id,
        empresaResolvida,
        usuarioId: req.user.id,
        motivo: `Estorno para edição da venda #${id}`
      });

      await removerDadosDependentesVenda({
        client,
        vendaId: id,
        empresaResolvida
      });

      const vendaAtualizadaResult = await client.query(
        `
        UPDATE vendas
        SET empresa = $1,
            empresa_id = $2,
            cliente_id = $3,
            cliente_nome = $4,
            subtotal = $5,
            desconto = $6,
            acrescimo = $7,
            total = $8,
            pagamento = $9,
            parcelas = $10,
            status_pagamento = $11,
            data = $12,
            observacao = $13,
            atualizado_em = NOW()
        WHERE id = $14 AND empresa_id = $15
        RETURNING *
        `,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          clienteIdFinal,
          clienteNomeFinal,
          subtotalFinal,
          descontoFinal,
          acrescimoFinal,
          totalFinal,
          pagamento || 'Dinheiro',
          parcelasFinal,
          status_pagamento || 'pago',
          dataFinal,
          observacao || '',
          id,
          empresaResolvida.id
        ]
      );

      if (vendaAtualizadaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Venda não encontrada para atualização');
      }

      await inserirItensVendaEBaixarEstoque({
        client,
        vendaId: id,
        empresaResolvida,
        itens,
        usuarioId: req.user.id
      });

      if (
        deveGerarFinanceiroVenda({
          conta_receber,
          pagamento,
          status_pagamento,
          parcelas: parcelasFinal
        })
      ) {
        await criarParcelasContasReceber({
          client,
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          venda_id: id,
          cliente_id: clienteIdFinal,
          cliente_nome: clienteNomeFinal,
          total: totalFinal,
          quantidade_parcelas: parcelasFinal,
          data_primeiro_vencimento: dataFinal,
          intervalo_dias: 30,
          observacao: observacao || '',
          criado_por: req.user.id,
          forma_pagamento: pagamento || 'Promissória'
        });
      }

      await client.query('COMMIT');

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'vendas',
        acao: 'edicao',
        referencia_id: id,
        dados_anteriores: vendaAtual,
        dados_novos: {
          cliente_id: clienteIdFinal,
          cliente_nome: clienteNomeFinal,
          subtotal: subtotalFinal,
          desconto: descontoFinal,
          acrescimo: acrescimoFinal,
          total: totalFinal,
          pagamento: pagamento || 'Dinheiro',
          parcelas: parcelasFinal,
          status_pagamento: status_pagamento || 'pago',
          itens: itens.map((i) => ({
            produto_id: i.produto_id,
            quantidade: i.quantidade,
            preco_unitario: i.preco_unitario
          }))
        },
        req
      });

      await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);

      return res.json({
        sucesso: true,
        mensagem: 'Venda editada com sucesso',
        dados: {
          venda_id: id
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao editar venda:', error);
      return erro(res, 500, error.message || 'Erro ao editar venda');
    } finally {
      client.release();
    }
  });

  router.patch('/:id/observacao', auth, async (req, res) => {
    try {
      if (!podeGerenciarVendas(req)) {
        return erro(res, 403, 'Sem permissão para editar vendas');
      }

      const id = Number(req.params.id);
      const { empresa, observacao } = req.body;

      if (!id) {
        return erro(res, 400, 'Venda inválida');
      }

      const vendaResult = await pool.query(`SELECT * FROM vendas WHERE id = $1 LIMIT 1`, [id]);

      if (vendaResult.rowCount === 0) {
        return erro(res, 404, 'Venda não encontrada');
      }

      const venda = vendaResult.rows[0];
      const empresaBase = empresa || venda.empresa;
      const empresaResolvida = await validarAcessoEmpresa(req, empresaBase);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const vendaEmpresaId = venda.empresa_id ? Number(venda.empresa_id) : null;
      const pertenceEmpresa =
        (vendaEmpresaId && vendaEmpresaId === Number(empresaResolvida.id)) ||
        (!vendaEmpresaId && venda.empresa === empresaResolvida.nome);

      if (!pertenceEmpresa) {
        return erro(res, 403, 'Venda não pertence à empresa autenticada');
      }

      const result = await pool.query(
        `
      UPDATE vendas
      SET observacao = $1,
          atualizado_em = NOW()
      WHERE id = $2
        AND (
          empresa_id = $3
          OR empresa = $4
        )
      RETURNING id, observacao
      `,
        [observacao || '', id, empresaResolvida.id, empresaResolvida.nome]
      );

      if (result.rowCount === 0) {
        return erro(res, 404, 'Venda não encontrada para atualização');
      }

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'vendas',
        acao: 'edicao_observacao',
        referencia_id: id,
        dados_anteriores: {
          observacao: venda.observacao || ''
        },
        dados_novos: {
          observacao: observacao || ''
        },
        req
      });

      return res.json({
        sucesso: true,
        mensagem: 'Observação atualizada com sucesso',
        dados: result.rows[0]
      });
    } catch (error) {
      console.error('Erro real ao editar observação da venda:', error);
      return erro(res, 500, 'Erro ao editar observação da venda');
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
      const clienteId = normalizarInt(req.query.cliente_id || 0);
      const pagamento = (req.query.pagamento || '').trim();
      const statusPagamento = (req.query.status_pagamento || '').trim();
      const { dataInicial, dataFinal } = obterPeriodo(req);

      const params = [];

      let sql = `
  SELECT v.*
  FROM vendas v
  WHERE 1=1
  ${adicionarFiltroEmpresaSaaS({
    alias: 'v',
    params,
    empresaResolvida
  })}
`;
      let idx = 2;

      if (clienteId > 0) {
        sql += ` AND v.cliente_id = $${idx}`;
        params.push(clienteId);
        idx++;
      }

      if (pagamento) {
        sql += ` AND v.pagamento = $${idx}`;
        params.push(pagamento);
        idx++;
      }

      if (statusPagamento) {
        sql += ` AND v.status_pagamento = $${idx}`;
        params.push(statusPagamento);
        idx++;
      }

      if (busca) {
        sql += ` AND (
          LOWER(COALESCE(v.cliente_nome,'')) LIKE $${idx}
          OR LOWER(COALESCE(v.observacao,'')) LIKE $${idx}
          OR CAST(v.id AS TEXT) LIKE $${idx}
        )`;
        params.push(`%${busca}%`);
        idx++;
      }

      sql += adicionarFiltroPeriodo({
        campo: 'v.data',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      sql += ` ORDER BY v.id DESC`;

      const result = await pool.query(sql, params);

      return res.json(
        result.rows.map((row) => ({
          ...row,
          subtotal: Number(row.subtotal || 0),
          desconto: Number(row.desconto || 0),
          acrescimo: Number(row.acrescimo || 0),
          total: Number(row.total || 0),
          parcelas: Number(row.parcelas || 1)
        }))
      );
    } catch (error) {
      console.error('Erro real ao buscar vendas:', error);
      return erro(res, 500, 'Erro ao buscar vendas');
    }
  });

  router.get('/detalhe/:id', auth, async (req, res) => {
    try {
      const id = Number(req.params.id);

      const vendaResult = await pool.query(`SELECT * FROM vendas WHERE id = $1`, [id]);

      if (vendaResult.rowCount === 0) {
        return erro(res, 404, 'Venda não encontrada');
      }

      const venda = vendaResult.rows[0];

      const empresaBase = venda.empresa_id || venda.empresa;

      const empresaResolvida = await validarAcessoEmpresa(req, empresaBase);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const itensResult = await pool.query(
        `SELECT * FROM venda_itens WHERE venda_id = $1 ORDER BY id ASC`,
        [id]
      );

      await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);

      const contasReceberResult = await pool.query(
        `
        SELECT
          *,
          CASE
            WHEN LOWER(COALESCE(status, 'pendente')) = 'pago' THEN 'pago'
            WHEN data_vencimento IS NOT NULL AND data_vencimento < $2 THEN 'atrasado'
            ELSE COALESCE(status, 'pendente')
          END AS status_exibicao
        FROM contas_receber
        WHERE venda_id = $1
AND (
  empresa_id = $3
  OR (
    empresa_id IS NULL
    AND empresa = $4
  )
)
ORDER BY parcela ASC
        `,
        [id, hoje(), empresaResolvida.id, empresaResolvida.nome]
      );

      return res.json({
        ...venda,
        subtotal: Number(venda.subtotal || 0),
        desconto: Number(venda.desconto || 0),
        acrescimo: Number(venda.acrescimo || 0),
        total: Number(venda.total || 0),
        parcelas: Number(venda.parcelas || 1),
        itens: itensResult.rows.map((item) => ({
          ...item,
          quantidade: Number(item.quantidade || 0),
          preco_unitario: Number(item.preco_unitario || 0),
          custo_unitario: Number(item.custo_unitario || 0),
          total: Number(item.total || 0)
        })),
        contas_receber: contasReceberResult.rows.map((cr) => ({
          ...cr,
          status: cr.status_exibicao || cr.status || 'pendente',
          status_exibicao: cr.status_exibicao || cr.status || 'pendente',
          valor: Number(cr.valor || 0),
          parcela: Number(cr.parcela || 1),
          total_parcelas: Number(cr.total_parcelas || 1),
          multa: Number(cr.multa || 0),
          juros: Number(cr.juros || 0),
          valor_atualizado: Number(cr.valor_atualizado || cr.valor || 0),
          dias_atraso: Number(cr.dias_atraso || 0)
        }))
      });
    } catch (error) {
      console.error('Erro real ao buscar venda:', error);
      return erro(res, 500, 'Erro ao buscar venda');
    }
  });

  router.delete('/:id', auth, async (req, res) => {
    const client = await pool.connect();

    try {
      if (!podeGerenciarVendas(req)) {
        return erro(res, 403, 'Sem permissão para excluir vendas');
      }

      const id = Number(req.params.id);

      if (!id) {
        return erro(res, 400, 'Venda inválida');
      }

      await client.query('BEGIN');

      const vendaResult = await client.query(`SELECT * FROM vendas WHERE id = $1 LIMIT 1`, [id]);

      if (vendaResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Venda não encontrada');
      }

      const venda = vendaResult.rows[0];
      const empresaBase = venda.empresa_id || venda.empresa;

      const empresaResolvida = await validarAcessoEmpresa(req, empresaBase);
      if (!empresaResolvida) {
        await client.query('ROLLBACK');
        return erro(res, 403, 'Sem acesso');
      }

      const pertenceEmpresa = await validarVendaPertenceEmpresa({
        client,
        venda,
        empresaResolvida
      });

      if (!pertenceEmpresa) {
        await client.query('ROLLBACK');
        return erro(res, 403, 'Venda não pertence à empresa autenticada');
      }

      const possuiParcelaPaga = await vendaPossuiParcelaPaga({
        client,
        vendaId: id,
        empresaResolvida
      });

      if (possuiParcelaPaga) {
        await client.query('ROLLBACK');
        return erro(
          res,
          400,
          'Esta venda possui conta a receber paga. Estorne o recebimento antes de excluir.'
        );
      }

      await estornarEstoqueVenda({
        client,
        vendaId: id,
        empresaResolvida,
        usuarioId: req.user.id,
        motivo: `Estorno por exclusão da venda #${id}`
      });

      await removerDadosDependentesVenda({
        client,
        vendaId: id,
        empresaResolvida
      });

      await client.query(
        `
        DELETE FROM vendas
        WHERE id = $1 AND empresa_id = $2
        `,
        [id, empresaResolvida.id]
      );

      await client.query('COMMIT');

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'vendas',
        acao: 'exclusao',
        referencia_id: id,
        dados_anteriores: venda,
        dados_novos: null,
        req
      });

      await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome);

      return res.json({
        sucesso: true,
        mensagem: 'Venda excluída com sucesso'
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao excluir venda:', error);
      return erro(res, 500, 'Erro ao excluir venda');
    } finally {
      client.release();
    }
  });

  return router;
};
