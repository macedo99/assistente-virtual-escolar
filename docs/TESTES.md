# Testes

Há três camadas. As duas primeiras rodam sozinhas no GitHub (`.github/workflows/ci.yml`) a cada push na
`main` e em cada pull request; a terceira é o que você roda no servidor depois de subir uma versão nova.

| Camada | O que confere | Precisa de banco? | Comando (na pasta `dashboard/`) |
|---|---|---|---|
| Unidade | Regras e funções isoladas: validação da base, permissões do atendimento, métricas, CSRF, datas, PDF, limite de login, configuração de segurança, versões fixas | Não | `npm test` |
| Integração | Schema + migrações, regras do banco (gatilhos, conversa ativa única), base de conhecimento e métricas com dados controlados | Sim (Postgres de teste; tudo em transação desfeita no final) | `node scripts/verificar-banco.js`, `verificar-base.js`, `verificar-metricas.js` |
| Fumaça (ponta a ponta) | O dashboard de pé, por HTTP: login, sessão, CSRF, permissões de admin e de atendente, cabeçalhos de segurança | Sim | `node scripts/testar-dashboard.js "admin@..." "senha" "atendente@..." "senha"` |

Fora do CI (dependem de serviços reais): `scripts/verificar-n8n.js` (webhook e embeddings do n8n/Ollama) e
`scripts/verificar-telegram.js` (token do bot).

## O que o CI faz

**Testes do dashboard**: `npm ci` → `npm test` → `npm run build:css` → cria um Postgres com pgvector (mesma
versão do `docker-compose.yml`), aplica `schema.sql` e as migrações → roda os três `verificar-*` → cria dois
atendentes e uma conversa de exemplo → sobe o dashboard e roda o teste de fumaça. Se algo falhar, o log do
dashboard aparece no fim.

**Imagem Docker e docker-compose**: valida o `docker-compose.yml`, constrói a imagem do dashboard e confere
que ela se recusa a subir sem `SESSION_SECRET`.

As actions usadas (`actions/checkout`, `actions/setup-node`) estão fixadas pelo commit, não só pela tag.

## Rodar tudo localmente (sem mexer no banco de verdade)

```bash
docker run -d --rm --name pg-teste -e POSTGRES_USER=ci -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=chatbot \
  -p 127.0.0.1:55433:5432 pgvector/pgvector:0.8.7-pg17

cd dashboard
export DB_HOST=127.0.0.1 DB_PORT=55433 DB_NAME=chatbot DB_USER=ci DB_PASSWORD=ci PGPASSWORD=ci
npm ci && npm test && npm run build:css
psql -h 127.0.0.1 -p 55433 -U ci -d chatbot -c "CREATE EXTENSION IF NOT EXISTS vector" -f ../schema.sql
node scripts/aplicar-migracao.js
node scripts/verificar-banco.js && node scripts/verificar-base.js && node scripts/verificar-metricas.js

# quando terminar:
docker stop pg-teste
```

Para o teste de fumaça, crie dois atendentes com `scripts/criar-atendente.js`, suba o dashboard com
`SESSION_SECRET="$(openssl rand -hex 32)" node src/server.js` e rode `scripts/testar-dashboard.js` (os passos
exatos estão no `ci.yml`).

## Proteger a `main`

No GitHub: **Settings → Branches → Add rule** para `main`, marcando *Require status checks to pass* com
“Testes do dashboard” e “Imagem Docker e docker-compose”. Assim nada entra na `main` sem passar no CI.
