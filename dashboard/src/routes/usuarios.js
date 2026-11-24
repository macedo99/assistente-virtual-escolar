// Usuários do bot (professores e gestores que conversam pelo Telegram) — só administradores.
//
// O papel de "gestor" é concedido AQUI, por um administrador. O cadastro pelo Telegram sempre cria o
// usuário como "professor" (garantido pelo banco: migracoes/002_papel_professor.sql). Antes, o papel vinha
// de uma palavra digitada pelo próprio usuário ("gestor"), e qualquer um podia se declarar gestor.

const express = require('express');
const pool = require('../db');
const { exigirCsrf } = require('../csrf');
const { exigirAdmin } = require('../admin');
const { idValido } = require('../base');
const { formatarDataHora } = require('../formato');

const router = express.Router();

const PAPEIS = { professor: 'Professor', gestor: 'Gestor' };

const SQL_LISTAR = `
  SELECT u.id, u.nome, u.telegram_username, u.papel, u.criado_em,
         (SELECT count(*) FROM conversas c WHERE c.usuario_id = u.id)::int AS n_conversas,
         (SELECT max(m.enviada_em) FROM mensagens m JOIN conversas c ON c.id = m.conversa_id
           WHERE c.usuario_id = u.id AND m.remetente = 'usuario') AS ultima_mensagem
  FROM usuarios u
  ORDER BY (u.papel = 'gestor') DESC, u.nome ASC NULLS LAST, u.id ASC`;

const SQL_MUDAR_PAPEL = `
  UPDATE usuarios SET papel = $2 WHERE id = $1
  RETURNING id, nome, papel`;

function avisar(req, tipo, texto) {
  req.session.aviso = { tipo, texto };
}
function consumirAviso(req) {
  const aviso = req.session.aviso || null;
  delete req.session.aviso;
  return aviso;
}

router.get('/usuarios', exigirAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(SQL_LISTAR);
    const usuarios = rows.map((u) => ({
      ...u,
      nome_exibicao: u.nome || (u.telegram_username ? `@${u.telegram_username}` : `Usuário ${u.id}`),
      papel_rotulo: PAPEIS[u.papel] || u.papel,
      criado_em_fmt: formatarDataHora(u.criado_em),
      ultima_mensagem_fmt: u.ultima_mensagem ? formatarDataHora(u.ultima_mensagem) : '—',
    }));
    res.render('usuarios', {
      usuarios,
      contagem: { gestor: usuarios.filter((u) => u.papel === 'gestor').length, professor: usuarios.filter((u) => u.papel === 'professor').length },
      atendente: req.session.atendente,
      aviso: consumirAviso(req),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios/:id/papel', exigirAdmin, exigirCsrf, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!idValido(id)) return res.status(404).send('Usuário não encontrado.');

    const papel = req.body && req.body.papel;
    if (!Object.prototype.hasOwnProperty.call(PAPEIS, papel)) {
      avisar(req, 'erro', 'Papel inválido.');
      return res.redirect('/usuarios');
    }

    const { rows } = await pool.query(SQL_MUDAR_PAPEL, [id, papel]);
    if (!rows.length) {
      avisar(req, 'erro', 'Usuário não encontrado.');
      return res.redirect('/usuarios');
    }

    const nome = rows[0].nome || `Usuário ${rows[0].id}`;
    // Fica registrado no log do container quem mudou o papel de quem.
    console.log(`Papel alterado: usuário ${rows[0].id} → ${papel}, por atendente ${req.session.atendente.id}`);
    avisar(req, 'ok', papel === 'gestor' ? `${nome} agora é gestor.` : `${nome} agora é professor.`);
    res.redirect('/usuarios');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
