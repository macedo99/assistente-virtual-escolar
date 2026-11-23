// No "Divide em trechos" (Code, modo "Run Once for All Items") do workflow "RAG - Reindexar item"
const TAMANHO_MAXIMO = 800;   // caracteres por trecho
const SOBREPOSICAO = 100;     // caracteres repetidos entre trechos, para nao cortar uma frase ao meio

const entrada = $input.first().json;
const itemId = entrada.item_id;
const conteudo = String(entrada.conteudo || '');

let trechos = [];
if (conteudo.length <= TAMANHO_MAXIMO) {
  // FAQ curta: vira um unico trecho (nao separa pergunta de resposta)
  trechos = [conteudo];
} else {
  // Conteudo longo (manual): quebra em pedacos com sobreposicao
  let inicio = 0;
  while (inicio < conteudo.length) {
    const fim = Math.min(inicio + TAMANHO_MAXIMO, conteudo.length);
    trechos.push(conteudo.slice(inicio, fim));
    if (fim >= conteudo.length) break;
    inicio += TAMANHO_MAXIMO - SOBREPOSICAO;
  }
}

return trechos.map(trecho => ({ json: { item_id: itemId, trecho } }));
