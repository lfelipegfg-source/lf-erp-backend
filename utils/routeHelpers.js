function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
  const statusValido = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
  return res.status(statusValido).json({ sucesso: false, erro: mensagem });
}

function jsonErro(res, status, mensagem, codigo = null) {
  const body = { sucesso: false, erro: mensagem };
  if (codigo) body.codigo = codigo;
  return res.status(status).json(body);
}

function ok(res, dados = {}, status = 200) {
  return res.status(status).json({ ...dados, sucesso: true });
}

module.exports = { erro, jsonErro, ok };
