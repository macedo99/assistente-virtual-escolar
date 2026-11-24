// Limpa os workflows exportados do n8n antes de irem para o git. Roda DENTRO do container do n8n
// (chamado pelo exportar-workflows.sh): node - <pasta-da-exportação>
//
// - Tira dados que não são o workflow: pinData (podem ser mensagens reais de professores), staticData,
//   o id da instância e campos que mudam a cada salvamento (só gerariam diferença no git).
// - Dá a cada arquivo o nome do workflow ("RAG - Reindexar item" → rag-reindexar-item.json).
// - Procura coisas com cara de segredo (token do Telegram, chave de API, senha escrita num campo) e AVISA.
//   As credenciais do n8n NÃO vêm na exportação (só uma referência com id e nome); um segredo só aparece
//   se alguém o escreveu direto num nó — e aí ele deve virar uma credencial antes do commit.

const fs = require('fs');
const path = require('path');


const CAMPOS_FORA = ['pinData', 'staticData', 'shared', 'versionId', 'activeVersionId', 'activeVersion', 'createdAt', 'updatedAt', 'triggerCount', 'versionCounter'];

const SUSPEITOS = [
  ['token de bot do Telegram', /(?<!\d)\d{8,12}:[A-Za-z0-9_-]{30,}/],
  ['chave de API (sk-...)', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['cabeçalho Bearer com valor', /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['senha/token/chave escrito num campo', /"(password|senha|token|apiKey|api_key|secret|segredo|accessToken)"\s*:\s*"(?![={])[^"]{6,}"/i],
  ['URL com usuário e senha', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"]+:[^\s/@"]+@/i],
];

const slug = (texto) => String(texto || 'workflow')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';

// Lista onde há algo com cara de segredo nos parâmetros dos nós (usada aqui e pelo teste do CI).
function procurarSegredos(workflow) {
  const achados = [];
  for (const no of workflow.nodes || []) {
    const texto = JSON.stringify(no.parameters || {});
    for (const [tipo, regra] of SUSPEITOS) {
      if (regra.test(texto)) achados.push({ no: no.name, tipo });
    }
  }
  return achados;
}

function limpar(pasta) {
const saida = path.join(pasta, 'limpos');
fs.mkdirSync(saida, { recursive: true });
const avisos = [];
const usados = new Set();
const arquivos = fs.readdirSync(pasta).filter((nome) => nome.endsWith('.json'));

for (const arquivo of arquivos) {
  const workflow = JSON.parse(fs.readFileSync(path.join(pasta, arquivo), 'utf8'));
  for (const campo of CAMPOS_FORA) delete workflow[campo];
  if (workflow.meta) delete workflow.meta.instanceId;

  let nome = slug(workflow.name);
  if (usados.has(nome)) nome = `${nome}-${workflow.id}`;
  usados.add(nome);

  // Diz ONDE está (nunca imprime o valor).
  for (const { no, tipo } of procurarSegredos(workflow)) avisos.push(`${nome}.json · nó "${no}": ${tipo}`);

  fs.writeFileSync(path.join(saida, `${nome}.json`), JSON.stringify(workflow, null, 2) + '\n');
  console.log(`  ✔  ${workflow.name} → n8n/workflows/${nome}.json${workflow.active ? '' : ' (inativo)'}`);
}

if (arquivos.length === 0) console.log('  Nenhum workflow encontrado no n8n.');

if (avisos.length) {
  console.log('\n  ATENÇÃO: possíveis segredos escritos direto nos nós (os valores não são mostrados):');
  for (const aviso of avisos) console.log(`   - ${aviso}`);
  console.log('  Troque cada um por uma credencial do n8n e exporte de novo ANTES de fazer commit.');
  process.exitCode = 3;
}
}

module.exports = { SUSPEITOS, procurarSegredos };

// Rodando como script (node - <pasta>, pelo exportar-workflows.sh), e não carregado por um teste.
if (!module.parent && process.argv[2]) limpar(process.argv[2]);
