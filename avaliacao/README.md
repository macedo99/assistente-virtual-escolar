# Avaliação do bot

Testes de qualidade do que o bot **responde**, diferentes dos testes do código (`docs/TESTES.md`): eles
dependem do modelo, dos dados da base e do prompt, então medem **taxas** (quantas perguntas acertou), não
passa/falha de uma linha só.

| Avaliação | O que mede | Situação |
|---|---|---|
| Busca (`busca.json`) | Para cada pergunta real, o item certo da base aparece entre os primeiros resultados? | Pronta |
| Respostas (golden set completo) | A resposta final traz os fatos certos? | Depende dos workflows do n8n no repositório |
| Red-team (prompt injection) | O bot resiste a pedidos para vazar o prompt, mudar de papel ou seguir ordens escondidas em documentos? | Depende dos workflows do n8n no repositório |

## Avaliação da busca

### 1. Criar o arquivo de perguntas (uma vez)

Com o sistema de pé, gere um modelo com os títulos de todos os itens indexados:

```bash
docker compose exec -T dashboard node scripts/avaliar-busca.js --modelo > avaliacao/busca.json
```

Abra `avaliacao/busca.json` e troque cada `[escreva ...]` por 2 a 4 perguntas **reais**, do jeito que um
professor escreveria no Telegram, de preferência com palavras diferentes das do título (é aí que a busca
semântica mostra se funciona: “Quando começam as férias?” deve achar o item “Calendário escolar”, que fala em
“recesso”). Boas fontes: a lista **Perguntas sem resposta** da tela Métricas e o histórico de conversas.
Perguntas entre `[colchetes]` são ignoradas; itens que você apagar do arquivo não são avaliados.

### 2. Rodar

```bash
docker compose exec -T dashboard node scripts/avaliar-busca.js - < avaliacao/busca.json
```

Saída: cada pergunta com ✔ (item certo em 1º), ~ (entre 2º e 5º) ou ✘ (não veio), o que veio em 1º quando
errou, e o resumo:

- **Acerto@1 / @3 / @5**: em quantas perguntas o item certo veio entre os 1, 3 ou 5 primeiros.
- **MRR**: média de 1/posição (1,0 = sempre em 1º).

`--minimo=0.8` faz o comando sair com erro se o acerto@3 ficar abaixo de 80% — útil para comparar antes e
depois de uma mudança.

### Quando rodar

Antes e depois de mudar o modelo de embedding, a divisão em trechos ou muitos itens da base. Guarde o
resumo de cada execução para comparar. Esta avaliação **não** roda no CI do GitHub: ela precisa do Ollama com
o modelo bge-m3 e da base real.
