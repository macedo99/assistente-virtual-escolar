// Avalia a detecção de prompt injection (as mesmas regras do nó "Detecta injeção" do n8n) contra:
//   avaliacao/red-team.json   — ataques: o bot TEM de responder com o aviso de injeção (detecção)
//   avaliacao/golden-set.json — perguntas legítimas: o bot NÃO pode tratar como injeção (falso positivo)
// Não precisa de banco, n8n nem Ollama. Na pasta dashboard/:
//
//   node scripts/avaliar-injecao.js
//
// Sai com código 1 se algum ataque passar sem aviso ou alguma pergunta legítima for barrada
// (os testes do CI conferem a mesma coisa em test/injecao.test.js).
const fs = require('fs');
const path = require('path');
const { detectarInjecao, descreverMotivos, RESPOSTA_INJECAO } = require('../src/injecao');

const PASTA = path.join(__dirname, '..', '..', 'avaliacao');
const ler = (nome) => JSON.parse(fs.readFileSync(path.join(PASTA, nome), 'utf8')).casos;
const pct = (parte, total) => `${((parte / total) * 100).toFixed(1).replace('.', ',')}%`;

const redTeam = ler('red-team.json');
const golden = ler('golden-set.json');

console.log('Red-team (o bot deve responder com o aviso de prompt injection)\n');
let detectados = 0;
for (const caso of redTeam) {
  const r = detectarInjecao(caso.mensagem, { origem: caso.tipo === 'indireta' ? 'documento' : 'mensagem' });
  if (r.injecao) detectados += 1;
  const texto = caso.mensagem.replace(/\s+/g, ' ').slice(0, 90);
  console.log(`  ${r.injecao ? '✔' : '✘'}  ${caso.id} [${caso.tipo}] ${texto}${r.injecao ? `\n         → ${descreverMotivos(r.motivos)}` : '\n         → PASSOU SEM AVISO'}`);
}

console.log('\nGolden set (perguntas legítimas: o bot deve responder normalmente)\n');
let falsos = 0;
for (const caso of golden) {
  const r = detectarInjecao(caso.pergunta, { origem: 'mensagem' });
  if (r.injecao) {
    falsos += 1;
    console.log(`  ✘  ${caso.id} ${caso.pergunta}\n         → BARRADA POR ENGANO: ${descreverMotivos(r.motivos)} (“${r.trechos.join('”, “')}”)`);
  } else {
    console.log(`  ✔  ${caso.id} ${caso.pergunta}`);
  }
}

console.log(`\nDetecção no red-team: ${detectados}/${redTeam.length} (${pct(detectados, redTeam.length)})`);
console.log(`Falsos positivos no golden set: ${falsos}/${golden.length} (${pct(falsos, golden.length)})`);
console.log(`\nResposta que o bot envia quando detecta:\n  ${RESPOSTA_INJECAO}`);
process.exitCode = detectados === redTeam.length && falsos === 0 ? 0 : 1;
