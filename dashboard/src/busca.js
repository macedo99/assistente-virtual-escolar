// Busca semântica na base de conhecimento — a mesma ideia que o RAG do n8n usa: transformar a pergunta em
// vetor (embedding, modelo bge-m3 no Ollama) e procurar os trechos mais próximos pela distância de cosseno
// do pgvector. Usada pela avaliação da busca (scripts/avaliar-busca.js).

const TEMPO_LIMITE_MS = 30000;

function configuracao() {
  return {
    url: (process.env.OLLAMA_URL || 'http://ollama:11434').replace(/\/+$/, ''),
    modelo: process.env.EMBEDDING_MODEL || 'bge-m3',
  };
}

// Pergunta → vetor. Usa a API /api/embed do Ollama.
async function gerarEmbedding(texto) {
  const { url, modelo } = configuracao();
  let resposta;
  try {
    resposta = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelo, input: texto }),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (err) {
    throw new Error(`Não consegui falar com o Ollama em ${url} (${err.name === 'TimeoutError' ? 'demorou demais' : 'sem conexão'}). Ele está de pé?`);
  }
  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '');
    throw new Error(`O Ollama recusou o pedido de embedding (status ${resposta.status}). O modelo "${modelo}" está instalado? ${detalhe.slice(0, 200)}`);
  }
  const dados = await resposta.json();
  const vetor = dados && Array.isArray(dados.embeddings) ? dados.embeddings[0] : null;
  if (!Array.isArray(vetor) || vetor.length === 0) throw new Error('O Ollama respondeu sem o vetor (campo "embeddings").');
  return vetor;
}

// Itens da base (só os indexados) do mais próximo ao mais distante da pergunta. A distância de um item é a do
// seu trecho mais próximo.
const SQL_BUSCAR = `
  SELECT i.id, i.titulo, min(t.embedding <=> $1::vector) AS distancia
  FROM trechos_embeddings t
  JOIN itens_base_conhecimento i ON i.id = t.item_id
  WHERE i.status_indexacao = 'indexado'
  GROUP BY i.id, i.titulo
  ORDER BY distancia ASC, i.id ASC
  LIMIT $2`;

async function buscarItens(db, vetor, limite = 5) {
  const { rows } = await db.query(SQL_BUSCAR, [JSON.stringify(vetor), limite]);
  return rows.map((r) => ({ id: String(r.id), titulo: r.titulo, similaridade: 1 - Number(r.distancia) }));
}

// ---------------------------------------------------------------------------------------------------------
// Avaliação (funções puras, testadas em test/busca.test.js)

const normalizarTitulo = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Lê o arquivo do conjunto de perguntas e devolve [{ pergunta, item }]. Formato:
//   { "casos": [ { "item": "Título do item", "perguntas": ["...", "..."] } ] }
function lerConjunto(json) {
  const dados = typeof json === 'string' ? JSON.parse(json) : json;
  if (!dados || !Array.isArray(dados.casos)) throw new Error('O arquivo precisa ter uma lista "casos".');
  const lista = [];
  dados.casos.forEach((caso, i) => {
    if (!caso || typeof caso.item !== 'string' || !caso.item.trim()) throw new Error(`O caso ${i + 1} não tem "item" (o título do item da base).`);
    if (!Array.isArray(caso.perguntas)) throw new Error(`O caso "${caso.item}" não tem a lista "perguntas".`);
    for (const pergunta of caso.perguntas) {
      if (typeof pergunta !== 'string' || !pergunta.trim()) continue;
      if (/^\[.*\]$/.test(pergunta.trim())) continue; // texto de modelo ainda não preenchido: "[escreva ...]"
      lista.push({ pergunta: pergunta.trim(), item: caso.item.trim() });
    }
  });
  return lista;
}

// Posição (1, 2, 3...) do item esperado no resultado, ou null se ele não veio.
function posicaoDoEsperado(item, resultado) {
  const alvo = normalizarTitulo(item);
  const i = resultado.findIndex((r) => normalizarTitulo(r.titulo) === alvo);
  return i >= 0 ? i + 1 : null;
}

// Acerto@k = fração das perguntas em que o item certo veio entre os k primeiros.
// MRR = média de 1/posição (1 se veio em 1º, 0,5 se em 2º...; 0 se não veio).
function resumir(posicoes, ks = [1, 3, 5]) {
  const n = posicoes.length;
  const acerto = {};
  for (const k of ks) acerto[k] = n ? posicoes.filter((p) => p !== null && p <= k).length / n : null;
  const mrr = n ? posicoes.reduce((soma, p) => soma + (p ? 1 / p : 0), 0) / n : null;
  return { perguntas: n, acerto, mrr };
}

module.exports = { configuracao, gerarEmbedding, buscarItens, normalizarTitulo, lerConjunto, posicaoDoEsperado, resumir };
