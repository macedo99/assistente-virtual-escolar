// Confere se o banco está pronto para o Passo 8b e se as regras da base de conhecimento funcionam de ponta
// a ponta — incluindo os comandos SQL que você cola nos nós do n8n (arquivos da pasta sql-n8n/).
//
// NÃO deixa nenhum dado para trás: tudo o que o teste cria (um item de mentirinha e os trechos dele) roda
// dentro de uma transação que é DESFEITA (ROLLBACK) no final, mesmo se alguma verificação falhar.
// Efeito colateral inofensivo: os contadores de id (BIGSERIAL) avançam alguns números.
//
// Este script não precisa do n8n: ele confere o lado do banco e do dashboard. Quem confere o n8n de verdade
// (o webhook, o Ollama, os embeddings) é o verificar-n8n.js.
//
//   docker compose exec dashboard node scripts/verificar-base.js
//
// Sai com código 0 se tudo passou e 1 se alguma verificação falhou.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const pool = require('../src/db');
const base = require('../src/base');

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

const ctx = { dimensao: null };

async function estrutura() {
  console.log('Estrutura do banco');
  const colunasDe = async (tabela) => (await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [tabela],
  )).rows.map((r) => r.column_name);
  let tudoOk = true;

  tudoOk = (await verificar('tabela itens_base_conhecimento existe, com as colunas esperadas', async () => {
    const colunas = await colunasDe('itens_base_conhecimento');
    const faltam = ['id', 'titulo', 'conteudo', 'status_indexacao', 'criado_em', 'atualizado_em'].filter((c) => !colunas.includes(c));
    assert(colunas.length > 0, 'tabela não encontrada (o schema.sql do Passo 2 foi aplicado neste banco?)');
    assert(faltam.length === 0, `faltam as colunas: ${faltam.join(', ')}`);
  })) && tudoOk;

  tudoOk = (await verificar('tabela trechos_embeddings existe, com as colunas esperadas', async () => {
    const colunas = await colunasDe('trechos_embeddings');
    const faltam = ['id', 'item_id', 'conteudo_trecho', 'embedding', 'criado_em'].filter((c) => !colunas.includes(c));
    assert(colunas.length > 0, 'tabela não encontrada');
    assert(faltam.length === 0, `faltam as colunas: ${faltam.join(', ')}`);
  })) && tudoOk;

  tudoOk = (await verificar('a coluna embedding é VECTOR(1024), a dimensão do bge-m3', async () => {
    const r = await pool.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS tipo
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'trechos_embeddings'
          AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
          AND a.attname = 'embedding' AND NOT a.attisdropped`,
    );
    const tipo = r.rows[0] && r.rows[0].tipo;
    const dimensao = tipo && /^vector\((\d+)\)$/.exec(tipo);
    assert(dimensao, `tipo da coluna não reconhecido: ${tipo}`);
    ctx.dimensao = Number(dimensao[1]);
    assert(ctx.dimensao === 1024, `a coluna é ${tipo}, mas o bge-m3 gera 1024 dimensões. Rode o ALTER do Passo 5: ALTER TABLE trechos_embeddings ALTER COLUMN embedding TYPE VECTOR(1024);`);
  })) && tudoOk;

  return tudoOk;
}

async function validacao() {
  console.log('\nValidação do formulário (sem banco)');
  await verificar('título e conteúdo vazios são recusados; espaços e quebras de linha são normalizados', async () => {
    const vazio = base.validarItem({ titulo: '   ', conteudo: '\r\n  ' });
    assert(!vazio.ok && vazio.erros.titulo && vazio.erros.conteudo, 'deveria recusar título e conteúdo vazios');
    const bom = base.validarItem({ titulo: '  Prazo   das   notas ', conteudo: 'linha 1\r\nlinha 2\r\n' });
    assert(bom.ok, 'deveria aceitar um item normal');
    assert.strictEqual(bom.valores.titulo, 'Prazo das notas');
    assert.strictEqual(bom.valores.conteudo, 'linha 1\nlinha 2');
    const naoTexto = base.validarItem({ titulo: ['a'], conteudo: { b: 1 } });
    assert(!naoTexto.ok, 'valores que não são texto (ex.: titulo[]=a) deveriam ser recusados');
  });

  await verificar('os limites de tamanho valem (título 200, conteúdo 50 000)', async () => {
    assert(!base.validarItem({ titulo: 'x'.repeat(base.TITULO_MAXIMO + 1), conteudo: 'ok' }).ok, 'título grande demais foi aceito');
    assert(base.validarItem({ titulo: 'x'.repeat(base.TITULO_MAXIMO), conteudo: 'ok' }).ok, 'título no limite deveria ser aceito');
    assert(!base.validarItem({ titulo: 'ok', conteudo: 'x'.repeat(base.CONTEUDO_MAXIMO + 1) }).ok, 'conteúdo grande demais foi aceito');
    assert(base.validarItem({ titulo: 'ok', conteudo: 'x'.repeat(base.CONTEUDO_MAXIMO) }).ok, 'conteúdo no limite deveria ser aceito');
  });
}

async function comportamento() {
  console.log('\nRegras da base e comandos do n8n (numa transação que é desfeita no final)');

  const sufixo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const titulo = `[verificar-base] item de teste ${sufixo}`;
  const conteudoInicial = 'Texto de teste do Passo 8b.\nSegunda linha do texto.';
  // O n8n manda o embedding como texto: "[0.12,0.34,...]". Aqui vai [1,0,0,...]: um vetor que não é todo zero
  // (o pgvector não indexa vetores nulos com distância de cosseno, caso um índice seja criado no futuro).
  const vetor = JSON.stringify([1, ...new Array(ctx.dimensao - 1).fill(0)]);
  const client = await pool.connect();
  const c = {}; // guarda o id do item entre as verificações
  let seguir = true;
  const passo = async (nome, funcao) => {
    if (!seguir) return pular(nome, 'depende de uma verificação anterior que falhou');
    seguir = await verificar(nome, funcao);
  };
  const contarTrechos = async () => (await client.query('SELECT count(*)::int AS n FROM trechos_embeddings WHERE item_id = $1', [c.id])).rows[0].n;
  const statusAtual = async () => (await client.query('SELECT status_indexacao AS s FROM itens_base_conhecimento WHERE id = $1', [c.id])).rows[0].s;
  const salvarTrecho = (texto) => client.query(lerSql('reindexar_salvar_trecho.sql'), [c.id, texto, vetor]);

  try {
    await client.query('BEGIN');

    await passo('cria um item: nasce "pendente", sem trechos, e aparece na lista', async () => {
      const v = base.validarItem({ titulo, conteudo: conteudoInicial });
      assert(v.ok, 'a validação recusou o item de teste');
      c.id = await base.criar(client, v.valores);
      const item = await base.obter(client, c.id);
      assert.strictEqual(item.status, 'pendente');
      assert.strictEqual(item.n_trechos, 0);
      assert.strictEqual(item.travado, false, 'um item recém-criado não pode estar "travado"');
      const naLista = (await base.listar(client)).find((i) => String(i.id) === String(c.id));
      assert(naLista, 'o item não apareceu na lista');
      const tela = base.apresentar(naLista);
      assert.strictEqual(tela.visual, 'indexando');
      assert.strictEqual(tela.pode_reindexar, false, 'enquanto indexa, Reindexar deve ficar desligado');
    });

    await passo('n8n "Preparar item": devolve o texto, marca "pendente" e apaga os trechos antigos', async () => {
      await salvarTrecho('trecho antigo 1');
      await salvarTrecho('trecho antigo 2');
      await client.query("UPDATE itens_base_conhecimento SET status_indexacao = 'indexado' WHERE id = $1", [c.id]);
      assert.strictEqual(await contarTrechos(), 2, 'não consegui preparar o cenário (2 trechos antigos)');

      const r = await client.query(lerSql('reindexar_preparar.sql'), [c.id]);
      assert.strictEqual(r.rows.length, 1, `deveria devolver 1 linha, devolveu ${r.rows.length}`);
      assert.strictEqual(String(r.rows[0].item_id), String(c.id), 'item_id devolvido está errado');
      assert.strictEqual(r.rows[0].conteudo, conteudoInicial, 'o conteúdo devolvido está diferente do gravado');
      assert.strictEqual(await statusAtual(), 'pendente', 'o item deveria voltar para "pendente"');
      assert.strictEqual(await contarTrechos(), 0, 'os trechos antigos deveriam ter sido apagados');
    });

    await passo('n8n "Preparar item": item que não existe não devolve nada (o workflow termina ali)', async () => {
      const r = await client.query(lerSql('reindexar_preparar.sql'), ['999999999999999']);
      assert.strictEqual(r.rows.length, 0, 'não deveria devolver linha para um item inexistente');
    });

    await passo('n8n "Salvar trecho": grava os trechos (com embedding) do item', async () => {
      for (const texto of ['trecho 1', 'trecho 2', 'trecho 3']) await salvarTrecho(texto);
      assert.strictEqual(await contarTrechos(), 3);
    });

    await passo('n8n "Marcar como indexado": só marca quando a quantidade de trechos bate', async () => {
      const errado = await client.query(lerSql('reindexar_marcar_indexado.sql'), [c.id, 5]);
      assert.strictEqual(errado.rowCount, 0, 'com a contagem errada (5 em vez de 3) NÃO deveria marcar como indexado');
      assert.strictEqual(await statusAtual(), 'pendente');
      const certo = await client.query(lerSql('reindexar_marcar_indexado.sql'), [c.id, 3]);
      assert.strictEqual(certo.rowCount, 1, 'com a contagem certa deveria marcar como indexado');
      assert.strictEqual(await statusAtual(), 'indexado');
    });

    await passo('n8n "Marcar como erro": o item passa a "erro" e fica fora da busca do bot', async () => {
      await client.query(lerSql('reindexar_marcar_erro.sql'), [c.id]);
      assert.strictEqual(await statusAtual(), 'erro');
      const visivelParaOBot = (await client.query("SELECT count(*)::int AS n FROM itens_base_conhecimento WHERE id = $1 AND status_indexacao = 'indexado'", [c.id])).rows[0].n;
      assert.strictEqual(visivelParaOBot, 0, 'a busca do bot só lê itens "indexado"');
      const tela = base.apresentar(await base.obter(client, c.id));
      assert.strictEqual(tela.visual, 'erro');
      assert.strictEqual(tela.pode_reindexar, true, 'um item com erro precisa poder ser reindexado');
    });

    await passo('dashboard: mudar só o título não reindexa e mantém o status', async () => {
      await client.query("UPDATE itens_base_conhecimento SET status_indexacao = 'indexado' WHERE id = $1", [c.id]);
      const r = await base.atualizar(client, c.id, { titulo: `${titulo} (renomeado)`, conteudo: conteudoInicial });
      assert(r.ok && r.reindexar === false, 'só o título mudou: não deveria pedir reindexação');
      assert.strictEqual(await statusAtual(), 'indexado');
      assert.strictEqual((await base.obter(client, c.id)).titulo, `${titulo} (renomeado)`);
    });

    await passo('dashboard: o mesmo texto com quebras de linha do navegador (CRLF) não conta como mudança', async () => {
      const r = await base.atualizar(client, c.id, { titulo: `${titulo} (renomeado)`, conteudo: base.normalizarTexto(conteudoInicial.replace(/\n/g, '\r\n')) });
      assert(r.ok && r.reindexar === false, 'CRLF x LF não pode disparar uma reindexação');
    });

    await passo('dashboard: mudar o conteúdo volta para "pendente" e some da busca do bot', async () => {
      const r = await base.atualizar(client, c.id, { titulo, conteudo: 'Conteúdo novo, bem diferente.' });
      assert(r.ok && r.reindexar === true, 'o conteúdo mudou: deveria pedir reindexação');
      assert.strictEqual(await statusAtual(), 'pendente');
    });

    await passo('dashboard: com a indexação em andamento, mudar o conteúdo ou reindexar é recusado (409)', async () => {
      const antes = (await base.obter(client, c.id)).conteudo;
      const edicao = await base.atualizar(client, c.id, { titulo, conteudo: 'Outra mudança, feita cedo demais.' });
      assert(!edicao.ok && edicao.http === 409, 'a segunda mudança de conteúdo deveria ser recusada com 409');
      assert.strictEqual((await base.obter(client, c.id)).conteudo, antes, 'o conteúdo não pode ter mudado');
      const reindex = await base.marcarParaReindexar(client, c.id);
      assert(!reindex.ok && reindex.http === 409, 'Reindexar durante a indexação deveria ser recusado com 409');
    });

    await passo('dashboard: mudar só o título continua permitido durante a indexação', async () => {
      const r = await base.atualizar(client, c.id, { titulo: `${titulo} (de novo)`, conteudo: 'Conteúdo novo, bem diferente.' });
      assert(r.ok && r.reindexar === false);
    });

    await passo('dashboard: "pendente" há mais de 5 minutos vira "travado" e libera a reindexação', async () => {
      await client.query("UPDATE itens_base_conhecimento SET atualizado_em = now() - interval '10 minutes' WHERE id = $1", [c.id]);
      const item = await base.obter(client, c.id);
      assert.strictEqual(item.travado, true, 'deveria estar travado');
      const tela = base.apresentar(item);
      assert.strictEqual(tela.visual, 'travado');
      assert.strictEqual(tela.pode_reindexar, true);
      const r = await base.marcarParaReindexar(client, c.id);
      assert(r.ok, 'um item travado deveria poder ser reindexado');
    });

    await passo('dashboard: se o n8n não pôde ser avisado, o item vai para "erro" (só se estava "pendente")', async () => {
      assert.strictEqual(await base.marcarErro(client, c.id), true);
      assert.strictEqual(await statusAtual(), 'erro');
      assert.strictEqual(await base.marcarErro(client, c.id), false, 'um item que já não está pendente não deve ser marcado de novo');
    });

    await passo('dashboard: um item em "erro" pode ser reindexado (volta para "pendente")', async () => {
      const r = await base.marcarParaReindexar(client, c.id);
      assert(r.ok, 'Reindexar deveria funcionar a partir de "erro"');
      assert.strictEqual(await statusAtual(), 'pendente');
    });

    await passo('dashboard: excluir apaga o item e os trechos dele (cascata)', async () => {
      await salvarTrecho('trecho que deve sumir junto');
      assert(await contarTrechos() >= 1, 'não consegui preparar o cenário');
      const apagado = await base.excluir(client, c.id);
      assert.strictEqual(apagado, `${titulo} (de novo)`, 'deveria devolver o título do item excluído');
      assert.strictEqual(await contarTrechos(), 0, 'os trechos deveriam ter sido apagados junto');
      assert.strictEqual(await base.obter(client, c.id), null, 'o item ainda existe');
      assert.strictEqual(await base.excluir(client, c.id), null, 'excluir de novo deveria devolver null');
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }

  // Prova de que nada ficou: consulta FORA da transação.
  if (c.id) {
    await verificar('depois do ROLLBACK não sobrou nenhum dado do teste no banco', async () => {
      const n = (await pool.query("SELECT count(*)::int AS n FROM itens_base_conhecimento WHERE titulo LIKE '[verificar-base]%'")).rows[0].n;
      assert.strictEqual(n, 0, `sobraram ${n} item(ns) de teste`);
    });
  }
}

async function main() {
  console.log('Verificando o banco e as regras da base de conhecimento...\n');
  const estruturaOk = await estrutura();
  await validacao();

  if (estruturaOk) {
    await comportamento();
  } else {
    console.log('\nRegras da base e comandos do n8n');
    pular('todas as verificações de comportamento', 'a estrutura acima está incompleta ou fora do esperado: corrija e rode de novo');
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
