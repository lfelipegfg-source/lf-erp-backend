const { requirePermissao } = require('../utils/permissoes');
const { resolverPreco } = require('../utils/resolverPreco');
const { validarEstoqueKit, baixarComponentesKit, estornarComponentesKit, sincronizarEstoqueKit } = require('../utils/kits');
const { calcularComissaoVenda } = require('../utils/comissoes');
const { acumularPontosFidelidade } = require('../utils/fidelidade');
const { dispararWebhookComRetry } = require('../utils/webhookContabil');

module.exports = ({
  auth,
  writeRateLimiter,
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
  registrarAuditoria,
  validarItensVenda
}) => {
  const router = require('express').Router();

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

  // Normaliza array de pagamentos do split.
  // Retorna { pagamentosArray, pagamentoPrincipal, totalPromissoria, statusPagamento }
  function normalizarPagamentosSplit({ pagamentos, pagamento, total, status_pagamento, parcelas }) {
    const FORMAS_PENDENTES = ['promissoria', 'promissória', 'boleto'];

    let pagamentosArray;

    if (Array.isArray(pagamentos) && pagamentos.length > 0) {
      pagamentosArray = pagamentos.map((p) => ({
        forma: String(p.forma || 'Dinheiro'),
        valor: normalizarDecimal(p.valor),
        parcelas: normalizarInt(p.parcelas) || 1,
        vencimento: p.vencimento || null
      }));
    } else {
      // Retrocompatibilidade: pagamento único
      pagamentosArray = [{ forma: pagamento || 'Dinheiro', valor: normalizarDecimal(total), parcelas: normalizarInt(parcelas) || 1, vencimento: null }];
    }

    const pagamentoPrincipal = pagamentosArray[0]?.forma || 'Dinheiro';

    const totalPromissoria = pagamentosArray
      .filter((p) => FORMAS_PENDENTES.includes(normalizarTexto(p.forma)))
      .reduce((acc, p) => acc + p.valor, 0);

    const statusFinal = totalPromissoria > 0 ? 'pendente' : (status_pagamento || 'pago');

    return { pagamentosArray, pagamentoPrincipal, totalPromissoria: Number(totalPromissoria.toFixed(2)), statusPagamento: statusFinal };
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
      SELECT 1
      FROM contas_receber
      WHERE venda_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        AND LOWER(COALESCE(status, 'pendente')) = 'pago'
      LIMIT 1
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    return result.rowCount > 0;
  }

  async function estornarEstoqueVenda({ client, vendaId, empresaResolvida, usuarioId, motivo }) {
    const itensResult = await client.query(
      `
      SELECT *
      FROM venda_itens
      WHERE venda_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      ORDER BY id ASC
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    // Pré-busca e_kit de todos os produtos da venda — evita N+1 (atributo estático)
    const prodIdsEstorno = [...new Set(
      itensResult.rows.map(r => Number(r.produto_id)).filter(id => id > 0)
    )];
    const eKitRows = await client.query(
      `SELECT id, e_kit FROM produtos WHERE id = ANY($1) AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
      [prodIdsEstorno, empresaResolvida.id, empresaResolvida.nome]
    );
    const eKitMap = Object.fromEntries(eKitRows.rows.map(r => [r.id, Boolean(r.e_kit)]));

    for (const item of itensResult.rows) {
      const produtoId = Number(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);
      const gradeId = item.grade_id ? Number(item.grade_id) : null;

      if (!produtoId || quantidade <= 0) continue;

      const eKit = eKitMap[produtoId] ?? false;

      if (gradeId) {
        // Restaura estoque na grade específica
        await client.query(
          `UPDATE produto_grades SET estoque = estoque + $1, atualizado_em = NOW()
           WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
          [quantidade, gradeId, empresaResolvida.id, empresaResolvida.nome]
        );
        await client.query(
          `UPDATE produtos SET estoque = (
             SELECT COALESCE(SUM(estoque), 0) FROM produto_grades
             WHERE produto_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND ativo = true
           ), atualizado_em = NOW()
           WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
          [produtoId, empresaResolvida.id, empresaResolvida.nome]
        );
      } else if (eKit) {
        // Restaura estoque de cada componente do kit
        await estornarComponentesKit({
          client, kitId: produtoId, empresaId: empresaResolvida.id,
          qtdKits: quantidade, vendaId, usuarioId,
          registrarMovimentacaoEstoque
        });
        await sincronizarEstoqueKit(client, produtoId, empresaResolvida.id);
      } else {
        const produtoResult = await client.query(
          `SELECT estoque FROM produtos WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
          [produtoId, empresaResolvida.id, empresaResolvida.nome]
        );
        if (produtoResult.rowCount === 0) continue;

        const estoqueAtual = normalizarInt(produtoResult.rows[0].estoque);
        await client.query(
          `UPDATE produtos SET estoque = $1, atualizado_em = NOW() WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))`,
          [estoqueAtual + quantidade, produtoId, empresaResolvida.id, empresaResolvida.nome]
        );
      }

      if (!eKit) {
        await registrarMovimentacaoEstoque({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          produto_id: produtoId,
          grade_id: gradeId,
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
  }

  async function removerDadosDependentesVenda({ client, vendaId, empresaResolvida }) {
    await client.query(
      `
      DELETE FROM contas_receber
      WHERE venda_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
`,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM movimentacoes_estoque
      WHERE referencia_tipo = 'venda'
        AND referencia_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );

    await client.query(
      `
      DELETE FROM venda_itens
      WHERE venda_id = $1
        AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
      `,
      [vendaId, empresaResolvida.id, empresaResolvida.nome]
    );
  }

  async function inserirItensVendaEBaixarEstoque({
    client,
    vendaId,
    empresaResolvida,
    itens,
    usuarioId,
    clienteId = null
  }) {
    if (!validarItensVenda(itens)) {
      throw new Error('Itens da venda inválidos');
    }

    // Pré-busca todos os produtos em uma query — evita N+1 no loop
    // Seguro porque nome/preco/custo/e_kit/tem_grade são atributos estáticos;
    // o débito de estoque é feito via UPDATE atômico (estoque - qty WHERE estoque >= qty)
    const produtoIds = [...new Set(itens.map(i => Number(i.produto_id)).filter(id => id > 0))];
    const produtosRows = await client.query(
      `SELECT * FROM produtos WHERE id = ANY($1) AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
      [produtoIds, empresaResolvida.id, empresaResolvida.nome]
    );
    const produtosMap = Object.fromEntries(produtosRows.rows.map(p => [p.id, p]));

    let somaItens = 0;

    for (const item of itens) {
      const produtoId = Number(item.produto_id);
      const quantidade = normalizarInt(item.quantidade);
      const gradeId = item.grade_id ? Number(item.grade_id) : null;

      const produto = produtosMap[produtoId];
      if (!produto) {
        throw new Error(`Produto ${produtoId} não encontrado`);
      }

      // ── Produto com grade ──────────────────────────────────────────
      if (produto.tem_grade) {
        if (!gradeId) {
          throw new Error(`Produto "${produto.nome}" possui grade. Selecione a variação (tamanho/cor).`);
        }

        const gradeResult = await client.query(
          `SELECT * FROM produto_grades WHERE id = $1 AND produto_id = $2 AND empresa_id = $3 AND ativo = true FOR UPDATE`,
          [gradeId, produtoId, empresaResolvida.id]
        );

        if (gradeResult.rowCount === 0) {
          throw new Error(`Grade não encontrada para o produto "${produto.nome}"`);
        }

        const grade = gradeResult.rows[0];
        const estoqueGrade = normalizarInt(grade.estoque);

        if (estoqueGrade < quantidade) {
          throw new Error(
            `Estoque insuficiente para "${produto.nome}" (${grade.atributo1}${grade.atributo2 ? ' / ' + grade.atributo2 : ''}). Disponível: ${estoqueGrade}`
          );
        }

        const precoPorTabela = !item.preco_unitario
          ? await resolverPreco({ pool, produtoId, gradeId, clienteId, empresaId: empresaResolvida.id, quantidade })
          : null;
        const precoUnitario = normalizarDecimal(item.preco_unitario || precoPorTabela || grade.preco || produto.preco);
        const custoUnitario = normalizarDecimal(item.custo_unitario || grade.custo || produto.custo);
        const totalItem = Number((quantidade * precoUnitario).toFixed(2));
        somaItens += totalItem;

        await client.query(
          `INSERT INTO venda_itens
           (venda_id, empresa, empresa_id, produto_id, produto_nome, grade_id, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [vendaId, empresaResolvida.nome, empresaResolvida.id, produto.id, produto.nome, gradeId, quantidade, precoUnitario, custoUnitario, totalItem]
        );

        // Baixa estoque da grade
        await client.query(
          `UPDATE produto_grades SET estoque = $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`,
          [estoqueGrade - quantidade, gradeId, empresaResolvida.id]
        );

        // Sincroniza estoque do produto-pai como soma das grades
        await client.query(
          `UPDATE produtos SET estoque = (
             SELECT COALESCE(SUM(estoque), 0) FROM produto_grades
             WHERE produto_id = $1 AND empresa_id = $2 AND ativo = true
           ), atualizado_em = NOW() WHERE id = $1 AND empresa_id = $2`,
          [produtoId, empresaResolvida.id]
        );

      // ── Kit (composição) ──────────────────────────────────────────
      } else if (produto.e_kit) {
        await validarEstoqueKit(client, produtoId, empresaResolvida.id, quantidade);

        const precoPorTabela = !item.preco_unitario
          ? await resolverPreco({ pool, produtoId, gradeId: null, clienteId, empresaId: empresaResolvida.id, quantidade })
          : null;
        const precoUnitario = normalizarDecimal(item.preco_unitario || precoPorTabela || produto.preco);
        const custoUnitario = normalizarDecimal(item.custo_unitario || produto.custo);
        const totalItem = Number((quantidade * precoUnitario).toFixed(2));
        somaItens += totalItem;

        await client.query(
          `INSERT INTO venda_itens
           (venda_id, empresa, empresa_id, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [vendaId, empresaResolvida.nome, empresaResolvida.id, produto.id, produto.nome, quantidade, precoUnitario, custoUnitario, totalItem]
        );

        await baixarComponentesKit({
          client, kitId: produtoId, empresaId: empresaResolvida.id,
          qtdKits: quantidade, vendaId, usuarioId,
          registrarMovimentacaoEstoque
        });

        // Sincroniza estoque do kit com base nos componentes restantes
        await sincronizarEstoqueKit(client, produtoId, empresaResolvida.id);

      // ── Produto simples (sem grade, sem kit) ───────────────────────
      } else {
        const precoPorTabela = !item.preco_unitario
          ? await resolverPreco({ pool, produtoId, gradeId: null, clienteId, empresaId: empresaResolvida.id, quantidade })
          : null;
        const precoUnitario = normalizarDecimal(item.preco_unitario || precoPorTabela || produto.preco);
        const custoUnitario = normalizarDecimal(item.custo_unitario || produto.custo);
        const totalItem = Number((quantidade * precoUnitario).toFixed(2));
        somaItens += totalItem;

        await client.query(
          `INSERT INTO venda_itens
           (venda_id, empresa, empresa_id, produto_id, produto_nome, quantidade, preco_unitario, custo_unitario, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [vendaId, empresaResolvida.nome, empresaResolvida.id, produto.id, produto.nome, quantidade, precoUnitario, custoUnitario, totalItem]
        );

        // UPDATE atômico: debita apenas se estoque suficiente — previne oversell em concorrência
        const upd = await client.query(
          `UPDATE produtos SET estoque = estoque - $1, atualizado_em = NOW()
           WHERE id = $2 AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4)) AND estoque >= $1`,
          [quantidade, produto.id, empresaResolvida.id, empresaResolvida.nome]
        );

        if (upd.rowCount === 0) {
          throw new Error(`Estoque insuficiente para ${produto.nome}`);
        }
      }

      // Kits registram movimentações por componente em baixarComponentesKit
      if (!produto.e_kit) {
        await registrarMovimentacaoEstoque({
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          produto_id: produto.id,
          grade_id: gradeId,
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

    return somaItens;
  }

  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'vendas', 'criar'), async (req, res) => {
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
        pagamentos,
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
          `SELECT * FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL`,
          [clienteIdFinal, empresaResolvida.id, empresaResolvida.nome]
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

      const {
        pagamentosArray,
        pagamentoPrincipal,
        totalPromissoria,
        statusPagamento: statusFinal
      } = normalizarPagamentosSplit({ pagamentos, pagamento, total: totalFinal, status_pagamento, parcelas });

      // Dados de parcelas da entrada Promissória (se houver)
      const promissoriaEntry = pagamentosArray.find(
        (p) => ['promissoria', 'promissória'].includes(normalizarTexto(p.forma))
      );

      const vendaResult = await client.query(
        `INSERT INTO vendas
        (empresa, empresa_id, cliente_id, cliente_nome, subtotal, desconto, acrescimo, total, pagamento, pagamentos, parcelas, status_pagamento, data, observacao, criado_por, criado_em, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
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
          pagamentoPrincipal,
          JSON.stringify(pagamentosArray),
          Math.max(1, promissoriaEntry ? normalizarInt(promissoriaEntry.parcelas || 1) : normalizarInt(parcelas || 1)),
          statusFinal,
          normalizarDataISO(data) || hoje(),
          observacao || '',
          req.user.id
        ]
      );

      const venda = vendaResult.rows[0];

      const somaItens = await inserirItensVendaEBaixarEstoque({
        client,
        vendaId: venda.id,
        empresaResolvida,
        itens,
        usuarioId: req.user.id,
        clienteId: cliente_id ? Number(cliente_id) : null
      });

      // Confere se o total informado bate com a soma real dos itens (com tolerância de arredondamento)
      const totalEsperado = Number((somaItens - descontoFinal + acrescimoFinal).toFixed(2));
      const toleranciaTotal = Math.max(0.05, itens.length * 0.01);
      if (Math.abs(totalEsperado - totalFinal) > toleranciaTotal) {
        await client.query('ROLLBACK');
        return erro(res, 400, `Total da venda (R$ ${totalFinal.toFixed(2)}) não corresponde à soma dos itens com desconto/acréscimo (R$ ${totalEsperado.toFixed(2)}).`);
      }

      // Gera contas a receber apenas para a parcela Promissória do split
      if (totalPromissoria > 0) {
        await criarParcelasContasReceber({
          client,
          empresa: empresaResolvida.nome,
          empresa_id: empresaResolvida.id,
          venda_id: venda.id,
          cliente_id: clienteIdFinal,
          cliente_nome: clienteNomeFinal,
          total: totalPromissoria,
          quantidade_parcelas: Math.max(1, normalizarInt(promissoriaEntry?.parcelas || parcelas || 1)),
          data_primeiro_vencimento: normalizarDataISO(promissoriaEntry?.vencimento || data) || hoje(),
          intervalo_dias: 30,
          observacao: observacao || '',
          criado_por: req.user.id,
          forma_pagamento: 'Promissória'
        });
      } else if (deveGerarFinanceiroVenda({ conta_receber, pagamento: pagamentoPrincipal, status_pagamento: statusFinal, parcelas })) {
        // Retrocompatibilidade: venda sem split mas com conta_receber explícita
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
          forma_pagamento: pagamentoPrincipal || 'Promissória'
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

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[venda-criar] status-cr:', e.message); }

      // Calcula comissão em background — não bloqueia resposta; erro é logado com contexto
      calcularComissaoVenda(pool, {
        vendaId: venda.id,
        usuarioId: req.user.id,
        empresaId: empresaResolvida.id
      }).catch((e) => console.error(
        `[comissao] falha ao calcular venda=${venda.id} usuario=${req.user.id} empresa=${empresaResolvida.id}:`,
        e.message
      ));

      // Acumula pontos de fidelidade em background (só se houver cliente vinculado)
      if (clienteIdFinal) {
        acumularPontosFidelidade(pool, {
          empresaId: empresaResolvida.id,
          clienteId: clienteIdFinal,
          vendaId:   venda.id,
          totalVenda: totalFinal
        }).catch((e) => console.error(`[fidelidade] falha venda=${venda.id}:`, e.message));
      }

      // Notifica integração contábil em background (com 1 retry após 5s em falha transitória)
      dispararWebhookComRetry(pool, empresaResolvida.id, 'venda.criada', {
        id: venda.id, total: totalFinal,
        cliente: clienteNomeFinal, pagamento: pagamentoPrincipal || 'Dinheiro'
      }).catch((e) => console.error(`[webhook-contabil] venda=${venda.id}:`, e.message));

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

  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'vendas', 'editar'), async (req, res) => {
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

      const vendaResult = req.user.is_saas_owner
        ? await client.query(`SELECT * FROM vendas WHERE id = $1 LIMIT 1`, [id])
        : await client.query(
            `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
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
          `SELECT * FROM clientes WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND deletado_em IS NULL LIMIT 1`,
          [clienteIdFinal, empresaResolvida.id, empresaResolvida.nome]
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
        WHERE id = $14 AND (empresa_id = $15 OR (empresa_id IS NULL AND empresa = $1))
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

      const somaItens = await inserirItensVendaEBaixarEstoque({
        client,
        vendaId: id,
        empresaResolvida,
        itens,
        usuarioId: req.user.id,
        clienteId: clienteIdFinal ? Number(clienteIdFinal) : null
      });

      // Confere se o total informado bate com a soma real dos itens (com tolerância de arredondamento)
      const totalEsperadoEdicao = Number((somaItens - descontoFinal + acrescimoFinal).toFixed(2));
      const toleranciaTotalEdicao = Math.max(0.05, itens.length * 0.01);
      if (Math.abs(totalEsperadoEdicao - totalFinal) > toleranciaTotalEdicao) {
        await client.query('ROLLBACK');
        return erro(res, 400, `Total da venda (R$ ${totalFinal.toFixed(2)}) não corresponde à soma dos itens com desconto/acréscimo (R$ ${totalEsperadoEdicao.toFixed(2)}).`);
      }

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

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[venda-editar] status-cr:', e.message); }

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

  router.patch('/:id/observacao', auth, requirePermissao(pool, 'vendas', 'editar'), async (req, res) => {
    try {
      if (!podeGerenciarVendas(req)) {
        return erro(res, 403, 'Sem permissão para editar vendas');
      }

      const id = Number(req.params.id);
      const { empresa, observacao } = req.body;

      if (!id) {
        return erro(res, 400, 'Venda inválida');
      }

      const vendaResult = req.user.is_saas_owner
        ? await pool.query(`SELECT * FROM vendas WHERE id = $1 LIMIT 1`, [id])
        : await pool.query(
            `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

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
        AND (empresa_id = $3 OR (empresa_id IS NULL AND empresa = $4))
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

  router.get('/:empresa', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
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
      let idx = params.length + 1;

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
        const buscaEsc = busca.replace(/[%_\\]/g, '\\$&');
        sql += ` AND (
          LOWER(COALESCE(v.cliente_nome,'')) LIKE $${idx}
          OR LOWER(COALESCE(v.observacao,'')) LIKE $${idx}
          OR CAST(v.id AS TEXT) LIKE $${idx}
        )`;
        params.push(`%${buscaEsc}%`);
        idx++;
      }

      sql += adicionarFiltroPeriodo({
        campo: 'v.data',
        params,
        dataInicial,
        dataFinal,
        castDate: false
      });

      const limite = Math.min(normalizarInt(req.query.limit || 100), 500);
      const offset = Math.max(normalizarInt(req.query.offset || 0), 0);
      const filterParams = [...params];
      const limIdx = filterParams.length + 1;
      const offIdx = filterParams.length + 2;

      const [countResult, result] = await Promise.all([
        pool.query(sql.replace('SELECT v.*', 'SELECT COUNT(*) AS total'), filterParams),
        pool.query(
          sql + ` ORDER BY v.id DESC LIMIT $${limIdx} OFFSET $${offIdx}`,
          [...filterParams, limite, offset]
        )
      ]);

      return res.json({
        sucesso: true,
        dados: result.rows.map((row) => ({
          ...row,
          subtotal: Number(row.subtotal || 0),
          desconto: Number(row.desconto || 0),
          acrescimo: Number(row.acrescimo || 0),
          total: Number(row.total || 0),
          parcelas: Number(row.parcelas || 1)
        })),
        total:  Number(countResult.rows[0]?.total || 0),
        limite,
        offset
      });
    } catch (error) {
      console.error('Erro real ao buscar vendas:', error);
      return erro(res, 500, 'Erro ao buscar vendas');
    }
  });

  router.get('/detalhe/:id', auth, requirePermissao(pool, 'vendas', 'ver'), async (req, res) => {
    try {
      const id = Number(req.params.id);

      const vendaResult = req.user.is_saas_owner
        ? await pool.query(`SELECT * FROM vendas WHERE id = $1`, [id])
        : await pool.query(
            `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
            [id, req.user.empresa_id || 0, req.user.empresa || '']
          );

      if (vendaResult.rowCount === 0) {
        return erro(res, 404, 'Venda não encontrada');
      }

      const venda = vendaResult.rows[0];

      const empresaBase = venda.empresa_id || venda.empresa;

      const empresaResolvida = await validarAcessoEmpresa(req, empresaBase);

      if (!empresaResolvida) {
        return erro(res, 403, 'Sem acesso');
      }

      const [itensResult] = await Promise.all([
        pool.query(
          `SELECT vi.* FROM venda_itens vi
           WHERE vi.venda_id = $1
             AND (vi.empresa_id = $2 OR (vi.empresa_id IS NULL AND vi.empresa = $3))
           ORDER BY vi.id ASC`,
          [id, empresaResolvida.id, empresaResolvida.nome]
        ),
        atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id).catch(e => console.error('[venda-detalhe] status-cr:', e.message))
      ]);

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
        pagamentos: venda.pagamentos
          ? (typeof venda.pagamentos === 'string' ? JSON.parse(venda.pagamentos) : venda.pagamentos)
          : [{ forma: venda.pagamento || 'Dinheiro', valor: Number(venda.total || 0) }],
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

  router.delete('/:id', auth, writeRateLimiter, requirePermissao(pool, 'vendas', 'deletar'), async (req, res) => {
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

      const vendaResult = await client.query(
        `SELECT * FROM vendas WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) LIMIT 1`,
        [id, req.user.empresa_id || 0, req.user.empresa || '']
      );

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
        WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))
        `,
        [id, empresaResolvida.id, empresaResolvida.nome]
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

      try { await atualizarStatusContasReceberPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[venda-excluir] status-cr:', e.message); }

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
