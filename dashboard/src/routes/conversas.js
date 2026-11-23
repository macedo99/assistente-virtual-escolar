const express = require('express');
const pool = require('../db');
const atendimento = require('../atendimento');
const telegram = require('../telegram');
const { exigirCsrf } = require('../csrf');
const { formatarDataHora, formatarHora, formatarHoraCompleta, tempoDecorrido } = require('../formato');

const router = express.Router();

// Nomes legíveis pros valores de conversas.status (os valores no banco continuam os mesmos).
const ROTULO_STATUS = {
  bot: 'Só o bot',
  aguardando_atendente: 'Aguardando atendente',
  atendimento_humano: 'Em atendimento humano',
  encerrada: 'Encerrada',
};

// Fila: quem está esperando vem primeiro; depois quem já está sendo atendido; por último o que é só do bot.
const PRIORIDADE_STATUS = { aguardando_atendente: 0, atendimento_humano: 1, bot: 2 };

// Limite de caracteres de uma resposta do atendente (o Telegram aceita 4096; sobra espaço pro nome na frente).
const TAMANHO_MAXIMO_MENSAGEM = 3500;

// Os ids são BIGSERIAL: só dígitos, até 18 (cabe em bigint). Qualquer outra coisa
// ("abc", "99999999999999999999") faria o Postgres devolver erro e o usuário veria um 500 —
// aqui isso vira um 404 normal.
const idValido = (valor) => /^\d{1,18}$/.test(String(valor));

const comHora = (m) => ({ ...m, hora: formatarHora(m.enviada_em) });

// Recado que sobrevive a um redirect: grava na sessão, a próxima página mostra uma vez e apaga.
function avisar(req, tipo, texto) {
  req.session.aviso = { tipo, texto }; // tipo: 'ok' | 'aviso' | 'erro'
}
function consumirAviso(req) {
  const aviso = req.session.aviso || null;
  delete req.session.aviso;
  return aviso;
}

// Frase curta no topo da conversa dizendo quem está respondendo.
function quemAtende(conversa, atendente) {
  switch (conversa.status) {
    case 'bot':
      return 'Só o bot está respondendo esta conversa.';
    case 'aguardando_atendente':
      return 'O usuário pediu um atendente. O bot continua respondendo até alguém assumir.';
    case 'atendimento_humano':
      if (conversa.atendente_id === null || conversa.atendente_id === undefined) {
        return 'Em atendimento humano, mas sem atendente definido. Assuma a conversa para responder.';
      }
      return atendimento.mesmoId(conversa.atendente_id, atendente.id)
        ? 'Durante o atendimento humano, o bot para de responder. Encerre o atendimento ou devolva ao bot para ele continuar a interagir com o usuário.'
        : `Em atendimento por ${conversa.atendente_nome}.`;
    default:
      return 'Esta conversa foi encerrada.';
  }
}

// Avisa o usuário no Telegram (e registra o aviso no histórico). Nunca derruba a ação principal:
// se o Telegram falhar, a transição já aconteceu no banco — devolvemos o motivo pra mostrar ao atendente.
async function avisarUsuario(conversa, texto) {
  try {
    await telegram.enviarMensagem(conversa.telegram_chat_id, texto);
  } catch (err) {
    console.error(`Aviso ao usuário (conversa ${conversa.id}) não enviado: ${err.codigo || err.name} ${err.detalhe || ''}`);
    return { enviado: false, motivo: err.message };
  }
  try {
    await atendimento.registrarAviso(pool, conversa.id, texto);
  } catch (err) {
    console.error('Aviso enviado ao Telegram, mas não gravado no histórico:', err.message);
  }
  return { enviado: true };
}

// Painel principal: lista de conversas ativas
router.get('/', async (req, res, next) => {
  try {
    const resultado = await pool.query(`
      SELECT c.id, c.status, c.atendente_id,
             a.nome AS atendente_nome,
             u.nome AS usuario_nome, u.papel AS usuario_papel,
             (SELECT conteudo FROM mensagens m WHERE m.conversa_id = c.id ORDER BY m.enviada_em DESC, m.id DESC LIMIT 1) AS ultima_mensagem,
             (SELECT enviada_em FROM mensagens m WHERE m.conversa_id = c.id ORDER BY m.enviada_em DESC, m.id DESC LIMIT 1) AS ultima_em,
             (SELECT e.criado_em FROM conversa_eventos e WHERE e.conversa_id = c.id AND e.status_novo = 'aguardando_atendente' ORDER BY e.id DESC LIMIT 1) AS aguardando_desde
      FROM conversas c
      JOIN usuarios u ON u.id = c.usuario_id
      LEFT JOIN atendentes a ON a.id = c.atendente_id
      WHERE c.status <> 'encerrada'
      ORDER BY ultima_em DESC NULLS LAST;
    `);

    const agora = new Date();
    const conversas = resultado.rows.map((c) => ({
      ...c,
      status_rotulo: ROTULO_STATUS[c.status] || c.status,
      ultima_em_fmt: formatarDataHora(c.ultima_em),
      espera: c.status === 'aguardando_atendente' ? tempoDecorrido(c.aguardando_desde, agora) : '',
      atendente_exibicao: atendimento.mesmoId(c.atendente_id, req.session.atendente.id) ? 'Você' : (c.atendente_nome || ''),
    }));

    // Ordena aqui (e não no SQL): a lista é pequena e o JavaScript "sort" é estável — dentro de cada
    // grupo continua valendo a ordem do SQL (atividade mais recente primeiro).
    const instante = (c) => (c.aguardando_desde ? new Date(c.aguardando_desde).getTime() : Infinity);
    conversas.sort((a, b) => {
      const porGrupo = (PRIORIDADE_STATUS[a.status] ?? 9) - (PRIORIDADE_STATUS[b.status] ?? 9);
      if (porGrupo !== 0) return porGrupo;
      if (a.status === 'aguardando_atendente') {
        // quem espera há mais tempo fica no topo; sem horário registrado (conversa antiga) vai pro fim do grupo
        const ia = instante(a);
        const ib = instante(b);
        return ia === ib ? 0 : ia < ib ? -1 : 1;
      }
      return 0;
    });

    const contar = (status) => conversas.filter((c) => c.status === status).length;

    res.render('conversas', {
      conversas,
      contagem: {
        aguardando: contar('aguardando_atendente'),
        humano: contar('atendimento_humano'),
        bot: contar('bot'),
      },
      atualizadaEm: formatarHoraCompleta(agora),
      atendente: req.session.atendente,
      aviso: consumirAviso(req),
    });
  } catch (err) {
    next(err);
  }
});

// Tela de uma conversa específica
router.get('/conversas/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!idValido(id)) return res.status(404).send('Conversa não encontrada.');

    const conversa = await atendimento.buscarConversa(pool, id);
    if (!conversa) return res.status(404).send('Conversa não encontrada.');

    const mensagens = await atendimento.listarMensagens(pool, id);

    res.render('conversa', {
      conversa: {
        ...conversa,
        status_rotulo: ROTULO_STATUS[conversa.status] || conversa.status,
        quem_atende: quemAtende(conversa, req.session.atendente),
      },
      mensagens: mensagens.map(comHora),
      pode: atendimento.permissoes(conversa, req.session.atendente),
      limiteMensagem: TAMANHO_MAXIMO_MENSAGEM,
      atendente: req.session.atendente,
      aviso: consumirAviso(req),
    });
  } catch (err) {
    next(err);
  }
});

// Usado pelo polling da tela de conversa (a cada 3s): mensagens novas + o estado atual da conversa,
// pra tela perceber que alguém assumiu/devolveu/encerrou enquanto ela estava aberta.
router.get('/api/conversas/:id/mensagens', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!idValido(id)) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada.' });

    const estado = await atendimento.obterEstado(pool, id);
    if (!estado) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada.' });

    const desde = idValido(req.query.desde) ? String(req.query.desde) : '0';
    const mensagens = await atendimento.listarMensagens(pool, id, desde);

    res.json({
      estado: `${estado.status}:${estado.atendente_id ?? ''}`,
      mensagens: mensagens.map(comHora),
    });
  } catch (err) {
    next(err);
  }
});

// O atendente responde ao usuário: a mensagem vai pelo Telegram e, só se o Telegram aceitar, entra no histórico.
router.post('/api/conversas/:id/mensagens', exigirCsrf, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!idValido(id)) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada.' });

    const bruto = req.body.texto;
    const texto = typeof bruto === 'string' ? bruto.replace(/\r\n?/g, '\n').trim() : '';
    if (!texto) return res.status(400).json({ ok: false, erro: 'Escreva uma mensagem antes de enviar.' });
    if (texto.length > TAMANHO_MAXIMO_MENSAGEM) {
      return res.status(400).json({ ok: false, erro: `A mensagem passa de ${TAMANHO_MAXIMO_MENSAGEM} caracteres. Divida em duas.` });
    }

    const atendente = req.session.atendente;
    const conversa = await atendimento.buscarConversa(pool, id);
    if (!conversa) return res.status(404).json({ ok: false, erro: 'Conversa não encontrada.' });

    if (conversa.status !== 'atendimento_humano') {
      return res.status(409).json({ ok: false, erro: 'Esta conversa não está mais em atendimento humano. Atualize a página.' });
    }
    if (conversa.atendente_id === null || conversa.atendente_id === undefined) {
      return res.status(409).json({ ok: false, erro: 'Assuma a conversa antes de responder.' });
    }
    if (!atendimento.permissoes(conversa, atendente).responder) {
      return res.status(403).json({ ok: false, erro: `Esta conversa está sendo atendida por ${conversa.atendente_nome}.` });
    }

    try {
      await telegram.enviarMensagem(conversa.telegram_chat_id, atendimento.textoDoAtendente(atendente.nome, texto));
    } catch (err) {
      // Não gravamos no histórico uma mensagem que o usuário nunca recebeu.
      console.error(`Falha ao enviar pelo Telegram (conversa ${id}): ${err.codigo || err.name} ${err.detalhe || ''}`);
      return res.status(502).json({ ok: false, erro: err.message });
    }

    try {
      const gravada = await atendimento.registrarMensagemDoAtendente(pool, id, atendente.id, texto);
      return res.json({ ok: true, mensagem: comHora({ ...gravada, atendente_nome: atendente.nome }) });
    } catch (err) {
      // O usuário já recebeu. Se mandássemos "erro", o atendente tentaria de novo e a mensagem sairia duplicada.
      console.error('Mensagem enviada ao Telegram, mas NÃO gravada no histórico:', err);
      return res.json({ ok: true, aviso: 'A mensagem foi enviada ao usuário, mas não consegui registrá-la no histórico. Não envie de novo.' });
    }
  } catch (err) {
    next(err);
  }
});

// As três ações abaixo seguem o mesmo roteiro: valida o id → faz a transição no banco → avisa o usuário no
// Telegram (sem derrubar a ação se falhar) → deixa um recado na sessão → redireciona.
router.post('/conversas/:id/assumir', exigirCsrf, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!idValido(id)) return res.status(404).send('Conversa não encontrada.');

    const atendente = req.session.atendente;
    const resultado = await atendimento.assumir(pool, id, atendente);
    if (!resultado.ok) {
      avisar(req, 'erro', resultado.mensagem);
      return res.redirect(resultado.http === 404 ? '/' : `/conversas/${id}`);
    }

    const envio = await avisarUsuario(resultado.conversa, atendimento.AVISOS.assumiu(atendente.nome));
    if (envio.enviado) avisar(req, 'ok', 'Você está atendendo a esse usuário.');
    else avisar(req, 'aviso', `Você assumiu o atendimento, mas não consegui avisar o usuário no Telegram: ${envio.motivo}`);
    res.redirect(`/conversas/${id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/conversas/:id/devolver', exigirCsrf, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!idValido(id)) return res.status(404).send('Conversa não encontrada.');

    const resultado = await atendimento.devolverAoBot(pool, id, req.session.atendente);
    if (!resultado.ok) {
      avisar(req, 'erro', resultado.mensagem);
      return res.redirect(resultado.http === 404 ? '/' : `/conversas/${id}`);
    }

    const envio = await avisarUsuario(resultado.conversa, atendimento.AVISOS.devolveu());
    if (envio.enviado) avisar(req, 'ok', 'Conversa devolvida ao bot.');
    else avisar(req, 'aviso', `Conversa devolvida ao bot, mas não consegui avisar o usuário no Telegram: ${envio.motivo}`);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/conversas/:id/encerrar', exigirCsrf, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!idValido(id)) return res.status(404).send('Conversa não encontrada.');

    const resultado = await atendimento.encerrar(pool, id, req.session.atendente);
    if (!resultado.ok) {
      avisar(req, 'erro', resultado.mensagem);
      return res.redirect(resultado.http === 404 ? '/' : `/conversas/${id}`);
    }

    const envio = await avisarUsuario(resultado.conversa, atendimento.AVISOS.encerrou());
    if (envio.enviado) avisar(req, 'ok', 'Conversa encerrada. Se o usuário escrever de novo, começa uma conversa nova.');
    else avisar(req, 'aviso', `Conversa encerrada, mas não consegui avisar o usuário no Telegram: ${envio.motivo}`);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
