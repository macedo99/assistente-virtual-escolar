// Testes da configuração de segurança (src/seguranca.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { lerConfiguracao, ErroConfiguracao } = require('../src/seguranca');

const FORTE = 'a'.repeat(16) + '0123456789abcdef0123';

test('SESSION_SECRET ausente, de exemplo ou curto impede o servidor de subir', () => {
  for (const segredo of [undefined, '', '   ', 'hash-aleatorio', 'troque-isto-em-producao', 'curto-demais']) {
    assert.throws(() => lerConfiguracao({ SESSION_SECRET: segredo }), ErroConfiguracao, `deveria recusar ${JSON.stringify(segredo)}`);
  }
});

test('SESSION_SECRET forte é aceito; cookie seguro e proxy desligados por padrão', () => {
  const c = lerConfiguracao({ SESSION_SECRET: FORTE });
  assert.strictEqual(c.segredoSessao, FORTE);
  assert.strictEqual(c.cookieSeguro, false);
  assert.strictEqual(c.trustProxy, false);
});

test('COOKIE_SECURE e TRUST_PROXY são lidos do ambiente', () => {
  assert.strictEqual(lerConfiguracao({ SESSION_SECRET: FORTE, COOKIE_SECURE: 'true' }).cookieSeguro, true);
  assert.strictEqual(lerConfiguracao({ SESSION_SECRET: FORTE, COOKIE_SECURE: 'false' }).cookieSeguro, false);
  assert.strictEqual(lerConfiguracao({ SESSION_SECRET: FORTE, TRUST_PROXY: '1' }).trustProxy, 1);
  assert.strictEqual(lerConfiguracao({ SESSION_SECRET: FORTE, TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.strictEqual(lerConfiguracao({ SESSION_SECRET: FORTE, TRUST_PROXY: '' }).trustProxy, false);
});
