// Proteção contra CSRF (Cross-Site Request Forgery)
const crypto = require('crypto');

function gerarToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Comparação em tempo constante (não vaza, pelo tempo de resposta, quantos caracteres batem).
function tokensIguais(enviado, esperado) {
  if (typeof enviado !== 'string' || typeof esperado !== 'string' || esperado === '') return false;
  const a = Buffer.from(enviado);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Middleware de sessão: garante que quem está logado tem um token e o deixa disponível nas views (<%= csrf %>).
function prepararToken(req, res, next) {
  if (req.session.atendente && !req.session.csrf) req.session.csrf = gerarToken();
  res.locals.csrf = req.session.csrf || '';
  next();
}

// Middleware das rotas que alteram dados (POST).
function exigirCsrf(req, res, next) {
  if (tokensIguais(req.body && req.body._csrf, req.session && req.session.csrf)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ ok: false, erro: 'Sessão de segurança inválida. Recarregue a página e tente de novo.' });
  }
  return res.status(403).send('Requisição recusada: token de segurança inválido. Volte, recarregue a página e tente de novo.');
}

module.exports = { gerarToken, tokensIguais, prepararToken, exigirCsrf };
