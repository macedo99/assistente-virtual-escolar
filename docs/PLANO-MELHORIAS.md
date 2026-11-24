# Plano de melhorias (a partir da análise de QA)

Cada etapa é pequena o bastante para ser revisada e testada sozinha. A ordem segue o risco: primeiro o que o
usuário vê e usa todo dia, depois o que fecha brechas de segurança, por fim o que garante qualidade contínua.

| Etapa | Tema | Lacunas da análise que fecha | Situação |
|---|---|---|---|
| 1 | Dashboard: visual novo + importar PDF | Usabilidade; texto entrando na base sem revisão (para PDFs) | **Feita** |
| 2 | Segurança do acesso | Papel decidido por palavra-chave; login sem limite de tentativas; `SESSION_SECRET` padrão; cookie sem `Secure` | A fazer |
| 3 | Builds reproduzíveis | Imagens em `:latest`; sem `package-lock.json` | Parcial (lockfile já existe) |
| 4 | Testes automatizados e CI | Sem testes de unidade; nada roda sozinho em PR | Parcial (`npm test` criado) |
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

## Etapa 2 — Segurança do acesso

1. **Papel do usuário** (achado de severidade alta): no n8n, todo usuário novo entra como `professor`; criar no
   dashboard uma tela **Usuários do bot** em que um administrador promove alguém a `gestor`.
   Atualizar o nó “Inserir usuário” e o `queries_n8n.sql`.
2. **Limite de tentativas de login** (`express-rate-limit`): por exemplo, 10 tentativas por 15 minutos por IP
   e por e-mail, com a mesma mensagem genérica de hoje.
3. **`SESSION_SECRET` obrigatório**: o servidor não sobe sem ele (hoje só avisa e usa um valor padrão).
4. **Cookie `Secure` e `trust proxy`** quando o dashboard for publicado atrás de HTTPS (variável de ambiente,
   para continuar funcionando em `localhost`).
5. **Cabeçalhos de segurança** (CSP, `X-Frame-Options`, `Referrer-Policy`) com `helmet`.
6. Ampliar `scripts/testar-dashboard.js`: bloqueio após muitas tentativas de login; PDF falso recusado.

## Etapa 3 — Builds reproduzíveis

1. Fixar versões das imagens no `docker-compose.yml` (`n8n`, `ollama`, `ngrok`, `pgvector`).
2. `npm ci` no Dockerfile com `package-lock.json` versionado (já feito no dashboard).
3. Registrar no README como atualizar essas versões de propósito (e não por acaso, num restart).

## Etapa 4 — Testes automatizados e CI

1. Testes de unidade com `node:test` para as regras de `base.js` (validação, estados da indexação),
   `metricas.js` (classificação de respostas, agrupamento de lacunas), `csrf.js` e `formato.js`.
2. GitHub Actions em cada PR: `npm ci`, `npm test`, `npm run build:css`, e o teste de fumaça contra um
   Postgres de serviço (com os scripts `verificar-*` que não dependem do n8n).
3. Contrato do embedding: o `schema.sql` cria `VECTOR(1536)`, mas o bge-m3 gera 1024 — alinhar o schema com
   o `ALTER` do Passo 5 (o `verificar-base.js` já confere a coluna).

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
