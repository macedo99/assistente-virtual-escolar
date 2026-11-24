# Avaliação do bot

Testes de qualidade do que o bot **responde**, diferentes dos testes do código (`docs/TESTES.md`): eles
dependem do modelo, dos dados da base e do prompt, então medem **taxas** (quantas perguntas acertou), não
passa/falha de uma linha só.

| Avaliação | O que mede | Situação |
|---|---|---|
| Busca (`busca.json`) | Para cada pergunta real, o item certo da base aparece entre os primeiros resultados? | Pronta |
| Red-team × golden set (prompt injection) | Todo ataque recebe o aviso “⚠️ Possível tentativa de prompt injection”; nenhuma pergunta legítima é barrada | Pronta, roda no CI |
| Respostas (golden set, campo `fatos`) | A resposta final traz os fatos certos? | Depende dos workflows do n8n no repositório |

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

## Prompt injection: red-team e golden set

- **`red-team.json`**: ataques diretos (mensagens no Telegram) e indiretos (ordens escondidas em documentos da
  base), em português e inglês. Esperado: o bot responde com o aviso de prompt injection e não chama o LLM.
- **`golden-set.json`**: perguntas legítimas, muitas com palavras que também aparecem em ataques (“ignorar”,
  “regras”, “instruções”, “senha”, “sem restrições”). Esperado: o bot responde normalmente.

```bash
cd dashboard && node scripts/avaliar-injecao.js
```

Mostra caso a caso o que foi sinalizado e por quê, a taxa de detecção e a de falsos positivos. O teste
`dashboard/test/injecao.test.js` exige 100% de detecção e 0 falso positivo, então roda no CI a cada mudança.

**Leia o número com cuidado.** As regras foram escritas olhando esses casos, então 100% aqui não quer dizer que
toda paráfrase nova será pega: num teste com 10 ataques escritos depois das regras, só 1 foi detectado antes de
ajustá-las. Por isso:

1. Sempre que aparecer um ataque novo (no histórico de conversas, num teste da equipe), **rode primeiro** e só
   depois acrescente ao `red-team.json` — o resultado antes de acrescentar é a medida honesta.
2. Toda pergunta legítima barrada vai para o `golden-set.json`.
3. A detecção por regras é uma camada. O prompt do LLM continua precisando tratar o texto do usuário e o da base
   como dados (etapa 5, depois dos workflows no repositório).
