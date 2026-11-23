// Confere, de ponta a ponta, se o workflow "RAG - Reindexar item" do n8n está funcionando: cria um item de
// teste no banco, avisa o n8n pelo webhook (o mesmo caminho do botão do dashboard), espera a indexação
// terminar e confere os trechos gravados. Depois APAGA o item de teste.
//
// Diferente do verificar-base.js, aqui os dados são gravados de verdade (o n8n precisa enxergá-los), por
// alguns segundos. O item de teste tem um texto sem sentido, que nenhuma pergunta de usuário vai encontrar.
//
//   docker compose exec dashboard node scripts/verificar-n8n.js
//
// Passa por: INGESTAO_TOKEN/INGESTAO_URL, o webhook, o token (Header Auth), o Ollama (embeddings), o banco e
// a regra do "só marca como indexado se todos os trechos foram gravados".
//
// Sai com código 0 se tudo passou e 1 se alguma verificação falhou.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const pool = require('../src/db');
const base = require('../src/base');
const ingestao = require('../src/ingestao');

const LIMITE_ESPERA_S = 90;
const SEM_CONEXAO = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'];
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const detalhe = await funcao();
    passaram += 1;
    mostrar('ok', nome, typeof detalhe === 'string' ? detalhe : '');
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

// Quantos trechos o nó "Divide em trechos" do n8n deve produzir para este texto? Roda o MESMO código do arquivo
// sql-n8n/reindexar_divide_em_trechos.js (o que você colou no n8n), com um "$input" de mentira.
function trechosEsperados(conteudo) {
  const arquivo = fs.readFileSync(path.join(__dirname, '..', 'sql-n8n', 'reindexar_divide_em_trechos.js'), 'utf8');
  const codigo = arquivo.split(/^\/\/ -----\r?\n/m)[1];
  assert(codigo, 'não achei a linha "// -----" no arquivo reindexar_divide_em_trechos.js');
  const entrada = { first: () => ({ json: { item_id: '0', conteudo } }) };
  return new Function('$input', codigo)(entrada).length;
}

// Espera o item sair de "pendente". Devolve { status, segundos }.
async function esperarIndexacao(id) {
  const inicio = Date.now();
  while ((Date.now() - inicio) / 1000 < LIMITE_ESPERA_S) {
    const item = await base.obter(pool, id);
    if (!item) throw new Error('o item de teste sumiu do banco durante a espera');
    if (item.status !== 'pendente') return { status: item.status, segundos: Math.round((Date.now() - inicio) / 100) / 10 };
    await dormir(1000);
  }
  return { status: 'pendente', segundos: LIMITE_ESPERA_S };
}

const contarTrechos = async (id) => (await pool.query('SELECT count(*)::int AS n FROM trechos_embeddings WHERE item_id = $1', [id])).rows[0].n;

async function main() {
  console.log('Verificando a indexação pelo n8n...\n');

  const { url, token } = { url: (process.env.INGESTAO_URL || ingestao.URL_PADRAO).trim(), token: (process.env.INGESTAO_TOKEN || '').trim() };
  let seguir = true;
  const passo = async (nome, funcao) => {
    if (!seguir) return pular(nome, 'depende de uma verificação anterior que falhou');
    seguir = await verificar(nome, funcao);
  };

  await passo('INGESTAO_TOKEN e INGESTAO_URL estão configurados no container do dashboard', async () => {
    assert(token, 'INGESTAO_TOKEN está vazio. Confira o .env e a linha INGESTAO_TOKEN no docker-compose.yml; depois: docker compose up -d dashboard');
    new URL(url);
    return `endereço: ${url}`;
  });

  await passo('o n8n recusa um token errado (o webhook está protegido)', async () => {
    let resposta;
    try {
      resposta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [ingestao.CABECALHO_TOKEN]: `errado-${Date.now()}` },
        body: JSON.stringify({ item_id: '0' }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new Error(`não consegui falar com o n8n em ${url}. Ele está de pé? Confira com: docker compose ps`);
    }
    if (resposta.status === 404) {
      throw new Error('o n8n respondeu 404 (webhook não registrado). O workflow "RAG - Reindexar item" está publicado/ativo? O caminho do nó Webhook é reindexar-item?');
    }
    if (resposta.status === 200) {
      throw new Error('o n8n ACEITOU um token errado. No nó Webhook, configure Authentication = Header Auth com a credencial do token.');
    }
    assert([401, 403].includes(resposta.status), `esperava 401 ou 403, veio ${resposta.status}`);
  });

  const sufixo = `${Date.now()}`;
  const titulo = `[verificar-n8n] item de teste ${sufixo}`;
  // ~3 800 caracteres de texto sem sentido, para o item virar vários trechos
  const conteudo = Array.from({ length: 40 }, (_, i) => `Linha ${i + 1} do item de teste automatico ${sufixo}, sem relacao com nenhum assunto da escola.`).join('\n');
  const esperado = trechosEsperados(conteudo);
  let id = null;

  try {
    await passo(`cria o item de teste (${conteudo.length} caracteres: o n8n deve gerar ${esperado} trechos)`, async () => {
      id = await base.criar(pool, { titulo, conteudo });
    });

    await passo('avisa o n8n pelo webhook (o mesmo aviso do botão do dashboard)', async () => {
      await ingestao.acionar(id);
    });

    await passo(`o n8n termina a indexação sozinho (espera até ${LIMITE_ESPERA_S} s)`, async () => {
      const r = await esperarIndexacao(id);
      if (r.status === 'erro') {
        throw new Error('o n8n marcou o item como "erro". Abra a execução em Executions no n8n: o nó que falhou aparece em vermelho (o mais provável é o "Gera embedding": o Ollama está de pé e com o modelo bge-m3?).');
      }
      if (r.status === 'pendente') {
        throw new Error(`o item continua "pendente" depois de ${LIMITE_ESPERA_S} s. Veja em Executions se a execução começou. Se não há execução nenhuma, o workflow não está publicado.`);
      }
      return `indexado em ${r.segundos} s`;
    });

    await passo(`foram gravados ${esperado} trechos, como o código do nó "Divide em trechos" prevê`, async () => {
      const n = await contarTrechos(id);
      assert(n === esperado, `gravou ${n} trecho(s), esperado ${esperado}. O código colado no nó "Divide em trechos" é igual ao arquivo sql-n8n/reindexar_divide_em_trechos.js?`);
    });

    await passo('reindexar de novo não duplica os trechos', async () => {
      const marcado = await base.marcarParaReindexar(pool, id);
      assert(marcado.ok, `não consegui marcar para reindexar: ${marcado.mensagem}`);
      await ingestao.acionar(id);
      const r = await esperarIndexacao(id);
      assert(r.status === 'indexado', `depois de reindexar o status ficou "${r.status}"`);
      const n = await contarTrechos(id);
      assert(n === esperado, `depois de reindexar há ${n} trecho(s), esperado ${esperado}: o nó "Preparar item" não apagou os trechos antigos?`);
      return `reindexado em ${r.segundos} s`;
    });
  } finally {
    if (id !== null) {
      await verificar('apaga o item de teste (e os trechos dele)', async () => {
        await base.excluir(pool, id);
        assert((await contarTrechos(id)) === 0, 'sobraram trechos do item de teste');
        assert((await base.obter(pool, id)) === null, 'o item de teste ainda existe');
      });
    }
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
