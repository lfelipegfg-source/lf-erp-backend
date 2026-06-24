const express = require('express');
const { requirePermissao } = require('../utils/permissoes');

const {
  normalizarDecimal,
  normalizarInt,
  normalizarDataISO,
  hoje,
  addDias,
  validarECalcularTotalItens
} = require('../utils/normalizadores');

module.exports = function ({
  auth,
  pool,
  writeRateLimiter,
  validarAcessoEmpresa,
  podeGerenciarCompras,
  registrarMovimentacaoEstoque,
  atualizarStatusContasPagarPorEmpresa,
  registrarAuditoria
}) {
  const router = express.Router();

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

  router.post('/', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'criar'), async (req, res) => {
    if (!podeGerenciarCompras(req)) {
      return erro(res, 403, 'Sem permissão para compras');
    }

    const {
      empresa,
      fornecedor_id,
      data,
      pagamento,
      parcelas,
      observacao,
      primeiro_vencimento,
      itens
    } = req.body;

    if (!fornecedor_id || !data || !pagamento || !Array.isArray(itens) || itens.length === 0) {
      return erro(res, 400, 'Dados da compra incompletos');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) {
      return erro(res, 403, 'Sem acesso');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const fornecedorResult = await client.query(
        `SELECT * FROM fornecedores WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [fornecedor_id, empresaResolvida.id]
      );

      if (fornecedorResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Fornecedor não encontrado');
      }

      const fornecedor = fornecedorResult.rows[0];

      const totalCalculado = validarECalcularTotalItens(itens);

      if (totalCalculado === null) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Itens da compra inválidos');
      }

      const pagamentoNormalizado = String(pagamento || '').toLowerCase();
      const geraContaPagar =
        pagamentoNormalizado === 'boleto' ||
        pagamentoNormalizado === 'promissoria' ||
        pagamentoNormalizado === 'duplicata mercantil';
      const parcelasFinal = geraContaPagar ? Math.max(1, normalizarInt(parcelas || 1)) : 1;

      const compraResult = await client.query(
        `INSERT INTO compras
        (empresa, empresa_id, fornecedor_id, data, total, observacao, gerar_conta_pagar, pagamento, status, criado_por, criado_em, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finalizada', $9, NOW(), NOW())
        RETURNING *`,
        [
          empresaResolvida.nome,
          empresaResolvida.id,
          fornecedor_id,
          normalizarDataISO(data) || hoje(),
          totalCalculado,
          observacao || '',
          geraContaPagar,
          pagamentoNormalizado || 'dinheiro',
          req.user.id
        ]
      );

      const compra = compraResult.rows[0];

      // Pré-busca todos os produtos em 1 SELECT FOR UPDATE com ids ordenados (evita deadlock)
      const idsProdutos = [...new Set(itens.map(i => Number(i.produto_id)))].sort((a, b) => a - b);
      const produtosResult = await client.query(
        `SELECT * FROM produtos WHERE id = ANY($1::int[]) AND empresa_id = $2 AND deletado_em IS NULL FOR UPDATE`,
        [idsProdutos, empresaResolvida.id]
      );
      const produtosMap = Object.fromEntries(produtosResult.rows.map(p => [Number(p.id), p]));

      for (const item of itens) {
        const produtoId = Number(item.produto_id);
        const quantidade = normalizarInt(item.quantidade);
        const custoUnitario = normalizarDecimal(
          item.custo_unitario || item.preco_unitario || item.custo
        );
        const subtotal = Number((quantidade * custoUnitario).toFixed(2));

        const produto = produtosMap[produtoId];

        if (!produto) {
          await client.query('ROLLBACK');
          return erro(res, 404, `Produto ${produtoId} não encontrado`);
        }

        const estoqueAtual = normalizarInt(produto.estoque);
        const novoEstoque = estoqueAtual + quantidade;

        const custoAtual = normalizarDecimal(produto.custo_medio || produto.custo || 0);
        const valorEstoqueAtual = Number((estoqueAtual * custoAtual).toFixed(2));
        const valorNovaCompra = Number((quantidade * custoUnitario).toFixed(2));

        const novoCustoMedio =
          novoEstoque > 0
            ? Number(((valorEstoqueAtual + valorNovaCompra) / novoEstoque).toFixed(2))
            : custoUnitario;

        const precoProduto = normalizarDecimal(produto.preco || 0);
        const lucroUnitario = Number((precoProduto - novoCustoMedio).toFixed(2));
        const margemLucroRaw =
          novoCustoMedio > 0 ? Number(((lucroUnitario / novoCustoMedio) * 100).toFixed(2)) : 0;
        const margemLucro = Math.min(Math.max(margemLucroRaw, -9999), 9999); // cap para evitar distorção no BI

        await client.query(
          `INSERT INTO compra_itens
          (
            compra_id,
    empresa,
    empresa_id,
    produto_id,
    produto_nome,
    quantidade,
    custo_unitario,
    subtotal
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            compra.id,
            empresaResolvida.nome,
            empresaResolvida.id,
            produto.id,
            produto.nome,
            quantidade,
            custoUnitario,
            subtotal
          ]
        );

        await client.query(
          `UPDATE produtos
          SET estoque = $1,
              custo = $2,
              custo_unitario = $3,
              custo_medio = $4,
              lucro_unitario = $5,
              margem_lucro = $6,
              atualizado_em = NOW()
          WHERE id = $7 AND empresa_id = $8`,
          [
            novoEstoque,
            custoUnitario,
            custoUnitario,
            novoCustoMedio,
            lucroUnitario,
            margemLucro,
            produto.id,
            empresaResolvida.id
          ]
        );

        // Atualiza mapa para itens duplicados na mesma compra
        produtosMap[produtoId] = { ...produto, estoque: novoEstoque, custo_medio: novoCustoMedio };

        if (typeof registrarMovimentacaoEstoque === 'function') {
          await registrarMovimentacaoEstoque({
            empresa: empresaResolvida.nome,
            empresa_id: empresaResolvida.id,
            produto_id: produto.id,
            tipo: 'entrada_compra',
            quantidade,
            observacao: `Entrada por compra #${compra.id}`,
            referencia_tipo: 'compra',
            referencia_id: compra.id,
            usuario_id: req.user.id,
            client
          });
        }
      }

      if (geraContaPagar) {
        const dataPrimeiroVencimento =
          normalizarDataISO(primeiro_vencimento || data) || normalizarDataISO(data) || hoje();

        const intervaloDias = 30;
        const valorBase = Number((totalCalculado / parcelasFinal).toFixed(2));
        let acumulado = 0;

        for (let i = 1; i <= parcelasFinal; i++) {
          let valorParcela = valorBase;

          if (i === parcelasFinal) {
            valorParcela = Number((totalCalculado - acumulado).toFixed(2));
          }

          acumulado = Number((acumulado + valorParcela).toFixed(2));

          const vencimento =
            i === 1
              ? dataPrimeiroVencimento
              : addDias(dataPrimeiroVencimento, (i - 1) * intervaloDias);

          await client.query(
            `INSERT INTO contas_pagar
  (
    empresa,
    empresa_id,
    fornecedor_id,
    fornecedor_nome,
    compra_id,
    descricao,
    parcela,
    total_parcelas,
    valor,
    data_vencimento,
    data_pagamento,
    status,
    forma_pagamento,
    observacao,
    criado_por,
    criado_em,
    atualizado_em
  )
  VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    NULL,
    'pendente',
    $11,
    $12,
    $13,
    NOW(),
    NOW()
  )`,
            [
              empresaResolvida.nome,
              empresaResolvida.id,
              fornecedor.id,
              fornecedor.nome,
              compra.id,
              `Parcela ${i}/${parcelasFinal} - Compra #${compra.id}`,
              i,
              parcelasFinal,
              valorParcela,
              vencimento,
              pagamentoNormalizado,
              observacao || '',
              req.user.id
            ]
          );
        }
      }

      await client.query('COMMIT');

      await registrarAuditoria({
        empresa: empresaResolvida.nome,
        empresa_id: empresaResolvida.id,
        usuario_id: req.user.id,
        usuario_nome: req.user.nome || '',
        modulo: 'compras',
        acao: 'cadastro',
        referencia_id: compra.id,
        dados_novos: {
          fornecedor_id,
          fornecedor_nome: fornecedor.nome,
          data,
          total: totalCalculado,
          pagamento: pagamentoNormalizado,
          parcelas: parcelasFinal,
          gerar_conta_pagar: geraContaPagar,
          itens: itens.map((i) => ({
            produto_id: i.produto_id,
            quantidade: i.quantidade,
            custo_unitario: i.custo_unitario || i.preco_unitario || i.custo
          }))
        },
        req
      });

      if (typeof atualizarStatusContasPagarPorEmpresa === 'function') {
        try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[compras-criar] status-cp:', e.message); }
      }

      return ok(res, {
        compra_id: compra.id,
        dados: {
          compra_id: compra.id
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao criar compra:', error);
      return erro(res, 500, 'Erro ao criar compra');
    } finally {
      client.release();
    }
  });

  router.put('/:id', auth, writeRateLimiter, requirePermissao(pool, 'compras', 'editar'), async (req, res) => {
    if (!podeGerenciarCompras(req)) return erro(res, 403, 'Sem permissão para compras');

    const id = Number(req.params.id);
    const { empresa, fornecedor_id, data, pagamento, parcelas, observacao, primeiro_vencimento, itens } = req.body;

    if (!id || !fornecedor_id || !data || !pagamento || !Array.isArray(itens) || itens.length === 0) {
      return erro(res, 400, 'Dados da compra incompletos');
    }

    const empresaResolvida = await validarAcessoEmpresa(req, empresa);
    if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const compraAtual = await client.query(
        `SELECT * FROM compras WHERE id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (compraAtual.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Compra não encontrada');
      }

      const contasPagas = await client.query(
        `SELECT COUNT(*) AS total FROM contas_pagar
         WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND LOWER(status) = 'pago'`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      if (Number(contasPagas.rows[0].total) > 0) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Não é possível editar uma compra com contas a pagar já pagas');
      }

      // Reverter estoque dos itens originais
      const itensOriginais = await client.query(
        `SELECT * FROM compra_itens WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      // Pré-busca todos os produtos originais em 1 SELECT FOR UPDATE (ORDER BY id = lock consistente)
      const idsOriginais = [...new Set(itensOriginais.rows.map(r => Number(r.produto_id)))].sort((a, b) => a - b);
      if (idsOriginais.length > 0) {
        const prodsOriginaisResult = await client.query(
          `SELECT id, estoque, custo_medio, custo FROM produtos WHERE id = ANY($1::int[]) AND empresa_id = $2 FOR UPDATE`,
          [idsOriginais, empresaResolvida.id]
        );
        const prodsOriginaisMap = Object.fromEntries(prodsOriginaisResult.rows.map(p => [Number(p.id), p]));

        for (const item of itensOriginais.rows) {
          const prod = prodsOriginaisMap[Number(item.produto_id)];
          if (!prod) continue;
          const estoqueAtual  = normalizarInt(prod.estoque);
          const custoAtual    = normalizarDecimal(prod.custo_medio || prod.custo || 0);
          const qtdOriginal   = normalizarInt(item.quantidade);
          const custoOriginal = normalizarDecimal(item.custo_unitario);
          const estoqueRevertido = Math.max(0, estoqueAtual - qtdOriginal);
          const custoRevertido = (() => {
            if (estoqueRevertido <= 0) return custoAtual;
            const calc = (estoqueAtual * custoAtual - qtdOriginal * custoOriginal) / estoqueRevertido;
            return calc > 0 ? Number(calc.toFixed(2)) : custoAtual;
          })();

          await client.query(
            `UPDATE produtos SET estoque = $1, custo_medio = $2, atualizado_em = NOW() WHERE id = $3 AND empresa_id = $4`,
            [estoqueRevertido, custoRevertido, Number(item.produto_id), empresaResolvida.id]
          );
          // Atualiza o mapa para itens duplicados na mesma compra
          prodsOriginaisMap[Number(item.produto_id)] = { ...prod, estoque: estoqueRevertido, custo_medio: custoRevertido };
        }
      }

      // Limpar dados originais
      await client.query(
        `DELETE FROM compra_itens WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      await client.query(
        `DELETE FROM movimentacoes_estoque WHERE referencia_tipo = 'compra' AND referencia_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3))`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );
      await client.query(
        `DELETE FROM contas_pagar WHERE compra_id = $1 AND (empresa_id = $2 OR (empresa_id IS NULL AND empresa = $3)) AND LOWER(status) != 'pago'`,
        [id, empresaResolvida.id, empresaResolvida.nome]
      );

      const totalCalculado = validarECalcularTotalItens(itens);
      if (totalCalculado === null) {
        await client.query('ROLLBACK');
        return erro(res, 400, 'Itens da compra inválidos');
      }

      const pagamentoNormalizado = String(pagamento || '').toLowerCase();
      const geraContaPagar = pagamentoNormalizado === 'boleto' || pagamentoNormalizado === 'promissoria' || pagamentoNormalizado === 'duplicata mercantil';
      const parcelasFinal = geraContaPagar ? Math.max(1, normalizarInt(parcelas || 1)) : 1;

      // Buscar fornecedor
      const fornecedorResult = await client.query(
        `SELECT * FROM fornecedores WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
        [fornecedor_id, empresaResolvida.id]
      );
      if (fornecedorResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return erro(res, 404, 'Fornecedor não encontrado');
      }
      const fornecedor = fornecedorResult.rows[0];

      // Atualizar compra
      await client.query(
        `UPDATE compras SET fornecedor_id=$1, data=$2, total=$3, observacao=$4, pagamento=$5, gerar_conta_pagar=$6, atualizado_em=NOW() WHERE id=$7 AND empresa_id=$8`,
        [fornecedor_id, normalizarDataISO(data) || hoje(), totalCalculado, observacao || '', pagamentoNormalizado, geraContaPagar, id, empresaResolvida.id]
      );

      // Aplicar novos itens — pré-busca todos em 1 SELECT FOR UPDATE (ORDER BY id = lock consistente)
      const idsNovos = [...new Set(itens.map(i => Number(i.produto_id)))].sort((a, b) => a - b);
      const prodsNovosResult = await client.query(
        `SELECT * FROM produtos WHERE id = ANY($1::int[]) AND empresa_id = $2 AND deletado_em IS NULL FOR UPDATE`,
        [idsNovos, empresaResolvida.id]
      );
      const prodsNovosMap = Object.fromEntries(prodsNovosResult.rows.map(p => [Number(p.id), p]));

      // Valida todos os produtos antes de iniciar as escritas
      for (const item of itens) {
        if (!prodsNovosMap[Number(item.produto_id)]) {
          await client.query('ROLLBACK');
          return erro(res, 404, `Produto ${Number(item.produto_id)} não encontrado`);
        }
      }

      for (const item of itens) {
        const produtoId     = Number(item.produto_id);
        const quantidade    = normalizarInt(item.quantidade);
        const custoUnitario = normalizarDecimal(item.custo_unitario || item.custo);
        const produto       = prodsNovosMap[produtoId];

        const estoqueAtual  = normalizarInt(produto.estoque);
        const novoEstoque   = estoqueAtual + quantidade;
        const custoAtual    = normalizarDecimal(produto.custo_medio || produto.custo || 0);
        const novoCustoMedio = novoEstoque > 0
          ? Number(((estoqueAtual * custoAtual + quantidade * custoUnitario) / novoEstoque).toFixed(2))
          : custoUnitario;
        const precoProduto  = normalizarDecimal(produto.preco || 0);
        const lucroUnitario  = Number((precoProduto - novoCustoMedio).toFixed(2));
        const margemLucroRaw = novoCustoMedio > 0 ? Number(((lucroUnitario / novoCustoMedio) * 100).toFixed(2)) : 0;
        const margemLucro    = Math.min(Math.max(margemLucroRaw, -9999), 9999);

        await client.query(
          `INSERT INTO compra_itens (compra_id, empresa, empresa_id, produto_id, produto_nome, quantidade, custo_unitario, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, empresaResolvida.nome, empresaResolvida.id, produto.id, produto.nome, quantidade, custoUnitario, Number((quantidade * custoUnitario).toFixed(2))]
        );

        await client.query(
          `UPDATE produtos SET estoque=$1, custo=$2, custo_unitario=$3, custo_medio=$4, lucro_unitario=$5, margem_lucro=$6, atualizado_em=NOW() WHERE id=$7 AND empresa_id=$8`,
          [novoEstoque, custoUnitario, custoUnitario, novoCustoMedio, lucroUnitario, margemLucro, produto.id, empresaResolvida.id]
        );

        // Atualiza mapa para produto duplicado na mesma compra
        prodsNovosMap[produtoId] = { ...produto, estoque: novoEstoque, custo_medio: novoCustoMedio };

        if (typeof registrarMovimentacaoEstoque === 'function') {
          await registrarMovimentacaoEstoque({
            empresa: empresaResolvida.nome, empresa_id: empresaResolvida.id,
            produto_id: produto.id, tipo: 'entrada_compra', quantidade,
            observacao: `Entrada por compra #${id} (editada)`,
            referencia_tipo: 'compra', referencia_id: id, usuario_id: req.user.id, client
          });
        }
      }

      // Recriar contas_pagar se necessário
      if (geraContaPagar) {
        const dataPrimeiroVencimento = normalizarDataISO(primeiro_vencimento || data) || normalizarDataISO(data) || hoje();
        const valorBase = Number((totalCalculado / parcelasFinal).toFixed(2));
        let acumulado = 0;
        for (let i = 1; i <= parcelasFinal; i++) {
          let valorParcela = valorBase;
          if (i === parcelasFinal) valorParcela = Number((totalCalculado - acumulado).toFixed(2));
          acumulado = Number((acumulado + valorParcela).toFixed(2));
          const vencimento = i === 1 ? dataPrimeiroVencimento : addDias(dataPrimeiroVencimento, (i - 1) * 30);
          await client.query(
            `INSERT INTO contas_pagar (empresa, empresa_id, fornecedor_id, fornecedor_nome, compra_id, descricao, parcela, total_parcelas, valor, data_vencimento, data_pagamento, status, forma_pagamento, observacao, criado_por, criado_em, atualizado_em)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,'pendente',$11,$12,$13,NOW(),NOW())`,
            [empresaResolvida.nome, empresaResolvida.id, fornecedor.id, fornecedor.nome, id,
             `Parcela ${i}/${parcelasFinal} - Compra #${id}`, i, parcelasFinal, valorParcela, vencimento,
             pagamentoNormalizado, observacao || '', req.user.id]
          );
        }
      }

      await client.query('COMMIT');

      await registrarAuditoria({
        empresa: empresaResolvida.nome, empresa_id: empresaResolvida.id,
        usuario_id: req.user.id, usuario_nome: req.user.nome || '',
        modulo: 'compras', acao: 'edicao', referencia_id: id,
        dados_novos: { fornecedor_id, data, total: totalCalculado, pagamento: pagamentoNormalizado, parcelas: parcelasFinal },
        req
      });

      if (typeof atualizarStatusContasPagarPorEmpresa === 'function') {
        try { await atualizarStatusContasPagarPorEmpresa(empresaResolvida.nome, empresaResolvida.id); } catch (e) { console.error('[compras-editar] status-cp:', e.message); }
      }

      return ok(res, { mensagem: 'Compra atualizada com sucesso' });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro real ao editar compra:', error);
      return erro(res, 500, 'Erro ao editar compra');
    } finally {
      client.release();
    }
  });

  // ── POST /compras/importar-xml ──────────────────────────────────────────────
  // Faz o parse de um XML de NF-e do fornecedor e retorna os dados estruturados.
  // Não cria nada no banco — apenas extrai e retorna para o frontend confirmar.

  function xmlSanitize(xml) {
    if (!xml) return '';
    // Remove comentários XML
    let s = xml.replace(/<!--[\s\S]*?-->/g, '');
    // Expande seções CDATA: <![CDATA[content]]> → content
    s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    return s;
  }

  function xmlTag(xml, tag) {
    if (!xml) return null;
    const s = xmlSanitize(xml);
    // Aceita tanto <tag> quanto <ns:tag> (namespace prefix)
    const openRe = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:[\\s>])`);
    const openMatch = openRe.exec(s);
    if (!openMatch) return null;
    const closeAngle = s.indexOf('>', openMatch.index);
    if (closeAngle === -1) return null;
    // self-closing tag?
    if (s[closeAngle - 1] === '/') return null;
    const closeRe = new RegExp(`</(?:[\\w.-]+:)?${tag}>`);
    const rest = s.slice(closeAngle + 1);
    const closeMatch = closeRe.exec(rest);
    if (!closeMatch) return null;
    return rest.slice(0, closeMatch.index).trim() || null;
  }

  function xmlTagAll(xml, tag) {
    if (!xml) return [];
    const s = xmlSanitize(xml);
    const results = [];
    const openRe  = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:[\\s>])`, 'g');
    const closeRe = new RegExp(`</(?:[\\w.-]+:)?${tag}>`);
    let openMatch;
    while ((openMatch = openRe.exec(s)) !== null && results.length < 1000) {
      const closeAngle = s.indexOf('>', openMatch.index);
      if (closeAngle === -1) break;
      if (s[closeAngle - 1] === '/') continue; // self-closing
      const rest = s.slice(closeAngle + 1);
      const closeMatch = closeRe.exec(rest);
      if (!closeMatch) break;
      results.push(rest.slice(0, closeMatch.index).trim());
      openRe.lastIndex = closeAngle + 1 + closeMatch.index + closeMatch[0].length;
    }
    return results;
  }

  const FORMA_PGTO_NF = {
    '01': 'dinheiro', '02': 'cheque', '03': 'cartao credito',
    '04': 'cartao debito', '05': 'credito loja', '10': 'vale alimentacao',
    '11': 'vale refeicao', '12': 'vale presente', '13': 'vale combustivel',
    '14': 'duplicata mercantil', '15': 'boleto', '17': 'pix', '90': 'sem pagamento', '99': 'outros'
  };

  router.post('/importar-xml', auth, requirePermissao(pool, 'compras', 'criar'), async (req, res) => {
    try {
      const empresaResolvida = await validarAcessoEmpresa(req, req.body.empresa);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const { conteudo } = req.body;
      if (!conteudo) return erro(res, 400, 'Conteúdo XML não informado');

      // ── Emitente (fornecedor) ────────────────────────────────────────────
      const emitBloco = xmlTag(conteudo, 'emit');
      const cnpjFornecedor = emitBloco ? (xmlTag(emitBloco, 'CNPJ') || xmlTag(emitBloco, 'CPF') || '') : '';
      const nomeFornecedor = emitBloco ? (xmlTag(emitBloco, 'xNome') || '') : '';

      // ── Identificação ────────────────────────────────────────────────────
      const ideBloco = xmlTag(conteudo, 'ide');
      const numeroNF = ideBloco ? (xmlTag(ideBloco, 'nNF') || '') : '';
      const dhEmi    = ideBloco ? (xmlTag(ideBloco, 'dhEmi') || xmlTag(ideBloco, 'dEmi') || '') : '';
      const dataEmissao = dhEmi ? dhEmi.slice(0, 10) : null;

      // ── Total ────────────────────────────────────────────────────────────
      const totalBloco = xmlTag(conteudo, 'ICMSTot');
      const totalNF = totalBloco ? parseFloat(xmlTag(totalBloco, 'vNF') || '0') : 0;

      // ── Forma de pagamento ───────────────────────────────────────────────
      const detPagBloco = xmlTag(conteudo, 'detPag') || xmlTag(conteudo, 'pag') || '';
      const tPag = xmlTag(detPagBloco, 'tPag') || '99';
      const formaPagamento = FORMA_PGTO_NF[tPag] || 'outros';

      // ── Itens ────────────────────────────────────────────────────────────
      const detBlocos = xmlTagAll(conteudo, 'det');
      const itens = detBlocos.map((det) => {
        const prod = xmlTag(det, 'prod') || det;
        const codigo  = xmlTag(prod, 'cProd') || '';
        const nome    = xmlTag(prod, 'xProd') || 'Produto';
        const ncm     = xmlTag(prod, 'NCM') || '';
        const unidade = xmlTag(prod, 'uCom') || 'UN';
        const qty     = parseFloat(xmlTag(prod, 'qCom') || '1');
        const vUnit   = parseFloat(xmlTag(prod, 'vUnCom') || '0');
        const vTotal  = parseFloat(xmlTag(prod, 'vProd') || String(qty * vUnit));
        return { codigo, nome, ncm, unidade, quantidade: qty, custo_unitario: vUnit, total: vTotal };
      }).filter(i => i.quantidade > 0);

      if (!itens.length) return erro(res, 400, 'Nenhum item encontrado no XML');

      // Tenta encontrar fornecedor pelo CNPJ
      let fornecedorId = null;
      let fornecedorNome = nomeFornecedor;
      if (cnpjFornecedor) {
        const cnpjLimpo = cnpjFornecedor.replace(/\D/g, '');
        const fRes = await pool.query(
          `SELECT id, nome FROM fornecedores
           WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))
             AND replace(replace(replace(cnpj,'.',''),'-',''),'/','') = $3
             AND deletado_em IS NULL
           LIMIT 1`,
          [empresaResolvida.id, empresaResolvida.nome, cnpjLimpo]
        );
        if (fRes.rowCount > 0) {
          fornecedorId   = fRes.rows[0].id;
          fornecedorNome = fRes.rows[0].nome;
        }
      }

      return ok(res, {
        fornecedor_cnpj: cnpjFornecedor,
        fornecedor_nome: fornecedorNome,
        fornecedor_id:   fornecedorId,
        numero_nf:       numeroNF,
        data_emissao:    dataEmissao,
        total:           totalNF,
        forma_pagamento: formaPagamento,
        itens
      });
    } catch (error) {
      console.error('[compras] importar-xml:', error.message);
      return erro(res, 500, 'Erro ao processar o XML da nota fiscal');
    }
  });

  return router;
};
