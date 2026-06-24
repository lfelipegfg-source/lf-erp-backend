/**
 * Builder de payload NFC-e (modelo 65) — LF ERP
 * Monta o JSON no formato Focus NFe para Nota Fiscal ao Consumidor Eletrônica.
 *
 * Diferenças em relação à NF-e (modelo 55):
 *  - Sem destinatário obrigatório (consumidor anônimo)
 *  - Sem transporte/frete
 *  - Requer codigo_csc e id_token_csc no emitente (para QR code SEFAZ)
 *  - Endpoint Focus NFe: /nfce (não /nfe)
 *  - presenca_comprador: 1 (presencial) ou 4 (entrega domiciliar)
 */

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
  return FORMA_PGTO[forma.toLowerCase().trim()] || '99';
}

function icmsSimplesNacional(produto) {
  return {
    icms_situacao_tributaria: produto.icms_cst || '102',
    icms_modalidade_base_calculo: 3,
    icms_aliquota: 0,
    icms_valor: 0
  };
}

function icmsRegimeNormal(produto, valorTotal) {
  const cst  = produto.icms_cst || '00';
  const aliq = Number(produto.icms_aliquota || 0);
  const base = valorTotal * (Number(produto.icms_base_calculo || 100) / 100);
  return {
    icms_situacao_tributaria: cst,
    icms_modalidade_base_calculo: 3,
    icms_base_calculo: Number(base.toFixed(2)),
    icms_aliquota: aliq,
    icms_valor: Number((base * aliq / 100).toFixed(2))
  };
}

function pisCofins(produto, valorTotal) {
  const pisCst = produto.pis_cst    || '07';
  const cofCst = produto.cofins_cst || '07';
  const pisAliq = Number(produto.pis_aliquota    || 0);
  const cofAliq = Number(produto.cofins_aliquota || 0);
  const isento = pisCst === '07';
  return {
    pis_situacao_tributaria:    pisCst,
    pis_base_calculo:           isento ? 0 : Number(valorTotal.toFixed(2)),
    pis_aliquota_porcentual:    isento ? 0 : pisAliq,
    pis_valor:                  isento ? 0 : Number((valorTotal * pisAliq / 100).toFixed(2)),
    cofins_situacao_tributaria: cofCst,
    cofins_base_calculo:        isento ? 0 : Number(valorTotal.toFixed(2)),
    cofins_aliquota_porcentual: isento ? 0 : cofAliq,
    cofins_valor:               isento ? 0 : Number((valorTotal * cofAliq / 100).toFixed(2))
  };
}

/**
 * Monta o payload completo da NFC-e para o Focus NFe.
 *
 * @param {object} venda        Linha da tabela vendas
 * @param {Array}  itens        Linhas de venda_itens com dados do produto
 * @param {object} empresa      Linha da tabela empresas (emitente)
 * @param {object} cliente      Linha da tabela clientes ou null (opcional na NFC-e)
 * @param {object} nfeConfig    Linha da tabela nfe_config (com codigo_csc e id_token_csc)
 */
function montarPayloadNfce({ venda, itens, empresa, cliente, nfeConfig }) {
  const crt = Number(empresa.crt || 1);
  const ufEmitente = empresa.uf || '';

  // ── Emitente ──────────────────────────────────────────────────────────────
  const emitente = {
    cnpj:               (empresa.cnpj || '').replace(/\D/g, ''),
    nome:               empresa.nome,
    regime_tributario:  crt,
    inscricao_estadual: empresa.ie || 'ISENTO',
    logradouro:         empresa.logradouro || 'Não informado',
    numero:             empresa.numero || 'SN',
    complemento:        empresa.complemento || undefined,
    bairro:             empresa.bairro || 'Não informado',
    municipio:          empresa.municipio || 'Não informado',
    uf:                 ufEmitente,
    cep:                (empresa.cep || '').replace(/\D/g, ''),
    codigo_municipio:   empresa.codigo_municipio || undefined,
    telefone:           (empresa.telefone || '').replace(/\D/g, '') || undefined,
    // CSC obrigatório para NFC-e (QR code SEFAZ)
    codigo_csc:         nfeConfig?.codigo_csc     || undefined,
    id_token_csc:       nfeConfig?.id_token_csc   || undefined
  };

  // ── Destinatário (opcional na NFC-e) ──────────────────────────────────────
  let destinatario;
  if (cliente?.cpf) {
    const cpf = (cliente.cpf || '').replace(/\D/g, '');
    if (cpf.length === 11) {
      destinatario = { cpf, nome: cliente.nome || 'Consumidor Final' };
    }
  }

  // ── Itens ─────────────────────────────────────────────────────────────────
  const itemsPayload = itens.map((item, idx) => {
    const qtd      = Number(item.quantidade || 1);
    const unitario = Number(item.preco_unitario || 0);
    const total    = Number((qtd * unitario).toFixed(2));

    const icms = crt === 3
      ? icmsRegimeNormal(item, total)
      : icmsSimplesNacional(item);

    const pc = pisCofins(item, total);

    const itemObj = {
      numero_item:              idx + 1,
      codigo_produto:           String(item.produto_id || idx + 1),
      descricao:                item.produto_nome || item.nome || 'Produto',
      codigo_ncm:               (item.ncm || '00000000').replace(/\D/g, ''),
      cfop:                     item.cfop_padrao || '5102',
      unidade_comercial:        item.unidade || 'UN',
      quantidade_comercial:     qtd,
      valor_unitario_comercial: unitario,
      valor_bruto:              total,
      origem:                   Number(item.origem || 0),
      ...icms,
      ...pc
    };

    if (item.gtin && item.gtin !== '') itemObj.codigo_barras_comercial = item.gtin;
    return itemObj;
  });

  // ── Pagamentos ────────────────────────────────────────────────────────────
  const pagamentosPayload = [{
    forma_pagamento: mapForma(venda.forma_pagamento || venda.pagamento),
    valor: Number(venda.total || venda.valor_total || 0)
  }];

  // ── Payload final ─────────────────────────────────────────────────────────
  const _agoraLocal = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
  const dataEmissao = _agoraLocal.toISOString().slice(0, 19) + '-03:00';

  const payload = {
    natureza_operacao:  'VENDA AO CONSUMIDOR',
    data_emissao:       dataEmissao,
    tipo_documento:     1,   // 1=saída
    finalidade_emissao: 1,   // 1=normal
    consumidor_final:   1,
    presenca_comprador: 1,   // 1=operação presencial
    emitente,
    items: itemsPayload,
    pagamentos: pagamentosPayload,
    informacoes_adicionais_contribuinte: 'NFC-e emitida pelo LF ERP'
  };

  if (destinatario) payload.destinatario = destinatario;

  return payload;
}

module.exports = { montarPayloadNfce };
