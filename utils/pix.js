/**
 * PIX EMV (BR Code) — LF ERP
 * Gera a string PIX Copia e Cola no padrão EMV QRCPS-MPM.
 * Referência: Bacen Manual de Padrão PIX (Anexo I)
 */

function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
  }
  return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

function campo(id, valor) {
  const v = String(valor);
  return `${id}${String(v.length).padStart(2, '0')}${v}`;
}

/**
 * Gera o PIX Copia e Cola (EMV) para pagamento estático.
 *
 * @param {{
 *   chave:    string  — chave PIX (CPF/CNPJ/email/telefone/aleatória)
 *   valor:    number  — valor do pagamento
 *   nome:     string  — nome do recebedor (máx 25 chars)
 *   cidade:   string  — cidade do recebedor (máx 15 chars)
 *   txid:     string  — identificador da transação (máx 25 chars, ou '***')
 *   descricao?: string
 * }} opts
 * @returns {string}
 */
function gerarPixCopiaCola({ chave, valor, nome, cidade, txid = '***', descricao }) {
  const nomeClean  = String(nome  || 'Recebedor').substring(0, 25).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Recebedor';
  const cidadeClean = String(cidade || 'SAO PAULO').substring(0, 15).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Cidade';
  const txidClean  = String(txid || '***').substring(0, 25).replace(/[^a-zA-Z0-9]/g, '') || '***';

  // Merchant Account Information (campo 26)
  const pixInfo = campo('00', 'BR.GOV.BCB.PIX') + campo('01', chave) + (descricao ? campo('02', String(descricao).substring(0, 72)) : '');
  const merchantInfo = campo('26', pixInfo);

  // Payload Format Indicator
  let payload = campo('00', '01');
  // Point of Initiation Method: 11 = static, 12 = dynamic (uma vez)
  payload += campo('01', '12');
  payload += merchantInfo;
  // Merchant Category Code
  payload += campo('52', '0000');
  // Transaction Currency (BRL = 986)
  payload += campo('53', '986');
  // Transaction Amount
  if (valor && Number(valor) > 0) {
    payload += campo('54', Number(valor).toFixed(2));
  }
  // Country Code
  payload += campo('58', 'BR');
  // Merchant Name
  payload += campo('59', nomeClean);
  // Merchant City
  payload += campo('60', cidadeClean);
  // Additional Data Field (txid)
  payload += campo('62', campo('05', txidClean));
  // CRC (campo 63, valor calculado sobre tudo incluindo "6304")
  const crcInput = payload + '6304';
  const crcValue = crc16(crcInput);
  payload += campo('63', crcValue);

  return payload;
}

module.exports = { gerarPixCopiaCola };
