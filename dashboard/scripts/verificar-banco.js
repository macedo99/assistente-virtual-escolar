// Confere se o banco está pronto para o Passo 8a e se as regras do atendimento humano funcionam de
// ponta a ponta — incluindo as queries que você colou no n8n (arquivos da pasta sql-n8n/).
//
// NÃO deixa nenhum dado para trás: tudo o que o teste cria (atendentes, usuário e conversa de mentirinha)
// roda dentro de uma transação que é DESFEITA (ROLLBACK) no final, mesmo se alguma verificação falhar.
// Efeito colateral inofensivo: os contadores de id (BIGSERIAL) avançam alguns números.
//
//   docker compose exec dashboard node scripts/verificar-banco.js
//
// Sai com código 0 se tudo passou e 1 se alguma verificação falhou.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const pool = require('../src/db');
const atendimento = require('../src/atendimento');

const lerSql = (arquivo) => fs.readFileSync(path.join(__dirname, '..', 'sql-n8n', arquivo), 'utf8');

// Códigos de "não consegui nem conectar": isso não é uma verificação reprovada, é um problema anterior.
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
    if (SEM_CONEXAO.includes(err.code)) throw err; // quem trata é o main(), com uma mensagem clara
    falharam += 1;
    mostrar('falha', nome, err.message);
    return false;
  }
}

function pular(nome, motivo) {
  puladas += 1;
  mostrar('pulada', nome, `(${motivo})`);
}

// "status_anterior>status_novo@quem" — formato compacto pra comparar a trilha de eventos
const resumoEventos = (linhas, nomes) =>
  linhas.map((e) => `${e.status_anterior || '-'}>${e.status_novo}@${e.atendente_id === null ? '-' : nomes[e.atendente_id] || e.atendente_id}`);

async function estrutura() {
  console.log('Estrutura do banco');
  const existe = async (sql, params) => (await pool.query(sql, params)).rows.length > 0;
  let tudoOk = true;

  tudoOk = (await verificar('coluna mensagens.atendente_id existe', async () => {
    assert(await existe("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'mensagens' AND column_name = 'atendente_id'"),
      'coluna não encontrada');
  })) && tudoOk;

  tudoOk = (await verificar('tabela conversa_eventos existe, com as colunas esperadas', async () => {
    const colunas = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'conversa_eventos'")).rows.map((r) => r.column_name);
    const faltam = ['id', 'conversa_id', 'status_anterior', 'status_novo', 'atendente_id', 'criado_em'].filter((c) => !colunas.includes(c));
    assert(colunas.length > 0, 'tabela não encontrada');
    assert(faltam.length === 0, `faltam as colunas: ${faltam.join(', ')}`);
  })) && tudoOk;

  tudoOk = (await verificar('gatilho (trigger) trg_conversa_eventos existe em conversas', async () => {
    assert(await existe("SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'conversas' AND t.tgname = 'trg_conversa_eventos' AND NOT t.tgisinternal"),
      'gatilho não encontrado');
  })) && tudoOk;

  tudoOk = (await verificar('índice único uq_conversa_ativa_por_usuario existe', async () => {
    assert(await existe("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_conversa_ativa_por_usuario'"),
      'índice não encontrado');
  })) && tudoOk;

  return tudoOk;
}

async function comportamento() {
  console.log('\nRegras do atendimento (numa transação que é desfeita no final)');

  const sufixo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const chatId = String(-(9000000000000 + Math.floor(Math.random() * 1000000000))); // negativo: não colide com chat de pessoa de verdade
  const emails = ['admin', 'b', 'c'].map((q) => `verificar-${q}-${sufixo}@exemplo.invalid`);
  const client = await pool.connect();
  const ctx = {};
  let seguir = true;
  const passo = async (nome, funcao) => {
    if (!seguir) return pular(nome, 'depende de uma verificação anterior que falhou');
    seguir = await verificar(nome, funcao);
  };

  try {
    await client.query('BEGIN');

    await passo('cria atendentes e um usuário de mentirinha com uma conversa (status "bot")', async () => {
      const a = await client.query(
        `INSERT INTO atendentes (nome, email, senha_hash, papel) VALUES
           ('Teste Admin', $1, 'x', 'admin'), ('Teste B', $2, 'x', 'atendente'), ('Teste C', $3, 'x', 'atendente')
         RETURNING id, nome, papel`, emails);
      const por = (nome) => a.rows.find((r) => r.nome === nome);
      ctx.admin = { id: por('Teste Admin').id, nome: 'Teste Admin', papel: 'admin' };
      ctx.b = { id: por('Teste B').id, nome: 'Teste B', papel: 'atendente' };
      ctx.c = { id: por('Teste C').id, nome: 'Teste C', papel: 'atendente' };
      ctx.nomes = { [ctx.admin.id]: 'admin', [ctx.b.id]: 'B', [ctx.c.id]: 'C' };

      const u = await client.query("INSERT INTO usuarios (telegram_chat_id, nome, papel) VALUES ($1, 'Usuário de teste', 'professor') RETURNING id", [chatId]);
      ctx.usuarioId = u.rows[0].id;
      const c = await client.query("INSERT INTO conversas (usuario_id) VALUES ($1) RETURNING id, status", [ctx.usuarioId]);
      ctx.conversaId = c.rows[0].id;
      assert.strictEqual(c.rows[0].status, 'bot');
    });

    await passo('o gatilho registrou a criação da conversa na trilha de eventos', async () => {
      const ev = (await client.query('SELECT status_anterior, status_novo, atendente_id FROM conversa_eventos WHERE conversa_id = $1 ORDER BY id', [ctx.conversaId])).rows;
      assert.deepStrictEqual(resumoEventos(ev, ctx.nomes), ['->bot@-'], 'esperava exatamente 1 evento: "criada em bot"');
    });

    await passo('o banco recusa uma SEGUNDA conversa ativa para o mesmo usuário', async () => {
      await client.query('SAVEPOINT duplicada');
      try {
        await client.query("INSERT INTO conversas (usuario_id, status) VALUES ($1, 'bot')", [ctx.usuarioId]);
        assert.fail('o banco aceitou duas conversas ativas do mesmo usuário');
      } catch (err) {
        assert.strictEqual(err.code, '23505', `esperava erro 23505 (violação de unicidade), veio: ${err.message}`);
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT duplicada');
      }
    });

    await passo('n8n · "Buscar usuário": acha o usuário e a conversa ativa, sem criar outra', async () => {
      const r = await client.query(lerSql('buscar_usuario.sql'), [chatId]);
      assert.strictEqual(r.rows.length, 1, `esperava 1 linha, vieram ${r.rows.length}`);
      assert.strictEqual(String(r.rows[0].conversa_id), String(ctx.conversaId));
      assert.strictEqual(r.rows[0].conversa_status, 'bot');
      const n = (await client.query('SELECT count(*)::int AS n FROM conversas WHERE usuario_id = $1', [ctx.usuarioId])).rows[0].n;
      assert.strictEqual(n, 1, `existem ${n} conversas do usuário (esperava 1)`);
    });

    await passo('n8n · "Atualizar status": o usuário pede atendente e a conversa vai para a fila', async () => {
      await client.query(lerSql('chamar_atendente.sql'), [ctx.usuarioId]);
      const c = await atendimento.buscarConversa(client, ctx.conversaId);
      assert.strictEqual(c.status, 'aguardando_atendente');
    });

    await passo('atendente B assume a conversa (status "atendimento_humano", responsável B)', async () => {
      const r = await atendimento.assumir(client, ctx.conversaId, ctx.b);
      assert(r.ok, `recusado: ${r.mensagem}`);
      assert.strictEqual(r.conversa.status, 'atendimento_humano');
      assert.strictEqual(String(r.conversa.atendente_id), String(ctx.b.id));
    });

    await passo('atendente C NÃO consegue assumir a mesma conversa (e a mensagem cita o B)', async () => {
      const r = await atendimento.assumir(client, ctx.conversaId, ctx.c);
      assert.strictEqual(r.ok, false, 'C conseguiu assumir uma conversa que já é do B');
      assert.strictEqual(r.http, 409);
      assert(r.mensagem.includes('Teste B'), `a mensagem deveria citar o B: "${r.mensagem}"`);
    });

    await passo('a mensagem do atendente é gravada com o nome dele', async () => {
      await atendimento.registrarMensagemDoAtendente(client, ctx.conversaId, ctx.b.id, 'Olá! Sou o B.');
      const m = await atendimento.listarMensagens(client, ctx.conversaId);
      assert.strictEqual(m.length, 1);
      assert.deepStrictEqual([m[0].remetente, m[0].conteudo, m[0].atendente_nome], ['atendente', 'Olá! Sou o B.', 'Teste B']);
    });

    await passo('C não consegue devolver nem encerrar a conversa do B (permissão negada)', async () => {
      const d = await atendimento.devolverAoBot(client, ctx.conversaId, ctx.c);
      const e = await atendimento.encerrar(client, ctx.conversaId, ctx.c);
      assert.deepStrictEqual([d.ok, d.http, e.ok, e.http], [false, 403, false, 403]);
      const c = await atendimento.buscarConversa(client, ctx.conversaId);
      assert.strictEqual(c.status, 'atendimento_humano');
    });

    await passo('o administrador consegue devolver a conversa do B ao bot (responsável fica vazio)', async () => {
      const r = await atendimento.devolverAoBot(client, ctx.conversaId, ctx.admin);
      assert(r.ok, `recusado: ${r.mensagem}`);
      assert.strictEqual(r.conversa.status, 'bot');
      assert.strictEqual(r.conversa.atendente_id, null);
    });

    await passo('nova rodada: usuário pede atendente, o administrador assume e encerra', async () => {
      await client.query(lerSql('chamar_atendente.sql'), [ctx.usuarioId]);
      const a = await atendimento.assumir(client, ctx.conversaId, ctx.admin);
      assert(a.ok, `assumir recusado: ${a.mensagem}`);
      const e = await atendimento.encerrar(client, ctx.conversaId, ctx.admin);
      assert(e.ok, `encerrar recusado: ${e.mensagem}`);
      assert.strictEqual(e.conversa.status, 'encerrada');
      const c = (await client.query('SELECT encerrada_em, atendente_id FROM conversas WHERE id = $1', [ctx.conversaId])).rows[0];
      assert(c.encerrada_em instanceof Date, 'encerrada_em não foi preenchida');
      assert.strictEqual(String(c.atendente_id), String(ctx.admin.id), 'a conversa encerrada deveria guardar quem atendeu');
    });

    await passo('a trilha de eventos tem todas as mudanças, na ordem, com o responsável de cada momento', async () => {
      const ev = (await client.query('SELECT status_anterior, status_novo, atendente_id FROM conversa_eventos WHERE conversa_id = $1 ORDER BY id', [ctx.conversaId])).rows;
      // formato: status_anterior>status_novo@responsável   ("-" = nenhum)
      assert.deepStrictEqual(resumoEventos(ev, ctx.nomes), [
        '->bot@-',                                   // conversa criada
        'bot>aguardando_atendente@-',                // o usuário pediu atendente (n8n)
        'aguardando_atendente>atendimento_humano@B', // B assumiu
        'atendimento_humano>bot@B',                  // o admin devolveu ao bot (o evento guarda que era do B)
        'bot>aguardando_atendente@-',                // o usuário pediu de novo
        'aguardando_atendente>atendimento_humano@admin',
        'atendimento_humano>encerrada@admin',
      ]);
    });

    await passo('n8n · "Buscar usuário" depois do encerramento abre uma conversa NOVA em "bot"', async () => {
      const r = await client.query(lerSql('buscar_usuario.sql'), [chatId]);
      assert.strictEqual(r.rows.length, 1);
      assert.notStrictEqual(String(r.rows[0].conversa_id), String(ctx.conversaId), 'reaproveitou a conversa encerrada');
      assert.strictEqual(r.rows[0].conversa_status, 'bot');
      const n = (await client.query('SELECT count(*)::int AS n FROM conversas WHERE usuario_id = $1', [ctx.usuarioId])).rows[0].n;
      assert.strictEqual(n, 2, `esperava 2 conversas (a encerrada e a nova), existem ${n}`);
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }

  // Prova de que nada ficou: consulta FORA da transação.
  if (ctx.usuarioId) {
    await verificar('depois do ROLLBACK não sobrou nenhum dado do teste no banco', async () => {
      const u = (await pool.query('SELECT count(*)::int AS n FROM usuarios WHERE telegram_chat_id = $1', [chatId])).rows[0].n;
      const a = (await pool.query('SELECT count(*)::int AS n FROM atendentes WHERE email = ANY($1::text[])', [emails])).rows[0].n;
      assert.strictEqual(u + a, 0, `sobraram ${u} usuário(s) e ${a} atendente(s) de teste`);
    });
  }
}

async function main() {
  console.log('Verificando o banco de dados...\n');
  const estruturaOk = await estrutura();

  if (estruturaOk) {
    await comportamento();
  } else {
    console.log('\nRegras do atendimento');
    pular('todas as verificações de comportamento', 'a estrutura acima está incompleta: rode antes  docker compose exec dashboard node scripts/aplicar-migracao.js');
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
