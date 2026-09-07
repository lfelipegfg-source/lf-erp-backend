'use strict';

function createEmpresaUtils(pool) {
  async function obterEmpresaPorId(empresaId) {
    if (!empresaId) return null;
    const result = await pool.query(
      `SELECT id, nome FROM empresas WHERE id = $1 LIMIT 1`,
      [empresaId]
    );
    if (result.rowCount === 0) return null;
    return result.rows[0];
  }

  async function obterEmpresaPorNome(nome) {
    if (!nome) return null;
    const result = await pool.query(
      `SELECT id, nome FROM empresas WHERE LOWER(nome) = LOWER($1) LIMIT 1`,
      [nome]
    );
    if (result.rowCount === 0) return null;
    return result.rows[0];
  }

  async function resolverEmpresaRequest(req, empresaInformada = null, empresaIdInformado = null) {
    const empresaIdInformada =
      empresaIdInformado ||
      req.body?.empresa_id || req.query?.empresa_id || req.params?.empresa_id || null;

    if (empresaIdInformada) {
      const empresa = await obterEmpresaPorId(Number(empresaIdInformada));
      if (empresa) return empresa;
    }

    if (empresaInformada) {
      const empresa = await obterEmpresaPorNome(empresaInformada);
      if (empresa) return empresa;
    }

    if (req.user?.empresa_id) {
      const empresa = await obterEmpresaPorId(Number(req.user.empresa_id));
      if (empresa) return empresa;
    }

    if (req.user?.empresa) {
      const empresa = await obterEmpresaPorNome(req.user.empresa);
      if (empresa) return empresa;
    }

    return null;
  }

  async function validarAcessoEmpresa(req, empresaInformada = null, empresaIdInformado = null) {
    if (req.user.is_saas_owner) {
      return await resolverEmpresaRequest(req, empresaInformada, empresaIdInformado);
    }

    const empresaResolvida = await resolverEmpresaRequest(req, empresaInformada, empresaIdInformado);

    if (!empresaResolvida) return null;

    const empresaIdUsuario = Number(req.user?.empresa_id || 0);
    const empresaNomeUsuario = req.user?.empresa || null;

    if (
      (empresaIdUsuario && empresaResolvida.id === empresaIdUsuario) ||
      (empresaNomeUsuario && empresaResolvida.nome === empresaNomeUsuario)
    ) {
      return empresaResolvida;
    }

    return null;
  }

  function adicionarFiltroEmpresaSaaS({ alias = '', params, empresaResolvida }) {
    const prefixo = alias ? `${alias}.` : '';

    params.push(Number(empresaResolvida.id));
    const idxEmpresaId = params.length;

    params.push(empresaResolvida.nome);
    const idxEmpresaNome = params.length;

    return `
      AND (
        ${prefixo}empresa_id = $${idxEmpresaId}
        OR (
          ${prefixo}empresa_id IS NULL
          AND ${prefixo}empresa = $${idxEmpresaNome}
        )
      )
    `;
  }

  function podeGerenciarUsuarios(req) {
    return req.user.tipo === 'admin' || req.user.tipo === 'gerente';
  }

  function podeGerenciarFinanceiro(req) {
    return req.user.tipo === 'admin' || req.user.tipo === 'gerente';
  }

  function podeGerenciarCompras(req) {
    return req.user.tipo === 'admin' || req.user.tipo === 'gerente';
  }

  function podeGerenciarVendas(req) {
    return (
      req.user.tipo === 'admin' || req.user.tipo === 'gerente' || req.user.tipo === 'funcionario'
    );
  }

  return {
    obterEmpresaPorId,
    obterEmpresaPorNome,
    resolverEmpresaRequest,
    validarAcessoEmpresa,
    adicionarFiltroEmpresaSaaS,
    podeGerenciarUsuarios,
    podeGerenciarFinanceiro,
    podeGerenciarCompras,
    podeGerenciarVendas
  };
}

module.exports = { createEmpresaUtils };
