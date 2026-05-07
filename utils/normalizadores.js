function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function agoraISO() {
  return new Date().toISOString();
}

function normalizarDecimal(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : 0;
}

function normalizarInt(valor) {
  const numero = parseInt(valor, 10);
  return Number.isFinite(numero) ? numero : 0;
}

function addDias(dataBase, dias) {
  const data = new Date(`${dataBase}T00:00:00`);
  data.setDate(data.getDate() + Number(dias || 0));
  return data.toISOString().slice(0, 10);
}

function normalizarDataISO(valor) {
  if (!valor) return null;

  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor.trim())) {
    return valor.trim();
  }

  const d = new Date(valor);

  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString().slice(0, 10);
}

module.exports = {
  hoje,
  agoraISO,
  normalizarDecimal,
  normalizarInt,
  addDias,
  normalizarDataISO
};
