/**
 * Cloudinary helper — LF ERP
 *
 * Variáveis de ambiente necessárias (.env):
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *
 * As imagens são organizadas por empresa e produto:
 *   lf-erp/{empresa_id}/produtos/{produto_id}/
 *
 * Transformações automáticas geradas pelo Cloudinary (sem custo extra):
 *   - url original: qualidade auto, formato auto
 *   - url_thumbnail: 300×300, crop fill, qualidade 80
 */

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true
});

function isConfigurado() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

/**
 * Faz upload de um buffer para o Cloudinary.
 * @param {Buffer} buffer   Conteúdo do arquivo
 * @param {object} opts
 * @param {number} opts.empresaId
 * @param {number} opts.produtoId
 * @param {string} [opts.fileName]  Nome original do arquivo
 * @returns {{ url, url_thumbnail, public_id }}
 */
async function uploadImagem(buffer, { empresaId, produtoId, fileName = '' }) {
  const folder = `lf-erp/${empresaId}/produtos/${produtoId}`;

  const resultado = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        use_filename: false,
        unique_filename: true,
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto' }]
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });

  // Thumbnail: 300×300 crop centrado
  const urlThumbnail = cloudinary.url(resultado.public_id, {
    width: 300,
    height: 300,
    crop: 'fill',
    quality: 80,
    fetch_format: 'auto'
  });

  return {
    url:         resultado.secure_url,
    url_thumbnail: urlThumbnail,
    public_id:   resultado.public_id
  };
}

/**
 * Remove uma imagem do Cloudinary pelo public_id.
 */
async function deletarImagem(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    console.warn('[cloudinary] Falha ao deletar imagem:', publicId, err.message);
  }
}

module.exports = { uploadImagem, deletarImagem, isConfigurado };
