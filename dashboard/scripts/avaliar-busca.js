// Avalia a BUSCA da base de conhecimento: para cada pergunta de um conjunto escrito pela equipe ("golden set"),
// confere se o item certo aparece entre os primeiros resultados. Usa o mesmo modelo de embedding do bot
// (bge-m3 no Ollama) e os trechos que já estão no banco. Não grava nada.
//
// Rode na pasta do projeto, com o sistema de pé (o arquivo vai pela entrada padrão):
//
//   docker compose exec -T dashboard node scripts/avaliar-busca.js - < avaliacao/busca.json
//
// Opções:
//   --minimo=0.8   sai com código 1 se o acerto@3 ficar abaixo disso (para usar como verificação)
//   --modelo       em vez de avaliar, imprime um arquivo-modelo com os títulos de todos os itens indexados,
//                  para a equipe escrever as perguntas:
//                    docker compose exec -T dashboard node scripts/avaliar-busca.js --modelo > avaliacao/busca.json
//
// Variáveis: OLLAMA_URL (padrão http://ollama:11434) e EMBEDDING_MODEL (padrão bge-m3).
const fs = require('fs');
const pool = require('../src/db');
const busca = require('../src/busca');

const K = 5;
const args = process.argv.slice(2);
const opcao = (nome) => {
  const a = args.find((x) => x === `--${nome}` || x.startsWith(`--${nome}=`));
  return a === undefined ? undefined : a.includes('=') ? a.split('=')[1] : true;
};
const pct = (v) => (v === null ? '—' : `${(v * 100).toFixed(1).replace('.', ',')}%`);

async function gerarModelo() {
  const { rows } = await pool.query("SELECT titulo FROM itens_base_conhecimento WHERE status_indexacao = 'indexado' ORDER BY titulo");
  const modelo = {
    descricao: 'Perguntas reais (como um professor escreveria no Telegram) e o item da base que deve responder cada uma. Escreva de 2 a 4 perguntas por item, com palavras diferentes das do título. Apague os itens que não quiser avaliar.',
    casos: rows.map((r) => ({ item: r.titulo, perguntas: ['[escreva uma pergunta real que este item responde]'] })),
  };
  process.stdout.write(JSON.stringify(modelo, null, 2) + '\n');
}

async function avaliar(arquivo) {
  const texto = arquivo === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arquivo, 'utf8');
  const casos = busca.lerConjunto(texto);
  if (!casos.length) {
    console.error('Nenhuma pergunta preenchida no arquivo (as que estão entre [colchetes] são do modelo e são ignoradas).');
    process.exit(1);
  }

  const { rows } = await pool.query("SELECT titulo FROM itens_base_conhecimento WHERE status_indexacao = 'indexado'");
  const indexados = new Set(rows.map((r) => busca.normalizarTitulo(r.titulo)));
  const { modelo, url } = busca.configuracao();
  console.log(`Avaliando a busca: ${casos.length} pergunta(s), ${indexados.size} item(ns) indexado(s), modelo ${modelo} em ${url}\n`);

  const posicoes = [];
  const fora = [];
  for (const caso of casos) {
    if (!indexados.has(busca.normalizarTitulo(caso.item))) {
      fora.push(caso);
      continue;
    }
    const vetor = await busca.gerarEmbedding(caso.pergunta);
    const resultado = await busca.buscarItens(pool, vetor, K);
    const pos = busca.posicaoDoEsperado(caso.item, resultado);
    posicoes.push(pos);
    const marca = pos === 1 ? '✔' : pos ? '~' : '✘';
    const detalhe = pos === 1 ? '' : `\n       esperado: ${caso.item}${pos ? ` (veio em ${pos}º)` : ` (fora dos ${K} primeiros)`}\n       veio em 1º: ${resultado[0] ? `${resultado[0].titulo} (similaridade ${resultado[0].similaridade.toFixed(3)})` : '—'}`;
    console.log(`  ${marca}  ${caso.pergunta}${detalhe}`);
  }

  const r = busca.resumir(posicoes);
  console.log(`\nAcerto@1: ${pct(r.acerto[1])} · Acerto@3: ${pct(r.acerto[3])} · Acerto@5: ${pct(r.acerto[5])} · MRR: ${r.mrr === null ? '—' : r.mrr.toFixed(3).replace('.', ',')}`);
  console.log('(acerto@k = o item certo veio entre os k primeiros; ✔ em 1º, ~ entre 2º e 5º, ✘ não veio)');
  if (fora.length) {
    console.log(`\n${fora.length} pergunta(s) não avaliada(s): o item esperado não existe ou não está indexado:`);
    for (const f of fora) console.log(`   - "${f.item}" ← ${f.pergunta}`);
  }

  const minimo = opcao('minimo');
  if (minimo !== undefined && r.acerto[3] !== null && r.acerto[3] < Number(minimo)) {
    console.log(`\nReprovado: acerto@3 ${pct(r.acerto[3])} abaixo do mínimo ${pct(Number(minimo))}.`);
    process.exitCode = 1;
  }
}

async function main() {
  if (opcao('modelo')) return gerarModelo();
  const arquivo = args.find((a) => !a.startsWith('--'));
  if (!arquivo) {
    console.error('Uso: node scripts/avaliar-busca.js <arquivo.json | -> [--minimo=0.8]   ou   --modelo');
    process.exit(1);
  }
  return avaliar(arquivo);
}

main()
  .catch((err) => {
    console.error(`\nErro: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
