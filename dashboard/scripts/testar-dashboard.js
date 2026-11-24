// Teste automático ("de fumaça") do dashboard: faz requisições HTTP de verdade e confere as respostas.
// NÃO altera nada no banco — só faz login/logout (as sessões ficam na memória do servidor). As ações do
// atendimento (assumir, enviar...) são testadas só no sentido "tem que ser RECUSADA": nenhuma é executada.
//
// Rode DENTRO do container do dashboard, com o e-mail e a senha de um atendente que você já criou:
//
//   docker compose exec dashboard node scripts/testar-dashboard.js "seu@email.com" "SuaSenha"
//
// Passos 8b e 8c: se o primeiro atendente for administrador, o teste também confere a base de conhecimento e as
// métricas. Para
// conferir que um atendente COMUM é barrado, passe o e-mail e a senha dele como 3º e 4º argumentos:
//
//   docker compose exec dashboard node scripts/testar-dashboard.js "admin@email.com" "SenhaAdmin" "comum@email.com" "SenhaComum"
//
// Sai com código 0 se tudo passou e 1 se alguma verificação falhou.

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
const MSG_ERRO = 'E-mail ou senha inválidos.';

const [email, senha, emailComum, senhaComum] = process.argv.slice(2);
if (!email || !senha) {
  console.error('Uso: node scripts/testar-dashboard.js "email@exemplo.com" "Senha" ["comum@exemplo.com" "SenhaDoComum"]');
  process.exit(1);
}

async function pedir(metodo, caminho, { cookie, form } = {}) {
  const resp = await fetch(BASE + caminho, {
    method: metodo,
    redirect: 'manual', // queremos ver o redirecionamento (302), não segui-lo
    headers: cookie ? { Cookie: cookie } : {},
    body: form ? new URLSearchParams(form) : undefined,
  });
  return {
    status: resp.status,
    headers: resp.headers,
    texto: await resp.text(),
    local: resp.headers.get('location'),
    cookies: resp.headers.getSetCookie(),
  };
}

function exigir(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

const comoJson = (texto, oQue) => {
  try {
    return JSON.parse(texto);
  } catch {
    throw new Error(`${oQue} deveria vir em JSON, mas veio: ${texto.slice(0, 80)}`);
  }
};

const estado = {}; // guarda o cookie de sessão e o id de uma conversa entre as verificações

// Verificações que precisam estar logadas são puladas (e não reprovadas) se o login correto falhou:
// assim a saída mostra só a causa (a verificação 06), sem uma cascata de falhas.
const PULA_SEM_LOGIN = 'pulado: depende do login correto (verificação 06), que falhou';

const verificacoes = [
  ['A tela de login abre', async () => {
    const r = await pedir('GET', '/login');
    exigir(r.status === 200, `esperava status 200, veio ${r.status}`);
    exigir(r.texto.includes('Dashboard de Atendimento'), 'a página não tem o título "Dashboard de Atendimento"');
  }],

  ['Cabeçalhos de segurança: CSP com nonce, sem iframe de outros sites, sem X-Powered-By', async () => {
    const r = await pedir('GET', '/login');
    const csp = r.headers.get('content-security-policy') || '';
    exigir(/default-src 'self'/.test(csp), `CSP ausente ou sem default-src 'self': "${csp}"`);
    exigir(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/.test(csp), 'a CSP deveria liberar só scripts do próprio site e com nonce');
    exigir(/frame-ancestors 'none'/.test(csp), "a CSP deveria ter frame-ancestors 'none' (impede abrir o dashboard dentro de outro site)");
    exigir(r.headers.get('x-content-type-options') === 'nosniff', 'falta X-Content-Type-Options: nosniff');
    exigir(!r.headers.get('x-powered-by'), 'o servidor não deveria anunciar X-Powered-By');
  }],

  ['Sem login, a lista (/) manda para /login', async () => {
    const r = await pedir('GET', '/');
    exigir(r.status === 302 && r.local === '/login', `esperava 302 → /login, veio ${r.status} → ${r.local}`);
  }],

  ['Sem login, a API responde 401 em JSON (não uma página HTML)', async () => {
    const r = await pedir('GET', '/api/conversas/1/mensagens');
    exigir(r.status === 401, `esperava status 401, veio ${r.status}`);
    exigir(comoJson(r.texto, 'a resposta da API').erro, 'o JSON não tem o campo "erro"');
  }],

  ['Senha errada → 401 com mensagem genérica', async () => {
    const r = await pedir('POST', '/login', { form: { email, senha: senha + '-errada' } });
    exigir(r.status === 401, `esperava status 401, veio ${r.status}`);
    exigir(r.texto.includes(MSG_ERRO), `a mensagem "${MSG_ERRO}" não apareceu`);
  }],

  ['E-mail que não existe → a MESMA mensagem (não revela quem está cadastrado)', async () => {
    const r = await pedir('POST', '/login', { form: { email: `nao-existe-${Date.now()}@exemplo.com`, senha } });
    exigir(r.status === 401, `esperava status 401, veio ${r.status}`);
    exigir(r.texto.includes(MSG_ERRO), `a mensagem "${MSG_ERRO}" não apareceu`);
  }],

  ['Login correto → vai para / com cookie de sessão HttpOnly e SameSite=Lax', async () => {
    const r = await pedir('POST', '/login', { form: { email, senha } });
    exigir(r.status === 302 && r.local === '/', `esperava 302 → /, veio ${r.status} → ${r.local}. Confira o e-mail/senha e se o atendente está ativo.`);
    const cookie = r.cookies.find((c) => c.startsWith('connect.sid='));
    exigir(cookie, 'o servidor não mandou o cookie de sessão (connect.sid)');
    exigir(/HttpOnly/i.test(cookie), 'o cookie não é HttpOnly');
    exigir(/SameSite=Lax/i.test(cookie), 'o cookie não tem SameSite=Lax');
    estado.cookie = cookie.split(';')[0];
  }],

  ['O login ignora maiúsculas/minúsculas no e-mail', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    const r = await pedir('POST', '/login', { form: { email: email.toUpperCase(), senha } });
    exigir(r.status === 302 && r.local === '/', `esperava 302 → /, veio ${r.status} → ${r.local}`);
  }],

  ['Logado, a lista de conversas abre', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    const r = await pedir('GET', '/', { cookie: estado.cookie });
    exigir(r.status === 200, `esperava status 200, veio ${r.status}`);
    exigir(r.texto.includes('<h1>Conversas</h1>'), 'a página não é a lista de conversas');
    const achou = /href="\/conversas\/(\d+)"/.exec(r.texto);
    if (achou) estado.conversaId = achou[1];
    estado.admin = r.texto.includes('href="/base"'); // o link da base de conhecimento só aparece para administradores
  }],

  ['Páginas e API não ficam em cache (Cache-Control: no-store)', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    const r = await pedir('GET', '/', { cookie: estado.cookie });
    exigir(r.headers.get('cache-control') === 'no-store', `Cache-Control veio "${r.headers.get('cache-control')}"`);
  }],

  ['Sem login, as ações do atendimento são recusadas (nada é executado)', async () => {
    const a = await pedir('POST', '/conversas/1/assumir', { form: { _csrf: 'x' } });
    exigir(a.status === 302 && a.local === '/login', `assumir sem login: esperava 302 → /login, veio ${a.status} → ${a.local}`);
    const b = await pedir('POST', '/api/conversas/1/mensagens', { form: { _csrf: 'x', texto: 'oi' } });
    exigir(b.status === 401, `enviar mensagem sem login: esperava 401, veio ${b.status}`);
    exigir(comoJson(b.texto, 'a resposta da API').erro, 'o JSON não tem o campo "erro"');
  }],

  ['Logado, mas SEM o token de segurança (CSRF), as ações são recusadas com 403', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    // O token é conferido antes de qualquer coisa: o id da conversa nem chega a ser consultado.
    for (const caminho of ['/conversas/1/assumir', '/conversas/1/devolver', '/conversas/1/encerrar']) {
      const r = await pedir('POST', caminho, { cookie: estado.cookie });
      exigir(r.status === 403, `POST ${caminho} sem token: esperava 403, veio ${r.status}`);
    }
    const envio = await pedir('POST', '/api/conversas/1/mensagens', { cookie: estado.cookie, form: { texto: 'não deve ser enviada' } });
    exigir(envio.status === 403, `enviar mensagem sem token: esperava 403, veio ${envio.status}`);
    exigir(comoJson(envio.texto, 'a resposta da API').erro, 'o JSON não tem o campo "erro"');
    const errado = await pedir('POST', '/conversas/1/assumir', { cookie: estado.cookie, form: { _csrf: 'token-errado' } });
    exigir(errado.status === 403, `token errado: esperava 403, veio ${errado.status}`);
  }],

  ['Conversa que não existe ou id inválido → 404 (nunca erro 500)', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    for (const id of ['999999999999', 'abc', '99999999999999999999']) {
      const r = await pedir('GET', `/conversas/${id}`, { cookie: estado.cookie });
      exigir(r.status === 404, `/conversas/${id}: esperava 404, veio ${r.status}`);
    }
  }],

  ['API com id inválido → 404 em JSON', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    const r = await pedir('GET', '/api/conversas/abc/mensagens', { cookie: estado.cookie });
    exigir(r.status === 404, `esperava status 404, veio ${r.status}`);
    comoJson(r.texto, 'a resposta da API');
  }],

  ['Abrir uma conversa existente e consultar as mensagens dela', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    if (!estado.conversaId) return 'pulado: não há nenhuma conversa ativa na lista (mande uma mensagem pelo Telegram e rode de novo)';
    const pagina = await pedir('GET', `/conversas/${estado.conversaId}`, { cookie: estado.cookie });
    exigir(pagina.status === 200, `/conversas/${estado.conversaId}: esperava 200, veio ${pagina.status}`);
    const api = await pedir('GET', `/api/conversas/${estado.conversaId}/mensagens?desde=0`, { cookie: estado.cookie });
    exigir(api.status === 200, `a API da conversa ${estado.conversaId}: esperava 200, veio ${api.status}`);
    const dados = comoJson(api.texto, 'a resposta da API');
    exigir(Array.isArray(dados.mensagens), 'a API deveria devolver { estado, mensagens } com a lista de mensagens');
    exigir(typeof dados.estado === 'string' && dados.estado.length > 0, 'a API deveria informar o "estado" da conversa');
  }],

  // ---------- Passo 8b: base de conhecimento ----------

  ['Sem login, a base de conhecimento é recusada (página → /login, API → 401 em JSON)', async () => {
    const pagina = await pedir('GET', '/base');
    exigir(pagina.status === 302 && pagina.local === '/login', `/base sem login: esperava 302 → /login, veio ${pagina.status} → ${pagina.local}`);
    const api = await pedir('GET', '/api/base/status');
    exigir(api.status === 401, `/api/base/status sem login: esperava 401, veio ${api.status}`);
    exigir(comoJson(api.texto, 'a resposta da API').erro, 'o JSON não tem o campo "erro"');
    const excluir = await pedir('POST', '/base/1/excluir', { form: { _csrf: 'x' } });
    exigir(excluir.status === 302 && excluir.local === '/login', `excluir sem login: esperava 302 → /login, veio ${excluir.status} → ${excluir.local}`);
  }],

  ['Logado, mas SEM o token de segurança (CSRF), as ações da base são recusadas com 403', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    for (const caminho of ['/base', '/base/1', '/base/1/reindexar', '/base/1/excluir']) {
      const r = await pedir('POST', caminho, { cookie: estado.cookie });
      exigir(r.status === 403, `POST ${caminho} sem token: esperava 403, veio ${r.status}`);
    }
  }],

  ['Administrador: a base de conhecimento abre e a API de status responde', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    if (!estado.admin) return 'pulado: o primeiro atendente informado não é administrador (o link "Base de conhecimento" não aparece para ele)';
    const pagina = await pedir('GET', '/base', { cookie: estado.cookie });
    exigir(pagina.status === 200, `/base: esperava 200, veio ${pagina.status}`);
    exigir(pagina.texto.includes('<h1>Base de conhecimento</h1>'), 'a página não é a lista da base de conhecimento');
    const novo = await pedir('GET', '/base/novo', { cookie: estado.cookie });
    exigir(novo.status === 200 && novo.texto.includes('Novo item da base'), `/base/novo: esperava a tela do formulário (200), veio ${novo.status}`);
    const api = await pedir('GET', '/api/base/status', { cookie: estado.cookie });
    exigir(api.status === 200, `/api/base/status: esperava 200, veio ${api.status}`);
    const dados = comoJson(api.texto, 'a resposta da API');
    exigir(dados.ok === true && Array.isArray(dados.itens), 'a API deveria devolver { ok: true, itens: [...] }');
    exigir(dados.contagem && typeof dados.contagem.indexado === 'number', 'a API deveria devolver os contadores (contagem)');
  }],

  ['Administrador: item da base que não existe ou id inválido → 404 (nunca erro 500)', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    if (!estado.admin) return 'pulado: o primeiro atendente informado não é administrador';
    for (const id of ['999999999999', 'abc', '99999999999999999999']) {
      const r = await pedir('GET', `/base/${id}/editar`, { cookie: estado.cookie });
      exigir(r.status === 404, `/base/${id}/editar: esperava 404, veio ${r.status}`);
    }
  }],

  // ---------- Passo 8c: métricas ----------

  ['Sem login, as métricas e os CSVs são recusados (mandam para /login)', async () => {
    for (const caminho of ['/metricas', '/metricas/exportar.csv?tipo=resumo']) {
      const r = await pedir('GET', caminho);
      exigir(r.status === 302 && r.local === '/login', `${caminho} sem login: esperava 302 → /login, veio ${r.status} → ${r.local}`);
    }
  }],

  ['Administrador: as métricas abrem, o período inválido não quebra e o CSV sai no formato certo', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    if (!estado.admin) return 'pulado: o primeiro atendente informado não é administrador (o link "Métricas" não aparece para ele)';

    const tela = await pedir('GET', '/metricas', { cookie: estado.cookie });
    exigir(tela.status === 200, `/metricas: esperava 200, veio ${tela.status}`);
    exigir(tela.texto.includes('<h1>Métricas</h1>') && tela.texto.includes('Perguntas sem resposta'), 'a página não é a tela de métricas');

    const invalido = await pedir('GET', '/metricas?de=lixo&ate=2026-01-01', { cookie: estado.cookie });
    exigir(invalido.status === 200 && invalido.texto.includes('Mostrando os últimos 30 dias'), `período inválido: esperava a tela com aviso (200), veio ${invalido.status}`);

    const csv = await pedir('GET', '/metricas/exportar.csv?tipo=resumo', { cookie: estado.cookie });
    exigir(csv.status === 200, `CSV de resumo: esperava 200, veio ${csv.status}`);
    exigir((csv.headers.get('content-type') || '').startsWith('text/csv'), `CSV: Content-Type deveria ser text/csv (veio ${csv.headers.get('content-type')})`);
    exigir(/^attachment; filename="metricas-resumo-\d{4}-\d{2}-\d{2}_a_\d{4}-\d{2}-\d{2}\.csv"$/.test(csv.headers.get('content-disposition') || ''), `CSV: Content-Disposition inesperado: ${csv.headers.get('content-disposition')}`);
    // O fetch() descarta o BOM ao converter para texto: para conferi-lo, olhamos os bytes (EF BB BF).
    const bruto = new Uint8Array(await (await fetch(`${BASE}/metricas/exportar.csv?tipo=resumo`, { headers: { Cookie: estado.cookie } })).arrayBuffer());
    exigir(bruto[0] === 0xef && bruto[1] === 0xbb && bruto[2] === 0xbf, 'o CSV deveria começar com o BOM UTF-8 (bytes EF BB BF), para o Excel reconhecer os acentos');
    exigir(csv.texto.includes('Relatório de métricas do atendimento'), 'o CSV deveria ter o título do relatório na primeira linha');

    const ruim = await pedir('GET', '/metricas/exportar.csv?tipo=tudo', { cookie: estado.cookie });
    exigir(ruim.status === 400, `CSV com tipo inválido: esperava 400, veio ${ruim.status}`);
    const periodoRuim = await pedir('GET', '/metricas/exportar.csv?tipo=resumo&de=2026-02-01&ate=2026-01-01', { cookie: estado.cookie });
    exigir(periodoRuim.status === 400, `CSV com período invertido: esperava 400, veio ${periodoRuim.status}`);

    const cadastro = await pedir('GET', '/base/novo?titulo=Pergunta%20de%20teste', { cookie: estado.cookie });
    exigir(cadastro.status === 200 && cadastro.texto.includes('value="Pergunta de teste"'), 'o link "Cadastrar na base" deveria pré-preencher o título');
  }],

  // ---------- Passo 9: usuários do bot (papel de gestor dado por administrador) ----------

  ['Usuários do bot: sem login vai para /login; sem token (CSRF) a troca de papel é recusada', async () => {
    const pagina = await pedir('GET', '/usuarios');
    exigir(pagina.status === 302 && pagina.local === '/login', `/usuarios sem login: esperava 302 → /login, veio ${pagina.status} → ${pagina.local}`);
    if (!estado.cookie) return PULA_SEM_LOGIN;
    const semToken = await pedir('POST', '/usuarios/1/papel', { cookie: estado.cookie, form: { papel: 'gestor' } });
    exigir(semToken.status === 403, `POST /usuarios/1/papel sem token: esperava 403, veio ${semToken.status}`);
  }],

  ['Administrador: a tela de usuários do bot abre', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    if (!estado.admin) return 'pulado: o primeiro atendente informado não é administrador';
    const pagina = await pedir('GET', '/usuarios', { cookie: estado.cookie });
    exigir(pagina.status === 200 && pagina.texto.includes('<h1>Usuários do bot</h1>'), `/usuarios: esperava a tela de usuários (200), veio ${pagina.status}`);
  }],

  ['Atendente comum NÃO acessa a base, as métricas nem os usuários do bot (403) e não vê os links', async () => {
    if (!emailComum || !senhaComum) return 'pulado: passe o e-mail e a senha de um atendente comum (não admin) como 3º e 4º argumentos';
    const entrada = await pedir('POST', '/login', { form: { email: emailComum, senha: senhaComum } });
    exigir(entrada.status === 302 && entrada.local === '/', `login do atendente comum: esperava 302 → /, veio ${entrada.status}. Confira o e-mail/senha e se ele está ativo.`);
    const cookie = entrada.cookies.find((c) => c.startsWith('connect.sid=')).split(';')[0];

    const lista = await pedir('GET', '/', { cookie });
    exigir(lista.status === 200, `a lista de conversas deveria abrir para o atendente comum (veio ${lista.status})`);
    exigir(!lista.texto.includes('href="/base"'), 'o atendente informado vê o link da base: ele é administrador? Use um atendente comum.');
    const pagina = await pedir('GET', '/base', { cookie });
    exigir(pagina.status === 403, `/base como atendente comum: esperava 403, veio ${pagina.status}`);
    const api = await pedir('GET', '/api/base/status', { cookie });
    exigir(api.status === 403, `/api/base/status como atendente comum: esperava 403, veio ${api.status}`);
    exigir(comoJson(api.texto, 'a resposta da API').erro, 'o JSON não tem o campo "erro"');

    exigir(!lista.texto.includes('href="/metricas"'), 'o atendente informado vê o link das métricas: ele é administrador? Use um atendente comum.');
    exigir(!lista.texto.includes('href="/usuarios"'), 'o atendente informado vê o link dos usuários do bot: ele é administrador? Use um atendente comum.');
    for (const caminho of ['/metricas', '/metricas/exportar.csv?tipo=resumo', '/usuarios']) {
      const r = await pedir('GET', caminho, { cookie });
      exigir(r.status === 403, `${caminho} como atendente comum: esperava 403, veio ${r.status}`);
    }

    await pedir('POST', '/logout', { cookie });
  }],

  ['Sair (logout) encerra a sessão', async () => {
    if (!estado.cookie) return PULA_SEM_LOGIN;
    const saida = await pedir('POST', '/logout', { cookie: estado.cookie });
    exigir(saida.status === 302 && saida.local === '/login', `esperava 302 → /login, veio ${saida.status} → ${saida.local}`);
    const depois = await pedir('GET', '/', { cookie: estado.cookie });
    exigir(depois.status === 302 && depois.local === '/login', `depois do logout a lista ainda abriu (status ${depois.status})`);
  }],
];

async function main() {
  console.log(`Testando o dashboard em ${BASE} ...\n`);
  let passaram = 0;
  let puladas = 0;
  let falharam = 0;

  for (const [indice, [nome, funcao]] of verificacoes.entries()) {
    const numero = String(indice + 1).padStart(2, '0');
    try {
      const resultado = await funcao();
      if (typeof resultado === 'string') {
        puladas += 1;
        console.log(`  –  ${numero} ${nome}\n         (${resultado})`);
      } else {
        passaram += 1;
        console.log(`  ✔  ${numero} ${nome}`);
      }
    } catch (err) {
      if (err.cause && err.cause.code === 'ECONNREFUSED') {
        console.error(`\nNão consegui falar com o dashboard em ${BASE}.`);
        console.error('Ele está de pé? Confira com: docker compose ps   e   docker compose logs dashboard');
        process.exit(1);
      }
      falharam += 1;
      console.log(`  ✘  ${numero} ${nome}\n         → ${err.message}`);
    }
  }

  const total = verificacoes.length - puladas;
  console.log(`\nResultado: ${passaram}/${total} verificações passaram` + (puladas ? ` (${puladas} pulada${puladas > 1 ? 's' : ''})` : '') + '.');
  process.exit(falharam === 0 ? 0 : 1);
}

main();
