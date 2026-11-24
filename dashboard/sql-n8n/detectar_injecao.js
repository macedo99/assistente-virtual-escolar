// Nó "Detecta injeção" (Code, modo "Run Once for All Items") do workflow do bot no Telegram.
// Fica logo depois do "Telegram Trigger". Se a mensagem parece uma tentativa de prompt injection, o fluxo NÃO
// chama o LLM: um nó IF ({{ $json.injecao }}) manda $json.resposta_injecao pelo Telegram e grava essa resposta
// (remetente 'bot'), e o dashboard conta essas respostas nas Métricas. Passo a passo em n8n/README.md.
//
// Cole no n8n TUDO o que vem depois da linha "// -----". A função detectarInjecao também é usada pelo
// dashboard (src/injecao.js, para conferir textos da base de conhecimento) e pelos testes de red-team e golden
// set (dashboard/test/injecao.test.js), então tudo usa as mesmas regras.
//
// É uma DETECÇÃO POR REGRAS: pega os ataques conhecidos e explícitos (em português e inglês), não todos. Ela é
// uma camada a mais — o prompt do LLM continua precisando tratar texto do usuário e da base como dados.
// -----
const PREFIXO_INJECAO = '⚠️ Possível tentativa de prompt injection';
const RESPOSTA_INJECAO = `${PREFIXO_INJECAO}: sua mensagem pede para eu ignorar minhas instruções, revelar configurações internas, mudar de papel ou expor dados de outras pessoas. Por segurança, não vou seguir esse pedido. Posso ajudar com dúvidas sobre a escola — ou digite /humano para falar com um atendente.`;

const W = '(?:\\s+\\S+){0,5}?'; // até 5 palavras quaisquer no meio

const REGRAS_INJECAO = [
  ['ignorar_instrucoes', new RegExp(`\\b(ignore|ignora|ignorar|ignorem|esqueca|esquece|esquecer|esquecam|desconsidere|desconsidera|desconsiderar|despreze|descarte|abandone|nao siga|pare de seguir|disregard|forget|override)${W}\\s+(instrucoes|instrucao|regras|ordens|orientacoes|diretrizes|comandos|prompt|restricoes|instructions|rules|guidelines|directives)\\b`)],
  ['ignorar_instrucoes', /\b(ignore|ignora|esqueca|esquece|desconsidere|desconsidera|despreze|forget)\s+(tudo\s+)?(o\s+)?(que|everything)\s+(te\s+|lhe\s+|you\s+)?(\S+\s+)?(mandaram|disseram|passaram|ensinaram|falaram|pediram|programaram|configuraram|orientaram|were told)\b/],
  ['ignorar_instrucoes', /\b(voce nao precisa mais|voce nao tem mais que|you no longer need to)\s+(\S+\s+)?(obedecer|seguir|respeitar|cumprir|follow|obey)\b|\bvoce (e|esta) livre (agora|de regras|das regras)\b/],
  ['ignorar_instrucoes', /\b(novas?|atualizadas?)\s+(regras|instrucoes|ordens|ordem|diretrizes)\s+(\S+\s+){0,2}?(voce|a partir de agora)\b/],
  ['revelar_prompt', /\b(system prompt|prompt (de|do) sistema|mensagem (de|do) sistema|instrucoes (do sistema|iniciais|originais|internas|ocultas|secretas)|initial instructions|system message|hidden instructions)\b/],
  ['revelar_prompt', /\b(comeco|inicio) da (nossa )?conversa\b|\bantes da (minha )?primeira mensagem\b|\b(quem|que) te (programou|configurou)\b|\b(orientacoes|instrucoes|regras|diretrizes) (que )?voce recebeu\b|\bo que voce recebeu antes\b/],
  ['revelar_prompt', new RegExp(`\\b(mostre|mostra|mostrar|revele|revela|revelar|imprima|imprime|exiba|exibe|repita|repete|copie|diga|conte|traduza|resuma|reescreva|transcreva|liste|explique|qual e|quais sao|me (de|da|passe|passa|envie|mande|manda)|print|show|reveal|repeat|translate|summarize|tell me|what is|what are)${W}\\s+(seu|sua|suas|seus|your)\\s+(prompt|instrucoes|orientacoes|diretrizes|regras internas|configuracao|configuracoes|instructions)\\b`)],
  ['mudar_papel', /\b(finja|finge|fingir|faca de conta|imagine que voce e|aja como|atue como|comporte se como|a partir de agora voce|de agora em diante voce|voce agora e|voce nao e mais|you are now|act as|pretend|roleplay|role play)\b/],
  ['mudar_papel', /\b(responda|responde|fale|escreva|aja|atue)\s+(\S+\s+)?como se (voce )?(fosse|fossem|estivesse)\b|\bcomo se voce fosse\b/],
  ['modo_sem_restricoes', /\b(modo|mode)\s+(desenvolvedor|developer|dev|deus|god|admin|administrador|irrestrito|sem restricoes|sem filtro|jailbreak|debug)\b|\b(developer|god|debug|admin|jailbreak|dan)\s+mode\b|\b(jailbreak|do anything now)\b/],
  ['modo_sem_restricoes', /\b(responda|responde|responder|fale|aja|funcione|assistente|ia|bot|answer|respond|ai|assistant)\s+(\S+\s+){0,2}?(sem (nenhuma |qualquer )?(restricao|restricoes|filtro|filtros|censura|limites)|without (any )?(restrictions|filters|limits|censorship))\b/],
  ['extrair_dados', /\b(senhas|tokens|cpfs|telefones|celulares|emails|e mails|enderecos|dados pessoais|chat ids|contatos)\s+(de\s+)?(dos|das|de todos os|de todas as|de cada|de todos|de todas)\s+(\S+\s+)?(professores|professoras|alunos|alunas|estudantes|usuarios|pais|responsaveis|gestores|atendentes|funcionarios|servidores)\b/],
  ['extrair_dados', /\b(senha|senhas|token|tokens|chave|credencial|credenciais)\s+(do|da|de)\s+(banco de dados|bot|telegram|api|servidor|n8n|ollama|dashboard|postgres)\b/],
  // Só em DOCUMENTOS da base (injeção indireta): numa conversa, "Assistente, me diga..." é uma pergunta normal.
  ['instrucao_escondida', /\b(assistente|bot|chatbot|ia|modelo|assistant|ai)\s+(diga|responda|informe|afirme|ignore|nao mencione|nao diga|nao responda|say|answer|tell)\b/, 'documento'],
  ['instrucao_escondida', /\b(quando|se)\s+(alguem|o usuario|um usuario|perguntarem|te perguntarem|voce for perguntado|for perguntado|someone|the user)\b.{0,80}?\b(diga|responda|afirme|informe que|say|answer|tell them)\b/, 'documento'],
];

// Marcações que imitam mensagens do sistema ou do próprio modelo (vale no texto original, com símbolos).
const REGRAS_MARCACAO = [
  /<\|?\s*(im_start|im_end|system|endoftext|eot_id|start_header_id)\s*\|?>/i,
  /^\s*(#{1,3}\s*)?\[?(system|developer)\]?\s*:/im,   // "SYSTEM:", "### system:" (papéis em inglês)
  /^\s*#{1,3}\s*\[?(sistema|assistente)\]?\s*:/im,           // "### Sistema:"
  /^\s*(\[(SISTEMA|ASSISTENTE)\]|SISTEMA|ASSISTENTE)\s*:/m,   // "SISTEMA:" em maiúsculas (não "Sistema: o portal caiu?")
  /\[\/?(system|sistema|inst|instrucoes)\]/i,
  /<\/?\s*(system|sistema|contexto|context|instrucoes|instructions)\s*>/i,
];

// Minúsculas, sem acentos, só letras/números/espaço — para "Ignore AS instruções!!!" e "ignore as instrucoes" serem iguais.
// Letras soltas ("i g n o r e") são juntadas, para o espaçamento não esconder a palavra.
function normalizarParaDeteccao(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:[a-z] ){3,}[a-z]\b/g, (letras) => letras.replace(/ /g, ''))
    .trim();
}

// Devolve { injecao, motivos: [...], trechos: [...] } — trechos são os pedaços (normalizados) que dispararam.
// origem: 'mensagem' (o que o usuário escreveu no Telegram) ou 'documento' (texto da base de conhecimento).
function detectarInjecao(texto, { origem = 'mensagem' } = {}) {
  const original = String(texto || '');
  const t = normalizarParaDeteccao(original);
  const motivos = [];
  const trechos = [];
  for (const [motivo, regra, escopo] of REGRAS_INJECAO) {
    if (escopo && escopo !== origem) continue;
    const achado = regra.exec(t);
    if (achado) {
      if (!motivos.includes(motivo)) motivos.push(motivo);
      if (trechos.length < 3) trechos.push(achado[0].slice(0, 120));
    }
  }
  for (const regra of REGRAS_MARCACAO) {
    const achado = regra.exec(original);
    if (achado) {
      if (!motivos.includes('marcacao_falsa')) motivos.push('marcacao_falsa');
      if (trechos.length < 3) trechos.push(achado[0].trim().slice(0, 120));
    }
  }
  return { injecao: motivos.length > 0, motivos, trechos };
}
// ----- fim da detecção (daqui para baixo, só o que o nó do n8n precisa)

const entrada = $input.first().json;
const textoRecebido = String((entrada.message && entrada.message.text) || entrada.texto || '');
const resultado = detectarInjecao(textoRecebido);

return [{
  json: {
    ...entrada,
    injecao: resultado.injecao,
    motivos_injecao: resultado.motivos,
    resposta_injecao: resultado.injecao ? RESPOSTA_INJECAO : null,
  },
}];
