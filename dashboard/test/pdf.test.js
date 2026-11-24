// Testes da importação de PDF (src/pdf.js). Rode com: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const pdf = require('../src/pdf');

test('extrai o texto de um PDF real, com acentos', async () => {
  const { texto, paginas } = await pdf.extrairTexto(fs.readFileSync(path.join(__dirname, 'fixtures', 'manual.pdf')));
  assert.strictEqual(paginas, 1);
  assert.match(texto, /^Manual do Professor 2026/);
  assert.match(texto, /atestado médico/);
  assert.match(texto, /O recesso escolar começa em 15 de dezembro\.$/);
});

test('recusa arquivo que não começa com %PDF-', async () => {
  await assert.rejects(pdf.extrairTexto(Buffer.from('não sou um pdf')), { name: 'ErroPdf', codigo: 'formato' });
  await assert.rejects(pdf.extrairTexto(Buffer.alloc(0)), { codigo: 'formato' });
});

test('PDF corrompido vira erro de leitura (não derruba o servidor)', async () => {
  await assert.rejects(pdf.extrairTexto(Buffer.from('%PDF-1.7\nlixo lixo lixo')), { name: 'ErroPdf' });
});

test('limparTexto junta hifenização e linhas partidas, e tira marcadores de página', () => {
  assert.strictEqual(pdf.limparTexto('matrí-\ncula do aluno\nque chegou.'), 'matrícula do aluno que chegou.');
  assert.strictEqual(pdf.limparTexto('Fim.\n\n\n\nNovo parágrafo\n\n-- 1 of 3 --\n'), 'Fim.\n\nNovo parágrafo');
  assert.strictEqual(pdf.limparTexto('Título\nTexto com maiúscula na linha seguinte'), 'Título\nTexto com maiúscula na linha seguinte');
  assert.strictEqual(pdf.limparTexto('a\u0000b\r\nc   d'), 'ab c d');
});

test('tituloDoArquivo sugere um título legível e respeita o limite', () => {
  assert.strictEqual(pdf.tituloDoArquivo('Manual_do-Professor 2026.PDF', 200), 'Manual do Professor 2026');
  assert.strictEqual(pdf.tituloDoArquivo('x'.repeat(300) + '.pdf', 200).length, 200);
  assert.strictEqual(pdf.tituloDoArquivo(undefined, 200), '');
});
