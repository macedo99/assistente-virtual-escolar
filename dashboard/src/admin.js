// Barreira de acesso compartilhada pelas telas que só administradores podem usar (base de conhecimento e métricas)
function exigirAdmin(req, res, next) {
  const atendente = req.session && req.session.atendente;
  if (atendente && atendente.papel === 'admin') return next();

  const mensagem = 'Acesso restrito a administradores.';
  if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, erro: mensagem });
  return res.status(403).send(mensagem);
}

module.exports = { exigirAdmin };
