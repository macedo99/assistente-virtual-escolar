// Regras da base de conhecimento (src/base.js) que não dependem do banco.
const { test } = require('node:test');
const assert = require('node:assert');
const base = require('../src/base');

test('idValido aceita só ids numéricos de bigint', () => {
  for (const ok of ['1', '42', '123456789012345678', 7]) assert.ok(base.idValido(ok), `deveria aceitar ${ok}`);
  for (const ruim of ['', 'abc', '1.5', '-1', '1 OR 1=1', '1234567890123456789', ' 1', null, undefined]) {
    assert.ok(!base.idValido(ruim), `deveria recusar ${JSON.stringify(ruim)}`);
  }
});

test('normalizarTexto troca CRLF por LF, tira o caractere nulo e apara as pontas', () => {
  assert.strictEqual(base.normalizarTexto('  a\r\nb\rc\u0000d  '), 'a\nb\ncd');
});

test('validarItem: título e conteúdo obrigatórios', () => {
  const v = base.validarItem({ titulo: '   ', conteudo: '' });
  assert.strictEqual(v.ok, false);
  assert.ok(v.erros.titulo && v.erros.conteudo);
  assert.strictEqual(base.validarItem(undefined).ok, false);
  assert.strictEqual(base.validarItem({ titulo: ['a'], conteudo: { x: 1 } }).ok, false, 'campos que não são texto contam como vazios');
});

test('validarItem: normaliza espaços do título e respeita os limites', () => {
  const v = base.validarItem({ titulo: '  Entrega   de\tatestado ', conteudo: 'Texto\r\n' });
  assert.deepStrictEqual(v, { ok: true, valores: { titulo: 'Entrega de atestado', conteudo: 'Texto' }, erros: {} });

  assert.match(base.validarItem({ titulo: 'x'.repeat(base.TITULO_MAXIMO + 1), conteudo: 'a' }).erros.titulo, /passa de 200/);
  assert.match(base.validarItem({ titulo: 'a', conteudo: 'x'.repeat(base.CONTEUDO_MAXIMO + 1) }).erros.conteudo, /Divida/);
  assert.strictEqual(base.validarItem({ titulo: 'a', conteudo: 'x'.repeat(base.CONTEUDO_MAXIMO) }).ok, true, 'exatamente no limite é aceito');
});

test('apresentar: estados visuais e quando o Reindexar fica disponível', () => {
  const agora = new Date('2026-11-24T12:00:00Z');
  const item = (extra) => ({ id: 5, titulo: 'T', n_trechos: '3', tamanho: '900', atualizado_em: '2026-11-24T11:50:00Z', ...extra });

  const indexado = base.apresentar(item({ status: 'indexado' }), agora);
  assert.strictEqual(indexado.visual, 'indexado');
  assert.strictEqual(indexado.pode_reindexar, true);
  assert.strictEqual(indexado.id, '5');
  assert.strictEqual(indexado.n_trechos, 3);

  const indexando = base.apresentar(item({ status: 'pendente', travado: false }), agora);
  assert.strictEqual(indexando.visual, 'indexando');
  assert.strictEqual(indexando.pode_reindexar, false, 'não reindexa durante uma indexação em andamento');

  const travado = base.apresentar(item({ status: 'pendente', travado: true }), agora);
  assert.strictEqual(travado.visual, 'travado');
  assert.strictEqual(travado.pode_reindexar, true, 'travado pode ser reindexado');
  assert.match(travado.detalhe, /10 min/);

  assert.strictEqual(base.apresentar(item({ status: 'erro' }), agora).detalhe, 'a indexação falhou');
});

test('contar: "com problema" soma erro e travado', () => {
  const itens = ['indexado', 'indexado', 'indexando', 'erro', 'travado'].map((visual) => ({ visual }));
  assert.deepStrictEqual(base.contar(itens), { indexado: 2, indexando: 1, problema: 2 });
});
