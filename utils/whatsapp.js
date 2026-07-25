/**
 * WhatsApp Business — abstração de envio — LF ERP
 * Suporta: Evolution API, Z-API, e fallback para link wa.me.
 */

const TIMEOUT_MS = 12000;

function validarUrlExterna(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const bloqueados = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^::1$/,
      /^fc00:/i,
      /^fe80:/i,
      /^0\.0\.0\.0$/,
      /^::ffff:127\./i,
      /^::ffff:10\./i,
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,
      /^::ffff:192\.168\./i,
    ];
    return !bloqueados.some(r => r.test(host));
  } catch {
    return false;
  }
}

function limparTelefone(tel) {
  let num = String(tel || '').replace(/\D/g, '');
  if (!num) return null;
  if (num.startsWith('0')) num = '55' + num.slice(1);
  if (!num.startsWith('55')) num = '55' + num;
  return num;
}

function gerarLinkWaMe(telefone, mensagem) {
  const num = limparTelefone(telefone);
  if (!num) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(mensagem)}`;
}

function aplicarTemplate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

/**
 * Envia mensagem via API ou retorna link wa.me como fallback.
 *
 * @param {{ cfg, telefone, mensagem }} opts
 * @returns {{ sucesso: boolean, status: 'enviado'|'erro'|'link', link?: string, erro?: string }}
 */
async function enviarMensagem({ cfg, telefone, mensagem }) {
  const num = limparTelefone(telefone);
  if (!num) return { sucesso: false, status: 'erro', erro: 'Telefone inválido' };

  const provider = cfg?.wpp_provider || 'link';

  // ── Evolution API ──────────────────────────────────────────────────────────
  if (provider === 'evolution' && cfg?.wpp_api_url && cfg?.wpp_instance && cfg?.wpp_token) {
    if (!validarUrlExterna(cfg.wpp_api_url)) {
      return { sucesso: false, status: 'erro', erro: 'wpp_api_url inválida ou aponta para rede privada' };
    }
    try {
      const url = `${cfg.wpp_api_url.replace(/\/$/, '')}/message/sendText/${cfg.wpp_instance}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': cfg.wpp_token
        },
        body: JSON.stringify({ number: num, text: mensagem }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (resp.ok) return { sucesso: true, status: 'enviado' };
      const err = await resp.json().catch(() => ({}));
      return { sucesso: false, status: 'erro', erro: err.message || `HTTP ${resp.status}` };
    } catch (err) {
      return { sucesso: false, status: 'erro', erro: err.name === 'AbortError' ? 'Timeout' : err.message };
    }
  }

  // ── Z-API ──────────────────────────────────────────────────────────────────
  if (provider === 'zapi' && cfg?.wpp_instance && cfg?.wpp_token) {
    if (cfg.wpp_api_url && !validarUrlExterna(cfg.wpp_api_url)) {
      return { sucesso: false, status: 'erro', erro: 'wpp_api_url inválida ou aponta para rede privada' };
    }
    try {
      const baseUrl = cfg.wpp_api_url || 'https://api.z-api.io';
      const url = `${baseUrl}/instances/${cfg.wpp_instance}/token/${cfg.wpp_token}/send-text`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: num, message: mensagem }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (resp.ok) return { sucesso: true, status: 'enviado' };
      const err = await resp.json().catch(() => ({}));
      return { sucesso: false, status: 'erro', erro: err.error || err.message || `HTTP ${resp.status}` };
    } catch (err) {
      return { sucesso: false, status: 'erro', erro: err.name === 'AbortError' ? 'Timeout' : err.message };
    }
  }

  // ── Fallback: link wa.me ───────────────────────────────────────────────────
  const link = gerarLinkWaMe(num, mensagem);
  return { sucesso: true, status: 'link', link };
}

module.exports = { enviarMensagem, aplicarTemplate, limparTelefone, gerarLinkWaMe };
