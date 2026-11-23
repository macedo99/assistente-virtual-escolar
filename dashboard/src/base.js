// Gestão da base de conhecimento: Consultas e regras dos itens (FAQs, trechos de manuais).
//
// Estados de um item (coluna status_indexacao):
//
//   pendente  --(o n8n termina de gerar os embeddings)-->            indexado
//   pendente  --(algo falha: n8n ou Ollama fora do ar, por exemplo)-->  erro
//   indexado | erro  --(criar, mudar o conteúdo ou "Reindexar")-->     pendente

const { formatarDataHora, tempoDecorrido } = require('./formato');

const TITULO_MAXIMO = 200;      // igual ao VARCHAR(200) da coluna titulo
const CONTEUDO_MAXIMO = 50000;  // cerca de 70 trechos de 800 caracteres; passou disso, divida em itens menores

// Uma indexação normal leva segundos. "pendente" há mais que isso significa que o n8n caiu no meio
// do caminho (ou o aviso nunca chegou): o item é considerado travado e pode ser reindexado.
const MINUTOS_TRAVADO = 5;

// Os ids são BIGSERIAL: só dígitos, até 18 (cabe em bigint). Qualquer outra coisa vira 404, não erro 500.
const idValido = (valor) => /^\d{1,18}$/.test(String(valor));

const TRAVADO_SQL = `(i.status_indexacao = 'pendente' AND i.atualizado_em < now() - interval '${MINUTOS_TRAVADO} minutes')`;
// Sem alias de tabela: usado dentro de UPDATE.
const PODE_INDEXAR_SQL = `(status_indexacao <> 'pendente' OR atualizado_em < now() - interval '${MINUTOS_TRAVADO} minutes')`;

const SQL_LISTAR = `
  SELECT i.id, i.titulo, i.status_indexacao AS status, i.criado_em, i.atualizado_em,
         length(i.conteudo) AS tamanho,
         (SELECT count(*) FROM trechos_embeddings t WHERE t.item_id = i.id)::int AS n_trechos,
         ${TRAVADO_SQL} AS travado
  FROM itens_base_conhecimento i
  ORDER BY i.atualizado_em DESC, i.id DESC`;

const SQL_OBTER = `
  SELECT i.id, i.titulo, i.conteudo, i.status_indexacao AS status, i.criado_em, i.atualizado_em,
         length(i.conteudo) AS tamanho,
         (SELECT count(*) FROM trechos_embeddings t WHERE t.item_id = i.id)::int AS n_trechos,
         ${TRAVADO_SQL} AS travado
  FROM itens_base_conhecimento i
  WHERE i.id = $1`;

const SQL_CRIAR = `
  INSERT INTO itens_base_conhecimento (titulo, conteudo, status_indexacao)
  VALUES ($1, $2, 'pendente')
  RETURNING id`;

// Só o título mudou: ele não entra nos embeddings (só o texto dos trechos entra), então não precisa reindexar.
const SQL_MUDAR_TITULO = `
  UPDATE itens_base_conhecimento
     SET titulo = $2
   WHERE id = $1
  RETURNING id`;

// O conteúdo mudou: volta para "pendente" e some da busca do bot até o n8n terminar. Recusa se o item
// está sendo indexado agora (duas indexações ao mesmo tempo gravariam trechos misturados).
const SQL_MUDAR_CONTEUDO = `
  UPDATE itens_base_conhecimento
     SET titulo = $2, conteudo = $3, status_indexacao = 'pendente', atualizado_em = now()
   WHERE id = $1
     AND ${PODE_INDEXAR_SQL}
  RETURNING id`;

const SQL_REINDEXAR = `
  UPDATE itens_base_conhecimento
     SET status_indexacao = 'pendente', atualizado_em = now()
   WHERE id = $1
     AND ${PODE_INDEXAR_SQL}
  RETURNING id`;

// Não conseguimos nem avisar o n8n: o item vira "erro" (e não fica "pendente" pra sempre).
const SQL_ERRO_AO_ACIONAR = `
  UPDATE itens_base_conhecimento
     SET status_indexacao = 'erro', atualizado_em = now()
   WHERE id = $1
     AND status_indexacao = 'pendente'
  RETURNING id`;

// Os trechos (e os embeddings) saem junto: a FK de trechos_embeddings tem ON DELETE CASCADE.
const SQL_EXCLUIR = `
  DELETE FROM itens_base_conhecimento
   WHERE id = $1
  RETURNING titulo`;

// Quebras de linha: o navegador envia CRLF; guardamos sempre LF (assim "não mudou nada" é comparável).
// O caractere nulo (U+0000) o Postgres não aceita em texto.
const normalizarTexto = (texto) => String(texto).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();

// Confere o que veio do formulário. Devolve { ok, valores, erros } — "valores" já normalizados.
function validarItem(entrada) {
  const bruto = entrada || {};
  const titulo = typeof bruto.titulo === 'string' ? bruto.titulo.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim() : '';
  const conteudo = typeof bruto.conteudo === 'string' ? normalizarTexto(bruto.conteudo) : '';
  const erros = {};

  if (!titulo) erros.titulo = 'Informe um título.';
  else if (titulo.length > TITULO_MAXIMO) erros.titulo = `O título passa de ${TITULO_MAXIMO} caracteres (tem ${titulo.length}).`;

  if (!conteudo) erros.conteudo = 'Escreva o conteúdo.';
  else if (conteudo.length > CONTEUDO_MAXIMO) {
    erros.conteudo = `O conteúdo passa de ${CONTEUDO_MAXIMO} caracteres (tem ${conteudo.length}). Divida em itens menores.`;
  }

  return { ok: Object.keys(erros).length === 0, valores: { titulo, conteudo }, erros };
}

async function listar(db) {
  const resultado = await db.query(SQL_LISTAR);
  return resultado.rows;
}

async function obter(db, id) {
  const resultado = await db.query(SQL_OBTER, [id]);
  return resultado.rows[0] || null;
}

async function criar(db, { titulo, conteudo }) {
  const resultado = await db.query(SQL_CRIAR, [titulo, conteudo]);
  return resultado.rows[0].id;
}

const recusa = (http, mensagem) => ({ ok: false, http, mensagem });
const NAO_ENCONTRADO = 'Item não encontrado (ele pode ter sido excluído).';
const EM_INDEXACAO = 'Este item está sendo indexado agora. Espere terminar (alguns segundos) e tente de novo.';

// Salva as mudanças. Devolve { ok: true, reindexar } — "reindexar" diz se o n8n precisa ser avisado —
// ou { ok: false, http, mensagem }.
async function atualizar(db, id, { titulo, conteudo }) {
  const atual = await obter(db, id);
  if (!atual) return recusa(404, NAO_ENCONTRADO);

  if (normalizarTexto(atual.conteudo) === conteudo) {
    const r = await db.query(SQL_MUDAR_TITULO, [id, titulo]);
    if (r.rows.length !== 1) return recusa(404, NAO_ENCONTRADO);
    return { ok: true, reindexar: false };
  }

  const r = await db.query(SQL_MUDAR_CONTEUDO, [id, titulo, conteudo]);
  if (r.rows.length === 1) return { ok: true, reindexar: true };

  // O UPDATE não mexeu em nada: o item sumiu ou está sendo indexado agora.
  const depois = await obter(db, id);
  return depois ? recusa(409, EM_INDEXACAO) : recusa(404, NAO_ENCONTRADO);
}

// "Reindexar": marca como pendente (se não houver uma indexação em andamento). Depois disso, quem chama
// avisa o n8n.
async function marcarParaReindexar(db, id) {
  const r = await db.query(SQL_REINDEXAR, [id]);
  if (r.rows.length === 1) return { ok: true };
  const depois = await obter(db, id);
  return depois ? recusa(409, EM_INDEXACAO) : recusa(404, NAO_ENCONTRADO);
}

async function marcarErro(db, id) {
  const r = await db.query(SQL_ERRO_AO_ACIONAR, [id]);
  return r.rows.length === 1;
}

// Devolve o título do item excluído (ou null se ele já não existia).
async function excluir(db, id) {
  const r = await db.query(SQL_EXCLUIR, [id]);
  return r.rows.length === 1 ? r.rows[0].titulo : null;
}

// Prepara um item para a tela e para a API de status (mesmo formato nos dois).
function apresentar(item, agora = new Date()) {
  const visual = item.status === 'pendente' ? (item.travado ? 'travado' : 'indexando') : item.status;
  const rotulo = { indexado: 'Indexado', erro: 'Erro', indexando: 'Indexando…', travado: 'Travado' }[visual] || item.status;
  const detalhe = {
    erro: 'a indexação falhou',
    travado: `sem resposta do n8n há ${tempoDecorrido(item.atualizado_em, agora)}`,
  }[visual] || '';

  return {
    id: String(item.id),
    titulo: item.titulo,
    status: item.status,
    visual,
    rotulo,
    detalhe,
    n_trechos: Number(item.n_trechos) || 0,
    tamanho: Number(item.tamanho) || 0,
    atualizado_em_fmt: formatarDataHora(item.atualizado_em),
    // Reindexar fica desligado enquanto há uma indexação em andamento (a menos que esteja travada).
    pode_reindexar: item.status !== 'pendente' || Boolean(item.travado),
  };
}

// Contadores do topo da tela: "com problema" soma erro + travado.
function contar(itens) {
  const por = (visual) => itens.filter((i) => i.visual === visual).length;
  return { indexado: por('indexado'), indexando: por('indexando'), problema: por('erro') + por('travado') };
}

module.exports = {
  TITULO_MAXIMO,
  CONTEUDO_MAXIMO,
  MINUTOS_TRAVADO,
  idValido,
  normalizarTexto,
  validarItem,
  listar,
  obter,
  criar,
  atualizar,
  marcarParaReindexar,
  marcarErro,
  excluir,
  apresentar,
  contar,
};
