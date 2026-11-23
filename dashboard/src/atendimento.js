// Regras do atendimento humano (handoff). Transições de status da conversa:
//
//   bot                  --(o usuário pede: /humano ou botão, no n8n)-->  aguardando_atendente
//   bot | aguardando     --(Assumir)-->                                   atendimento_humano
//   atendimento_humano   --(Devolver ao bot)-->                           bot
//   atendimento_humano   --(Encerrar)-->                                  encerrada

const AVISOS = {
  assumiu: (nome) => `🧑‍💼 ${nome} entrou na conversa e vai atender você por aqui.`,
  devolveu: () => '✅ O atendimento humano foi finalizado. Agora você está falando com o Assistente Virtual!',
  encerrou: () => '✅ Atendimento encerrado. Se precisar de algo mais, é só mandar uma mensagem.',
};

// Texto que chega ao Telegram quando o atendente responde: o nome na frente deixa claro que é uma pessoa.
const textoDoAtendente = (nome, texto) => `🧑‍💼 ${nome}: ${texto}`;

const mesmoId = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

const SQL_CONVERSA = `
  SELECT c.id, c.status, c.atendente_id, c.usuario_id,
         a.nome AS atendente_nome,
         u.nome AS usuario_nome, u.papel AS usuario_papel, u.telegram_chat_id
  FROM conversas c
  JOIN usuarios u ON u.id = c.usuario_id
  LEFT JOIN atendentes a ON a.id = c.atendente_id
  WHERE c.id = $1`;

// Assumir: conversa só com o bot, aguardando atendente — ou "em atendimento humano" sem ninguém
// responsável (sobra de experimentos manuais com UPDATE, como os do Passo 7).
const SQL_ASSUMIR = `
  UPDATE conversas
     SET status = 'atendimento_humano', atendente_id = $2
   WHERE id = $1
     AND (status IN ('bot', 'aguardando_atendente')
          OR (status = 'atendimento_humano' AND atendente_id IS NULL))
  RETURNING id`;

// Devolver / encerrar: só quem assumiu (ou um admin). $3 é o papel de quem pede; o "::text" é
// necessário — sem ele o Postgres não consegue descobrir o tipo do parâmetro.
const SQL_DEVOLVER = `
  UPDATE conversas
     SET status = 'bot', atendente_id = NULL
   WHERE id = $1
     AND status = 'atendimento_humano'
     AND (atendente_id IS NULL OR atendente_id = $2 OR $3::text = 'admin')
  RETURNING id`;

const SQL_ENCERRAR = `
  UPDATE conversas
     SET status = 'encerrada', encerrada_em = now(), atendente_id = COALESCE(atendente_id, $2)
   WHERE id = $1
     AND status = 'atendimento_humano'
     AND (atendente_id IS NULL OR atendente_id = $2 OR $3::text = 'admin')
  RETURNING id`;

async function buscarConversa(db, id) {
  const resultado = await db.query(SQL_CONVERSA, [id]);
  return resultado.rows[0] || null;
}

// Só o necessário pro polling saber se algo mudou.
async function obterEstado(db, id) {
  const resultado = await db.query('SELECT status, atendente_id FROM conversas WHERE id = $1', [id]);
  return resultado.rows[0] || null;
}

// O que o atendente pode fazer com esta conversa — usado para decidir quais botões aparecem.
// (As rotas conferem de novo: esconder um botão não é segurança; as regras de verdade estão nos UPDATEs acima.)
function permissoes(conversa, atendente) {
  const humano = conversa.status === 'atendimento_humano';
  const semResponsavel = conversa.atendente_id === null || conversa.atendente_id === undefined;
  const meu = mesmoId(conversa.atendente_id, atendente.id);
  const admin = atendente.papel === 'admin';
  return {
    assumir: conversa.status === 'bot' || conversa.status === 'aguardando_atendente' || (humano && semResponsavel),
    responder: humano && !semResponsavel && (meu || admin),
    devolver: humano && (semResponsavel || meu || admin),
    encerrar: humano && (semResponsavel || meu || admin),
  };
}

function recusa(http, mensagem) {
  return { ok: false, http, mensagem };
}

// O UPDATE não mexeu em nada: descobre por quê e escreve uma explicação que o atendente entenda.
function motivoDaRecusa(acao, conversa, atendente) {
  if (!conversa) return recusa(404, 'Conversa não encontrada.');
  if (conversa.status === 'encerrada') return recusa(409, 'Esta conversa já foi encerrada.');

  if (acao === 'assumir') {
    if (mesmoId(conversa.atendente_id, atendente.id)) return recusa(409, 'Você já está atendendo esta conversa.');
    if (conversa.status === 'atendimento_humano') {
      return recusa(409, `Esta conversa já está sendo atendida por ${conversa.atendente_nome || 'outro atendente'}.`);
    }
    return recusa(409, 'Não foi possível assumir esta conversa agora. Atualize a página e tente de novo.');
  }

  if (conversa.status !== 'atendimento_humano') return recusa(409, 'Esta conversa não está em atendimento humano.');
  const oQue = acao === 'devolver' ? 'devolver esta conversa ao bot' : 'encerrar esta conversa';
  return recusa(403, `Só ${conversa.atendente_nome || 'quem assumiu'} (ou um administrador) pode ${oQue}.`);
}

async function executar(db, acao, sql, params, conversaId, atendente) {
  const resultado = await db.query(sql, params);
  const conversa = await buscarConversa(db, conversaId); // já com o estado novo (ou o atual, se foi recusado)
  if (resultado.rows.length === 1) return { ok: true, conversa };
  return motivoDaRecusa(acao, conversa, atendente);
}

const assumir = (db, conversaId, atendente) =>
  executar(db, 'assumir', SQL_ASSUMIR, [conversaId, atendente.id], conversaId, atendente);

const devolverAoBot = (db, conversaId, atendente) =>
  executar(db, 'devolver', SQL_DEVOLVER, [conversaId, atendente.id, atendente.papel], conversaId, atendente);

const encerrar = (db, conversaId, atendente) =>
  executar(db, 'encerrar', SQL_ENCERRAR, [conversaId, atendente.id, atendente.papel], conversaId, atendente);

async function listarMensagens(db, conversaId, desdeId = '0') {
  const resultado = await db.query(`
    SELECT m.id, m.remetente, m.conteudo, m.feedback, m.enviada_em, a.nome AS atendente_nome
    FROM mensagens m
    LEFT JOIN atendentes a ON a.id = m.atendente_id
    WHERE m.conversa_id = $1 AND m.id > $2
    ORDER BY m.id ASC`, [conversaId, desdeId]);
  return resultado.rows;
}

async function registrarMensagemDoAtendente(db, conversaId, atendenteId, texto) {
  const resultado = await db.query(`
    INSERT INTO mensagens (conversa_id, remetente, conteudo, atendente_id)
    VALUES ($1, 'atendente', $2, $3)
    RETURNING id, remetente, conteudo, feedback, enviada_em`, [conversaId, texto, atendenteId]);
  return resultado.rows[0];
}

// Avisos automáticos ("Fulano entrou na conversa...") ficam registrados como mensagens do bot.
async function registrarAviso(db, conversaId, texto) {
  await db.query("INSERT INTO mensagens (conversa_id, remetente, conteudo) VALUES ($1, 'bot', $2)", [conversaId, texto]);
}

module.exports = {
  AVISOS,
  textoDoAtendente,
  mesmoId,
  buscarConversa,
  obterEstado,
  permissoes,
  assumir,
  devolverAoBot,
  encerrar,
  listarMensagens,
  registrarMensagemDoAtendente,
  registrarAviso,
};
