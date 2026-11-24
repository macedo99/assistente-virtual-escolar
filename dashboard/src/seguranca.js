// Configuração de segurança do servidor: segredo da sessão, cookie, proxy e cabeçalhos HTTP.

const crypto = require('crypto');
const helmet = require('helmet');

const TAMANHO_MINIMO_SEGREDO = 32;
// Valores de exemplo (env.example e o antigo padrão do código): parecem preenchidos, mas são públicos.
const SEGREDOS_DE_EXEMPLO = ['hash-aleatorio', 'troque-isto-em-producao', 'changeme', 'secret'];

const COMO_GERAR = 'Gere um com:  openssl rand -hex 32   e coloque no .env (SESSION_SECRET=...). Depois: docker compose up -d dashboard';

class ErroConfiguracao extends Error {}

function lerBooleano(valor) {
  return ['1', 'true', 'sim', 'yes'].includes(String(valor || '').trim().toLowerCase());
}

// TRUST_PROXY: vazio = não confia em proxy (acesso direto, o padrão); "1" = um proxy na frente (nginx,
// Caddy, túnel); também aceita a lista do Express ("loopback", "10.0.0.0/8" etc.).
function lerTrustProxy(valor) {
  const texto = String(valor || '').trim();
  if (!texto || texto === 'false' || texto === '0') return false;
  if (/^\d+$/.test(texto)) return Number(texto);
  if (texto === 'true') return true;
  return texto;
}

// Lê e confere as variáveis de ambiente. Lança ErroConfiguracao (com a explicação) se algo impede
// o servidor de subir com segurança.
function lerConfiguracao(env = process.env) {
  const segredo = String(env.SESSION_SECRET || '').trim();
  if (!segredo) {
    throw new ErroConfiguracao(`SESSION_SECRET não está definido. Sem ele, qualquer pessoa poderia forjar uma sessão. ${COMO_GERAR}`);
  }
  if (SEGREDOS_DE_EXEMPLO.includes(segredo.toLowerCase())) {
    throw new ErroConfiguracao(`SESSION_SECRET ainda é o valor de exemplo ("${segredo}"). ${COMO_GERAR}`);
  }
  if (segredo.length < TAMANHO_MINIMO_SEGREDO) {
    throw new ErroConfiguracao(`SESSION_SECRET é curto demais (${segredo.length} caracteres; o mínimo é ${TAMANHO_MINIMO_SEGREDO}). ${COMO_GERAR}`);
  }

  return {
    segredoSessao: segredo,
    // COOKIE_SECURE=true quando o dashboard for acessado por HTTPS: o navegador só envia o cookie por HTTPS.
    // Em http://localhost ele precisa ficar desligado, senão o login nunca "pega".
    cookieSeguro: lerBooleano(env.COOKIE_SECURE),
    trustProxy: lerTrustProxy(env.TRUST_PROXY),
  };
}

// Um valor aleatório por resposta: só os <script nonce="..."> escritos pelas próprias telas rodam.
function gerarNonce(req, res, next) {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
}

// Cabeçalhos de segurança (helmet). A CSP só deixa a página carregar arquivos do próprio dashboard;
// scripts inline precisam do nonce da resposta. Assim, mesmo que algum texto de usuário escapasse para o
// HTML, um <script> injetado não rodaria.
function cabecalhos({ https }) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        ...(https ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    // HSTS só faz sentido (e só é seguro ligar) quando o acesso é por HTTPS.
    strictTransportSecurity: https ? { maxAge: 180 * 24 * 60 * 60 } : false,
    referrerPolicy: { policy: 'same-origin' },
  });
}

module.exports = { ErroConfiguracao, lerConfiguracao, gerarNonce, cabecalhos, TAMANHO_MINIMO_SEGREDO };
