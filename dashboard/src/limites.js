// Limite de tentativas de login (contra quem tenta adivinhar senhas).
//
// Duas contagens, só de tentativas que FALHARAM (login certo não conta):
//   - por IP:     muitas senhas erradas vindas do mesmo computador, em qualquer e-mail;
//   - por e-mail: muitas senhas erradas para a mesma conta, venham de onde vierem.
// O login certo zera a contagem daquele e-mail (quem errou a senha duas vezes e acertou não fica marcado).
// A contagem do IP NÃO é zerada pelo login certo: senão quem tem uma conta poderia entrar nela de vez em
// quando para continuar testando senhas de outras pessoas.
//
// As contagens ficam na memória do processo: reiniciar o dashboard zera tudo. Para um único container,
// é o suficiente.

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const JANELA_MS = 15 * 60 * 1000;
const MAX_FALHAS_POR_IP = 30;
const MAX_FALHAS_POR_EMAIL = 8;
const MSG_BLOQUEIO = 'Muitas tentativas de login sem sucesso. Espere 15 minutos e tente de novo.';

const chaveDoEmail = (req) => {
  const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email ? `email:${email}` : `ip:${ipKeyGenerator(req.ip || '')}`;
};

// aoBloquear(req, res): o que responder quando o limite estoura. Padrão: a tela de login com status 429.
function criarLimitesLogin({ aoBloquear, janelaMs = JANELA_MS, maxPorIp = MAX_FALHAS_POR_IP, maxPorEmail = MAX_FALHAS_POR_EMAIL } = {}) {
  const responder = aoBloquear || ((req, res) => res.status(429).render('login', { erro: MSG_BLOQUEIO }));
  const comum = {
    windowMs: janelaMs,
    skipSuccessfulRequests: true, // conta só as respostas com status >= 400 (login errado)
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => responder(req, res),
  };

  const porIp = rateLimit({ ...comum, limit: maxPorIp });
  const porEmail = rateLimit({ ...comum, limit: maxPorEmail, keyGenerator: chaveDoEmail });

  return {
    middlewares: [porIp, porEmail],
    // Chamado pela rota depois de um login certo.
    zerarEmail: (req) => porEmail.resetKey(chaveDoEmail(req)),
  };
}

module.exports = { criarLimitesLogin, MSG_BLOQUEIO, JANELA_MS, MAX_FALHAS_POR_IP, MAX_FALHAS_POR_EMAIL };
