// Testes do limite de tentativas de login (src/limites.js), num servidor Express mínimo (sem banco).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { criarLimitesLogin } = require('../src/limites');

// Login de mentira: a senha certa é "certa".
async function subirServidor(opcoes) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const limites = criarLimitesLogin({ aoBloquear: (req, res) => res.status(429).send('bloqueado'), ...opcoes });
  app.post('/login', ...limites.middlewares, (req, res) => {
    if (req.body.senha !== 'certa') return res.status(401).send('errada');
    limites.zerarEmail(req);
    res.redirect('/');
  });
  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  const url = `http://127.0.0.1:${servidor.address().port}/login`;
  const logar = async (email, senha) => (await fetch(url, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ email, senha }) })).status;
  return { logar, fechar: () => new Promise((r) => servidor.close(r)) };
}

test('bloqueia o e-mail depois de N senhas erradas, mesmo com a senha certa', async () => {
  const s = await subirServidor({ maxPorEmail: 3, maxPorIp: 100 });
  try {
    for (let i = 0; i < 3; i++) assert.strictEqual(await s.logar('ana@escola.com', 'x'), 401);
    assert.strictEqual(await s.logar('ana@escola.com', 'x'), 429);
    assert.strictEqual(await s.logar('ANA@escola.com ', 'certa'), 429, 'maiúsculas e espaços contam como o mesmo e-mail');
    assert.strictEqual(await s.logar('outra@escola.com', 'certa'), 302, 'outro e-mail não é afetado');
  } finally { await s.fechar(); }
});

test('login certo zera a contagem do e-mail', async () => {
  const s = await subirServidor({ maxPorEmail: 3, maxPorIp: 100 });
  try {
    assert.strictEqual(await s.logar('bia@escola.com', 'x'), 401);
    assert.strictEqual(await s.logar('bia@escola.com', 'x'), 401);
    assert.strictEqual(await s.logar('bia@escola.com', 'certa'), 302);
    assert.strictEqual(await s.logar('bia@escola.com', 'x'), 401);
    assert.strictEqual(await s.logar('bia@escola.com', 'x'), 401);
    assert.strictEqual(await s.logar('bia@escola.com', 'certa'), 302, 'depois de zerar, ainda não chegou no limite');
  } finally { await s.fechar(); }
});

test('bloqueia o IP que testa senhas em muitos e-mails diferentes', async () => {
  const s = await subirServidor({ maxPorEmail: 100, maxPorIp: 4 });
  try {
    for (let i = 0; i < 4; i++) assert.strictEqual(await s.logar(`pessoa${i}@escola.com`, 'x'), 401);
    assert.strictEqual(await s.logar('pessoa9@escola.com', 'x'), 429);
    assert.strictEqual(await s.logar('dono@escola.com', 'certa'), 429, 'o IP bloqueado não entra nem com senha certa');
  } finally { await s.fechar(); }
});
