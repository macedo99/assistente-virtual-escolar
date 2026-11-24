// Proteção CSRF (src/csrf.js).
const { test } = require('node:test');
const assert = require('node:assert');
const { gerarToken, tokensIguais, prepararToken, exigirCsrf } = require('../src/csrf');

function respostaFalsa() {
  const res = { statusCode: 200, corpo: null, locals: {} };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (c) => { res.corpo = c; return res; };
  res.send = (c) => { res.corpo = c; return res; };
  return res;
}

test('gerarToken: 64 caracteres hexadecimais e diferentes a cada chamada', () => {
  const a = gerarToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, gerarToken());
});

test('tokensIguais: só aceita texto idêntico e nunca um token esperado vazio', () => {
  assert.ok(tokensIguais('abc', 'abc'));
  assert.ok(!tokensIguais('abc', 'abd'));
  assert.ok(!tokensIguais('abc', 'abcd'));
  assert.ok(!tokensIguais('', ''));
  assert.ok(!tokensIguais(undefined, 'abc'));
  assert.ok(!tokensIguais(['abc'], 'abc'), 'campo repetido no formulário chega como array');
});

test('prepararToken cria o token só para quem está logado e o expõe para as telas', () => {
  const anonimo = { session: {} };
  const res1 = respostaFalsa();
  prepararToken(anonimo, res1, () => {});
  assert.strictEqual(anonimo.session.csrf, undefined);
  assert.strictEqual(res1.locals.csrf, '');

  const logado = { session: { atendente: { id: 1 } } };
  const res2 = respostaFalsa();
  prepararToken(logado, res2, () => {});
  assert.match(logado.session.csrf, /^[0-9a-f]{64}$/);
  assert.strictEqual(res2.locals.csrf, logado.session.csrf);
});

test('exigirCsrf: segue com o token certo; 403 (JSON na API, texto nas telas) sem ele', () => {
  const sessao = { csrf: 'token-certo' };
  let seguiu = false;
  exigirCsrf({ path: '/base', body: { _csrf: 'token-certo' }, session: sessao }, respostaFalsa(), () => { seguiu = true; });
  assert.ok(seguiu);

  const api = respostaFalsa();
  exigirCsrf({ path: '/api/conversas/1/mensagens', body: { _csrf: 'errado' }, session: sessao }, api, () => assert.fail('não deveria seguir'));
  assert.strictEqual(api.statusCode, 403);
  assert.strictEqual(api.corpo.ok, false);

  const tela = respostaFalsa();
  exigirCsrf({ path: '/base', body: undefined, session: sessao }, tela, () => assert.fail('não deveria seguir'));
  assert.strictEqual(tela.statusCode, 403);
  assert.strictEqual(typeof tela.corpo, 'string');
});
