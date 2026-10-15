#!/usr/bin/env bash
#
# Solarvey — deploy do contrato `SolarveyEscrow` na testnet (Sprint 1).
#
# Uso:  ./scripts/deploy.sh [--force]
#
#   --force   ignora um contrato já implantado e publica um novo
#
# O que faz, nesta ordem:
#   1. carrega `.env` (cria as identidades da testnet se faltarem);
#   2. `stellar contract build` (o artefato precisa ter < 128 KB);
#   3. `stellar contract deploy`;
#   4. `initialize(admin, token)` imediatamente depois — a janela de
#      front-running entre os dois é documentada no README (risco v0);
#   5. grava o id em `.env` e em `web/.env.local`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
ENV_LOCAL="$ROOT/web/.env.local"
WASM="$ROOT/contracts/target/wasm32v1-none/release/solarvey_escrow.wasm"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merro:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. env

[[ -f "$ENV_FILE" ]] || die "falta $ENV_FILE — copie .env.example e preencha"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
NATIVE_SAC="${NATIVE_SAC_CONTRACT:?defina NATIVE_SAC_CONTRACT no .env}"
ADMIN_IDENT="${ADMIN_IDENT:-solarvey-admin}"
CREATOR_IDENT="${CREATOR_IDENT:-solarvey-creator}"
RESPONDER_IDENT="${RESPONDER_IDENT:-solarvey-responder}"
ADMIN_ADDR="$(stellar keys public-key "$ADMIN_IDENT")"

set_env_var() { # set_env_var <arquivo> <chave> <valor>
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

log "Verificando identidades da testnet"
for ident in "$CREATOR_IDENT" "$RESPONDER_IDENT" "$ADMIN_IDENT"; do
  if ! stellar keys public-key "$ident" >/dev/null 2>&1; then
    log "  criando $ident (com funding via faucet)"
    stellar keys generate "$ident" --network "$NETWORK" --fund
  fi
done

# Idempotência: um contrato já implantado não é redesenhado. `initialize` é
# idempotente de propósito — ERR_BAD_STATE(11) significa "já inicializado",
# que é o mesmo sinal do front-running documentado no README.
#
# Obs.: `stellar contract read` só devolve o hash do wasm da instância, então
# ele prova que o contrato existe, mas não que está inicializado. Por isso a
# decisão de inicializar fica para o passo 4.
existing_id="$(grep '^SOLARVEY_CONTRACT_ID=' "$ENV_FILE" | cut -d= -f2 || true)"
CONTRACT_ID=""
if [[ -n "$existing_id" && "$FORCE" -eq 0 ]]; then
  if stellar contract read --id "$existing_id" --network "$NETWORK" >/dev/null 2>&1; then
    CONTRACT_ID="$existing_id"
    log "Reaproveitando contrato já implantado: $CONTRACT_ID"
  else
    log "Id em $ENV_FILE não responde — reimplantando"
  fi
fi

# ---------------------------------------------------------- 1b. versão do CLI
#
# O wasm gerado depende da versão do `stellar` CLI: 27 e 28 constroem
# artefatos diferentes para a mesma fonte (hashes divergem, mesmo tamanho).
# Como o contrato usa `soroban-sdk` 28, exigimos a linha 28 — do contrário o
# que vai para a chain deixa de ser reproduzível a partir deste checkout, e a
# verificabilidade do MVP cai junto.
REQUIRED_CLI_MAJOR="${REQUIRED_CLI_MAJOR:-28}"
cli_bin="$(command -v stellar)" || die "stellar CLI não encontrado no PATH"
cli_version="$(stellar --version 2>/dev/null | head -1 |
  grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
[[ -n "$cli_version" ]] || die "não consegui ler 'stellar --version'"
cli_major="${cli_version%%.*}"
if [[ "$cli_major" != "$REQUIRED_CLI_MAJOR" ]]; then
  die "stellar CLI $cli_version em $cli_bin não serve: este repositório exige a linha $REQUIRED_CLI_MAJOR (soroban-sdk 28). Elas geram wasm com hashes diferentes para a mesma fonte."
fi
log "stellar CLI $cli_version ($cli_bin)"

# --------------------------------------------------------------- 2. build

log "Build do wasm"
( cd "$ROOT/contracts" && stellar contract build )

[[ -f "$WASM" ]] || die "wasm não encontrado em $WASM"
size="$(wc -c <"$WASM")"
WASM_HASH="$(sha256sum "$WASM" | cut -d' ' -f1)"
log "Wasm: $WASM ($size bytes, sha256 $WASM_HASH)"
[[ "$size" -lt 131072 ]] || die "wasm com $size bytes > limite de 128 KB"

# -------------------------------------------------------------- 3. deploy

log "Deploy na rede $NETWORK"
if [[ -z "$CONTRACT_ID" ]]; then
  CONTRACT_ID="$(
    stellar contract deploy \
      --wasm "$WASM" \
      --network "$NETWORK" \
      --source-account "$ADMIN_IDENT" \
      --alias solarvey-escrow
  )"
  log "Contrato: $CONTRACT_ID"
else
  log "Deploy pulado — reaproveitando $CONTRACT_ID"
fi

# Verificação de reprodutibilidade: o que está na chain tem que ser exatamente
# o wasm que este checkout acaba de buildar. Se divergir, a afirmação
# "contrato auditable a partir do código-fonte" deixa de valer.
onchain_hash="$(
  stellar contract read --id "$CONTRACT_ID" --network "$NETWORK" 2>/dev/null |
    grep -oE '[0-9a-f]{64}' | head -1
)"
[[ -n "$onchain_hash" ]] || die "não consegui ler o wasm do contrato $CONTRACT_ID"
if [[ "$onchain_hash" != "$WASM_HASH" ]]; then
  die "wasm na chain ($onchain_hash) != wasm buildado aqui ($WASM_HASH) — reimplante com --force"
fi
log "Wasm na chain confere com o buildado localmente"

# ----------------------------------------------------------- 4. initialize

# `initialize` devolve ERR_BAD_STATE(11) quando alguém já chamou — é o
# sintoma do front-running descrito no README, e também o caso normal de uma
# re-execução do script (o contrato já está pronto). Qualquer outro erro
# interrompe.
log "initialize(admin=$ADMIN_ADDR, token=$NATIVE_SAC)"
init_out="$(
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --network "$NETWORK" \
    --source-account "$ADMIN_IDENT" \
    -- initialize --admin "$ADMIN_ADDR" --token "$NATIVE_SAC" 2>&1
)" || {
  if grep -q 'Error(Contract, #11)' <<<"$init_out"; then
    log "initialize já havia sido feito (ERR_BAD_STATE) — seguindo"
  else
    printf '%s\n' "$init_out" >&2
    die "initialize falhou — investigar front-running na janela de deploy"
  fi
}

# ------------------------------------------------------------- 5. gravar ids

log "Gravando ids em .env e web/.env.local"
set_env_var "$ENV_FILE" SOLARVEY_CONTRACT_ID "$CONTRACT_ID"
[[ -f "$ENV_LOCAL" ]] || die "falta $ENV_LOCAL — rode pnpm install/dev na web"
set_env_var "$ENV_LOCAL" NEXT_PUBLIC_SOLARVEY_CONTRACT_ID "$CONTRACT_ID"

log "OK — contrato $CONTRACT_ID"
cat <<EOF

Próximos passos:
  ./scripts/get-events.sh     # eventos survey_created/funded via getEvents
  cd web && pnpm dev          # http://localhost:3000
  (cd contracts && cargo test) # invariantes §4.4 + erros §4.7
EOF
