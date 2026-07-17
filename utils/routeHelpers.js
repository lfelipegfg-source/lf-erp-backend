function erro(res, status = 500, mensagem = 'Erro interno do servidor') {
  return res.status(status).json({ sucesso: false, erro: mensagem });
}

function ok(res, dados = {}, status = 200) {
  return res.status(status).json({ sucesso: true, ...dados });
}

module.exports = { erro, ok };
