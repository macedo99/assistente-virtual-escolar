// Aviso ao n8n para (re)indexar um item da base de conhecimento

const TEMPO_LIMITE_MS = 10000;
const CABECALHO_TOKEN = 'X-Ingestao-Token';
const URL_PADRAO = 'http://n8n:5678/webhook/reindexar-item';

class ErroIngestao extends Error {
  constructor(mensagem, { codigo = 'api', detalhe = '' } = {}) {
    super(mensagem);
    this.name = 'ErroIngestao';
    // 'config' | 'timeout' | 'rede' | 'token' | 'webhook' | 'n8n' | 'api'
    this.codigo = codigo;
    this.detalhe = detalhe;
  }
}

// Lido a cada chamada (e não uma vez só ao carregar o arquivo): o valor do .env vale sempre, e os testes
// automáticos podem apontar INGESTAO_URL para um n8n de mentira.
function configuracao() {
  return {
    url: (process.env.INGESTAO_URL || URL_PADRAO).trim(),
    token: (process.env.INGESTAO_TOKEN || '').trim(),
  };
}

function traduzirErro(status, host) {
  if (status === 401 || status === 403) {
    return new ErroIngestao(
      `O n8n recusou o token da indexação. O INGESTAO_TOKEN do .env precisa ser igual ao valor da credencial “Header Auth” do webhook.`,
      { codigo: 'token', detalhe: `status ${status}` },
    );
  }
  if (status === 404) {
    return new ErroIngestao(
      'O n8n não encontrou o webhook. Confira se o workflow “RAG - Reindexar item” está publicado (ativo) e se o caminho é reindexar-item.',
      { codigo: 'webhook', detalhe: 'status 404' },
    );
  }
  if (status >= 500) {
    return new ErroIngestao(`O n8n respondeu com erro (status ${status}). Veja a aba Executions do n8n.`, { codigo: 'n8n', detalhe: `status ${status}` });
  }
  return new ErroIngestao(`O n8n recusou o aviso de indexação (status ${status}) em ${host}.`, { codigo: 'api', detalhe: `status ${status}` });
}

// Avisa o n8n. Se o n8n respondeu 2xx, o workflow começou a rodar (ele responde na hora e termina depois).
async function acionar(itemId) {
  const { url, token } = configuracao();
  if (!token) {
    throw new ErroIngestao('O token da indexação não está configurado (INGESTAO_TOKEN no .env).', { codigo: 'config' });
  }

  let host;
  try {
    host = new URL(url).host;
  } catch (err) {
    throw new ErroIngestao('O endereço da indexação (INGESTAO_URL) não é uma URL válida.', { codigo: 'config' });
  }

  let resposta;
  try {
    resposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CABECALHO_TOKEN]: token },
      body: JSON.stringify({ item_id: String(itemId) }),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ErroIngestao(`O n8n (${host}) demorou demais para responder.`, { codigo: 'timeout' });
    }
    throw new ErroIngestao(`Não consegui falar com o n8n (${host}). Ele está de pé? Confira com: docker compose ps`, { codigo: 'rede' });
  }

  try {
    await resposta.text(); // descarta o corpo, só para liberar a conexão
  } catch (err) {
    // sem importância
  }

  if (!resposta.ok) throw traduzirErro(resposta.status, host);
}

module.exports = { ErroIngestao, CABECALHO_TOKEN, URL_PADRAO, acionar };
