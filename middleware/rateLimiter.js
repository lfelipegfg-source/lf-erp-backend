'use strict';

const loginAttempts     = new Map();
const loginUserAttempts = new Map();
const LOGIN_MAP_MAX = 10000;
const LOGIN_MAX_TENTATIVAS      = 10;
const LOGIN_USER_MAX_TENTATIVAS = 15;
const LOGIN_JANELA_MS = 15 * 60 * 1000;

const writeAttempts  = new Map();
const WRITE_MAX      = 30;
const WRITE_JANELA_MS = 60 * 1000;
const WRITE_MAP_MAX  = 5000;

setInterval(() => {
  const agora = Date.now();
  for (const [ip, entrada] of loginAttempts) {
    if (agora - entrada.inicio > LOGIN_JANELA_MS) loginAttempts.delete(ip);
  }
  for (const [user, entrada] of loginUserAttempts) {
    if (agora - entrada.inicio > LOGIN_JANELA_MS) loginUserAttempts.delete(user);
  }
}, LOGIN_JANELA_MS).unref();

setInterval(() => {
  const agora = Date.now();
  for (const [chave, entrada] of writeAttempts) {
    if (agora - entrada.inicio > WRITE_JANELA_MS) writeAttempts.delete(chave);
  }
}, WRITE_JANELA_MS).unref();

function loginRateLimiter(req, res, next) {
  const ip       = req.ip || req.connection?.remoteAddress || 'unknown';
  const username = (req.body?.usuario || '').toLowerCase().trim();
  const agora    = Date.now();

  const entradaIp = loginAttempts.get(ip) || { count: 0, inicio: agora };
  if (agora - entradaIp.inicio > LOGIN_JANELA_MS) { entradaIp.count = 0; entradaIp.inicio = agora; }
  entradaIp.count += 1;
  if (loginAttempts.size >= LOGIN_MAP_MAX && !loginAttempts.has(ip)) {
    loginAttempts.delete(loginAttempts.keys().next().value);
  }
  loginAttempts.set(ip, entradaIp);
  if (entradaIp.count > LOGIN_MAX_TENTATIVAS) {
    const restante = Math.ceil((LOGIN_JANELA_MS - (agora - entradaIp.inicio)) / 60000);
    return res.status(429).json({ sucesso: false, erro: `Muitas tentativas de login. Tente novamente em ${restante} minuto(s).` });
  }

  if (username) {
    const entradaUser = loginUserAttempts.get(username) || { count: 0, inicio: agora };
    if (agora - entradaUser.inicio > LOGIN_JANELA_MS) { entradaUser.count = 0; entradaUser.inicio = agora; }
    entradaUser.count += 1;
    if (loginUserAttempts.size >= LOGIN_MAP_MAX && !loginUserAttempts.has(username)) {
      loginUserAttempts.delete(loginUserAttempts.keys().next().value);
    }
    loginUserAttempts.set(username, entradaUser);
    if (entradaUser.count > LOGIN_USER_MAX_TENTATIVAS) {
      const restante = Math.ceil((LOGIN_JANELA_MS - (agora - entradaUser.inicio)) / 60000);
      return res.status(429).json({ sucesso: false, erro: `Muitas tentativas para este usuário. Tente novamente em ${restante} minuto(s).` });
    }
  }

  next();
}

function writeRateLimiter(req, res, next) {
  if (!req.user) return next();
  const chave = `${req.user.id}:${req.method}:${req.route?.path || req.path}`;
  const agora = Date.now();
  const entrada = writeAttempts.get(chave) || { count: 0, inicio: agora };

  if (agora - entrada.inicio > WRITE_JANELA_MS) {
    entrada.count = 0;
    entrada.inicio = agora;
  }

  entrada.count += 1;

  if (writeAttempts.size >= WRITE_MAP_MAX && !writeAttempts.has(chave)) {
    writeAttempts.delete(writeAttempts.keys().next().value);
  }

  writeAttempts.set(chave, entrada);

  if (entrada.count > WRITE_MAX) {
    return res.status(429).json({
      sucesso: false,
      erro: 'Muitas requisições. Aguarde um momento e tente novamente.'
    });
  }

  next();
}

module.exports = { loginRateLimiter, writeRateLimiter };
