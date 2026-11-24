const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { criarLimitesLogin } = require('../limites');

const router = express.Router();
const limites = criarLimitesLogin();

const MSG_CREDENCIAIS_INVALIDAS = 'E-mail ou senha inválidos.';

router.get('/login', (req, res) => {
  if (req.session.atendente) return res.redirect('/');
  res.render('login', { erro: null });
});

router.post('/login', ...limites.middlewares, async (req, res, next) => {
  try {
    const { email, senha } = req.body;

    // Campo ausente ou repetido (ex.: requisição montada à mão): chega como undefined ou array.
    // Sem esta checagem o bcrypt estoura com "argumento ilegal" e o usuário vê um erro 500.
    if (typeof email !== 'string' || typeof senha !== 'string') {
      return res.status(400).render('login', { erro: MSG_CREDENCIAIS_INVALIDAS });
    }

    // E-mail comparado sem diferenciar maiúsculas/minúsculas ("Ana@x.com" = "ana@x.com").
    const resultado = await pool.query(
      'SELECT id, nome, senha_hash, papel, ativo FROM atendentes WHERE lower(email) = $1',
      [email.trim().toLowerCase()]
    );

    const atendente = resultado.rows[0];

    // Mesma mensagem de erro pra "não existe", "está inativo" e "senha errada" —
    // não dar pista de qual delas é.
    if (!atendente || !atendente.ativo) {
      return res.status(401).render('login', { erro: MSG_CREDENCIAIS_INVALIDAS });
    }

    const senhaCorreta = await bcrypt.compare(senha, atendente.senha_hash);
    if (!senhaCorreta) {
      return res.status(401).render('login', { erro: MSG_CREDENCIAIS_INVALIDAS });
    }

    limites.zerarEmail(req);
    // Sessão nova a cada login: um id de sessão anterior (ex.: plantado por outra pessoa no computador
    // compartilhado) não continua valendo depois que alguém entra.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.atendente = { id: atendente.id, nome: atendente.nome, papel: atendente.papel };
      res.redirect('/');
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
