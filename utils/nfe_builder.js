/**
 * Builder de payload NF-e — LF ERP
 * Monta o JSON no formato Focus NFe a partir de uma venda e seus dados relacionados.
 *
 * Suporte:
 *  - CRT 1 e 2: Simples Nacional (CSOSN)
 *  - CRT 3: Regime Normal (CST)
 *  - Destinatário PF (CPF) ou PJ (CNPJ)
 *  - Operações internas (5xxx) e interestaduais (6xxx)
 */

// Mapa de forma_pagamento LF ERP → código Focus NFe
const FORMA_PGTO = {
  'dinheiro':          '01',
  'cheque':            '02',
  'credito':           '03',
  'cartao credito':    '03',
  'cartão credito':    '03',
  'cartão de crédito': '03',
  'debito':            '04',
  'cartao debito':     '04',
  'cartão débito':     '04',
  'cartão de débito':  '04',
  'pix':               '17',
  'transferencia':     '18',
  'transferência':     '18',
  'boleto':            '15',
  'promissoria':       '99',
  'promissória':       '99',
  'outros':            '99'
};

function mapForma(forma) {
  if (!forma) return '01';
  const chave = forma.toLowerCase().trim();
  return FORMA_PGTO[chave] || '99';
}

// CSOSN padrão para Simples Nacional sem ICMS cobrado
const CSOSN_PADRAO_SN = '102';
// CST padrão para Regime Normal tributado integralmente
const CST_PADRAO_NORMAL = '00';

function icmsSimplesNacional(produto) {
  const csosn = produto.icms_cst || CSOSN_PADRAO_SN;
  // CSOSN 500/400 = já tributado substituição; 102 = sem cobrança; 900 = outros
  return {
    icms_situacao_tributaria: csosn,
    icms_modalidade_base_calculo: 3,
    icms_aliquota: 0,
    icms_valor: 0
  };
}

function icmsRegimeNormal(produto, valorTotal) {
  const cst = produto.icms_cst || CST_PADRAO_NORMAL;
  const aliq = Number(produto.icms_aliquota || 0);
  const base = valorTotal * (Number(produto.icms_base_calculo || 100) / 100);
  const valor = Number((base * aliq / 100).toFixed(2));
  return {
    icms_situacao_tributaria: cst,
    icms_modalidade_base_calculo: 3,
    icms_base_calculo: Number(base.toFixed(2)),
    icms_aliquota: aliq,
    icms_valor: valor
  };
}

function pisCofins(produto, valorTotal) {
  const pisCst  = produto.pis_cst  || '07';
  const cofCst  = produto.cofins_cst || '07';
  const pisAliq = Number(produto.pis_aliquota  || 0);
  const cofAliq = Number(produto.cofins_aliquota || 0);

  // CST 07 = operação isenta (Simples Nacional)
  return {
    pis_situacao_tributaria:    pisCst,
    pis_base_calculo:           pisCst === '07' ? 0 : Number(valorTotal.toFixed(2)),
    pis_aliquota_porcentual:    pisCst === '07' ? 0 : pisAliq,
    pis_valor:                  pisCst === '07' ? 0 : Number((valorTotal * pisAliq / 100).toFixed(2)),
    cofins_situacao_tributaria: cofCst,
    cofins_base_calculo:        cofCst === '07' ? 0 : Number(valorTotal.toFixed(2)),
    cofins_aliquota_porcentual: cofCst === '07' ? 0 : cofAliq,
    cofins_valor:               cofCst === '07' ? 0 : Number((valorTotal * cofAliq / 100).toFixed(2))
  };
}

/**
 * Determina CFOP baseado na UF do emitente x destinatário.
 * 5xxx = interna, 6xxx = interestadual.
 */
function resolverCfop(produto, ufEmitente, ufDestinatario) {
  const cfopBase = produto.cfop_padrao || '5102';
  const prefixo = (ufEmitente && ufDestinatario && ufEmitente !== ufDestinatario) ? '6' : '5';
  // Troca apenas o primeiro dígito mantendo os demais
  return prefixo + cfopBase.slice(1);
}

/**
 * Monta o payload completo da NF-e para o Focus NFe.
 *
 * @param {object} venda        Linha da tabela vendas
 * @param {Array}  itens        Linhas de venda_itens com dados do produto
 * @param {object} empresa      Linha da tabela empresas (emitente)
 * @param {object} cliente      Linha da tabela clientes (destinatário) ou null
 * @param {object} nfeConfig    Linha da tabela nfe_config
 */
function montarPayloadNfe({ venda, itens, empresa, cliente, nfeConfig }) {
  const crt = Number(empresa.crt || 1);
  const ufEmitente = empresa.uf || '';

  // ── Emitente ───────────────────────────────────────────────────────────────
  const emitente = {
    cnpj:                    (empresa.cnpj || '').replace(/\D/g, ''),
    nome:                    empresa.nome,
    regime_tributario:       crt,
    inscricao_estadual:      empresa.ie || 'ISENTO',
    logradouro:              empresa.logradouro || 'Não informado',
    numero:                  empresa.numero || 'SN',
    complemento:             empresa.complemento || undefined,
    bairro:                  empresa.bairro || 'Não informado',
    municipio:               empresa.municipio || 'Não informado',
    uf:                      ufEmitente,
    cep:                     (empresa.cep || '').replace(/\D/g, ''),
    codigo_municipio:        empresa.codigo_municipio || undefined,
    telefone:                (empresa.telefone || '').replace(/\D/g, '') || undefined
  };

  // ── Destinatário ──────────────────────────────────────────────────────────
  let destinatario = {};
  if (cliente && cliente.cpf_cnpj) {
    const doc = (cliente.cpf_cnpj || '').replace(/\D/g, '');
    const tipoPessoa = cliente.tipo_pessoa || (doc.length === 14 ? 'J' : 'F');
    destinatario = {
      [tipoPessoa === 'J' ? 'cnpj' : 'cpf']: doc,
      nome:             cliente.nome || 'Consumidor Final',
      email:            cliente.email || undefined,
      inscricao_estadual: cliente.ie_destinatario || undefined,
      logradouro:       cliente.logradouro || undefined,
      numero:           cliente.numero || undefined,
      complemento:      cliente.complemento || undefined,
      bairro:           cliente.bairro || undefined,
      municipio:        cliente.municipio || undefined,
      uf:               cliente.uf || undefined,
      cep:              cliente.cep ? (cliente.cep).replace(/\D/g, '') : undefined,
      codigo_municipio: cliente.codigo_municipio || undefined,
      telefone:         (cliente.telefone || '').replace(/\D/g, '') || undefined
    };
  } else {
    // Consumidor final sem identificação
    destinatario = {
      nome: 'CONSUMIDOR FINAL',
      cpf: '000.000.000-00'  // Focus NFe aceita para NFC-e, não NF-e modelo 55
    };
  }

  // ── Itens ─────────────────────────────────────────────────────────────────
  const ufDestinatario = cliente?.uf || ufEmitente;
  const itemsPayload = itens.map((item, idx) => {
    const qtd     = Number(item.quantidade || 1);
    const unitario = Number(item.preco_unitario || 0);
    const total   = Number((qtd * unitario).toFixed(2));
    const cfop    = resolverCfop(item, ufEmitente, ufDestinatario);

    const icms = crt === 3
      ? icmsRegimeNormal(item, total)
      : icmsSimplesNacional(item);

    const pc = pisCofins(item, total);

    const itemObj = {
      numero_item:              idx + 1,
      codigo_produto:           String(item.produto_id),
      descricao:                item.produto_nome || item.nome || 'Produto',
      codigo_ncm:               (item.ncm || '00000000').replace(/\D/g, ''),
      cfop,
      unidade_comercial:        item.unidade || 'UN',
      quantidade_comercial:     qtd,
      valor_unitario_comercial: unitario,
      valor_bruto:              total,
      origem:                   Number(item.origem || 0),
      ...icms,
      ...pc
    };

    if (item.gtin && item.gtin !== '') itemObj.codigo_barras_comercial = item.gtin;
    if (item.ipi_cst) {
      itemObj.ipi_situacao_tributaria = item.ipi_cst;
      itemObj.ipi_aliquota = Number(item.ipi_aliquota || 0);
    }

    return itemObj;
  });

  // ── Pagamentos ────────────────────────────────────────────────────────────
  const pagamentosPayload = [];
  if (venda.forma_pagamento) {
    pagamentosPayload.push({
      forma_pagamento: mapForma(venda.forma_pagamento),
      valor: Number(venda.total || venda.valor_total || 0)
    });
  } else {
    pagamentosPayload.push({
      forma_pagamento: '01',
      valor: Number(venda.total || venda.valor_total || 0)
    });
  }

  // ── Payload final ─────────────────────────────────────────────────────────
  const _agoraLocal = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
  const dataEmissao = _agoraLocal.toISOString().slice(0, 19) + '-03:00';

  return {
    natureza_operacao:   'VENDA DE MERCADORIA',
    data_emissao:        dataEmissao,
    tipo_documento:      1,           // 1=saída
    local_destino:       (ufEmitente === ufDestinatario) ? 1 : 2,
    finalidade_emissao:  1,           // 1=normal
    consumidor_final:    1,
    presenca_comprador:  1,           // 1=operação presencial
    emitente,
    destinatario,
    items: itemsPayload,
    pagamentos: pagamentosPayload
  };
}

module.exports = { montarPayloadNfe };
