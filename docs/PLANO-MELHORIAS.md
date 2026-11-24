# Plano de melhorias (a partir da análise de QA)

Cada etapa é pequena o bastante para ser revisada e testada sozinha. A ordem segue o risco: primeiro o que o
usuário vê e usa todo dia, depois o que fecha brechas de segurança, por fim o que garante qualidade contínua.

| Etapa | Tema | Lacunas da análise que fecha | Situação |
|---|---|---|---|
| 1 | Dashboard: visual novo + importar PDF | Usabilidade; texto entrando na base sem revisão (para PDFs) | **Feita** |
| 2 | Segurança do acesso | Papel decidido por palavra-chave; login sem limite de tentativas; `SESSION_SECRET` padrão; cookie sem `Secure` | **Feita** |
| 3 | Builds reproduzíveis | Imagens em `:latest`; sem `package-lock.json` | **Feita** |
| 4 | Testes automatizados e CI | Sem testes de unidade; nada roda sozinho em PR | **Feita** |
| 5 | Qualidade do LLM / PLN | Sem testes de prompt injection; sem golden set; corte de trechos por caractere | A fazer |
| 6 | PDFs avançados (opcional) | PDFs escaneados; documentos maiores que 50 mil caracteres | A fazer |

---

## Etapa 1 — Dashboard: visual novo e importação de PDF (feita)

- **Tailwind CSS v4** com etapa de build: entrada em `dashboard/src/estilos/app.css`, saída
  `dashboard/src/public/app.css` (gerada, fora do git). O `Dockerfile` gera o CSS numa etapa separada; a
  imagem final não leva as ferramentas de build.
  - Desenvolvimento local: `npm run dev:css` (regera ao salvar) ou `npm run build:css`.
- Partes comuns das telas em `src/views/partials/` (cabeçalho, navegação, recados, ícones).
- Navegação fixa no topo, cartões de resumo, tabelas responsivas, conversa em formato de chat e caixa de
  confirmação própria (no lugar do `window.confirm`), em `src/public/app.js`.
- **Importar PDF** (Base de conhecimento → Novo item): o texto extraído **preenche o formulário para revisão**;
  nada é salvo nem indexado até o administrador clicar em Salvar.
  - Limites: 10 MB, 200 páginas; o arquivo fica só na memória e é conferido pelos bytes (`%PDF-`).
  - Código em `src/pdf.js` e rota `POST /base/importar-pdf` em `src/routes/base.js` (admin + CSRF).
  - Testes: `npm test` (`test/pdf.test.js`).

Como conferir: `docker compose up -d --build dashboard` e depois
`docker compose exec dashboard node scripts/testar-dashboard.js "admin@..." "senha" "atendente@..." "senha"`.

## Etapa 2 — Segurança do acesso (feita)

- **Papel do usuário**: todo cadastro novo pelo Telegram entra como `professor`; o papel de gestor é dado por
  um administrador na nova tela **Usuários** (`/usuarios`). O banco garante a regra com um gatilho
  (`migracoes/002_papel_professor.sql`), mesmo que o n8n ainda mande “gestor”.
  - **Ação manual no n8n**: no nó “Inserir usuário”, troque o 4º parâmetro por `{{ 'professor' }}`
    (já atualizado em `queries_n8n.sql`). Se a mensagem de boas-vindas do bot diz “cadastrado como gestor”,
    ajuste o texto também.
  - Usuários que já eram gestores **não foram alterados**: revise-os na tela Usuários.
- **Limite de tentativas de login** (`src/limites.js`): 8 senhas erradas por e-mail ou 30 por IP em 15 minutos
  bloqueiam novas tentativas (429). Login certo zera a contagem daquele e-mail. A sessão é renovada a cada login.
- **`SESSION_SECRET` obrigatório** (`src/seguranca.js`): o dashboard não sobe sem ele, com o valor de exemplo ou
  com menos de 32 caracteres. Gere com `openssl rand -hex 32`.
- **`COOKIE_SECURE`** (cookie só por HTTPS + HSTS) e **`TRUST_PROXY`** (IP real atrás de proxy) no `.env`;
  ambos desligados por padrão, para funcionar em `http://localhost`.
- **Cabeçalhos de segurança** (`helmet`): CSP com nonce por resposta (só scripts do próprio dashboard rodam),
  `frame-ancestors 'none'`, `nosniff`, sem `X-Powered-By`.
- Testes: `npm test` (limites e configuração) e 3 verificações novas no `scripts/testar-dashboard.js`.

Para aplicar: gerar o `SESSION_SECRET` no `.env`, `docker compose up -d --build dashboard` e
`docker compose exec dashboard node scripts/aplicar-migracao.js`.

## Etapa 3 — Builds reproduzíveis (feita)

- Imagens com versão fixa no `docker-compose.yml` (`pgvector 0.8.7-pg17`, `n8n 2.49.5`, `ngrok 3.39.13-debian`,
  `ollama 0.40.16`), cada uma ajustável pelo `.env` (`N8N_VERSION` etc.); Node fixo no Dockerfile (`22.23.5-alpine`).
- `package-lock.json` versionado e `npm ci` no Dockerfile.
- Teste `test/versoes.test.js`: falha se alguma imagem voltar para `:latest` ou se o Dockerfile usar `npm install`.
- Como conferir a versão em uso e atualizar com segurança: `docs/ATUALIZAR-VERSOES.md`
  (atenção: o n8n não pode voltar para uma versão mais antiga).

## Etapa 4 — Testes automatizados e CI (feita)

- 43 testes de unidade (`npm test`, `node:test`, sem dependência nova): base de conhecimento, permissões do
  atendimento, métricas (datas, períodos, percentil, pareamento da fila, CSV com proteção contra fórmula),
  CSRF, formatação de datas, PDF, limite de login, configuração de segurança e versões fixas.
- GitHub Actions (`.github/workflows/ci.yml`) em cada push na `main` e em cada PR: testes de unidade, build do
  CSS, schema + migrações num Postgres com pgvector, os três `verificar-*`, teste de fumaça com o dashboard de
  pé, build da imagem Docker e validação do `docker-compose.yml`. Actions fixadas pelo commit.
- Contrato do embedding: `schema.sql` agora cria `VECTOR(1024)` (bge-m3), igual ao que o `verificar-base.js` exige.
- Como rodar tudo localmente e proteger a `main`: `docs/TESTES.md`.

## Etapa 5 — Qualidade do LLM e do PLN

1. Exportar os workflows do n8n para o repositório (hoje o prompt e a consulta de busca não estão versionados).
2. Reforçar o prompt: delimitar o texto do usuário e os trechos recuperados; regra explícita de que texto de
   contexto nunca é instrução.
3. **Golden set** (perguntas reais com os fatos esperados) e **red-team set** (injeções diretas e indiretas,
   fora do escopo), rodados a cada mudança de prompt, modelo ou divisão em trechos, medindo taxa de acerto.
4. Divisão em trechos respeitando frases e parágrafos (hoje corta em 800 caracteres fixos).
5. Métricas: agrupar lacunas por similaridade (embeddings), não só por texto igual.

## Etapa 6 — PDFs avançados (opcional)

1. OCR para PDFs escaneados (ex.: Tesseract em português) — hoje esses arquivos são recusados com aviso.
2. PDF maior que 50 mil caracteres: oferecer a divisão automática em vários itens (por capítulo ou por
   número de páginas), cada um revisado antes de salvar.
