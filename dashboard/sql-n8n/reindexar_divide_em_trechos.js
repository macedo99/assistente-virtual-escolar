// Nó "Divide em trechos" (Code, modo "Run Once for All Items") do workflow "RAG - Reindexar item".
// Cole no n8n TUDO o que vem depois da linha "// -----" (os testes e o verificar-n8n.js usam essa linha).
//
// Como divide:
//  - Conteúdo curto (até TAMANHO_MAXIMO, como uma FAQ): um trecho só, para não separar pergunta e resposta.
//  - Conteúdo longo (manuais): junta parágrafos e frases inteiras até TAMANHO_MAXIMO. Nunca corta uma palavra
//    ao meio (só uma "palavra" maior que o trecho inteiro, como uma URL enorme, é cortada).
//  - Sobreposição: cada trecho começa repetindo a última frase do anterior (até SOBREPOSICAO_MAXIMA), para a
//    busca não perder o contexto que ficou na fronteira.
// Antes (até nov/2026) o corte era a cada 800 caracteres exatos, partindo palavras e frases.
// -----
const TAMANHO_MAXIMO = 800;       // caracteres por trecho
const SOBREPOSICAO_MAXIMA = 200;  // no máximo isso do fim de um trecho é repetido no começo do próximo

const entrada = $input.first().json;
const itemId = entrada.item_id;
const conteudo = String(entrada.conteudo || '').replace(/\r\n?/g, '\n').trim();

// Quebra um texto grande demais em pedaços de até "limite", sempre num espaço (ou à força, se não houver).
function quebrarEmPalavras(texto, limite) {
  const pedacos = [];
  let resto = texto.trim();
  while (resto.length > limite) {
    let corte = resto.lastIndexOf(' ', limite);
    if (corte <= 0) corte = limite; // uma "palavra" maior que o trecho inteiro
    pedacos.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto) pedacos.push(resto);
  return pedacos;
}

// Unidades = frases (ou pedaços de frase, se uma frase passar do limite), cada uma marcada com o separador
// que vem antes dela no texto: '\n\n' (novo parágrafo), '\n' (nova linha) ou ' ' (mesma linha).
function unidades(texto) {
  const lista = [];
  const paragrafos = texto.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  paragrafos.forEach((paragrafo, ip) => {
    const linhas = paragrafo.split('\n').map((l) => l.trim()).filter(Boolean);
    linhas.forEach((linha, il) => {
      const frases = linha.split(/(?<=[.!?…])\s+/).filter(Boolean);
      frases.forEach((frase, iff) => {
        const sep = iff > 0 ? ' ' : il > 0 ? '\n' : ip > 0 ? '\n\n' : '';
        quebrarEmPalavras(frase, TAMANHO_MAXIMO).forEach((pedaco, ipc) => {
          lista.push({ texto: pedaco, sep: ipc > 0 ? ' ' : sep });
        });
      });
    });
  });
  return lista;
}

// O fim do trecho que é repetido no próximo: a última frase inteira, se couber; senão, as últimas palavras.
function sobreposicao(ultima) {
  if (ultima.length <= SOBREPOSICAO_MAXIMA) return ultima;
  const fim = ultima.slice(-SOBREPOSICAO_MAXIMA);
  const espaco = fim.indexOf(' ');
  return espaco >= 0 ? fim.slice(espaco + 1) : '';
}

let trechos = [];
if (conteudo.length <= TAMANHO_MAXIMO) {
  trechos = conteudo ? [conteudo] : [];
} else {
  let atual = '';
  let ultima = '';
  for (const u of unidades(conteudo)) {
    const junto = atual ? atual + (u.sep || ' ') + u.texto : u.texto;
    if (junto.length <= TAMANHO_MAXIMO) {
      atual = junto;
    } else {
      trechos.push(atual);
      const repetir = sobreposicao(ultima);
      atual = repetir && repetir.length + 1 + u.texto.length <= TAMANHO_MAXIMO ? `${repetir} ${u.texto}` : u.texto;
    }
    ultima = u.texto;
  }
  if (atual) trechos.push(atual);
}

return trechos.map((trecho) => ({ json: { item_id: itemId, trecho } }));
