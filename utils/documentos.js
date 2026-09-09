'use strict';

function validarCpf(cpf) {
  if (!cpf) return true;
  const nums = cpf.replace(/\D/g, '');
  if (nums.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(nums)) return false;
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(nums[i]) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(nums[9])) return false;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(nums[i]) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  return resto === parseInt(nums[10]);
}

function validarCNPJ(cnpj) {
  const s = cnpj.replace(/\D/g, '');
  if (s.length !== 14) return false;
  if (/^(\d)\1+$/.test(s)) return false;
  let soma = 0, pos = 5;
  for (let i = 0; i < 12; i++) { soma += Number(s[i]) * pos--; if (pos < 2) pos = 9; }
  let r = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  if (r !== Number(s[12])) return false;
  soma = 0; pos = 6;
  for (let i = 0; i < 13; i++) { soma += Number(s[i]) * pos--; if (pos < 2) pos = 9; }
  r = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  return r === Number(s[13]);
}

module.exports = { validarCpf, validarCNPJ };
