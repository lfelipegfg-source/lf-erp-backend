/**
 * Imagens de Produtos — LF ERP
 * Upload para Cloudinary, CRUD e reordenação.
 *
 * Montado em /imagens pelo server.js.
 *
 * Rotas:
 *   GET    /imagens/produto/:produtoId           — listar imagens
 *   POST   /imagens/produto/:produtoId           — upload de imagem
 *   PATCH  /imagens/:imagemId/principal          — definir como imagem principal
 *   PUT    /imagens/:imagemId/ordem              — atualizar ordem de exibição
 *   DELETE /imagens/:imagemId                    — excluir imagem (e do Cloudinary)
 *   GET    /imagens/config                       — verifica se Cloudinary está configurado
 */

const multer = require('multer');
const { uploadImagem, deletarImagem, isConfigurado } = require('../utils/cloudinary');

const TIPOS_ACEITOS = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const LIMITE_BYTES  = 5 * 1024 * 1024; // 5 MB
const MAX_IMAGENS   = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (TIPOS_ACEITOS.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype}. Use JPG, PNG ou WebP.`));
  }
});

module.exports = ({
  auth,
  writeRateLimiter,
  pool,
  validarAcessoEmpresa,
  normalizarInt
}) => {
  const router = require('express').Router();

  function ok(res, dados = {}) {
    return res.status(200).json({ sucesso: true, ...dados });
  }
  function erro(res, status = 500, msg = 'Erro interno') {
    return res.status(status).json({ sucesso: false, erro: msg });
  }

  async function obterProduto(id, empresaId) {
    const r = await pool.query(
      `SELECT id, nome, empresa, empresa_id FROM produtos
       WHERE id = $1 AND empresa_id = $2 AND deletado_em IS NULL`,
      [id, empresaId]
    );
    return r.rows[0] || null;
  }

  async function obterImagem(id, empresaId) {
    const r = await pool.query(
      `SELECT * FROM produto_imagens WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId]
    );
    return r.rows[0] || null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /imagens/config — verifica configuração Cloudinary
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/config', auth, (_req, res) => {
    return ok(res, { configurado: isConfigurado() });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /imagens/produto/:produtoId
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/produto/:produtoId', auth, async (req, res) => {
    try {
      const produtoId = Number(req.params.produtoId);
      if (!produtoId) return erro(res, 400, 'ID de produto inválido');

      const produto = await obterProduto(produtoId, req.empresa_id);
      if (!produto) return erro(res, 404, 'Produto não encontrado');

      const empresaResolvida = await validarAcessoEmpresa(req, produto.empresa, produto.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `SELECT * FROM produto_imagens
         WHERE produto_id = $1 AND empresa_id = $2
         ORDER BY principal DESC, ordem ASC, criado_em ASC`,
        [produtoId, empresaResolvida.id]
      );

      return ok(res, { imagens: result.rows });
    } catch (err) {
      console.error('[imagens] GET produto:', err.message);
      return erro(res, 500, 'Erro ao buscar imagens');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /imagens/produto/:produtoId — upload
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    '/produto/:produtoId',
    auth,
    writeRateLimiter,
    (req, res, next) => {
      upload.single('imagem')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return erro(res, 400, `Arquivo muito grande. Limite: ${LIMITE_BYTES / 1024 / 1024}MB`);
          }
          return erro(res, 400, err.message);
        }
        if (err) return erro(res, 400, err.message);
        next();
      });
    },
    async (req, res) => {
      try {
        if (!isConfigurado()) {
          return erro(res, 503, 'Cloudinary não configurado. Adicione CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e CLOUDINARY_API_SECRET ao .env');
        }

        if (!req.file) return erro(res, 400, 'Envie uma imagem no campo "imagem"');

        const produtoId = Number(req.params.produtoId);
        if (!produtoId) return erro(res, 400, 'ID de produto inválido');

        const produto = await obterProduto(produtoId, req.empresa_id);
        if (!produto) return erro(res, 404, 'Produto não encontrado');

        const empresaResolvida = await validarAcessoEmpresa(req, produto.empresa, produto.empresa_id);
        if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

        // Verifica limite de imagens
        const totalResult = await pool.query(
          `SELECT COUNT(*) AS total FROM produto_imagens WHERE produto_id = $1 AND empresa_id = $2`,
          [produtoId, empresaResolvida.id]
        );
        if (Number(totalResult.rows[0].total) >= MAX_IMAGENS) {
          return erro(res, 400, `Limite de ${MAX_IMAGENS} imagens por produto atingido`);
        }

        // Faz upload para Cloudinary
        const { url, url_thumbnail, public_id } = await uploadImagem(req.file.buffer, {
          empresaId: empresaResolvida.id,
          produtoId,
          fileName: req.file.originalname
        });

        // Primeira imagem vira principal automaticamente
        const ehPrimeira = Number(totalResult.rows[0].total) === 0;

        const result = await pool.query(
          `INSERT INTO produto_imagens
             (produto_id, empresa_id, url, url_thumbnail, storage_public_id, ordem, principal)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [
            produtoId,
            empresaResolvida.id,
            url,
            url_thumbnail,
            public_id,
            Number(totalResult.rows[0].total),
            ehPrimeira
          ]
        );

        return ok(res, { imagem: result.rows[0] });
      } catch (err) {
        console.error('[imagens] POST upload:', err.message);
        return erro(res, 500, 'Erro ao fazer upload: ' + err.message);
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /imagens/:imagemId/principal — define como imagem principal
  // ─────────────────────────────────────────────────────────────────────────
  router.patch('/:imagemId/principal', auth, writeRateLimiter, async (req, res) => {
    try {
      const imagemId = Number(req.params.imagemId);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const imagem = await obterImagem(imagemId, empresaResolvida.id);
      if (!imagem) return erro(res, 404, 'Imagem não encontrada');

      // Remove principal de todas as imagens do produto
      await pool.query(
        `UPDATE produto_imagens SET principal = false
         WHERE produto_id = $1 AND empresa_id = $2`,
        [imagem.produto_id, empresaResolvida.id]
      );

      // Define a nova principal
      const result = await pool.query(
        `UPDATE produto_imagens SET principal = true WHERE id = $1 RETURNING *`,
        [imagemId]
      );

      return ok(res, { imagem: result.rows[0] });
    } catch (err) {
      console.error('[imagens] PATCH principal:', err.message);
      return erro(res, 500, 'Erro ao definir imagem principal');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PUT /imagens/:imagemId/ordem — atualiza ordem de exibição
  // ─────────────────────────────────────────────────────────────────────────
  router.put('/:imagemId/ordem', auth, writeRateLimiter, async (req, res) => {
    try {
      const imagemId = Number(req.params.imagemId);
      const { ordem } = req.body;
      if (ordem == null) return erro(res, 400, 'Informe o campo "ordem"');

      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const result = await pool.query(
        `UPDATE produto_imagens SET ordem = $1 WHERE id = $2 AND empresa_id = $3 RETURNING *`,
        [normalizarInt(ordem), imagemId, empresaResolvida.id]
      );

      if (result.rowCount === 0) return erro(res, 404, 'Imagem não encontrada');
      return ok(res, { imagem: result.rows[0] });
    } catch (err) {
      console.error('[imagens] PUT ordem:', err.message);
      return erro(res, 500, 'Erro ao atualizar ordem');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /imagens/:imagemId — exclui imagem do banco e do Cloudinary
  // ─────────────────────────────────────────────────────────────────────────
  router.delete('/:imagemId', auth, writeRateLimiter, async (req, res) => {
    try {
      const imagemId = Number(req.params.imagemId);
      const empresaResolvida = await validarAcessoEmpresa(req, null, req.empresa_id);
      if (!empresaResolvida) return erro(res, 403, 'Sem acesso');

      const imagem = await obterImagem(imagemId, empresaResolvida.id);
      if (!imagem) return erro(res, 404, 'Imagem não encontrada');

      // Remove do banco
      await pool.query(`DELETE FROM produto_imagens WHERE id = $1`, [imagemId]);

      // Remove do Cloudinary (fire-and-forget — não bloqueia resposta)
      deletarImagem(imagem.storage_public_id).catch(() => {});

      // Se era principal, promove a próxima imagem disponível
      if (imagem.principal) {
        await pool.query(
          `UPDATE produto_imagens SET principal = true
           WHERE produto_id = $1 AND empresa_id = $2
           ORDER BY ordem ASC, criado_em ASC
           LIMIT 1`,
          [imagem.produto_id, empresaResolvida.id]
        );
      }

      return ok(res, { mensagem: 'Imagem excluída com sucesso' });
    } catch (err) {
      console.error('[imagens] DELETE:', err.message);
      return erro(res, 500, 'Erro ao excluir imagem');
    }
  });

  return router;
};
