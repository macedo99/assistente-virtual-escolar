// Avaliação da busca (src/busca.js): leitura do conjunto de perguntas, métricas e a chamada ao Ollama.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const busca = require('../src/busca');

test('lerConjunto: uma linha por pergunta; ignora perguntas vazias e as do modelo entre [colchetes]', () => {
  const lista = busca.lerConjunto({
    casos: [
      { item: 'Calendário escolar', perguntas: ['Quando começam as férias?', '  ', '[escreva uma pergunta]', 'Tem aula no feriado?'] },
      { item: ' Entrega de atestado ', perguntas: ['Onde entrego o atestado?'] },
    ],
  });
  assert.deepStrictEqual(lista, [
    { pergunta: 'Quando começam as férias?', item: 'Calendário escolar' },
    { pergunta: 'Tem aula no feriado?', item: 'Calendário escolar' },
    { pergunta: 'Onde entrego o atestado?', item: 'Entrega de atestado' },
  ]);
});

test('lerConjunto: formato errado dá uma mensagem clara', () => {
  assert.throws(() => busca.lerConjunto('{}'), /lista "casos"/);
  assert.throws(() => busca.lerConjunto({ casos: [{ perguntas: [] }] }), /não tem "item"/);
  assert.throws(() => busca.lerConjunto({ casos: [{ item: 'X' }] }), /lista "perguntas"/);
});

test('posicaoDoEsperado compara títulos sem diferenciar maiúsculas e espaços', () => {
  const resultado = [{ titulo: 'Notas e boletim' }, { titulo: 'Calendário  Escolar' }];
  assert.strictEqual(busca.posicaoDoEsperado('calendário escolar', resultado), 2);
  assert.strictEqual(busca.posicaoDoEsperado('Senha do portal', resultado), null);
});

test('resumir: acerto@1, @3, @5 e MRR', () => {
  const r = busca.resumir([1, 2, 4, null]);
  assert.strictEqual(r.perguntas, 4);
  assert.deepStrictEqual(r.acerto, { 1: 0.25, 3: 0.5, 5: 0.75 });
  assert.strictEqual(r.mrr, (1 + 0.5 + 0.25 + 0) / 4);
  assert.deepStrictEqual(busca.resumir([]), { perguntas: 0, acerto: { 1: null, 3: null, 5: null }, mrr: null });
});

test('gerarEmbedding chama /api/embed do Ollama com o modelo configurado e devolve o vetor', async (t) => {
  let recebido = null;
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      recebido = { caminho: req.url, corpo: JSON.parse(corpo) };
      if (recebido.corpo.model === 'nao-existe') { res.writeHead(404); return res.end('model not found'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => servidor.close());
  const antes = { url: process.env.OLLAMA_URL, modelo: process.env.EMBEDDING_MODEL };
  t.after(() => { process.env.OLLAMA_URL = antes.url || ''; process.env.EMBEDDING_MODEL = antes.modelo || ''; });

  process.env.OLLAMA_URL = `http://127.0.0.1:${servidor.address().port}/`;
  process.env.EMBEDDING_MODEL = 'bge-m3';
  assert.deepStrictEqual(await busca.gerarEmbedding('Quando começam as férias?'), [0.1, 0.2, 0.3]);
  assert.deepStrictEqual(recebido, { caminho: '/api/embed', corpo: { model: 'bge-m3', input: 'Quando começam as férias?' } });

  process.env.EMBEDDING_MODEL = 'nao-existe';
  await assert.rejects(busca.gerarEmbedding('x'), /status 404.*"nao-existe" está instalado/s);

  process.env.OLLAMA_URL = 'http://127.0.0.1:9';
  await assert.rejects(busca.gerarEmbedding('x'), /Não consegui falar com o Ollama/);
});
