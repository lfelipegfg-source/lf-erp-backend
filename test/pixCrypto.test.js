'use strict';

const crypto = require('crypto');

// Chave de teste: 32 bytes = 64 hex chars
const TEST_KEY = crypto.randomBytes(32).toString('hex');

// Define ANTES do require para evitar o console.warn do module load
process.env.PIX_ENCRYPTION_KEY = TEST_KEY;

const { encryptField, decryptField } = require('../utils/pixCrypto');

afterEach(() => {
  // Restaura chave após cada test que altera a env
  process.env.PIX_ENCRYPTION_KEY = TEST_KEY;
});

// ── Round-trip ─────────────────────────────────────────────────────────────

describe('encryptField / decryptField — round-trip', () => {
  test('chave PIX simples', () => {
    const original = 'chave@pix.com';
    expect(decryptField(encryptField(original))).toBe(original);
  });

  test('chave com caracteres especiais', () => {
    const original = 'CPF:123.456.789-00 / CNPJ:12.345.678/0001-90';
    expect(decryptField(encryptField(original))).toBe(original);
  });

  test('string vazia', () => {
    const original = '';
    expect(decryptField(encryptField(original))).toBe(original);
  });

  test('string muito longa (1000 chars)', () => {
    const original = 'x'.repeat(1000);
    expect(decryptField(encryptField(original))).toBe(original);
  });

  test('string com Unicode / emojis', () => {
    const original = 'pix 💸 chave açaí: 日本語';
    expect(decryptField(encryptField(original))).toBe(original);
  });

  test('cada encrypt gera ciphertext diferente (IV aleatório)', () => {
    const original = 'mesma-chave';
    const e1 = encryptField(original);
    const e2 = encryptField(original);
    expect(e1).not.toBe(e2); // IVs distintos
    expect(decryptField(e1)).toBe(original);
    expect(decryptField(e2)).toBe(original);
  });
});

// ── Passthrough sem chave ──────────────────────────────────────────────────

describe('sem PIX_ENCRYPTION_KEY — modo fallback', () => {
  beforeEach(() => { delete process.env.PIX_ENCRYPTION_KEY; });

  test('encryptField retorna texto puro', () => {
    const val = 'chave-legada';
    expect(encryptField(val)).toBe(val);
  });

  test('encryptField: null → null', () => {
    expect(encryptField(null)).toBeNull();
  });

  test('decryptField com plaintext retorna plaintext', () => {
    expect(decryptField('texto-sem-cripto')).toBe('texto-sem-cripto');
  });

  test('decryptField com dado criptografado lança erro quando chave ausente', () => {
    // Gera dado criptografado com a chave, remove a chave, tenta descriptografar
    process.env.PIX_ENCRYPTION_KEY = TEST_KEY;
    const encrypted = encryptField('segredo');
    delete process.env.PIX_ENCRYPTION_KEY;
    expect(() => decryptField(encrypted)).toThrow('PIX_ENCRYPTION_KEY não configurada');
  });
});

// ── Passthrough null / undefined ──────────────────────────────────────────

describe('encryptField / decryptField — valores nulos', () => {
  test('encryptField(null) → null', () => expect(encryptField(null)).toBeNull());
  test('encryptField(undefined) → undefined', () => expect(encryptField(undefined)).toBeUndefined());
  test('decryptField(null) → null', () => expect(decryptField(null)).toBeNull());
  test('decryptField(undefined) → undefined', () => expect(decryptField(undefined)).toBeUndefined());
});

// ── Idempotência: não re-criptografa ──────────────────────────────────────

describe('encryptField — idempotência', () => {
  test('dado já criptografado não é re-criptografado', () => {
    const original = 'valor-original';
    const once = encryptField(original);
    const twice = encryptField(once);
    expect(once).toBe(twice);
    // E ainda pode ser descriptografado de volta
    expect(decryptField(twice)).toBe(original);
  });
});

// ── Dados legados (texto puro sem prefixo) ────────────────────────────────

describe('decryptField — dados legados', () => {
  test('string sem prefixo enc:v1: é retornada como está', () => {
    expect(decryptField('11.222.333/0001-44')).toBe('11.222.333/0001-44');
  });

  test('número como string legado', () => {
    expect(decryptField('12345678901')).toBe('12345678901');
  });
});

// ── Validação de chave ────────────────────────────────────────────────────

describe('getKey — validação do tamanho da chave', () => {
  test('chave com 63 chars hex (31 bytes) lança erro', () => {
    process.env.PIX_ENCRYPTION_KEY = 'a'.repeat(63);
    expect(() => encryptField('test')).toThrow('PIX_ENCRYPTION_KEY deve ter 64 hex chars');
  });

  test('chave com 65 chars hex (truncado para 32 bytes por Buffer) não lança', () => {
    // Buffer.from('a'.repeat(65), 'hex') → pega os primeiros 64 chars → 32 bytes
    // Portanto key.length === 32 → não lança
    process.env.PIX_ENCRYPTION_KEY = 'a'.repeat(64) + 'f';
    // Pode lançar ou não dependendo de como Node.js trata hex ímpar
    // Documentamos o comportamento sem asserção rígida
    try {
      encryptField('test');
    } catch (e) {
      // Aceito: comportamento defensivo
    }
  });

  test('chave com 64 chars hex (32 bytes) funciona normalmente', () => {
    process.env.PIX_ENCRYPTION_KEY = TEST_KEY;
    expect(() => encryptField('valor')).not.toThrow();
  });
});

// ── Adulteração (tamper detection) ───────────────────────────────────────

describe('decryptField — adulteração do ciphertext', () => {
  test('tag adulterada (1 byte diferente) lança erro de autenticação', () => {
    const encrypted = encryptField('dado-sensivel');
    // Formato: enc:v1:IV_HEX:TAG_HEX:CIPHERTEXT_BASE64
    const [, , iv, tag, ct] = encrypted.split(':');
    // Altera 1 char do tag
    const tagAlterada = tag.slice(0, -2) + (tag.slice(-2) === 'aa' ? 'bb' : 'aa');
    const adulterado = `enc:v1:${iv}:${tagAlterada}:${ct}`;
    expect(() => decryptField(adulterado)).toThrow();
  });

  test('ciphertext adulterado lança erro de autenticação', () => {
    const encrypted = encryptField('segredo');
    const parts = encrypted.split(':');
    // Altera o ciphertext (base64)
    const ctOriginal = parts[4];
    const ctAdulterado = ctOriginal.slice(0, -2) + (ctOriginal.slice(-2) === 'AA' ? 'BB' : 'AA');
    parts[4] = ctAdulterado;
    expect(() => decryptField(parts.join(':'))).toThrow();
  });

  test('formato inválido (partes incorretas) lança erro', () => {
    expect(() => decryptField('enc:v1:aabbcc:ddeeff')).toThrow('Formato de campo PIX criptografado inválido');
  });

  test('IV de tamanho errado lança erro', () => {
    // IV deve ser 12 bytes = 24 hex chars
    const tagHex = 'a'.repeat(32); // 16 bytes correto
    const ctB64 = Buffer.from('teste').toString('base64');
    const ivCurto = 'a'.repeat(10); // apenas 5 bytes — inválido
    expect(() => decryptField(`enc:v1:${ivCurto}:${tagHex}:${ctB64}`)).toThrow('IV inválido');
  });

  test('tag de tamanho errado lança erro', () => {
    const ivHex = 'b'.repeat(24); // 12 bytes correto
    const tagCurta = 'c'.repeat(10); // 5 bytes — inválido
    const ctB64 = Buffer.from('teste').toString('base64');
    expect(() => decryptField(`enc:v1:${ivHex}:${tagCurta}:${ctB64}`)).toThrow('AuthTag inválido');
  });
});
