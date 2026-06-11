const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function getKey() {
  const hex = process.env.PIX_ENCRYPTION_KEY;
  if (!hex) return null;
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('PIX_ENCRYPTION_KEY deve ter 64 hex chars (32 bytes)');
  return key;
}

// Criptografa um campo sensível do PIX. Se PIX_ENCRYPTION_KEY não estiver
// configurada, retorna o valor original sem criptografar (compatibilidade gradual).
function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const str = String(plaintext);
  if (str.startsWith(PREFIX)) return str; // já criptografado

  const key = getKey();
  if (!key) return str; // chave não configurada — mantém texto puro

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('base64')}`;
}

// Descriptografa um campo. Se não começar com enc:v1:, retorna como está
// (suporte a dados legados em texto puro gravados antes da criptografia).
function decryptField(value) {
  if (value === null || value === undefined) return value;
  const str = String(value);
  if (!str.startsWith(PREFIX)) return str; // texto puro ou dado legado

  try {
    const key = getKey();
    if (!key) return str;

    const parts = str.slice(PREFIX.length).split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Falha na descriptografia — retorna o valor original sem quebrar
    return str;
  }
}

module.exports = { encryptField, decryptField };
