# Solarvey

**Pesquisas pagas com escrow verificável na Stellar (Soroban).**

Um criador cria um formulário (até 6 perguntas, 4 opções cada) e financia um escrow
em XLM. Um respondente com wallet Stellar responde, cada resposta é ancorada on-chain
como hash (1 resposta por conta) e a recompensa é reivindicada direto do escrow pelo
contrato. Ao fechar, o criador publica a raiz de Merkle de todas as respostas —
qualquer pessoa pode verificar provas de inclusão em `/verify`.

> Este repositório foi reescrito para **Stellar/Soroban**. A versão anterior
> descrevia um MVP "Survey Rewards on Solana (Anchor)" — veja `docs/SDD-MVP.md`
> para a decisão de arquitetura.

## Status

| Sprint | Tema                                         | Estado       |
| ------ | -------------------------------------------- | ------------ |
| S0     | Fundação (toolchain, repo, ADR-001)          | ✅           |
| S1     | Contrato vivo na testnet (criar + financiar) | ✅           |
| S2     | Responder e receber (fluxo completo)         | 🟡 em curso  |
| S3     | Verificabilidade (Merkle / `/verify`)        | ⬜ planejado |
| S4     | Piloto + submissão SCF                       | ⬜ planejado |

**S1 concluída.** Contrato `SolarveyEscrow` com 47 testes (invariantes §4.4,
os 11 erros de §4.7, TTL de §4.2 e as arestas deadline-exato / max-exato /
refund-duplicado), `.wasm` de 11 KB implantado e inicializado na testnet, e
`/create` criando + financiando pesquisas com assinatura na Freighter.

O DoD foi verificado de ponta a ponta **pela UI, com Freighter real na
testnet**: `web/e2e/s1-create-sign.mjs` conecta, preenche, mostra o painel de
revisão (destino + valor travado, §8) e assina as duas transações — as
pesquisas **#2** e **#3** saíram desse fluxo, ambas com `get_escrow` batendo
com `recompensa × máx` e os eventos `survey_created`/`funded` legíveis por
`./scripts/get-events.sh`. O limite do formulário (6 perguntas × 4 opções) e a
validação que trava a revisão são cobertos headless por
`web/e2e/s1-create-ui.mjs` (12 verificações, sem carteira).

Contrato na testnet:
`CBGSHXM3KTO2OLTEHMRGI4IK52Z6SI5ILPMRPQ3FCCZVDCYNTMPB3PW4`
(wasm sha256 `f6cf4300…`, igual ao `stellar contract build` deste checkout;
`deploy.sh` confere essa igualdade antes de dar por encerrado).

> **Reprodutibilidade**: o `stellar` CLI 27 e 28 geram wasm com **hashes
> diferentes para a mesma fonte** (mesmo tamanho). Como o contrato usa
> `soroban-sdk` 28, o `deploy.sh` recusa qualquer CLI de outra linha — veja
> "Requisitos".

Documentos: [`docs/SDD-MVP.md`](docs/SDD-MVP.md) (design) ·
[`docs/PLANO-SPRINTS.md`](docs/PLANO-SPRINTS.md) (plano) ·
[`docs/adr/`](docs/adr) (decisões).

## Estrutura

```
solarvey/
├── contracts/              # workspace Rust (Soroban)
│   └── solarvey-escrow/    # contrato de escrow + testes unitários
├── web/                    # Next.js (App Router) + API routes
│   ├── app/                # /create  /s/[id]  /results/[id]
│   ├── lib/                # stellar, hash canônico, erros
│   ├── db/                 # schema + migrations (PGlite/Postgres)
│   └── e2e/                # specs Playwright
├── scripts/                # deploy.sh, get-events.sh
└── docs/                   # SDD, plano de sprints, ADRs
```

## Requisitos

- Rust stable + `rustup target add wasm32v1-none`
- **Stellar CLI 28** ([instalação](https://developers.stellar.org/docs/tools/cli))
  — o antigo `soroban` CLI foi **fundido no `stellar` CLI**, e todos os
  comandos `soroban *` correspondem a `stellar contract *`.
  A versão importa de verdade: CLI 27 e 28 constroem `.wasm` com **hash
  diferente** para a mesma fonte (e o mesmo tamanho), então o que está na chain
  só é auditável a partir deste código se as duas linhas coincidirem. O
  contrato usa `soroban-sdk` 28 e `scripts/deploy.sh` recusa um CLI de outra
  linha. Se a máquina tiver mais de um `stellar` no `PATH`, confira com
  `which -a stellar && stellar --version`.
- Node.js ≥ 22 e pnpm
- Freighter (extensão) apontando para a **testnet**

## Início rápido

```bash
# 1. contratos
cd contracts && cargo test          # invariantes + erros
stellar contract build               # gera .wasm (< 128 KB)

# 2. contas de teste (testnet) + deploy
./scripts/deploy.sh                  # idempotente: faz deploy + initialize

# 3. app
cd web && pnpm install && pnpm dev   # http://localhost:3000

# 4. e2e (opcional — ver web/e2e/README.md)
cd web && node e2e/s1-create-ui.mjs        # headless, sem carteira
node e2e/onboard-freighter.mjs             # implanta a Freighter no perfil de teste
node e2e/s1-create-sign.mjs                # fluxo completo com Freighter real
```

Credenciais e o id do contrato ficam em `.env` (contas) e `web/.env.local`
(público, gitignored). Depois de usar `/create`, os eventos saem por:

```bash
./scripts/get-events.sh              # topics em JSON, com filtro e limit
./scripts/get-events.sh funded 50    # só o evento "funded", últimas 50
```

## Decisões técnicas principais

| Tema         | Decisão                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| Recompensa   | Transferência direta do escrow (SAC/XLM) no `claim` — `docs/adr/0001-reward-mechanism.md` |
| Persistência | Postgres (PGlite embarcado em dev, `DATABASE_URL` para Supabase/produção)                 |
| Indexação    | Sem worker no MVP: `getEvents` sob demanda nas route handlers                             |
| Contrato     | Imutável no v0 (sem upgrade) — reforça a verificabilidade                                 |
| TTL          | Bot semanal estende entries persistentes (S3); temporary nas respostas                    |

## Segurança conhecida (v0)

- `initialize` tem janela de front-running entre deploy e init — `scripts/deploy.sh`
  faz os dois de trás para frente. Avaliar `__constructor` no gate de mainnet (S4).
- 1 resposta por conta **não impede** farming com N contas — aceito no piloto de
  comunidade; reputação/ZK é v1/v2.
- O `close` aceita a raiz informada pelo dono; a divergência contra os eventos
  públicos só fica visível em `/verify` (S3).

## Licença

MIT — veja [`LICENSE`](LICENSE).
