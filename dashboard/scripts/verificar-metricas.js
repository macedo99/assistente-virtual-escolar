// Confere se as métricas do Passo 8c calculam o que dizem calcular, NO SEU BANCO: grava um cenário pequeno
// (3 usuários, 3 conversas, mensagens e eventos com horários controlados, em janeiro de 2099) e confere cada
// número: volume, satisfação, handoff, espera na fila, duração do atendimento, tempo de resposta do bot,
// perguntas sem resposta, séries por dia e os CSVs. O cenário e os números esperados estão em
// scripts/cenario-metricas.js.
//
// NÃO deixa nenhum dado para trás: tudo roda numa transação que é DESFEITA (ROLLBACK) no final, mesmo se
// alguma verificação falhar. Efeito colateral inofensivo: os contadores de id (BIGSERIAL) avançam.
// Como o cenário é de 2099, ele nunca se mistura com os seus dados reais.
//
//   docker compose exec dashboard node scripts/verificar-metricas.js
//
// Sai com código 0 se tudo passou e 1 se alguma verificação falhou.
const assert = require('assert');
const pool = require('../src/db');
const metricas = require('../src/metricas');
const { AVISOS } = require('../src/atendimento');
const cenario = require('./cenario-metricas');

const SEM_CONEXAO = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'];
let passaram = 0;
let falharam = 0;
let puladas = 0;
let numero = 0;

function mostrar(situacao, nome, detalhe) {
  numero += 1;
  const marca = { ok: '✔', falha: '✘', pulada: '–' }[situacao];
  console.log(`  ${marca}  ${String(numero).padStart(2, '0')} ${nome}` + (detalhe ? `\n         ${situacao === 'falha' ? '→ ' : ''}${detalhe}` : ''));
}

async function verificar(nome, funcao) {
  try {
    await funcao();
    passaram += 1;
    mostrar('ok', nome);
    return true;
  } catch (err) {
    if (SEM_CONEXAO.includes(err.code)) throw err;
    falharam += 1;
    mostrar('falha', nome, err.message);
    return false;
  }
}

function pular(nome, motivo) {
  puladas += 1;
  mostrar('pulada', nome, `(${motivo})`);
}

const perto = (obtido, esperado, rotulo) => {
  assert(typeof obtido === 'number' && Math.abs(obtido - esperado) < 1e-6, `${rotulo}: esperava ${esperado}, veio ${obtido}`);
};

async function estrutura() {
  console.log('Estrutura do banco e consultas');
  let tudoOk = true;

  tudoOk = (await verificar('a tabela conversa_eventos existe (migração do 8a aplicada)', async () => {
    const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'conversa_eventos'");
    const colunas = r.rows.map((x) => x.column_name);
    assert(colunas.length > 0, 'tabela não encontrada: aplique a migração do 8a (docker compose exec dashboard node scripts/aplicar-migracao.js)');
    const faltam = ['id', 'conversa_id', 'status_anterior', 'status_novo', 'atendente_id', 'criado_em'].filter((c) => !colunas.includes(c));
    assert(faltam.length === 0, `faltam as colunas: ${faltam.join(', ')}`);
  })) && tudoOk;

  tudoOk = (await verificar('a tabela mensagens tem feedback e enviada_em', async () => {
    const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'mensagens'");
    const colunas = r.rows.map((x) => x.column_name);
    const faltam = ['feedback', 'enviada_em', 'remetente', 'conteudo', 'conversa_id'].filter((c) => !colunas.includes(c));
    assert(faltam.length === 0, `faltam as colunas: ${faltam.join(', ')}`);
  })) && tudoOk;

  tudoOk = (await verificar('o Postgres reconhece os avisos do dashboard (LIKE com emoji) e as frases da heurística (ILIKE com acento)', async () => {
    const aviso = await pool.query('SELECT $1::text LIKE $2::text AS ok', [AVISOS.assumiu('Maria da Silva'), AVISOS.assumiu('%')]);
    assert.strictEqual(aviso.rows[0].ok, true, 'o modelo do aviso "entrou na conversa" não casou com um aviso real (emoji ou acentos?)');
    const heuristica = await pool.query('SELECT $1::text ILIKE ANY ($2::text[]) AS ok', ['O contexto fornecido NÃO CONTÉM informações sobre isso.', metricas.PADROES_SEM_CONTEXTO]);
    assert.strictEqual(heuristica.rows[0].ok, true, 'a heurística de "contexto não contém" não casou (acentos/maiúsculas?)');
    const fallback = await pool.query('SELECT $1::text LIKE $2::text AS ok', [cenario.FALLBACK, `${metricas.PREFIXO_FALLBACK}%`]);
    assert.strictEqual(fallback.rows[0].ok, true, 'o início do "não encontrei" não casou com o texto do fallback');
  })) && tudoOk;

  return tudoOk;
}

// Grava o cenário. Devolve { idsConversa: { C1: '12', ... } }.
async function gravarCenario(client) {
  const sufixo = Math.floor(Math.random() * 900000) + 100000;
  const idUsuario = {};
  for (const [i, u] of cenario.USUARIOS.entries()) {
    const r = await client.query(
      'INSERT INTO usuarios (telegram_chat_id, nome, papel, criado_em) VALUES ($1, $2, $3, COALESCE($4::timestamptz, now())) RETURNING id',
      [990000000000 + sufixo * 10 + i, u.nome, u.papel, u.criado_em],
    );
    idUsuario[u.chave] = r.rows[0].id;
  }
  const idConversa = {};
  for (const c of cenario.CONVERSAS) {
    const r = await client.query(
      "INSERT INTO conversas (usuario_id, status, iniciada_em) VALUES ($1, 'bot', COALESCE($2::timestamptz, now())) RETURNING id",
      [idUsuario[c.usuario], c.iniciada_em],
    );
    idConversa[c.chave] = r.rows[0].id;
  }
  for (const m of cenario.MENSAGENS) {
    await client.query(
      'INSERT INTO mensagens (conversa_id, remetente, conteudo, feedback, enviada_em) VALUES ($1, $2, $3, $4, $5::timestamptz)',
      [idConversa[m.c], m.de, m.texto, m.feedback || null, m.em],
    );
  }
  for (const e of cenario.EVENTOS) {
    await client.query(
      'INSERT INTO conversa_eventos (conversa_id, status_anterior, status_novo, criado_em) VALUES ($1, $2, $3, $4::timestamptz)',
      [idConversa[e.c], e.de, e.para, e.em],
    );
  }
  return { idConversa };
}

async function cenarioNumerico() {
  console.log('\nCenário de números exatos (numa transação que é desfeita no final)');
  const E = cenario.ESPERADO;
  const client = await pool.connect();
  const ctx = {};
  let seguir = true;
  const passo = async (nome, funcao) => {
    if (!seguir) return pular(nome, 'depende de uma verificação anterior que falhou');
    seguir = await verificar(nome, funcao);
  };

  try {
    await client.query('BEGIN');

    await passo(`grava o cenário (${cenario.USUARIOS.length} usuários, ${cenario.CONVERSAS.length} conversas, ${cenario.MENSAGENS.length} mensagens, ${cenario.EVENTOS.length} eventos)`, async () => {
      ctx.ids = await gravarCenario(client);
    });

    await passo('coletar() traz as mensagens do período (as de fora, não) e os eventos', async () => {
      ctx.dados = await metricas.coletar(client, cenario.PERIODO);
      const { ini, fim } = metricas.instantes(cenario.PERIODO);
      const dentro = cenario.MENSAGENS.filter((m) => new Date(m.em) >= ini && new Date(m.em) < fim).length;
      assert.strictEqual(ctx.dados.mensagens.length, dentro, `esperava ${dentro} mensagens no período, vieram ${ctx.dados.mensagens.length}`);
      assert(ctx.dados.eventos.length >= cenario.EVENTOS.length, 'os eventos do cenário não vieram');
      ctx.r = metricas.calcular(ctx.dados, cenario.PERIODO, new Date('2099-02-05T12:00:00-03:00'));
    });

    await passo('cada mensagem do bot é classificada certo (aviso, não encontrei, contexto insuficiente, resposta)', async () => {
      const por = {};
      for (const m of ctx.dados.mensagens.filter((x) => x.remetente === 'bot')) por[m.tipo] = (por[m.tipo] || 0) + 1;
      assert.deepStrictEqual(por, { aviso: 2, fallback: 2, sem_contexto: 1, resposta: 3 }, `contagem por tipo: ${JSON.stringify(por)}`);
    });

    await passo('volume: conversas ativas, mensagens, respostas do bot (sem os avisos), usuários ativos e novos', async () => {
      assert.deepStrictEqual(ctx.r.volume, E.volume);
    });

    await passo('as fronteiras do período no fuso de São Paulo valem (00:00:00 entra, 23:59:59 entra, o dia seguinte não)', async () => {
      assert.strictEqual(ctx.r.serie[0].mensagens, 1, '01/01 00:00:00 deveria entrar');
      assert.strictEqual(ctx.r.serie[30].mensagens, 1, '31/01 23:59:59 deveria entrar');
      const so31 = metricas.calcular(await metricas.coletar(client, { de: '2098-12-31', ate: '2098-12-31' }), { de: '2098-12-31', ate: '2098-12-31' }, new Date());
      assert.strictEqual(so31.volume.mensagens_usuario, 1, '31/12/2098 23:59:59 pertence a 31/12, não a janeiro');
      const so01 = metricas.calcular(await metricas.coletar(client, { de: '2099-02-01', ate: '2099-02-01' }), { de: '2099-02-01', ate: '2099-02-01' }, new Date());
      assert.strictEqual(so01.volume.mensagens_usuario, 1, '01/02/2099 00:00:00 pertence a 01/02');
    });

    await passo('satisfação: 2 👍, 1 👎, 66,7%; 3 avaliadas de 4 respostas do modelo (75%)', async () => {
      const s = ctx.r.satisfacao;
      for (const k of ['positivas', 'negativas', 'avaliadas', 'respostas_avaliaveis']) assert.strictEqual(s[k], E.satisfacao[k], k);
      perto(s.percentual, E.satisfacao.percentual, 'percentual');
      perto(s.taxa_avaliacao, E.satisfacao.taxa_avaliacao, 'taxa_avaliacao');
    });

    await passo('handoff: 1 conversa de 3 pediu atendente (33,3%); resolvidas pelo bot 66,7%', async () => {
      const a = ctx.r.atendimento;
      for (const k of ['conversas', 'conversas_com_pedido', 'pedidos', 'pedidos_atendidos', 'pedidos_abandonados', 'pedidos_na_fila']) assert.strictEqual(a[k], E.atendimento[k], k);
      perto(a.taxa_handoff, E.atendimento.taxa_handoff, 'taxa_handoff');
      perto(a.taxa_resolucao_bot, E.atendimento.taxa_resolucao_bot, 'taxa_resolucao_bot');
    });

    await passo('espera na fila = 120 s e duração do atendimento = 720 s (da trilha de eventos)', async () => {
      assert.deepStrictEqual(ctx.r.fila.espera, E.espera);
      assert.deepStrictEqual(ctx.r.duracao, E.duracao);
    });

    await passo('tempo de resposta do bot: 6 respostas, mediana 4,5 s, p90 7,5 s, 66,7% em até 5 s', async () => {
      const b = ctx.r.resposta_bot;
      assert.strictEqual(b.n, E.resposta_bot.n, 'n');
      perto(b.mediana_s, E.resposta_bot.mediana_s, 'mediana');
      perto(b.p90_s, E.resposta_bot.p90_s, 'p90');
      perto(b.dentro_do_limite_pct, E.resposta_bot.dentro_do_limite_pct, 'dentro do limite');
    });

    await passo('série por dia: 31 dias, e os dias com movimento batem', async () => {
      assert.strictEqual(ctx.r.serie.length, E.serie.dias);
      for (const d of ctx.r.serie) {
        assert.deepStrictEqual({ conversas: d.conversas, mensagens: d.mensagens }, E.serie.movimento[d.dia] || { conversas: 0, mensagens: 0 }, `dia ${d.dia}`);
      }
    });

    await passo('perguntas sem resposta: agrupadas, com os motivos certos e na ordem certa', async () => {
      const obtido = ctx.r.lacunas.map((l) => ({ pergunta: l.pergunta, vezes: l.vezes, motivos: l.motivos }));
      assert.deepStrictEqual(obtido, E.lacunas);
    });

    await passo('uma linha por conversa (base do CSV de conversas), com nome e totais', async () => {
      const obtido = ctx.r.conversas.map((c) => ({
        usuario: c.usuario, mensagens_usuario: c.mensagens_usuario, respostas_bot: c.respostas_bot, pedidos: c.pedidos,
        espera_total_s: c.espera_total_s, atendimento_total_s: c.atendimento_total_s,
      }));
      assert.deepStrictEqual(obtido, E.conversas);
    });

    await passo('os três CSVs saem completos (resumo, conversas, sem resposta)', async () => {
      const resumo = metricas.csvResumo(ctx.r, 'teste');
      assert(resumo.includes('Conversas ativas;3;conversas') && resumo.includes('Espera na fila — mediana;120;segundos'), 'CSV de resumo incompleto');
      const conversas = metricas.csvConversas(ctx.r).split('\r\n').filter(Boolean);
      assert.strictEqual(conversas.length, 1 + cenario.CONVERSAS.length, 'CSV de conversas: número de linhas');
      const lacunas = metricas.csvLacunas(ctx.r, (d) => d.toISOString()).split('\r\n').filter(Boolean);
      assert.strictEqual(lacunas.length, 1 + E.lacunas.length, 'CSV de sem resposta: número de linhas');
    });

    await passo('fila de agora: um pedido novo aparece em "esperando agora"', async () => {
      const antes = metricas.calcular(await metricas.coletar(client, cenario.PERIODO), cenario.PERIODO, new Date());
      await client.query("UPDATE conversas SET status = 'aguardando_atendente' WHERE id = $1", [ctx.ids.idConversa.C3]);
      const depois = metricas.calcular(await metricas.coletar(client, cenario.PERIODO), cenario.PERIODO, new Date());
      assert.strictEqual(depois.fila.esperando_agora, antes.fila.esperando_agora + 1, 'esperando_agora deveria subir 1');
      assert.strictEqual(depois.fila.em_atendimento_agora, antes.fila.em_atendimento_agora, 'em atendimento não deveria mudar');
      assert(depois.fila.mais_antiga_s !== null && depois.fila.mais_antiga_s >= 0, 'a espera mais antiga deveria ser um número');
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }

  if (ctx.ids) {
    await verificar('depois do ROLLBACK não sobrou nenhum dado do teste no banco', async () => {
      // o cenário vive entre dez/2098 e fev/2099: nenhum dado real cai nessa janela
      const r = await pool.query("SELECT (SELECT count(*)::int FROM usuarios WHERE nome LIKE '%(verificar-metricas)') AS usuarios, (SELECT count(*)::int FROM mensagens WHERE enviada_em >= '2098-12-01' AND enviada_em < '2099-03-01') AS mensagens");
      assert.strictEqual(r.rows[0].usuarios, 0, `sobraram ${r.rows[0].usuarios} usuário(s) de teste`);
      assert.strictEqual(r.rows[0].mensagens, 0, `sobraram ${r.rows[0].mensagens} mensagem(ns) de teste`);
    });
  }
}

async function main() {
  console.log('Verificando as métricas...\n');
  const estruturaOk = await estrutura();
  if (estruturaOk) {
    await cenarioNumerico();
  } else {
    console.log('\nCenário de números exatos');
    pular('todas as verificações do cenário', 'a estrutura acima está incompleta ou fora do esperado: corrija e rode de novo');
  }

  const total = passaram + falharam;
  console.log(`\nResultado: ${passaram}/${total} verificações passaram` + (puladas ? ` (${puladas} pulada${puladas > 1 ? 's' : ''})` : '') + '.');
  await pool.end();
  process.exit(falharam === 0 && puladas === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(SEM_CONEXAO.includes(err.code)
    ? `Não consegui falar com o banco (${err.code}). O container do Postgres está de pé? Confira com: docker compose ps`
    : `Erro inesperado: ${err.stack || err.message}`);
  try { await pool.end(); } catch (e) { /* já fechado */ }
  process.exit(1);
});
