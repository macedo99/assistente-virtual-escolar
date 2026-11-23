// Envio de mensagens pelo bot do Telegram, direto na API oficial (método sendMessage):
// https://core.telegram.org/bots/api#sendmessage

const TEMPO_LIMITE_MS = 10000;

class ErroTelegram extends Error {
  constructor(mensagem, { codigo = 'api', detalhe = '' } = {}) {
    super(mensagem);
    this.name = 'ErroTelegram';
    // 'config' | 'rede' | 'timeout' | 'token' | 'bloqueado' | 'chat_inexistente' | 'limite' | 'texto_longo' | 'api'
    this.codigo = codigo;
    this.detalhe = detalhe; // texto original do Telegram (em inglês), útil para diagnóstico nos logs
  }
}

// Lido a cada chamada (e não uma vez só ao carregar o arquivo) para o valor do .env valer sempre.
// TELEGRAM_API_URL existe só para os testes automáticos apontarem para um Telegram de mentira.
function configuracao() {
  return {
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    base: (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, ''),
  };
}

function traduzirErro(status, dados) {
  const detalhe = String((dados && dados.description) || '');
  const d = detalhe.toLowerCase();

  if (status === 401 || status === 404) {
    return new ErroTelegram('O Telegram não reconheceu o token do bot. Confira o TELEGRAM_BOT_TOKEN no .env.', { codigo: 'token', detalhe });
  }
  if (status === 403) {
    return new ErroTelegram('O usuário bloqueou o bot (ou apagou a conta), então não dá para enviar mensagem.', { codigo: 'bloqueado', detalhe });
  }
  if (status === 429) {
    const espera = dados && dados.parameters && dados.parameters.retry_after;
    return new ErroTelegram(`O Telegram pediu para esperar${espera ? ` ${espera} s` : ' um pouco'} antes de enviar de novo.`, { codigo: 'limite', detalhe });
  }
  if (status === 400 && d.includes('chat not found')) {
    return new ErroTelegram('O Telegram não encontrou esse chat (o usuário pode ter apagado a conversa com o bot).', { codigo: 'chat_inexistente', detalhe });
  }
  if (status === 400 && d.includes('too long')) {
    return new ErroTelegram('A mensagem é grande demais para o Telegram. Divida em duas.', { codigo: 'texto_longo', detalhe });
  }
  return new ErroTelegram(`O Telegram recusou a mensagem${detalhe ? ` (${detalhe})` : ` (erro ${status})`}.`, { codigo: 'api', detalhe });
}

async function chamar(metodo, corpo) {
  const { token, base } = configuracao();
  if (!token) {
    throw new ErroTelegram('O token do bot não está configurado (TELEGRAM_BOT_TOKEN no .env).', { codigo: 'config' });
  }

  let resposta;
  try {
    resposta = await fetch(`${base}/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo || {}),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ErroTelegram('O Telegram demorou demais para responder. Tente de novo.', { codigo: 'timeout' });
    }
    throw new ErroTelegram('Não consegui falar com o Telegram (o servidor está sem internet ou o Telegram está fora do ar).', { codigo: 'rede' });
  }

  let dados = null;
  try {
    dados = await resposta.json();
  } catch (err) {
    // corpo que não é JSON (ex.: página de erro de um proxy) — cai no erro genérico abaixo
  }

  if (resposta.ok && dados && dados.ok === true) return dados.result;
  throw traduzirErro(resposta.status, dados);
}

// Envia texto puro (sem parse_mode, de propósito: o que o atendente digita nunca é interpretado como
// formatação, então "_" ou "*" no texto não quebram o envio).
function enviarMensagem(chatId, texto) {
  return chamar('sendMessage', { chat_id: chatId, text: texto });
}

// Pergunta ao Telegram "quem é o dono deste token?" — não envia nada para ninguém.
function obterBot() {
  return chamar('getMe');
}

module.exports = { ErroTelegram, enviarMensagem, obterBot };
