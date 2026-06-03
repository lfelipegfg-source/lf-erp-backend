/**
 * Alertas de Cobrança — LF ERP
 * Dispara lembretes de pagamento por email (SMTP) e gera links WhatsApp.
 *
 * Montado em /alertas.
 *
 * Rotas:
 *   GET  /alertas/config      — ler configuração de alertas
 *   PUT  /alertas/config      — salvar configuração (SMTP, templates)
 *   POST /alertas/disparar    — envia emails e retorna links WhatsApp
 *   GET  /alertas/historico   — histórico dos últimos 100 alertas
 */

const nodemailer = require('nodemailer');

// Template simples: substitui {{variavel}} pelos valores
function aplicarTemplate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// Limpa número de telefone e gera URL wa.me
function gerarLinkWhatsApp(telefone, mensagem) {
  if (!telefone) return null;
  let num = String(telefone).replace(/\D/g, '');
  if (!num) return null;
  if (num.startsWith('0')) num = '55' + num.slice(1);
  if (!num.startsWith('55')) num = '55' + num;
  return `https://wa.me/${num}?text=${encodeURIComponent(mensagem)}`;
}

module.exports = ({ auth, writeRateLimiter, pool, validarAcessoEmpresa }) => {
  const router = require('express').Router();

  function ok(res, d = {}) { return res.status(200).json({ sucesso: true, ...d }); }
  function erro(res, s = 500, m = 'Erro') { return res.status(s).json({ sucesso: false, erro: m }); }

  async function getEmpresa(req) {
    return validarAcessoEmpresa(req, req.query.empresa || req.body?.empresa, req.empresa_id);
  }

  async function getConfig(empresaId) {
    const r = await pool.query(`SELECT * FROM alertas_config WHERE empresa_id = $1`, [empresaId]);
    return r.rows[0] || null;
  }

  // ── GET /alertas/config ───────────────────────────────────────────────────
  router.get('/config', auth, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const cfg = await getConfig(emp.id);
      // Nunca retorna a senha ao frontend
      const cfgSafe = cfg ? { ...cfg, smtp_pass: cfg.smtp_pass ? '***configurado***' : null } : null;
      return ok(res, { config: cfgSafe });
    } catch (err) {
      console.error('[alertas] GET config:', err.message);
      return erro(res, 500, 'Erro ao buscar configuração');
    }
  });

  // ── PUT /alertas/config ───────────────────────────────────────────────────
  router.put('/config', auth, writeRateLimiter, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const {
        email_ativo, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
        email_assunto, email_corpo,
        whatsapp_ativo, whatsapp_msg,
        dias_atraso_minimo
      } = req.body;

      await pool.query(
        `INSERT INTO alertas_config
           (empresa_id, email_ativo, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from,
            email_assunto, email_corpo, whatsapp_ativo, whatsapp_msg, dias_atraso_minimo, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (empresa_id) DO UPDATE SET
           email_ativo           = $2,
           smtp_host             = COALESCE($3, alertas_config.smtp_host),
           smtp_port             = COALESCE($4, alertas_config.smtp_port),
           smtp_user             = COALESCE($5, alertas_config.smtp_user),
           smtp_pass             = COALESCE($6, alertas_config.smtp_pass),
           smtp_from             = COALESCE($7, alertas_config.smtp_from),
           email_assunto         = COALESCE($8, alertas_config.email_assunto),
           email_corpo           = COALESCE($9, alertas_config.email_corpo),
           whatsapp_ativo        = $10,
           whatsapp_msg          = COALESCE($11, alertas_config.whatsapp_msg),
           dias_atraso_minimo    = COALESCE($12, alertas_config.dias_atraso_minimo),
           atualizado_em         = NOW()`,
        [
          emp.id,
          Boolean(email_ativo),
          smtp_host || null,
          smtp_port ? Number(smtp_port) : null,
          smtp_user || null,
          smtp_pass || null,   // só atualiza se informado
          smtp_from || null,
          email_assunto || null,
          email_corpo || null,
          Boolean(whatsapp_ativo),
          whatsapp_msg || null,
          dias_atraso_minimo != null ? Number(dias_atraso_minimo) : null
        ]
      );

      return ok(res, { mensagem: 'Configuração de alertas salva' });
    } catch (err) {
      console.error('[alertas] PUT config:', err.message);
      return erro(res, 500, 'Erro ao salvar configuração');
    }
  });

  // ── POST /alertas/disparar ────────────────────────────────────────────────
  router.post('/disparar', auth, writeRateLimiter, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const cfg = await getConfig(emp.id);
      if (!cfg) return erro(res, 400, 'Configure os alertas antes de disparar');

      if (!cfg.email_ativo && !cfg.whatsapp_ativo) {
        return erro(res, 400, 'Ative email ou WhatsApp nas configurações');
      }

      const diasMin = Number(cfg.dias_atraso_minimo || 1);

      // Busca clientes inadimplentes com dados de contato
      const clientesResult = await pool.query(
        `SELECT
           cr.cliente_id,
           cr.cliente_nome,
           c.email,
           c.telefone,
           COALESCE(SUM(cr.valor), 0) AS valor_total,
           MAX(CURRENT_DATE - cr.data_vencimento::date) AS max_dias
         FROM contas_receber cr
         LEFT JOIN clientes c ON c.id = cr.cliente_id AND c.empresa_id = cr.empresa_id
         WHERE cr.empresa_id = $1
           AND LOWER(COALESCE(cr.status,'pendente')) NOT IN ('pago')
           AND cr.data_vencimento::date < CURRENT_DATE
           AND CURRENT_DATE - cr.data_vencimento::date >= $2
         GROUP BY cr.cliente_id, cr.cliente_nome, c.email, c.telefone
         ORDER BY valor_total DESC`,
        [emp.id, diasMin]
      );

      const clientes = clientesResult.rows;

      if (clientes.length === 0) {
        return ok(res, { enviados_email: 0, links_whatsapp: [], mensagem: 'Nenhum cliente inadimplente para o critério configurado' });
      }

      const results = { enviados_email: 0, erros_email: 0, links_whatsapp: [], total_clientes: clientes.length };

      // ── Email ──────────────────────────────────────────────────────────────
      let transporter = null;
      if (cfg.email_ativo && cfg.smtp_host && cfg.smtp_user && cfg.smtp_pass) {
        try {
          transporter = nodemailer.createTransport({
            host: cfg.smtp_host,
            port: Number(cfg.smtp_port || 587),
            secure: Number(cfg.smtp_port) === 465,
            auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
            tls: { rejectUnauthorized: false }
          });
        } catch (te) {
          console.error('[alertas] transporter error:', te.message);
        }
      }

      const defaultCorpo = `Olá {{cliente_nome}},\n\nVerificamos que você possui um saldo em aberto de {{valor_total}} com vencimento ultrapassado.\n\nPor favor, entre em contato para regularizar sua situação.\n\nAtenciosamente,\n{{empresa_nome}}`;
      const defaultAssunto = `Aviso de pagamento — {{empresa_nome}}`;

      for (const cli of clientes) {
        const vars = {
          cliente_nome:  cli.cliente_nome || 'Cliente',
          valor_total:   Number(cli.valor_total || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
          empresa_nome:  emp.nome,
          dias_atraso:   String(cli.max_dias || 0)
        };

        // Email
        if (transporter && cli.email) {
          const assunto = aplicarTemplate(cfg.email_assunto || defaultAssunto, vars);
          const corpo   = aplicarTemplate(cfg.email_corpo   || defaultCorpo,   vars);
          try {
            await transporter.sendMail({
              from:    cfg.smtp_from || cfg.smtp_user,
              to:      cli.email,
              subject: assunto,
              text:    corpo,
              html:    corpo.replace(/\n/g, '<br>')
            });
            results.enviados_email++;
            await pool.query(
              `INSERT INTO alertas_historico (empresa_id, tipo, cliente_id, cliente_nome, contato, valor_total, status)
               VALUES ($1,'email',$2,$3,$4,$5,'enviado')`,
              [emp.id, cli.cliente_id, cli.cliente_nome, cli.email, cli.valor_total]
            );
          } catch (mailErr) {
            results.erros_email = (results.erros_email || 0) + 1;
            await pool.query(
              `INSERT INTO alertas_historico (empresa_id, tipo, cliente_id, cliente_nome, contato, valor_total, status, erro_msg)
               VALUES ($1,'email',$2,$3,$4,$5,'erro',$6)`,
              [emp.id, cli.cliente_id, cli.cliente_nome, cli.email, cli.valor_total, mailErr.message]
            );
          }
        }

        // WhatsApp link
        if (cfg.whatsapp_ativo && cli.telefone) {
          const msgWpp = aplicarTemplate(
            cfg.whatsapp_msg || `Olá {{cliente_nome}}, você possui um saldo em aberto de {{valor_total}} com {{empresa_nome}}. Por favor entre em contato.`,
            vars
          );
          const link = gerarLinkWhatsApp(cli.telefone, msgWpp);
          if (link) {
            results.links_whatsapp.push({
              cliente_nome:  cli.cliente_nome,
              telefone:      cli.telefone,
              valor_total:   Number(cli.valor_total || 0),
              link
            });
            await pool.query(
              `INSERT INTO alertas_historico (empresa_id, tipo, cliente_id, cliente_nome, contato, valor_total, status)
               VALUES ($1,'whatsapp',$2,$3,$4,$5,'enviado')`,
              [emp.id, cli.cliente_id, cli.cliente_nome, cli.telefone, cli.valor_total]
            );
          }
        }
      }

      results.mensagem = `Alertas processados. ${results.enviados_email} email(s) enviado(s), ${results.links_whatsapp.length} link(s) WhatsApp gerado(s).`;
      return ok(res, results);
    } catch (err) {
      console.error('[alertas] POST disparar:', err.message);
      return erro(res, 500, 'Erro ao disparar alertas: ' + err.message);
    }
  });

  // ── GET /alertas/historico ────────────────────────────────────────────────
  router.get('/historico', auth, async (req, res) => {
    try {
      const emp = await getEmpresa(req);
      if (!emp) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT * FROM alertas_historico
         WHERE empresa_id = $1
         ORDER BY criado_em DESC
         LIMIT 100`,
        [emp.id]
      );

      return ok(res, {
        historico: result.rows.map((r) => ({ ...r, valor_total: Number(r.valor_total || 0) }))
      });
    } catch (err) {
      console.error('[alertas] GET historico:', err.message);
      return erro(res, 500, 'Erro ao buscar histórico');
    }
  });

  return router;
};
