/**
 * Exportação Contábil — LF ERP
 * Gera arquivos CSV e EFD (SPED) para entrega ao contador.
 *
 * Rotas (todas requerem autenticação JWT):
 *   GET /exportacao/vendas          — Resumo de vendas (CSV)
 *   GET /exportacao/compras         — Resumo de compras (CSV)
 *   GET /exportacao/contas-receber  — Títulos a receber (CSV)
 *   GET /exportacao/contas-pagar    — Títulos a pagar (CSV)
 *   GET /exportacao/lancamentos     — Lançamentos financeiros (CSV)
 *   GET /exportacao/dre             — DRE simplificada (CSV)
 *   GET /exportacao/efd             — Arquivo EFD/SPED rascunho (TXT)
 *
 * Parâmetros comuns: ?inicio=YYYY-MM-DD&fim=YYYY-MM-DD
 */

module.exports = function ({ auth, pool, validarAcessoEmpresa, adicionarFiltroPeriodo, obterPeriodo, normalizarDecimal, hoje }) {
  const router = require('express').Router();

  // ── Helpers ───────────────────────────────────────────────────────────────

  function csvVal(v) {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[;"\n]/.test(s) ? `"${s}"` : s;
  }

  function csvRow(cols) {
    return cols.map(csvVal).join(';');
  }

  function brlNum(v) {
    return Number(v || 0).toFixed(2).replace('.', ',');
  }

  function dataBR(d) {
    if (!d) return '';
    const s = String(d).substring(0, 10);
    const [y, m, dia] = s.split('-');
    return `${dia}/${m}/${y}`;
  }

  function sendCSV(res, filename, rows) {
    const bom = '﻿';
    const body = bom + rows.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }

  function sendTXT(res, filename, content) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  }

  async function resolveEmpresa(req) {
    return validarAcessoEmpresa(req, null, req.empresa_id);
  }

  // ── GET /exportacao/vendas ────────────────────────────────────────────────

  router.get('/vendas', auth, async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))`;
      where += adicionarFiltroPeriodo({ campo: 'v.data', params, dataInicial, dataFinal, castDate: false });

      const result = await pool.query(
        `SELECT v.id, v.data, v.cliente_nome, v.subtotal, v.desconto, v.acrescimo, v.total,
                v.pagamento, v.status_pagamento, v.parcelas, v.observacao,
                COUNT(vi.id) AS qtd_itens
         FROM vendas v
         LEFT JOIN venda_itens vi ON vi.venda_id = v.id
         ${where}
         GROUP BY v.id
         ORDER BY v.data, v.id`,
        params
      );

      const header = csvRow(['ID','Data','Cliente','Subtotal','Desconto','Acréscimo','Total','Forma Pagamento','Status','Parcelas','Qtd Itens','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, dataBR(r.data), r.cliente_nome,
        brlNum(r.subtotal), brlNum(r.desconto), brlNum(r.acrescimo), brlNum(r.total),
        r.pagamento, r.status_pagamento, r.parcelas, r.qtd_itens, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `vendas_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] vendas:', err.message);
      res.status(500).json({ sucesso: false, erro: err.message });
    }
  });

  // ── GET /exportacao/compras ───────────────────────────────────────────────

  router.get('/compras', auth, async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (c.empresa_id = $1 OR (c.empresa_id IS NULL AND c.empresa = $2))`;
      where += adicionarFiltroPeriodo({ campo: 'c.data', params, dataInicial, dataFinal, castDate: false });

      const result = await pool.query(
        `SELECT c.id, c.data, c.fornecedor_nome, c.subtotal, c.desconto, c.total,
                c.status, c.observacao,
                COUNT(ci.id) AS qtd_itens
         FROM compras c
         LEFT JOIN compra_itens ci ON ci.compra_id = c.id
         ${where}
         GROUP BY c.id
         ORDER BY c.data, c.id`,
        params
      );

      const header = csvRow(['ID','Data','Fornecedor','Subtotal','Desconto','Total','Status','Qtd Itens','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, dataBR(r.data), r.fornecedor_nome,
        brlNum(r.subtotal), brlNum(r.desconto), brlNum(r.total),
        r.status, r.qtd_itens, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `compras_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] compras:', err.message);
      res.status(500).json({ sucesso: false, erro: err.message });
    }
  });

  // ── GET /exportacao/contas-receber ────────────────────────────────────────

  router.get('/contas-receber', auth, async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;
      where += adicionarFiltroPeriodo({ campo: 'data_vencimento', params, dataInicial, dataFinal, castDate: false });

      const result = await pool.query(
        `SELECT id, data_vencimento, data_pagamento, cliente_nome, descricao,
                parcela, total_parcelas, valor, valor_pago, status, forma_pagamento, observacao
         FROM contas_receber
         ${where}
         ORDER BY data_vencimento, id`,
        params
      );

      const header = csvRow(['ID','Vencimento','Pagamento','Cliente','Descrição','Parcela','Total Parcelas','Valor','Valor Pago','Status','Forma Pagamento','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, dataBR(r.data_vencimento), dataBR(r.data_pagamento),
        r.cliente_nome, r.descricao, r.parcela, r.total_parcelas,
        brlNum(r.valor), brlNum(r.valor_pago), r.status, r.forma_pagamento, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `contas_receber_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] contas-receber:', err.message);
      res.status(500).json({ sucesso: false, erro: err.message });
    }
  });

  // ── GET /exportacao/contas-pagar ──────────────────────────────────────────

  router.get('/contas-pagar', auth, async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;
      where += adicionarFiltroPeriodo({ campo: 'data_vencimento', params, dataInicial, dataFinal, castDate: false });

      const result = await pool.query(
        `SELECT id, data_vencimento, data_pagamento, fornecedor, descricao,
                parcela, total_parcelas, valor, valor_pago, status, forma_pagamento, categoria, observacao
         FROM contas_pagar
         ${where}
         ORDER BY data_vencimento, id`,
        params
      );

      const header = csvRow(['ID','Vencimento','Pagamento','Fornecedor','Descrição','Parcela','Total Parcelas','Valor','Valor Pago','Status','Forma Pagamento','Categoria','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, dataBR(r.data_vencimento), dataBR(r.data_pagamento),
        r.fornecedor, r.descricao, r.parcela, r.total_parcelas,
        brlNum(r.valor), brlNum(r.valor_pago), r.status, r.forma_pagamento, r.categoria, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `contas_pagar_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] contas-pagar:', err.message);
      res.status(500).json({ sucesso: false, erro: err.message });
    }
  });

  // ── GET /exportacao/lancamentos ───────────────────────────────────────────

  router.get('/lancamentos', auth, async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const params = [emp.id, emp.nome];
      let where = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;
      where += adicionarFiltroPeriodo({
        campo: `COALESCE(pagamento_data, vencimento)`,
        params, dataInicial, dataFinal, castDate: false
      });

      const result = await pool.query(
        `SELECT id, tipo, categoria, descricao, valor, vencimento, pagamento_data,
                status, forma_pagamento, observacao
         FROM lancamentos_financeiros
         ${where}
         ORDER BY COALESCE(pagamento_data, vencimento), id`,
        params
      );

      const header = csvRow(['ID','Tipo','Categoria','Descrição','Valor','Vencimento','Data Pagamento','Status','Forma Pagamento','Observação']);
      const linhas = result.rows.map((r) => csvRow([
        r.id, r.tipo, r.categoria, r.descricao,
        brlNum(r.valor), dataBR(r.vencimento), dataBR(r.pagamento_data),
        r.status, r.forma_pagamento, r.observacao
      ]));

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `lancamentos_${ini}.csv`, [header, ...linhas]);
    } catch (err) {
      console.error('[exportacao] lancamentos:', err.message);
      res.status(500).json({ sucesso: false, erro: err.message });
    }
  });

  // ── GET /exportacao/dre ───────────────────────────────────────────────────

  router.get('/dre', auth, async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const eId = emp.id; const eNome = emp.nome;

      // Receita bruta de vendas
      const vparam = [eId, eNome];
      let vwhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2))`;
      vwhere += adicionarFiltroPeriodo({ campo: 'data', params: vparam, dataInicial, dataFinal, castDate: false });
      const vr = await pool.query(`SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(desconto),0) AS desconto FROM vendas ${vwhere}`, vparam);

      // CMV
      const cmvr = await pool.query(
        `SELECT COALESCE(SUM(vi.quantidade * COALESCE(vi.custo_unitario,0)),0) AS cmv
         FROM venda_itens vi
         JOIN vendas v ON v.id = vi.venda_id
         WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2))
         ${adicionarFiltroPeriodo({ campo: 'v.data', params: [eId, eNome], dataInicial, dataFinal, castDate: false })}`,
        [eId, eNome]
      );

      // Despesas (lançamentos tipo despesa + contas_pagar pagas)
      const dparam = [eId, eNome];
      let dwhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND LOWER(tipo) = 'despesa'`;
      dwhere += adicionarFiltroPeriodo({ campo: `COALESCE(pagamento_data, vencimento)`, params: dparam, dataInicial, dataFinal, castDate: false });
      const dr = await pool.query(`SELECT COALESCE(SUM(valor),0) AS total FROM lancamentos_financeiros ${dwhere}`, dparam);

      const cpparam = [eId, eNome];
      let cpwhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND LOWER(COALESCE(status,'pendente')) = 'pago'`;
      cpwhere += adicionarFiltroPeriodo({ campo: 'data_pagamento', params: cpparam, dataInicial, dataFinal, castDate: false });
      const cpr = await pool.query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar ${cpwhere}`, cpparam);

      // Receitas extras (lançamentos receita)
      const rparam = [eId, eNome];
      let rwhere = `WHERE (empresa_id = $1 OR (empresa_id IS NULL AND empresa = $2)) AND LOWER(tipo) = 'receita'`;
      rwhere += adicionarFiltroPeriodo({ campo: `COALESCE(pagamento_data, vencimento)`, params: rparam, dataInicial, dataFinal, castDate: false });
      const rr = await pool.query(`SELECT COALESCE(SUM(valor),0) AS total FROM lancamentos_financeiros ${rwhere}`, rparam);

      const receitaBruta   = normalizarDecimal(vr.rows[0].total);
      const descontoVendas = normalizarDecimal(vr.rows[0].desconto);
      const receitaLiquida = receitaBruta - descontoVendas;
      const cmv            = normalizarDecimal(cmvr.rows[0].cmv);
      const lucroBruto     = receitaLiquida - cmv;
      const despesasLanc   = normalizarDecimal(dr.rows[0].total);
      const despesasCP     = normalizarDecimal(cpr.rows[0].total);
      const totalDespesas  = despesasLanc + despesasCP;
      const receitaExtra   = normalizarDecimal(rr.rows[0].total);
      const resultadoOp    = lucroBruto - totalDespesas + receitaExtra;

      const periodo = `${dataBR(dataInicial || hoje())} a ${dataBR(dataFinal || hoje())}`;

      const linhas = [
        csvRow(['DRE Simplificada', emp.nome]),
        csvRow(['Período', periodo]),
        csvRow(['', '']),
        csvRow(['DESCRIÇÃO', 'VALOR (R$)']),
        csvRow(['(+) Receita Bruta de Vendas', brlNum(receitaBruta)]),
        csvRow(['(-) Descontos Concedidos', brlNum(descontoVendas)]),
        csvRow(['(=) Receita Líquida', brlNum(receitaLiquida)]),
        csvRow(['(-) CMV (Custo das Mercadorias Vendidas)', brlNum(cmv)]),
        csvRow(['(=) Lucro Bruto', brlNum(lucroBruto)]),
        csvRow(['(-) Despesas Operacionais (lançamentos)', brlNum(despesasLanc)]),
        csvRow(['(-) Contas a Pagar Liquidadas', brlNum(despesasCP)]),
        csvRow(['(+) Receitas Extras / Financeiras', brlNum(receitaExtra)]),
        csvRow(['(=) RESULTADO OPERACIONAL', brlNum(resultadoOp)])
      ];

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendCSV(res, `dre_${ini}.csv`, linhas);
    } catch (err) {
      console.error('[exportacao] dre:', err.message);
      res.status(500).json({ sucesso: false, erro: err.message });
    }
  });

  // ── GET /exportacao/efd ───────────────────────────────────────────────────
  // Gera rascunho de arquivo EFD (SPED) para entrega ao contador.
  // Inclui blocos 0, C (NF-e emitidas), 9.

  router.get('/efd', auth, async (req, res) => {
    try {
      const emp = await resolveEmpresa(req);
      if (!emp) return res.status(403).json({ sucesso: false, erro: 'Sem acesso' });

      const { dataInicial, dataFinal } = obterPeriodo(req);
      const dtIni = (dataInicial || hoje()).substring(0, 10).replace(/-/g, '');
      const dtFin = (dataFinal   || hoje()).substring(0, 10).replace(/-/g, '');

      // Participantes: clientes com vendas no período
      const partParams = [emp.id, emp.nome];
      let partWhere = `WHERE (v.empresa_id = $1 OR (v.empresa_id IS NULL AND v.empresa = $2)) AND v.cliente_id IS NOT NULL`;
      partWhere += adicionarFiltroPeriodo({ campo: 'v.data', params: partParams, dataInicial, dataFinal, castDate: false });

      const partResult = await pool.query(
        `SELECT DISTINCT c.id, c.nome, c.cpf_cnpj, c.endereco, c.cidade, c.uf
         FROM vendas v
         JOIN clientes c ON c.id = v.cliente_id
         ${partWhere}
         LIMIT 500`,
        partParams
      );

      // NF-e emitidas no período
      const nfeParams = [emp.id];
      let nfeWhere = `WHERE empresa_id = $1 AND status NOT IN ('cancelada','rejeitada')`;
      nfeWhere += adicionarFiltroPeriodo({ campo: 'data_emissao', params: nfeParams, dataInicial, dataFinal, castDate: false });

      const nfeResult = await pool.query(
        `SELECT numero, serie, chave_acesso, data_emissao, valor_total,
                destinatario_nome, destinatario_cpf_cnpj, cfop, natureza_operacao
         FROM nfe
         ${nfeWhere}
         ORDER BY data_emissao, numero`,
        nfeParams
      ).catch(() => ({ rows: [] }));

      // Monta arquivo EFD
      const linhas = [];
      let totalRegs = 0;

      function reg(linha) {
        linhas.push(`|${linha}|`);
        totalRegs++;
      }

      // Bloco 0
      reg(`0000|013|0|${dtIni}|${dtFin}|${emp.nome}|${emp.cnpj || '00000000000000'}|${emp.uf || 'CE'}|0|0|0|0|0|0|S|`);
      reg(`0001|0|`);
      reg(`0100|${emp.nome}|${emp.cnpj || ''}||||||||`);

      // Participantes
      partResult.rows.forEach((p, i) => {
        reg(`0150|${String(i + 1).padStart(4,'0')}|${p.nome}|${p.cpf_cnpj ? '1' : '2'}|${p.cpf_cnpj || ''}||${p.uf || ''}|${p.cidade || ''}|`);
      });

      reg(`0990|${partResult.rows.length + 3}|`);

      // Bloco C — documentos fiscais (NF-e)
      reg(`C001|0|`);
      nfeResult.rows.forEach((nf) => {
        const dtNF = String(nf.data_emissao || '').substring(0, 10).replace(/-/g, '');
        reg(`C100|0|0||55|${nf.serie || '001'}|${nf.numero}|${nf.chave_acesso || ''}|${dtNF}|${nf.destinatario_nome || ''}|${nf.destinatario_cpf_cnpj || ''}|${brlNum(nf.valor_total)}|0|0|0|0|0|0|0|0|0|`);
      });
      reg(`C990|${nfeResult.rows.length + 2}|`);

      // Bloco 9 — encerramento
      reg(`9001|0|`);
      reg(`9900|0000|1|`);
      reg(`9900|0001|1|`);
      reg(`9900|0100|1|`);
      if (partResult.rows.length > 0) reg(`9900|0150|${partResult.rows.length}|`);
      reg(`9900|0990|1|`);
      reg(`9900|C001|1|`);
      if (nfeResult.rows.length > 0) reg(`9900|C100|${nfeResult.rows.length}|`);
      reg(`9900|C990|1|`);
      reg(`9900|9001|1|`);
      reg(`9900|9900|${nfeResult.rows.length > 0 ? 8 : 7}|`);
      reg(`9900|9999|1|`);
      const bloco9total = linhas.filter((l) => l.startsWith('|9')).length + 2;
      reg(`9990|${bloco9total}|`);
      reg(`9999|${totalRegs + 1}|`);

      const ini = (dataInicial || hoje()).substring(0, 7).replace('-', '');
      sendTXT(res, `efd_${ini}.txt`, linhas.join('\r\n'));
    } catch (err) {
      console.error('[exportacao] efd:', err.message);
      res.status(500).json({ sucesso: false, erro: err.message });
    }
  });

  return router;
};
