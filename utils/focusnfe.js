/**
 * Cliente HTTP Focus NFe — LF ERP
 * Usa fetch nativo do Node 18+ (sem dependência extra).
 *
 * Documentação: https://focusnfe.com.br/doc/
 */

const BASE_HOMOLOGACAO = 'https://homologacao.focusnfe.com.br/v2';
const BASE_PRODUCAO    = 'https://api.focusnfe.com.br/v2';

function baseUrl(ambiente) {
  return ambiente === 1 ? BASE_PRODUCAO : BASE_HOMOLOGACAO;
}

function authHeader(token) {
  return 'Basic ' + Buffer.from(token + ':').toString('base64');
}

async function focusRequest(token, ambiente, method, path, body = null) {
  const url = `${baseUrl(ambiente)}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: authHeader(token),
      'Content-Type': 'application/json'
    }
  };

  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return { status: res.status, ok: res.ok, data };
}

// ──────────────────────────────────────────────────────────────────────────────
// NF-e
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Emite uma NF-e.
 * @param {string} token  Token Focus NFe da empresa
 * @param {number} ambiente  1=producao, 2=homologacao
 * @param {string} ref  Referência única gerada pelo LF ERP
 * @param {object} payload  Payload completo da NF-e
 */
async function emitirNfe(token, ambiente, ref, payload) {
  return focusRequest(token, ambiente, 'POST', `/nfe?ref=${ref}`, payload);
}

/**
 * Consulta status de uma NF-e.
 */
async function consultarNfe(token, ambiente, ref) {
  return focusRequest(token, ambiente, 'GET', `/nfe/${ref}`);
}

/**
 * Cancela uma NF-e autorizada.
 * @param {string} justificativa  Mínimo 15 caracteres
 */
async function cancelarNfe(token, ambiente, ref, justificativa) {
  return focusRequest(token, ambiente, 'DELETE', `/nfe/${ref}`, { justificativa });
}

/**
 * Retorna URL do PDF (DANFE) — o PDF é gerado pelo Focus NFe.
 */
function urlDanfe(ambiente, ref) {
  return `${baseUrl(ambiente)}/nfe/${ref}/pdf`;
}

/**
 * Retorna URL do XML.
 */
function urlXml(ambiente, ref) {
  return `${baseUrl(ambiente)}/nfe/${ref}/xml`;
}

/**
 * Faz proxy do PDF retornando o buffer para o cliente LF ERP.
 */
async function downloadDanfe(token, ambiente, ref) {
  const url = urlDanfe(ambiente, ref);
  const res = await fetch(url, { headers: { Authorization: authHeader(token) } });
  if (!res.ok) return null;
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
}

/**
 * Faz proxy do XML.
 */
async function downloadXml(token, ambiente, ref) {
  const url = urlXml(ambiente, ref);
  const res = await fetch(url, { headers: { Authorization: authHeader(token) } });
  if (!res.ok) return null;
  const text = await res.text();
  return { text, contentType: 'application/xml' };
}

// ──────────────────────────────────────────────────────────────────────────────
// NFC-e (modelo 65)
// ──────────────────────────────────────────────────────────────────────────────

async function emitirNfce(token, ambiente, ref, payload) {
  return focusRequest(token, ambiente, 'POST', `/nfce?ref=${ref}`, payload);
}

async function consultarNfce(token, ambiente, ref) {
  return focusRequest(token, ambiente, 'GET', `/nfce/${ref}`);
}

async function cancelarNfce(token, ambiente, ref, justificativa) {
  return focusRequest(token, ambiente, 'DELETE', `/nfce/${ref}`, { justificativa });
}

async function downloadDanfce(token, ambiente, ref) {
  const url = `${baseUrl(ambiente)}/nfce/${ref}/pdf`;
  const res = await fetch(url, { headers: { Authorization: authHeader(token) } });
  if (!res.ok) return null;
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
}

// ──────────────────────────────────────────────────────────────────────────────
// NFS-e (Nota Fiscal de Serviço Eletrônica)
// FocusNFe suporta NFS-e para múltiplos municípios via API unificada.
// ──────────────────────────────────────────────────────────────────────────────

async function emitirNfse(token, ambiente, ref, payload) {
  return focusRequest(token, ambiente, 'POST', `/nfse?ref=${ref}`, payload);
}

async function consultarNfse(token, ambiente, ref) {
  return focusRequest(token, ambiente, 'GET', `/nfse/${ref}`);
}

async function cancelarNfse(token, ambiente, ref) {
  return focusRequest(token, ambiente, 'DELETE', `/nfse/${ref}`);
}

async function downloadNfsePdf(token, ambiente, ref) {
  const url = `${baseUrl(ambiente)}/nfse/${ref}/pdf`;
  const res = await fetch(url, { headers: { Authorization: authHeader(token) } });
  if (!res.ok) return null;
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
}

async function listarNfse(token, ambiente, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return focusRequest(token, ambiente, 'GET', `/nfse${qs ? '?' + qs : ''}`);
}

module.exports = {
  emitirNfe, consultarNfe, cancelarNfe, downloadDanfe, downloadXml, urlDanfe, urlXml,
  emitirNfce, consultarNfce, cancelarNfce, downloadDanfce,
  emitirNfse, consultarNfse, cancelarNfse, downloadNfsePdf, listarNfse
};
