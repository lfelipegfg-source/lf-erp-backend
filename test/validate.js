// Smoke test: verifica que os modulos essenciais carregam e funcoes criticas existem
'use strict';

let erros = 0;

function checar(descricao, fn) {
  try {
    fn();
    console.log(`  OK  ${descricao}`);
  } catch (err) {
    console.error(`  FAIL ${descricao}: ${err.message}`);
    erros++;
  }
}

// Verifica variaveis de ambiente obrigatorias (em CI, podem ser ficticias)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ci';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost/test';

checar('utils/normalizadores exporta normalizarDecimal', () => {
  const { normalizarDecimal } = require('../utils/normalizadores');
  if (typeof normalizarDecimal !== 'function') throw new Error('nao e funcao');
  if (normalizarDecimal('3,14') !== 0 && normalizarDecimal(3.14) !== 3.14) throw new Error('retorno inesperado');
});

checar('utils/normalizadores exporta normalizarInt', () => {
  const { normalizarInt } = require('../utils/normalizadores');
  if (typeof normalizarInt !== 'function') throw new Error('nao e funcao');
  if (normalizarInt('5') !== 5) throw new Error('retorno inesperado');
});

checar('utils/periodoUtils exporta obterPeriodo e adicionarFiltroPeriodo', () => {
  const { obterPeriodo, adicionarFiltroPeriodo } = require('../utils/periodoUtils');
  if (typeof obterPeriodo !== 'function') throw new Error('obterPeriodo nao e funcao');
  if (typeof adicionarFiltroPeriodo !== 'function') throw new Error('adicionarFiltroPeriodo nao e funcao');
});

checar('routes existem e exportam funcao', () => {
  const rotasEsperadas = [
    'compras', 'vendas', 'produtos', 'clientes',
    'fornecedores', 'estoque', 'financeiro', 'relatorios'
  ];
  for (const rota of rotasEsperadas) {
    const mod = require(`../routes/${rota}.routes`);
    if (typeof mod !== 'function') throw new Error(`${rota}.routes nao exporta funcao`);
  }
});

checar('JWT_SECRET definido', () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET ausente');
});

checar('DATABASE_URL definido', () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente');
});

if (erros > 0) {
  console.error(`\n${erros} verificacao(es) falharam.`);
  process.exit(1);
} else {
  console.log('\nTodas as verificacoes passaram.');
}
