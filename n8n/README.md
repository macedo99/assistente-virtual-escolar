# Workflows do n8n

Os workflows (o fluxo do bot no Telegram, o RAG e a reindexação da base) ficam versionados em
`n8n/workflows/`, um arquivo `.json` por workflow, para poderem ser revisados e testados como o resto do código.

## Exportar (atualizar os arquivos daqui a partir do n8n)

Na pasta do projeto, com o sistema de pé:

```bash
sh n8n/exportar-workflows.sh
git diff n8n/workflows
```

O script:

- exporta todos os workflows com o próprio n8n (`n8n export:workflow`);
- tira o que não é o workflow: `pinData` (dados de execução fixados, que podem ter mensagens reais de
  professores), `staticData` e campos que mudam a cada salvamento — exportar duas vezes sem mudar nada gera
  os mesmos arquivos;
- nomeia cada arquivo pelo nome do workflow (`RAG - Reindexar item` → `rag-reindexar-item.json`);
- **avisa** (código de saída 3) se encontrar algo com cara de segredo escrito direto num nó: token do
  Telegram, chave de API, `Bearer ...`, senha num campo, URL com usuário e senha. O valor nunca é mostrado.

As **credenciais do n8n não são exportadas**: os arquivos só guardam uma referência (id e nome). Se o script
avisar sobre um segredo, troque o valor por uma credencial no n8n e exporte de novo antes do commit. O teste
`dashboard/test/workflows.test.js` repete essa checagem no CI e reprova o commit se algo escapar.

## Importar (levar os arquivos daqui para um n8n)

```bash
docker compose cp n8n/workflows n8n:/tmp/workflows
docker compose exec n8n n8n import:workflow --separate --input=/tmp/workflows
```

Depois, no n8n, associe as credenciais (Telegram, Postgres, Header Auth da ingestão) a cada nó que pedir.

## Nó “Detecta injeção” (prompt injection)

O bot precisa **dizer** quando uma mensagem é uma tentativa de prompt injection, sem chamar o LLM. O código
fica em `dashboard/sql-n8n/detectar_injecao.js` (o mesmo que os testes e o dashboard usam). No workflow do bot:

1. Logo depois do **Telegram Trigger**, adicione um nó **Code** chamado “Detecta injeção” (modo *Run Once for
   All Items*) e cole tudo o que vem depois da linha `// -----` do arquivo.
2. Depois dele, um nó **IF** com a condição `{{ $json.injecao }}` é verdadeiro:
   - **verdadeiro** → **Telegram: Send Message** com o texto `{{ $json.resposta_injecao }}`, e o nó
     **Gravar mensagem** gravando a mensagem do usuário e esta resposta (`remetente = 'bot'`). O fluxo termina
     aí: o LLM não é chamado.
   - **falso** → segue o fluxo normal (Buscar usuário, RAG etc.).
3. A resposta começa com `⚠️ Possível tentativa de prompt injection`. O dashboard reconhece esse começo e mostra
   em **Métricas → Volume → Tentativas de prompt injection bloqueadas**. Se mudar o texto, mude só o que vem depois.

Confira as regras com `cd dashboard && node scripts/avaliar-injecao.js` (red-team e golden set em `avaliacao/`).
Ao exportar os workflows, o nó entra no repositório como os outros.
