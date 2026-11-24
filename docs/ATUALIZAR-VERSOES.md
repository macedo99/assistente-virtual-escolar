# Versões das imagens: como conferir e como atualizar

As imagens do `docker-compose.yml` e do `dashboard/Dockerfile` têm **versão fixa**. Antes elas usavam
`:latest`, e qualquer `docker compose pull` (ou uma máquina nova) trazia uma versão diferente sem ninguém
decidir. O teste `dashboard/test/versoes.test.js` (`npm test`) falha se alguma voltar a ficar sem versão.

| Serviço | Imagem | Versão fixa | Variável no `.env` |
|---|---|---|---|
| Banco | `pgvector/pgvector` | `0.8.7-pg17` | `PGVECTOR_VERSION` |
| n8n | `docker.n8n.io/n8nio/n8n` | `2.49.5` | `N8N_VERSION` |
| Túnel | `ngrok/ngrok` | `3.39.13-debian` | `NGROK_VERSION` |
| Modelos | `ollama/ollama` | `0.40.16` | `OLLAMA_VERSION` |
| Dashboard | `node` (no Dockerfile) | `22.23.5-alpine` | `ARG NODE_IMAGE` |

As dependências do dashboard (npm) ficam fixas pelo `package-lock.json` e são instaladas com `npm ci`.

## Antes de subir pela primeira vez com as versões fixas

Se o servidor já roda o sistema com `:latest`, confira as versões que estão lá:

```bash
docker compose images
docker compose exec n8n n8n --version
docker compose exec ollama ollama --version
```

**n8n nunca pode voltar para uma versão mais antiga**: ele migra o próprio banco ao atualizar, e uma versão
anterior não entende o banco migrado. Se o servidor estiver com um n8n mais novo que `2.49.5`, coloque a
versão dele no `.env` (`N8N_VERSION=...`) antes do `docker compose up`.

## Atualizar uma imagem (de propósito)

1. Leia as notas da versão nova (principalmente do n8n: mudanças de nós e de workflows).
2. Faça backup antes de atualizar o n8n ou o Postgres:
   ```bash
   docker compose exec postgres pg_dumpall -U "$POSTGRES_USER" > backup-$(date +%F).sql
   ```
3. Mude a versão no `.env` (só neste servidor) ou no `docker-compose.yml` (para todo mundo, num commit).
4. `docker compose pull <serviço> && docker compose up -d <serviço>`
5. Confira: `docker compose exec dashboard node scripts/verificar-n8n.js` e
   `docker compose exec dashboard node scripts/testar-dashboard.js "admin@..." "senha"`.

Prefira versões publicadas há pelo menos duas semanas: correções urgentes costumam sair logo depois de uma
versão nova.
