# ADR-001 — Mecanismo de recompensa: transferência direta do escrow

- **Status:** Aceito
- **Data:** 2026-10-12 (spike executado na S0)
- **Contexto:** `docs/SDD-MVP.md` §4.5
- **Spiker:** S0, trilha Spike

## Decisão

Recompensa paga por **transferência direta do escrow (SAC/XLM)** no `claim`,
não por *claimable balance*.

## O que foi testado

Spike executado contra a toolchain local:

| Verificação | Resultado |
|---|---|
| `grep -rn "create_claimable_balance\|claim_claimable_balance" soroban-sdk-28.0.0/` | **0 ocorrências** |
| Mesmo grep em `soroban-env-common-*` | **0 ocorrências** |
| `Env` (impl) — métodos públicos listados | `storage`, `events`, `ledger`, `deployer`, `custom_account`, `crypto`, `prng`, `invoke_contract`, `authorize_as_current_contract`, `logger`, `cost_estimate`, `register*`, `as_contract`, `mock_auths`, `auths` … **não há `create_claimable_balance`** |

Versão da toolchain: `soroban-sdk 28.0.0`, `stellar-cli 28.1.0`, `rustc 1.98.1`.

## Consequências

1. **A API proposta no SDD não existe.** `env.create_claimable_balance` /
   `env.claim_claimable_balance` não estão no SDK nem no ambiente do host —
   o plano original provavelmente confundiu com o *claimable balance clássico*
   (operação de ledger não-Soroban, que um contrato não consegue criar sem
   assinar uma tx clássica).
2. **Mantém-se a decisão já registrada no SDD:** o `claim` transfere XLM do
   escrow para o respondente via `TokenClient::transfer` na SAC nativa. O
   `refund` devolve o residual diretamente — sem `clawback`, que seria
   impossível (exigiria tx clássica assinada pelo contrato).
3. **UX inalterada:** o respondente assina 1 tx de qualquer forma.
4. **Nenhuma reversão de ADR necessária** — o SDD já trazia essa escolha como
   "Decisão v0".

## Não resolvido aqui

- Expiração automática de recompensas não reivindicadas (v1). Hoje o residual
  volta ao criador por `refund` após o `deadline`/`close`.
- Ver se `stellar contract` expõe claimable balance como *operação* clássica
  encapsulável — fora do escopo desta ADR.
