// Divisão do conteúdo em trechos para os embeddings (sql-n8n/reindexar_divide_em_trechos.js).
// Roda EXATAMENTE o código que é colado no nó "Divide em trechos" do n8n (o que vem depois da linha "// -----"),
// com um $input de mentira — o mesmo jeito que o scripts/verificar-n8n.js usa.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const arquivo = fs.readFileSync(path.join(__dirname, '..', 'sql-n8n', 'reindexar_divide_em_trechos.js'), 'utf8');
const codigo = arquivo.split(/^\/\/ -----\r?\n/m)[1];
const MAXIMO = 800;

function dividir(conteudo) {
  const entrada = { first: () => ({ json: { item_id: '7', conteudo } }) };
  const saida = new Function('$input', codigo)(entrada);
  for (const s of saida) assert.strictEqual(s.json.item_id, '7');
  return saida.map((s) => s.json.trecho);
}

const juntar = (t) => t.replace(/\s+/g, ' ').trim();
const LETRA = /[\p{L}\p{N}]/u;

// Cada trecho é um pedaço do original e não começa nem termina no meio de uma palavra.
function conferirFronteiras(original, trechos) {
  const texto = juntar(original);
  for (const trecho of trechos) {
    const t = juntar(trecho);
    const inicio = texto.indexOf(t);
    assert.ok(inicio >= 0, `trecho não é parte do texto original: "${t.slice(0, 60)}…"`);
    const antes = texto[inicio - 1];
    const depois = texto[inicio + t.length];
    assert.ok(!(antes && LETRA.test(antes) && LETRA.test(t[0])), `trecho começa no meio de uma palavra: "${t.slice(0, 40)}"`);
    assert.ok(!(depois && LETRA.test(depois) && LETRA.test(t[t.length - 1])), `trecho termina no meio de uma palavra: "…${t.slice(-40)}"`);
  }
}

const FRASES = Array.from({ length: 30 }, (_, i) => `A regra número ${i + 1} do manual explica um procedimento da secretaria com alguns detalhes importantes.`);
const MANUAL = [FRASES.slice(0, 10).join(' '), FRASES.slice(10, 20).join(' '), FRASES.slice(20).join(' ')].join('\n\n');

test('o arquivo tem a linha "// -----" que separa o código colado no n8n', () => {
  assert.ok(codigo && codigo.includes('TAMANHO_MAXIMO'));
});

test('conteúdo curto (FAQ) vira um único trecho, igual ao original', () => {
  const faq = 'Como entrego o atestado médico?\nNa secretaria, em até 48 horas.';
  assert.deepStrictEqual(dividir(faq), [faq]);
  assert.deepStrictEqual(dividir('  \r\n '), []);
  assert.strictEqual(dividir('x'.repeat(MAXIMO)).length, 1, 'exatamente no limite ainda é um trecho só');
});

test('manual longo: trechos de até 800 caracteres, frases inteiras, nenhuma palavra cortada', () => {
  const trechos = dividir(MANUAL);
  assert.ok(trechos.length >= 4);
  for (const t of trechos) assert.ok(t.length <= MAXIMO, `trecho com ${t.length} caracteres`);
  conferirFronteiras(MANUAL, trechos);
  for (const t of trechos) assert.match(t, /\.$/, 'cada trecho termina no fim de uma frase');
});

test('nenhuma frase se perde: todas aparecem em algum trecho', () => {
  const trechos = dividir(MANUAL);
  for (const frase of FRASES) assert.ok(trechos.some((t) => t.includes(frase)), `frase perdida: ${frase}`);
});

test('sobreposição: cada trecho começa com a última frase do anterior', () => {
  const trechos = dividir(MANUAL);
  for (let i = 1; i < trechos.length; i++) {
    const ultimaFrase = trechos[i - 1].split(/(?<=\.)\s+/).pop();
    assert.ok(trechos[i].startsWith(ultimaFrase), `o trecho ${i + 1} não repete o fim do anterior`);
  }
});

test('frase enorme sem pontuação é quebrada nos espaços, nunca no meio da palavra', () => {
  const longa = Array.from({ length: 400 }, (_, i) => `palavra${i}`).join(' ');
  const trechos = dividir(longa);
  for (const t of trechos) assert.ok(t.length <= MAXIMO);
  conferirFronteiras(longa, trechos);
  assert.ok(trechos.join(' ').includes('palavra399'));
});

test('uma "palavra" maior que o trecho inteiro (URL enorme) é cortada à força, sem travar', () => {
  const url = 'https://exemplo.escola/' + 'a'.repeat(2000);
  const trechos = dividir(`Veja o link: ${url} e depois volte.`);
  for (const t of trechos) assert.ok(t.length <= MAXIMO);
  assert.ok(trechos.length >= 3);
});

test('mantém quebras de parágrafo e de linha (listas continuam legíveis)', () => {
  const lista = ['Documentos necessários:', ...Array.from({ length: 40 }, (_, i) => `- Documento ${i + 1}: cópia autenticada e original.`)].join('\n');
  const trechos = dividir(lista);
  assert.ok(trechos[0].startsWith('Documentos necessários:\n- Documento 1:'));
  conferirFronteiras(lista, trechos);
});

test('o corte antigo (a cada 800 caracteres, sobreposição de 100) partia palavras; o novo não', () => {
  // o algoritmo anterior, reproduzido aqui só para comparar
  const cortesAntigos = [];
  for (let inicio = 0; inicio + MAXIMO < MANUAL.length; inicio += MAXIMO - 100) cortesAntigos.push(inicio + MAXIMO);
  const partiuPalavra = cortesAntigos.some((c) => LETRA.test(MANUAL[c - 1]) && LETRA.test(MANUAL[c]));
  assert.ok(partiuPalavra, 'o exemplo deveria mostrar o problema antigo');
  conferirFronteiras(MANUAL, dividir(MANUAL)); // o novo nunca parte
});

test('é determinístico (reindexar o mesmo texto gera os mesmos trechos)', () => {
  assert.deepStrictEqual(dividir(MANUAL), dividir(MANUAL));
});
