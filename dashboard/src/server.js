const express = require('express');
const session = require('express-session');
const path = require('path');

const pool = require('./db');
const { prepararToken } = require('./csrf');
const authRoutes = require('./routes/auth');
const conversasRoutes = require('./routes/conversas');
const baseRoutes = require('./routes/base');
const metricasRoutes = require('./routes/metricas');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// 500kb (e não os 100kb padrão): o conteúdo de um item da base pode ter até 50 mil caracteres, e cada
// acento e quebra de linha ocupa 6 bytes quando o formulário é enviado.
app.use(express.urlencoded({ extended: true, limit: '500kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Páginas e respostas da API mostram conversas de pessoas: o navegador não deve guardá-las em cache.
// Sem isso, depois de clicar em "Sair" o botão Voltar poderia reabrir a lista guardada na memória
// do navegador — num computador compartilhado (sala dos professores), o próximo usuário a veria.
// (Fica depois do express.static de propósito: o CSS continua podendo ser guardado em cache.)
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

if (!process.env.SESSION_SECRET) {
  console.warn('AVISO: SESSION_SECRET não está definido (confira o .env). Usando uma chave padrão, que NÃO é segura.');
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'troque-isto-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
    httpOnly: true,             // o JavaScript da página não lê o cookie (limita o estrago de um XSS)
    sameSite: 'lax',            // o navegador não manda o cookie em POSTs vindos de outros sites (CSRF)
  },
}));

// Token anti-CSRF da sessão (segunda camada além do SameSite): disponível nas telas como <%= csrf %>.
app.use(prepararToken);

function negarAcesso(req, res) {
  // O polling da tela de conversa usa fetch e espera JSON. Um redirect pra /login viraria uma
  // página HTML no lugar do JSON — pras rotas /api/ a resposta certa é 401.
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, erro: 'não autenticado' });
  res.redirect('/login');
}

// Exige login — e confere no banco, a cada requisição, se quem está na sessão continua ativo e com o
// mesmo papel. Sem isso, um atendente desativado (ou rebaixado de admin) continuaria com o acesso antigo
// até a sessão expirar (8 h). É uma consulta por chave primária: custo desprezível.
async function exigirLogin(req, res, next) {
  const naSessao = req.session.atendente;
  if (!naSessao) return negarAcesso(req, res);

  try {
    const resultado = await pool.query('SELECT nome, papel, ativo FROM atendentes WHERE id = $1', [naSessao.id]);
    const atual = resultado.rows[0];

    if (atual && atual.ativo) {
      if (atual.nome !== naSessao.nome || atual.papel !== naSessao.papel) {
        req.session.atendente = { id: naSessao.id, nome: atual.nome, papel: atual.papel };
      }
      return next();
    }

    // desativado ou removido: encerra a sessão
    req.session.destroy(() => negarAcesso(req, res));
  } catch (err) {
    next(err);
  }
}

app.use('/', authRoutes);
// exigirLogin roda uma vez só; depois as rotas das conversas, as da base e as das métricas (estas duas só para administradores).
app.use('/', exigirLogin, conversasRoutes, baseRoutes, metricasRoutes);

// Handler de erro genérico — sem isso, uma exceção numa rota vira uma conexão pendurada
// sem explicação nenhuma no navegador.
app.use((err, req, res, next) => {
  // Falhas ao ler a requisição (ex.: corpo grande demais = 413) trazem status 4xx; o resto é erro nosso (500).
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);

  const mensagem = status === 500
    ? 'Erro interno. Veja os logs do container (docker compose logs dashboard).'
    : status === 413 ? 'Requisição grande demais.' : 'Requisição inválida.';

  // As telas chamam /api/ com fetch e esperam JSON — uma página HTML de erro quebraria o parse.
  if (req.path.startsWith('/api/')) return res.status(status).json({ ok: false, erro: mensagem });
  res.status(status).send(mensagem);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard rodando na porta ${PORT}`));
