#!/bin/sh
# Exporta todos os workflows do n8n para n8n/workflows/ (um arquivo .json por workflow), já limpos para o git.
# Rode na pasta do projeto, com o sistema de pé (docker compose up):
#
#   sh n8n/exportar-workflows.sh
#
# Depois confira com "git diff n8n/workflows" e faça o commit. As credenciais (tokens, senhas) NÃO são
# exportadas; o script avisa se encontrar algo com cara de segredo escrito direto num nó.
#
# (N8N_CONTAINER=<nome> usa "docker exec" num container avulso em vez do serviço do docker compose.)
set -eu
cd "$(dirname "$0")/.."

TMP=/tmp/exportacao-workflows
DESTINO=n8n/workflows

if [ -n "${N8N_CONTAINER:-}" ]; then
  no_n8n() { docker exec -i "$N8N_CONTAINER" "$@"; }
  copiar() { docker cp "$N8N_CONTAINER:$1" "$2"; }
else
  no_n8n() { docker compose exec -T n8n "$@"; }
  copiar() { docker compose cp "n8n:$1" "$2"; }
fi

echo "Exportando os workflows do n8n..."
no_n8n sh -c "rm -rf $TMP && n8n export:workflow --all --separate --pretty --output=$TMP/ >/dev/null"

status=0
no_n8n node - "$TMP" < n8n/limpar-workflows.js || status=$?
if [ "$status" -ne 0 ] && [ "$status" -ne 3 ]; then
  echo "A limpeza falhou (código $status). Nada foi copiado."
  exit "$status"
fi

rm -rf "$DESTINO"
copiar "$TMP/limpos" "$DESTINO"
no_n8n rm -rf "$TMP"

printf "\nPronto: %s workflow(s) em %s/. Confira com: git diff %s\n" "$(ls "$DESTINO" | wc -l)" "$DESTINO" "$DESTINO"
exit "$status"
