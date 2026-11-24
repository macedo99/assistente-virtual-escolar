// Métricas do dashboard: volume, satisfação, atendimento humano e perguntas sem resposta.

const { AVISOS } = require('./atendimento');
const { PREFIXO_INJECAO, ROTULOS_INJECAO, detectarInjecao } = require('./injecao');

const FUSO = 'America/Sao_Paulo';
const DESLOCAMENTO = '-03:00';
const DIAS_PADRAO = 30;
const DIAS_MAXIMOS = 180;
const LIMITE_RESPOSTA_S = 5; // RNF-01: "o bot deve responder em até ~5 segundos na maioria das interações"

// O "não encontrei" do fallback (nó "Gravar resposta bot" do n8n). Reconhecido pelo INÍCIO do texto, então
// pequenas mudanças no final da frase não quebram a métrica; se você mudar o começo dela no n8n, mude aqui.
const PREFIXO_FALLBACK = 'Não encontrei uma resposta confiável';

// HEURÍSTICA: respostas em que o modelo diz que o contexto não tem a informação. O texto varia de uma
// resposta para outra, então isto é uma aproximação (pode deixar passar variações). Padrões do ILIKE do
// Postgres (% = qualquer trecho); maiúsculas e minúsculas não importam, acentos sim.
const PADROES_SEM_CONTEXTO = [
  '%não contém informa%',
  '%não há informa%',
  '%não tenho informa%',
  '%não encontrei informa%',
  '%informações não são suficientes%',
  '%não há dados suficientes%',
];

const MOTIVOS = {
  sem_resposta: 'Sem resposta na base',
  contexto_insuficiente: 'Contexto insuficiente',
  avaliacao_negativa: 'Avaliada com 👎',
};

// ---------------------------------------------------------------------------------------------------------
// Datas (dia = texto "AAAA-MM-DD" no fuso de São Paulo)

let formatadorDia = null;
try {
  formatadorDia = new Intl.DateTimeFormat('en-GB', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' });
} catch (err) {
  formatadorDia = null; // plano B abaixo: UTC-3 fixo (o formato.js faz o mesmo)
}

function diaLocal(valor) {
  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) return null;
  if (!formatadorDia) return new Date(data.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const p = {};
  for (const parte of formatadorDia.formatToParts(data)) p[parte.type] = parte.value;
  return `${p.year}-${p.month}-${p.day}`;
}

function dataValida(texto) {
  if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const [a, m, d] = texto.split('-').map(Number);
  const data = new Date(Date.UTC(a, m - 1, d));
  return data.getUTCFullYear() === a && data.getUTCMonth() === m - 1 && data.getUTCDate() === d;
}

function somarDias(dia, n) {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

const diferencaEmDias = (de, ate) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000);

function diasDoPeriodo(de, ate) {
  const dias = [];
  for (let dia = de; dia <= ate; dia = somarDias(dia, 1)) dias.push(dia);
  return dias;
}

// "2026-11-18" → "18/11/2026"
const dataBR = (dia) => (dia ? dia.split('-').reverse().join('/') : '');

// Os instantes exatos do período: [ini, fim) — fim é a meia-noite do dia seguinte ao último dia.
function instantes({ de, ate }) {
  return { ini: new Date(`${de}T00:00:00${DESLOCAMENTO}`), fim: new Date(`${somarDias(ate, 1)}T00:00:00${DESLOCAMENTO}`) };
}

// Lê ?de=AAAA-MM-DD&ate=AAAA-MM-DD. Sem nada, usa os últimos 30 dias. Com algo inválido, também usa os
// últimos 30 dias, mas avisa. Devolve { de, ate, aviso, invalido, motivo }: a tela mostra o "aviso"; o CSV
// usa "invalido"/"motivo" para recusar (um relatório com período trocado em silêncio enganaria).
function lerPeriodo(consulta, agora = new Date()) {
  const hoje = diaLocal(agora);
  const padrao = { de: somarDias(hoje, -(DIAS_PADRAO - 1)), ate: hoje };
  const q = consulta || {};
  if (q.de === undefined && q.ate === undefined) return { ...padrao, aviso: '', invalido: false, motivo: '' };

  const recusar = (motivo) => ({ ...padrao, aviso: `${motivo} Mostrando os últimos ${DIAS_PADRAO} dias.`, invalido: true, motivo });
  if (!dataValida(q.de) || !dataValida(q.ate)) return recusar('Datas inválidas (use o formato AAAA-MM-DD).');
  if (q.de > q.ate) return recusar('A data inicial é depois da final.');
  if (diferencaEmDias(q.de, q.ate) + 1 > DIAS_MAXIMOS) return recusar(`O período passa de ${DIAS_MAXIMOS} dias.`);
  return { de: q.de, ate: q.ate, aviso: '', invalido: false, motivo: '' };
}

// Atalhos da barra de período (links prontos).
function atalhos(agora = new Date()) {
  const hoje = diaLocal(agora);
  const ate = hoje;
  return [
    { rotulo: 'Hoje', de: hoje, ate },
    { rotulo: '7 dias', de: somarDias(hoje, -6), ate },
    { rotulo: '30 dias', de: somarDias(hoje, -29), ate },
    { rotulo: '90 dias', de: somarDias(hoje, -89), ate },
  ];
}

// ---------------------------------------------------------------------------------------------------------
// Consultas (linhas cruas)

// Classifica cada mensagem do BOT:
//   aviso         → os recados que o dashboard grava ("fulano entrou na conversa", devolveu, encerrou)
//   injecao       → o aviso de "possível tentativa de prompt injection" (nó "Detecta injeção" do n8n)
//   fallback      → o "não encontrei uma resposta confiável"
//   sem_contexto  → resposta do modelo dizendo que o contexto não tem a informação (heurística)
//   resposta      → resposta normal do RAG
// Parâmetros: $3 modelo do aviso "assumiu", $4 aviso "devolveu", $5 aviso "encerrou", $6 início do fallback
// (com %), $7 lista de padrões da heurística, $8 início do aviso de prompt injection (com %).
const TIPO_SQL = `
    CASE
      WHEN m.remetente <> 'bot' THEN NULL
      WHEN m.conteudo LIKE $3 OR m.conteudo = $4 OR m.conteudo = $5 THEN 'aviso'
      WHEN m.conteudo LIKE $8 THEN 'injecao'
      WHEN m.conteudo LIKE $6 THEN 'fallback'
      WHEN m.conteudo ILIKE ANY ($7::text[]) THEN 'sem_contexto'
      ELSE 'resposta'
    END`;

// Para cada mensagem do período: o tipo (se for do bot), a hora da pergunta que ela respondeu (a mensagem
// do usuário imediatamente anterior na mesma conversa) e, só quando interessa às lacunas, o texto dessa pergunta.
const SQL_MENSAGENS = `
  WITH base AS (
    SELECT m.id, m.conversa_id, m.remetente, m.feedback, m.enviada_em,
           ${TIPO_SQL} AS tipo
    FROM mensagens m
    WHERE m.enviada_em >= $1 AND m.enviada_em < $2
  )
  SELECT b.id, b.conversa_id, b.remetente, b.feedback, b.enviada_em, b.tipo,
         (SELECT u.enviada_em
            FROM mensagens u
           WHERE u.conversa_id = b.conversa_id AND u.remetente = 'usuario' AND u.id < b.id
           ORDER BY u.id DESC LIMIT 1) AS pergunta_em,
         CASE WHEN b.tipo IN ('fallback', 'sem_contexto', 'injecao') OR b.feedback = 'negativo'
              THEN (SELECT left(u.conteudo, 500)
                      FROM mensagens u
                     WHERE u.conversa_id = b.conversa_id AND u.remetente = 'usuario' AND u.id < b.id
                     ORDER BY u.id DESC LIMIT 1)
         END AS pergunta
  FROM base b
  ORDER BY b.id`;

// Todos os eventos das conversas que tiveram algum evento no período (o evento seguinte a um pedido pode
// cair depois do fim do período: precisamos dele para medir a espera).
const SQL_EVENTOS = `
  SELECT e.id, e.conversa_id, e.status_anterior, e.status_novo, e.atendente_id, e.criado_em
  FROM conversa_eventos e
  WHERE e.conversa_id IN (
    SELECT x.conversa_id FROM conversa_eventos x
    WHERE x.criado_em >= $1 AND x.criado_em < $2
  )
  ORDER BY e.conversa_id, e.id`;

// A fila de AGORA (não depende do período).
const SQL_FILA_AGORA = `
  SELECT c.id, c.status,
         (SELECT max(e.criado_em)
            FROM conversa_eventos e
           WHERE e.conversa_id = c.id AND e.status_novo = 'aguardando_atendente') AS desde
  FROM conversas c
  WHERE c.status IN ('aguardando_atendente', 'atendimento_humano')`;

const SQL_NOVOS = `
  SELECT
    (SELECT count(*)::int FROM usuarios WHERE criado_em >= $1 AND criado_em < $2) AS usuarios_novos,
    (SELECT count(*)::int FROM conversas WHERE iniciada_em >= $1 AND iniciada_em < $2) AS conversas_novas`;

// Itens da base (todos, agora): o cartão Segurança procura neles ordens escondidas para o bot.
const SQL_ITENS_BASE = 'SELECT id, titulo, conteudo FROM itens_base_conhecimento ORDER BY id';

const SQL_CONVERSAS_INFO = `
  SELECT c.id, c.status, c.usuario_id, u.nome, u.papel
  FROM conversas c
  JOIN usuarios u ON u.id = c.usuario_id
  WHERE c.id = ANY($1::bigint[])
  ORDER BY c.id`;

const emIntervalo = (valor, ini, fim) => {
  const t = new Date(valor).getTime();
  return t >= ini.getTime() && t < fim.getTime();
};

// As conversas "do período": as que tiveram mensagem do usuário OU pedido de atendente no período.
function conversasDoPeriodo(mensagens, eventos, periodo) {
  const { ini, fim } = instantes(periodo);
  const ids = new Set();
  for (const m of mensagens) if (m.remetente === 'usuario') ids.add(String(m.conversa_id));
  for (const e of eventos) if (e.status_novo === 'aguardando_atendente' && emIntervalo(e.criado_em, ini, fim)) ids.add(String(e.conversa_id));
  return ids;
}

async function coletar(db, periodo) {
  const { ini, fim } = instantes(periodo);
  const janela = [ini.toISOString(), fim.toISOString()];
  const [mensagens, eventos, fila, novos, itens] = await Promise.all([
    db.query(SQL_MENSAGENS, [...janela, AVISOS.assumiu('%'), AVISOS.devolveu(), AVISOS.encerrou(), `${PREFIXO_FALLBACK}%`, PADROES_SEM_CONTEXTO, `${PREFIXO_INJECAO}%`]),
    db.query(SQL_EVENTOS, janela),
    db.query(SQL_FILA_AGORA),
    db.query(SQL_NOVOS, janela),
    db.query(SQL_ITENS_BASE),
  ]);

  const ids = [...conversasDoPeriodo(mensagens.rows, eventos.rows, periodo)];
  const conversas = ids.length ? await db.query(SQL_CONVERSAS_INFO, [ids]) : { rows: [] };

  return {
    mensagens: mensagens.rows,
    eventos: eventos.rows,
    fila: fila.rows,
    novos: novos.rows[0] || { usuarios_novos: 0, conversas_novas: 0 },
    conversas: conversas.rows,
    itens: itens.rows,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Cálculo (função pura)

// Percentil com interpolação linear — o mesmo critério do percentile_cont do Postgres.
function percentil(valores, p) {
  if (!valores.length) return null;
  const v = [...valores].sort((a, b) => a - b);
  const posicao = p * (v.length - 1);
  const baixo = Math.floor(posicao);
  const alto = Math.ceil(posicao);
  return v[baixo] + (v[alto] - v[baixo]) * (posicao - baixo);
}

const resumoTempos = (valores) => ({ n: valores.length, mediana_s: percentil(valores, 0.5), p90_s: percentil(valores, 0.9) });
const razao = (parte, total) => (total > 0 ? (parte / total) * 100 : null);

// Percorre a trilha de eventos de cada conversa e emparelha:
//   pedido  (→ aguardando_atendente) + próximo evento → atendido (virou atendimento_humano), abandonado
//                                                       (voltou ao bot ou encerrou sem ninguém atender) ou
//                                                       na fila (ainda não houve próximo evento)
//   atendimento (→ atendimento_humano) + próximo evento (→ bot ou encerrada) → duração
// "eventos" precisa estar ordenado por conversa_id e id (o SQL_EVENTOS já entrega assim).
function parearEventos(eventos) {
  const pedidos = [];
  const atendimentos = [];
  for (let i = 0; i < eventos.length; i += 1) {
    const e = eventos[i];
    const proximo = eventos[i + 1] && String(eventos[i + 1].conversa_id) === String(e.conversa_id) ? eventos[i + 1] : null;

    if (e.status_novo === 'aguardando_atendente') {
      const pedido = { conversa_id: String(e.conversa_id), em: new Date(e.criado_em), desfecho: 'na_fila', espera_s: null };
      if (proximo && proximo.status_novo === 'atendimento_humano') {
        pedido.desfecho = 'atendido';
        pedido.espera_s = (new Date(proximo.criado_em) - pedido.em) / 1000;
      } else if (proximo) {
        pedido.desfecho = 'abandonado';
      }
      pedidos.push(pedido);
    }

    if (e.status_novo === 'atendimento_humano') {
      const atendimento = { conversa_id: String(e.conversa_id), inicio: new Date(e.criado_em), duracao_s: null, em_andamento: true };
      if (proximo && (proximo.status_novo === 'bot' || proximo.status_novo === 'encerrada')) {
        atendimento.em_andamento = false;
        atendimento.duracao_s = (new Date(proximo.criado_em) - atendimento.inicio) / 1000;
      }
      atendimentos.push(atendimento);
    }
  }
  return { pedidos, atendimentos };
}

// "Qual o prazo?", "qual o prazo" e "  Qual o prazo ?? " contam como a mesma pergunta.
const normalizarPergunta = (texto) => String(texto).toLowerCase().replace(/\s+/g, ' ').replace(/[\s?!.¿¡,;:]+$/u, '').trim();

function hrefCadastrar(pergunta) {
  return `/base/novo?titulo=${encodeURIComponent(String(pergunta).slice(0, 200))}`;
}

function calcular(dados, periodo, agora = new Date()) {
  const { ini, fim } = instantes(periodo);
  const dias = diasDoPeriodo(periodo.de, periodo.ate);
  const mensagens = dados.mensagens;

  // ---- volume
  const doUsuario = mensagens.filter((m) => m.remetente === 'usuario');
  const doBot = mensagens.filter((m) => m.remetente === 'bot' && m.tipo !== 'aviso');
  const respostasIA = doBot.filter((m) => m.tipo === 'resposta' || m.tipo === 'sem_contexto'); // as que levam 👍/👎

  // ---- atendimento humano (trilha de eventos)
  const { pedidos: todosPedidos, atendimentos: todosAtendimentos } = parearEventos(dados.eventos);
  const pedidos = todosPedidos.filter((p) => emIntervalo(p.em, ini, fim));
  const atendimentos = todosAtendimentos.filter((a) => emIntervalo(a.inicio, ini, fim));

  const populacao = conversasDoPeriodo(mensagens, dados.eventos, periodo);
  const comPedido = new Set(pedidos.map((p) => p.conversa_id));
  const infoConversa = new Map(dados.conversas.map((c) => [String(c.id), c]));
  const usuariosAtivos = new Set();
  for (const id of populacao) {
    const info = infoConversa.get(id);
    if (info) usuariosAtivos.add(String(info.usuario_id));
  }

  // ---- satisfação
  const positivas = mensagens.filter((m) => m.remetente === 'bot' && m.feedback === 'positivo').length;
  const negativas = mensagens.filter((m) => m.remetente === 'bot' && m.feedback === 'negativo').length;

  // ---- tempo de resposta do bot: da pergunta do usuário até a resposta (fallback também conta)
  const temposResposta = doBot
    .filter((m) => m.pergunta_em)
    .map((m) => (new Date(m.enviada_em) - new Date(m.pergunta_em)) / 1000)
    .filter((s) => s >= 0);

  // ---- fila de agora
  const esperando = dados.fila.filter((c) => c.status === 'aguardando_atendente');
  const desdeEsperando = esperando.filter((c) => c.desde).map((c) => (agora - new Date(c.desde)) / 1000);

  // ---- série por dia (dia = dia local de São Paulo)
  const porDia = new Map(dias.map((dia) => [dia, { dia, conversas: new Set(), mensagens: 0 }]));
  for (const m of doUsuario) {
    const alvo = porDia.get(diaLocal(m.enviada_em));
    if (!alvo) continue;
    alvo.mensagens += 1;
    alvo.conversas.add(String(m.conversa_id));
  }
  const serie = dias.map((dia) => ({ dia, conversas: porDia.get(dia).conversas.size, mensagens: porDia.get(dia).mensagens }));

  // ---- perguntas sem resposta (lacunas): fallback + contexto insuficiente + 👎
  const grupos = new Map();
  for (const m of mensagens) {
    if (m.remetente !== 'bot' || !m.pergunta) continue;
    const motivos = [];
    if (m.tipo === 'fallback') motivos.push('sem_resposta');
    if (m.tipo === 'sem_contexto') motivos.push('contexto_insuficiente');
    if (m.feedback === 'negativo') motivos.push('avaliacao_negativa');
    if (!motivos.length) continue;

    const chave = normalizarPergunta(m.pergunta);
    if (!chave) continue;
    const grupo = grupos.get(chave) || { pergunta: m.pergunta.trim(), vezes: 0, ultima: null, motivos: new Set() };
    grupo.vezes += 1;
    if (!grupo.ultima || new Date(m.enviada_em) >= grupo.ultima) {
      grupo.ultima = new Date(m.enviada_em);
      grupo.pergunta = m.pergunta.trim(); // mostra a redação mais recente
    }
    for (const motivo of motivos) grupo.motivos.add(motivo);
    grupos.set(chave, grupo);
  }
  const lacunas = [...grupos.values()]
    .sort((a, b) => b.vezes - a.vezes || b.ultima - a.ultima || a.pergunta.localeCompare(b.pergunta, 'pt-BR'))
    .map((g) => ({
      pergunta: g.pergunta,
      vezes: g.vezes,
      ultima: g.ultima,
      motivos: Object.keys(MOTIVOS).filter((k) => g.motivos.has(k)),
      href: hrefCadastrar(g.pergunta),
    }));

  // ---- uma linha por conversa (para o CSV de conversas)
  const conversas = [...populacao]
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => {
      const info = infoConversa.get(id) || {};
      const meusPedidos = pedidos.filter((p) => p.conversa_id === id);
      const meusAtendimentos = atendimentos.filter((a) => a.conversa_id === id);
      const soma = (lista, campo) => lista.reduce((t, x) => t + (x[campo] || 0), 0);
      return {
        id,
        usuario: info.nome || '',
        papel: info.papel || '',
        status_atual: info.status || '',
        mensagens_usuario: doUsuario.filter((m) => String(m.conversa_id) === id).length,
        respostas_bot: doBot.filter((m) => String(m.conversa_id) === id).length,
        pedidos: meusPedidos.length,
        espera_total_s: meusPedidos.some((p) => p.espera_s !== null) ? soma(meusPedidos, 'espera_s') : null,
        atendimento_total_s: meusAtendimentos.some((a) => a.duracao_s !== null) ? soma(meusAtendimentos, 'duracao_s') : null,
      };
    });

  // ---- segurança: tentativas de prompt injection bloqueadas (a mensagem do usuário que causou o aviso passa de
  // novo pelo detector, para saber o tipo) e itens da base que têm, agora, ordens escondidas para o bot.
  const tentativas = doBot
    .filter((m) => m.tipo === 'injecao')
    .map((m) => {
      const info = infoConversa.get(String(m.conversa_id)) || {};
      const motivos = m.pergunta ? detectarInjecao(m.pergunta).motivos : [];
      return {
        em: new Date(m.enviada_em),
        conversa_id: String(m.conversa_id),
        usuario_id: info.usuario_id === undefined ? null : String(info.usuario_id),
        usuario: info.nome || '—',
        mensagem: m.pergunta ? String(m.pergunta).replace(/\s+/g, ' ').trim() : '(mensagem não encontrada)',
        motivos: motivos.length ? motivos : ['desconhecido'],
      };
    })
    .sort((a, b) => b.em - a.em);
  const porMotivo = new Map();
  for (const t of tentativas) for (const motivo of t.motivos) porMotivo.set(motivo, (porMotivo.get(motivo) || 0) + 1);
  const itensSuspeitos = (dados.itens || [])
    .map((item) => ({ id: String(item.id), titulo: item.titulo, r: detectarInjecao(`${item.titulo}\n${item.conteudo}`, { origem: 'documento' }) }))
    .filter((x) => x.r.injecao)
    .map((x) => ({ id: x.id, titulo: x.titulo, motivos: x.r.motivos.map((m) => ROTULOS_INJECAO[m] || m) }));

  return {
    periodo: { de: periodo.de, ate: periodo.ate, dias: dias.length },
    volume: {
      conversas_ativas: populacao.size,
      mensagens_usuario: doUsuario.length,
      respostas_bot: doBot.length,
      // respostas com o aviso de prompt injection (o LLM nem foi chamado)
      injecoes_bloqueadas: doBot.filter((m) => m.tipo === 'injecao').length,
      usuarios_ativos: usuariosAtivos.size,
      usuarios_novos: Number(dados.novos.usuarios_novos) || 0,
      conversas_novas: Number(dados.novos.conversas_novas) || 0,
    },
    satisfacao: {
      positivas,
      negativas,
      avaliadas: positivas + negativas,
      respostas_avaliaveis: respostasIA.length,
      percentual: razao(positivas, positivas + negativas),
      taxa_avaliacao: razao(positivas + negativas, respostasIA.length),
    },
    atendimento: {
      conversas: populacao.size,
      conversas_com_pedido: comPedido.size,
      pedidos: pedidos.length,
      pedidos_atendidos: pedidos.filter((p) => p.desfecho === 'atendido').length,
      pedidos_abandonados: pedidos.filter((p) => p.desfecho === 'abandonado').length,
      pedidos_na_fila: pedidos.filter((p) => p.desfecho === 'na_fila').length,
      taxa_handoff: razao(comPedido.size, populacao.size),
      taxa_resolucao_bot: populacao.size > 0 ? 100 - razao(comPedido.size, populacao.size) : null,
    },
    fila: {
      esperando_agora: esperando.length,
      em_atendimento_agora: dados.fila.filter((c) => c.status === 'atendimento_humano').length,
      mais_antiga_s: desdeEsperando.length ? Math.max(...desdeEsperando) : null,
      espera: resumoTempos(pedidos.filter((p) => p.desfecho === 'atendido').map((p) => p.espera_s)),
    },
    duracao: {
      ...resumoTempos(atendimentos.filter((a) => a.duracao_s !== null).map((a) => a.duracao_s)),
      em_andamento: atendimentos.filter((a) => a.em_andamento).length,
    },
    resposta_bot: {
      ...resumoTempos(temposResposta),
      limite_s: LIMITE_RESPOSTA_S,
      dentro_do_limite_pct: razao(temposResposta.filter((s) => s <= LIMITE_RESPOSTA_S).length, temposResposta.length),
    },
    seguranca: {
      tentativas: tentativas.length,
      usuarios: new Set(tentativas.map((t) => t.usuario_id).filter(Boolean)).size,
      por_motivo: [...porMotivo.entries()]
        .map(([motivo, vezes]) => ({ motivo, rotulo: ROTULOS_INJECAO[motivo] || motivo, vezes }))
        .sort((a, b) => b.vezes - a.vezes || a.rotulo.localeCompare(b.rotulo, 'pt-BR')),
      lista: tentativas.map((t) => ({ ...t, motivos: t.motivos.map((m) => ROTULOS_INJECAO[m] || m) })),
      itens_suspeitos: itensSuspeitos,
    },
    serie,
    lacunas,
    conversas,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Formatação (pt-BR)

function formatarDuracao(segundos) {
  if (segundos === null || segundos === undefined || Number.isNaN(segundos)) return '—';
  const s = Number(segundos);
  if (s < 10) return `${(Math.round(s * 10) / 10).toString().replace('.', ',')} s`;
  const total = Math.round(s);
  if (total < 60) return `${total} s`;
  if (total < 3600) return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
  return `${Math.floor(total / 3600)} h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')} min`;
}

function formatarPercentual(valor) {
  if (valor === null || valor === undefined || Number.isNaN(valor)) return '—';
  const r = Math.round(valor * 10) / 10;
  return `${String(r).replace('.', ',')}%`;
}

const formatarNumero = (valor) => (valor === null || valor === undefined ? '—' : Number(valor).toLocaleString('pt-BR'));

// ---------------------------------------------------------------------------------------------------------
// Gráfico de barras em SVG (sem biblioteca). Só números e datas calculadas aqui entram no desenho; nenhum
// texto vindo do banco, então a saída pode ir direto para a página.

function graficoBarras(serie, campo, rotulo) {
  const largura = 640;
  const altura = 180;
  const margem = { esq: 34, dir: 8, topo: 12, base: 26 };
  const areaL = largura - margem.esq - margem.dir;
  const areaA = altura - margem.topo - margem.base;
  const maximo = Math.max(0, ...serie.map((d) => d[campo]));
  const total = serie.reduce((t, d) => t + d[campo], 0);

  const partes = [`<svg class="grafico" viewBox="0 0 ${largura} ${altura}" role="img" aria-label="${rotulo}" preserveAspectRatio="xMidYMid meet">`];
  partes.push(`<line class="grafico-eixo" x1="${margem.esq}" y1="${margem.topo + areaA}" x2="${largura - margem.dir}" y2="${margem.topo + areaA}"/>`);

  if (total === 0) {
    partes.push(`<text class="grafico-vazio" x="${largura / 2}" y="${margem.topo + areaA / 2}" text-anchor="middle">Sem dados no período</text>`);
  } else {
    const topoEscala = maximo < 4 ? 4 : maximo; // escala mínima de 4 para uma barra de "1" não ocupar a altura toda
    const passo = areaL / serie.length;
    const larguraBarra = Math.max(1, passo * 0.7);
    partes.push(`<text class="grafico-rotulo" x="${margem.esq - 6}" y="${margem.topo + 4}" text-anchor="end">${topoEscala}</text>`);
    partes.push(`<text class="grafico-rotulo" x="${margem.esq - 6}" y="${margem.topo + areaA}" text-anchor="end">0</text>`);
    serie.forEach((d, i) => {
      const valor = d[campo];
      const h = (valor / topoEscala) * areaA;
      const x = margem.esq + i * passo + (passo - larguraBarra) / 2;
      const y = margem.topo + areaA - h;
      const dia = dataBR(d.dia).slice(0, 5);
      partes.push(`<rect class="grafico-barra" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${larguraBarra.toFixed(2)}" height="${h.toFixed(2)}"><title>${dia}: ${valor}</title></rect>`);
    });
    const marcas = new Set([0, Math.floor((serie.length - 1) / 2), serie.length - 1]);
    for (const i of marcas) {
      const x = margem.esq + i * passo + passo / 2;
      const ancora = i === 0 ? 'start' : i === serie.length - 1 ? 'end' : 'middle';
      const xAjustado = i === 0 ? margem.esq : i === serie.length - 1 ? largura - margem.dir : x;
      partes.push(`<text class="grafico-rotulo" x="${xAjustado.toFixed(2)}" y="${altura - 8}" text-anchor="${ancora}">${dataBR(serie[i].dia).slice(0, 5)}</text>`);
    }
  }
  partes.push('</svg>');
  return partes.join('');
}

// ---------------------------------------------------------------------------------------------------------
// CSV (separador ";" e UTF-8 com BOM: abre direto no Excel em português)

const BOM = '\uFEFF';

function celulaCsv(valor) {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'number') return Number.isInteger(valor) ? String(valor) : String(Math.round(valor * 100) / 100).replace('.', ',');
  let texto = String(valor).replace(/\r\n?/g, '\n');
  // Texto que começa com = + - @ (ou tab) viraria uma fórmula no Excel (injeção de fórmula): o apóstrofo neutraliza.
  if (/^[=+\-@\t]/.test(texto)) texto = `'${texto}`;
  if (/[;"\n]/.test(texto)) texto = `"${texto.replace(/"/g, '""')}"`;
  return texto;
}

const montarCsv = (linhas) => BOM + linhas.map((linha) => linha.map(celulaCsv).join(';')).join('\r\n') + '\r\n';

const sim = (condicao) => (condicao ? 'sim' : 'não');

function csvResumo(r, geradoEm) {
  const pct = (v) => (v === null ? null : Math.round(v * 10) / 10);
  const seg = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return montarCsv([
    ['Relatório de métricas do atendimento'],
    ['Período', `${dataBR(r.periodo.de)} a ${dataBR(r.periodo.ate)}`],
    ['Gerado em', geradoEm],
    [],
    ['Métrica', 'Valor', 'Unidade'],
    ['Conversas ativas', r.volume.conversas_ativas, 'conversas'],
    ['Conversas novas', r.volume.conversas_novas, 'conversas'],
    ['Mensagens do usuário', r.volume.mensagens_usuario, 'mensagens'],
    ['Respostas do bot', r.volume.respostas_bot, 'mensagens'],
    ['Tentativas de prompt injection bloqueadas', r.volume.injecoes_bloqueadas, 'mensagens'],
    ['Usuários ativos', r.volume.usuarios_ativos, 'usuários'],
    ['Usuários novos', r.volume.usuarios_novos, 'usuários'],
    ['Avaliações positivas (👍)', r.satisfacao.positivas, 'avaliações'],
    ['Avaliações negativas (👎)', r.satisfacao.negativas, 'avaliações'],
    ['Satisfação (👍 ÷ avaliadas)', pct(r.satisfacao.percentual), '%'],
    ['Taxa de avaliação (avaliadas ÷ respostas do modelo)', pct(r.satisfacao.taxa_avaliacao), '%'],
    ['Conversas com pedido de atendente', r.atendimento.conversas_com_pedido, 'conversas'],
    ['Pedidos de atendente', r.atendimento.pedidos, 'pedidos'],
    ['Taxa de handoff', pct(r.atendimento.taxa_handoff), '%'],
    ['Taxa de resolução pelo bot (sem pedido de atendente)', pct(r.atendimento.taxa_resolucao_bot), '%'],
    ['Espera na fila — mediana', seg(r.fila.espera.mediana_s), 'segundos'],
    ['Espera na fila — p90', seg(r.fila.espera.p90_s), 'segundos'],
    ['Pedidos atendidos (base da espera)', r.fila.espera.n, 'pedidos'],
    ['Duração do atendimento — mediana', seg(r.duracao.mediana_s), 'segundos'],
    ['Duração do atendimento — p90', seg(r.duracao.p90_s), 'segundos'],
    ['Atendimentos concluídos (base da duração)', r.duracao.n, 'atendimentos'],
    ['Tempo de resposta do bot — mediana', seg(r.resposta_bot.mediana_s), 'segundos'],
    ['Tempo de resposta do bot — p90', seg(r.resposta_bot.p90_s), 'segundos'],
    [`Respostas do bot em até ${r.resposta_bot.limite_s} s`, pct(r.resposta_bot.dentro_do_limite_pct), '%'],
    ['Respostas medidas (base do tempo de resposta)', r.resposta_bot.n, 'respostas'],
    ['Perguntas sem resposta (distintas)', r.lacunas.length, 'perguntas'],
  ]);
}

function csvConversas(r) {
  const cabecalho = ['Conversa', 'Usuário', 'Papel', 'Status atual', 'Mensagens do usuário', 'Respostas do bot', 'Pedidos de atendente', 'Espera na fila (s, soma)', 'Atendimento (s, soma)'];
  const linhas = r.conversas.map((c) => [
    Number(c.id), c.usuario, c.papel, c.status_atual, c.mensagens_usuario, c.respostas_bot, c.pedidos,
    c.espera_total_s === null ? null : Math.round(c.espera_total_s * 10) / 10,
    c.atendimento_total_s === null ? null : Math.round(c.atendimento_total_s * 10) / 10,
  ]);
  return montarCsv([cabecalho, ...linhas]);
}

function csvSeguranca(r, formatarDataHoraCompleta) {
  const cabecalho = ['Quando', 'Usuário', 'Conversa', 'Tipo de ataque', 'Mensagem'];
  const linhas = r.seguranca.lista.map((t) => [formatarDataHoraCompleta(t.em), t.usuario, t.conversa_id, t.motivos.join(', '), t.mensagem]);
  return montarCsv([cabecalho, ...linhas]);
}

function csvLacunas(r, formatarDataHoraCompleta) {
  const cabecalho = ['Pergunta', 'Vezes', 'Última vez', 'Motivos'];
  const linhas = r.lacunas.map((l) => [l.pergunta, l.vezes, formatarDataHoraCompleta(l.ultima), l.motivos.map((m) => MOTIVOS[m]).join(', ')]);
  return montarCsv([cabecalho, ...linhas]);
}

module.exports = {
  LIMITE_RESPOSTA_S,
  DIAS_MAXIMOS,
  PREFIXO_FALLBACK,
  PADROES_SEM_CONTEXTO,
  MOTIVOS,
  diaLocal,
  dataValida,
  somarDias,
  diasDoPeriodo,
  dataBR,
  instantes,
  lerPeriodo,
  atalhos,
  coletar,
  conversasDoPeriodo,
  percentil,
  parearEventos,
  normalizarPergunta,
  calcular,
  formatarDuracao,
  formatarPercentual,
  formatarNumero,
  graficoBarras,
  celulaCsv,
  montarCsv,
  csvResumo,
  csvConversas,
  csvLacunas,
  csvSeguranca,
};
