function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
  const statusValido = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
  return res.status(statusValido).json({ sucesso: false, erro: mensagem });
}

function ok(res, dados = {}, status = 200) {
  return res.status(status).json({ ...dados, sucesso: true });
}

module.exports = { erro, ok };
