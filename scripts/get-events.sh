#!/usr/bin/env bash
#
# Solarvey — lê os eventos do contrato pela Soroban RPC (`getEvents`).
#
# Uso:
#   ./scripts/get-events.sh                        # janela padrão (~14 h)
#   ./scripts/get-events.sh survey_created         # só esse tipo de evento
#   ./scripts/get-events.sh funded 20              # esse tipo, últimos 20
#   ./scripts/get-events.sh 5175000 survey_created # a partir de uma ledger
#   ./scripts/get-events.sh 5175000                # a partir de uma ledger
#
# O 1º argumento só é a ledger inicial se for numérico; caso contrário ele é o
# filtro de tópico (topic 0). Assim `./get-events.sh funded` funciona como se
# espera, em vez de virar um `startLedger` inválido.
#
# O RPC devolve `topic` e `value` como **XDR ScVal em base64** (não JSON), então
# cada ScVal é decodificado com `stellar xdr decode --type ScVal`.
#
# Serve à DoD da Sprint 1 ("eventos survey_created/funded visíveis via
# getEvents") e ao fluxo do SDD §5.2 (validação de `solarvey:response`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

[[ -f "$ENV_FILE" ]] || { echo "falta $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

RPC_URL="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
CONTRACT_ID="${SOLARVEY_CONTRACT_ID:?rode ./scripts/deploy.sh antes}"

# O 1º argumento só é a ledger inicial se for numérico; do contrário ele é o
# filtro de tópico (topic 0). Evita a armadilha de `./get-events.sh funded`
# virar um `startLedger` inválido e estourar um erro confuso de `jq`.
START_LEDGER=""
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  START_LEDGER="$1"
  TOPIC_FILTER="${2:-}"
  LIMIT="${3:-50}"
elif [[ -n "${1:-}" ]]; then
  TOPIC_FILTER="$1"
  LIMIT="${2:-50}"
else
  TOPIC_FILTER="${2:-}"
  LIMIT="${3:-50}"
fi

# Janela padrão (≈14 h a 5 s/ledger) quando não informada — o RPC rejeita
# `startLedger` ausente ou <= 0, e também recusa ledger fora da retenção.
WINDOW="${SOLARVEY_EVENTS_WINDOW:-10000}"

latest="$(curl -sS "$RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
  | jq -r '.result.sequence')"
[[ "$latest" =~ ^[0-9]+$ ]] || { echo "falha ao ler a ledger atual" >&2; exit 1; }

if [[ -z "$START_LEDGER" ]]; then
  START_LEDGER=$(( latest > WINDOW ? latest - WINDOW : 1 ))
fi

response="$(curl -sS "$RPC_URL" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg id "$CONTRACT_ID" --argjson ledger "$START_LEDGER" \
    --argjson limit "$LIMIT" '{
      jsonrpc: "2.0",
      id: 87,
      method: "getEvents",
      params: {
        filters: [{ type: "contract", contractIds: [$id] }],
        startLedger: $ledger,
        limit: $limit
      }
    }')")"

if jq -e '.error' <<<"$response" >/dev/null 2>&1; then
  echo "RPC devolveu erro:" >&2
  jq '.error' <<<"$response" >&2
  exit 1
fi

# ScVal JSON -> forma curta para exibição. `map` vira contagem de campos; o
# valor completo é impresso à parte quando é um map (é o payload do evento).
scval_short='
  if type != "object" then tostring
  elif has("symbol") then .symbol
  elif has("u64") then .u64
  elif has("i128") then .i128
  elif has("address") then .address
  elif has("string") then .string
  elif has("map") then ((.map | length | tostring) + " campos")
  else tostring end
'

decode() { # decode <base64 ScVal>
  stellar xdr decode --type ScVal --input single-base64 --output json "$1" \
    2>/dev/null || echo '{}'
}

emit() { # emit <topics...> -- <ledger> <tx> <data-json>
  local topics=() ledger="" tx="" data=""
  while [[ $# -gt 0 && "$1" != "--" ]]; do topics+=("$1"); shift; done
  shift # consome o "--"
  ledger="$1"; tx="$2"; data="$3"

  local joined=""
  printf -v joined '%s | ' "${topics[@]}"
  joined="${joined% | }"

  printf '%-16s ledger %-9s tx %s\n' "${topics[0]:-?}" "$ledger" "$tx"
  printf '  %-14s [%s]\n' "topics:" "$joined"
  printf '  %-14s %s\n' "data:" "$data"
  printf '\n'
}

count=0
while IFS= read -r ev_b64; do
  [[ -z "$ev_b64" ]] && continue
  ev="$(base64 -d <<<"$ev_b64")"

  rendered=()
  n="$(jq -r '.topic | length' <<<"$ev")"
  for ((i = 0; i < n; i++)); do
    b64="$(jq -r --argjson i "$i" '.topic[$i] // ""' <<<"$ev")"
    [[ -z "$b64" ]] && continue
    rendered+=("$(jq -r "$scval_short" <<<"$(decode "$b64")")")
  done

  # Filtra pelo nome do evento (topic 0), se pedido.
  if [[ -n "$TOPIC_FILTER" && "${rendered[0]:-}" != "$TOPIC_FILTER" ]]; then
    continue
  fi

  value_b64="$(jq -r '.value // ""' <<<"$ev")"
  data_json="{}"
  [[ -n "$value_b64" ]] && data_json="$(decode "$value_b64")"

  emit "${rendered[@]}" -- \
    "$(jq -r '.ledger' <<<"$ev")" \
    "$(jq -r '.txHash // "-"' <<<"$ev")" \
    "$data_json"
  count=$((count + 1))
done < <(jq -r '(.result.events // [])[] | @base64' <<<"$response")

if [[ "$count" -eq 0 ]]; then
  echo "Nenhum evento${TOPIC_FILTER:+ “$TOPIC_FILTER”} na janela (ledger $START_LEDGER+)."
  echo "Crie/financie uma pesquisa ou amplie com SOLARVEY_EVENTS_WINDOW."
  exit 0
fi

echo "$count evento(s). cursor=$(jq -r '.result.cursor // "-"' <<<"$response")"
