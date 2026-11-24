// Detecção de prompt injection no dashboard. As regras ficam num lugar só: o arquivo que é colado no nó
// "Detecta injeção" do n8n (sql-n8n/detectar_injecao.js). Aqui carregamos a parte da DETECÇÃO desse arquivo
// (entre "// -----" e "// ----- fim"), sem a parte que só existe dentro do n8n.
const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, '..', 'sql-n8n', 'detectar_injecao.js');

function carregar() {
  const fonte = fs.readFileSync(ARQUIVO, 'utf8');
  const inicio = fonte.search(/^\/\/ -----\r?\n/m);
  const fim = fonte.search(/^\/\/ ----- fim/m);
  if (inicio < 0 || fim < 0) throw new Error(`${ARQUIVO}: faltam as linhas "// -----" e "// ----- fim"`);
  const codigo = fonte.slice(inicio, fim);
  // Código do próprio repositório (não vem de usuário): a mesma função que roda no n8n.
  return new Function(`${codigo}\nreturn { detectarInjecao, normalizarParaDeteccao, PREFIXO_INJECAO, RESPOSTA_INJECAO };`)();
}

const { detectarInjecao, normalizarParaDeteccao, PREFIXO_INJECAO, RESPOSTA_INJECAO } = carregar();

// Nomes dos motivos para mostrar na tela.
const MOTIVOS_INJECAO = {
  ignorar_instrucoes: 'pede para ignorar instruções',
  revelar_prompt: 'pede para revelar o prompt ou as instruções internas',
  mudar_papel: 'pede para o bot fingir ser outra coisa',
  modo_sem_restricoes: 'pede um “modo sem restrições”',
  extrair_dados: 'pede dados pessoais ou credenciais',
  instrucao_escondida: 'dá ordens ao bot (“quando perguntarem, diga…”)',
  marcacao_falsa: 'imita mensagens do sistema',
};

const descreverMotivos = (motivos) => motivos.map((m) => MOTIVOS_INJECAO[m] || m).join('; ');

// Nomes curtos, para o cartão Segurança das Métricas.
const ROTULOS_INJECAO = {
  ignorar_instrucoes: 'Ignorar instruções',
  revelar_prompt: 'Revelar o prompt',
  mudar_papel: 'Mudar de papel',
  modo_sem_restricoes: 'Modo sem restrições',
  extrair_dados: 'Extrair dados ou senhas',
  instrucao_escondida: 'Ordem escondida em texto',
  marcacao_falsa: 'Imitar o sistema',
  desconhecido: 'Tipo não identificado',
};

module.exports = { detectarInjecao, normalizarParaDeteccao, descreverMotivos, MOTIVOS_INJECAO, ROTULOS_INJECAO, PREFIXO_INJECAO, RESPOSTA_INJECAO };
