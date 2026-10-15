# Solarvey — SDD (Software Design Document) — MVP v0

> **Status:** Draft para contexto/decisão — não implementado.
> **Data de referência da pesquisa:** 2026-10-12 (fontes: Lumenloop, Scout, developers.stellar.org, skills stellar-dev).
> **Rede:** Stellar (Soroban) — Testnet → Mainnet.

> ⚠️ **Nota sobre o README atual do repositório:** o `README.md` descreve um MVP "Survey Rewards on Solana (Anchor)". Todo o documento abaixo assume **Stellar/Soroban**, conforme a validação feita nesta conversa. Se a intenção for Stellar, o README deve ser reescrito (tarefa S0).

---

## 1. Visão geral

### 1.1 Produto
**Solarvey** é uma dapp de pesquisa (survey) onde:
1. Um **criador** cria um formulário objetivo (MVP: máx. 6 perguntas, 4 opções cada) e **financia um escrow em XLM** por pesquisa.
2. Um **respondente** (wallet Stellar) responde; cada resposta é **ancorada on-chain como hash** e **1-resposta-por-conta** é garantida pelo contrato.
3. O respondente **reivindica (claim) a recompensa** diretamente do escrow via contrato.
4. Ao fechar, o criador publica a **raiz de Merkle** de todas as respostas; qualquer pessoa pode verificar **provas de inclusão** — resultados publicamente auditáveis.

### 1.2 Posicionamento (diferenciação vs. concorrência)
- **QSTN** (Live, SCF #20 — marketplace de surveys com foco em monetização de dados, EUA) e **Answerly** (SCF #9 — Q&A rewards) já existem no ecossistema.
- Diferença Solarvey: **credibilidade de resultado verificável** (raiz de Merkle + proofs + metodologia publicada), não acesso a dados. Contra Typeform + pagamento manual: escrow em contrato + claim automático + trava anti-Sybil.

### 1.3 Objetivos do MVP (O)
| # | Objetivo | Métrica |
|---|---|---|
| O1 | Criar e financiar uma pesquisa em < 2 min | tempo médio de criação |
| O2 | Responder + recompensa em 1 sessão | claim rate ≥ 90% das respostas |
| O3 | Resultado auditável por terceiros | página `/verify` com proof funcional |
| O4 | Custo por resposta previsível | ≤ reward + ~0.01 XLM de fees |
| O5 | Piloto real com comunidade Stellar | 2 pesquisas pagas, ≥ 30 respostas |

### 1.4 Não-objetivos do MVP (fora de escopo)
Marketplace de compradores, KYC/on-ramp, recompensas em USDC, gamificação (badges/streaks), widget embutido, ZK de humano único, upgrade de contrato, app mobile nativo, pesquisa anônima com garantia de privacidade criptográfica (Stellot já cobre votação ZK).

---

## 2. Personas

| Persona | Papel | Dor que resolve |
|---|---|---|
| **Respondent** (comunidade Stellar) | Responde pesquisas pagas | "Vale a pena? Recebo rápido e sem pagar taxa de onboarding?" |
| **Creator** (comunidade/DAO/fund/SCF) | Cria e financia pesquisas | "Meus dados são confiáveis e auditáveis? Não quero pagar Sybils." |
| **Verifier** (pesquisador/jornalista/dev) | Confere resultados publicados | "Posso provar que este resultado não foi forjado depois?" |

---

## 3. Arquitetura

```
┌────────────────────────┐     ┌──────────────────────────────┐
│  web (Next.js)         │     │  Stellar Testnet/Mainnet     │
│  - /create             │────▶│  SolarveyEscrow (Soroban)    │
│  - /s/[id] (wizard)    │ tx  │  - registry + escrow XLM     │
│  - /results/[id]       │◀────│  - 1 resp/conta              │
│  - /verify/[id]        │ RPC │  - eventos (hashes)          │
│  Freighter wallet      │     │  - raiz de Merkle (close)    │
└───────────┬────────────┘     └──────────────┬───────────────┘
            │ POST resposta (JSON)            │ getEvents (Soroban RPC)
            ▼                                 ▼
┌────────────────────────────────────────────────────────────┐
│  api (route handlers do próprio web)                       │
│  - valida hash(JSON) == hash ancorado on-chain             │
│  - armazena respostas completas (Postgres)                  │
│  - calcula árvore de Merkle no fechamento                   │
│  - serve provas de inclusão                                 │
└────────────────────────────────────────────────────────────┘
```

**Decisão de escopo:** sem indexer separado no MVP — sincronização por `getEvents` sob demanda (pull), mantido nas route handlers. Um worker dedicado é v1.

### 3.1 Stack
| Camada | Tecnologia | Base oficial |
|---|---|---|
| Contrato | Rust `no_std`, target `wasm32v1-none`, `soroban-sdk` | skill `stellar-dev.smart-contracts` (limite 128KB, `Symbol` ≤ 32 chars, sem stdlib) |
| Frontend | Next.js (App Router) + TypeScript | skill `stellar-dev.dapp` |
| Wallet | Freighter (`@stellar/freighter-api`) | mesma skill — checklist de UX obrigatório (§8) |
| Tx building | `@stellar/stellar-sdk` (TransactionBuilder + Soroban RPC) | docs SDK |
| Dados off-chain | Postgres (Supabase ou self-host) | — |
| Hash | SHA-256 (`sha2` no contrato, `node:crypto` no web) | — |

### 3.2 Estrutura de repositório (monorepo simples)
```
solarvey/
├── contracts/          # workspace Rust (soroban)
│   └── solarvey-escrow/
│       ├── src/lib.rs
│       └── tests/
├── web/                # Next.js (app + api routes)
│   ├── app/            # /create /s/[id] /results/[id] /verify/[id]
│   ├── lib/            # stellar, hashing, merkle (client+server)
│   └── db/             # schema + migrations
└── docs/               # este SDD, plano de sprints, ADRs
```

---

## 4. Design on-chain (contrato `SolarveyEscrow`)

### 4.1 Modelo de dados
```rust
#[contracttype]
pub enum DataKey {
    Admin,                       // Address
    NextId,                      // u64
    Survey(u64),                 // -> Survey (persistent)
    Escrow(u64),                 // -> i128 (stroops restantes, persistent)
    Response(u64, Address),      // -> BytesN<32> hash da resposta (temporary)
}

#[contracttype]
pub struct Survey {
    pub id: u64,
    pub owner: Address,
    pub questions_hash: BytesN<32>,   // commit do JSON das perguntas
    pub reward: i128,                 // stroops (1 XLM = 10_000_000) por resposta
    pub max_responses: u32,
    pub responded: u32,
    pub deadline: u64,                // ledger sequence de expiração
    pub state: State,                 // Open | Closed
    pub merkle_root: BytesN<32>,      // zeros até close()
}
```

### 4.2 Storage e TTL (regra crítica)
Storage em Soroban é **alugado** (TTL + arquivamento). Estratégia por entry (docs `storage-strategies` e `choosing-the-right-storage`):

| Entry | Tipo | TTL inicial | Motivo |
|---|---|---|---|
| `Survey(id)`, `Escrow(id)` | Persistent | 30 dias, extendido por tx de manutenção | vive até close + retention |
| `Response(id, addr)` | **Temporary** | `deadline − agora` (+ folga) | expira junto com a pesquisa; mais barato |
| Instance | Instance | — | `admin`, constantes |

**Risco de arquivamento:** se o TTL de `Survey` expirar e a entry for arquivada, o escrow fica intocável até restoration. **Mitigação v0:** bot de manutenção (script semanal que estende TTL das entries persistentes abertas) —列入 checklist de operação.

### 4.3 Interface pública
```rust
pub trait SolarveyEscrow {
    // setup
    fn initialize(env: Env, admin: Address);

    // criador
    fn create_survey(env: Env, owner: Address, questions_hash: BytesN<32>,
                     reward: i128, max_responses: u32, deadline: u64) -> u64;
    fn fund(env: Env, owner: Address, id: u64);        // transfere reward*max_responses de XLM p/ escrow
    fn close(env: Env, owner: Address, id: u64,
             merkle_root: BytesN<32>, count: u32);     // count deve == responded
    fn refund(env: Env, owner: Address, id: u64);      // devolve escrow residual (pós deadline ou closed)

    // respondente
    fn submit(env: Env, responder: Address, id: u64, response_hash: BytesN<32>);
    fn claim(env: Env, responder: Address, id: u64);   // transfer XLM do escrow p/ respondedor

    // views (read-only, sem fee de escrita)
    fn get_survey(env: Env, id: u64) -> Survey;
    fn has_responded(env: Env, id: u64, addr: Address) -> bool;
    fn get_escrow(env: Env, id: u64) -> i128;
}
```

### 4.4 Regras de negócio (invariantes)
1. `fund` exige `state == Open` e saldo do criador ≥ `reward × max_responses`; só pode ser chamado uma vez por survey (escrow total antecipado — garante que a recompensa existe).
2. `submit` exige: `state == Open`, `ledger.sequence < deadline`, `responded < max_responses`, e **não existir** `Response(id, responder)` → grava hash, `responded += 1`, emite evento.
3. `claim` exige `Response(id, responder)` existente e `Escrow(id) ≥ reward`; transfere `reward` via token transfer (XLM nativo via SAC) e **não** permite duplo claim (marca `claimed` em storage temporary junto do `Response`).
4. `close` exige owner, `state == Open`, `count == responded`; grava `merkle_root`, muda `state → Closed`. **Não impede claims já feitos** — claims continuam válidos após o fechamento dentro da retention.
5. `refund` exige owner e (`Closed` ou `ledger.sequence > deadline`); devolve o saldo residual de `Escrow(id)`.
6. `submit` após `deadline` falha (nem `Closed` precisa estar; deadline é a trava dura).

### 4.5 Recompensa — nota de decisão (divergência do plano original)
O plano original mencionou **claimable balance** como mecanismo de recompensa. Análise técnica mais profunda aponta um problema: claimable balances criados por um contrato têm o **contrato como source**, e o `clawback` (não-reclamado → devolução ao criador) exigiria uma transação **clássica assinada pelo contrato** — algo que o contrato não pode fazer. Isso quebraria o `refund`.

**Decisão v0:** recompensa como **transferência direta do escrow (SAC/XLM) no `claim`**. Refund é total e simples. UX é idêntica (o respondente assina 1 tx de qualquer forma).
**Spike S0:** verificar se `env.create_claimable_balance` + `env.claim_claimable_balance` do soroban-sdk cobrem o fluxo interno ao contrato; se sim, ADR reversão para expiração automática. Registrar resultado em `docs/adr/000X-reward-mechanism.md`.

### 4.6 Eventos (fonte da verdade do indexer)
| Evento | Topics | Data |
|---|---|---|
| `solarvey:survey_created` | `["survey_created", id]` | (owner, questions_hash, reward, max, deadline) |
| `solarvey:funded` | `["funded", id]` | (amount) |
| `solarvey:response` | `["response", id]` | (responder, response_hash) — **feed do Merkle** |
| `suv solarvey:claimed` | `["claimed", id]` | (responder, amount) |
| `solarvey:closed` | `["closed", id]` | (merkle_root, count) |
| `solarvey:refunded` | `["refunded", id]` | (amount) |

### 4.7 Erros (códigos)
`ERR_NOT_AUTH` (1), `ERR_CLOSED` (2), `ERR_DEADLINE` (3), `ERR_FULL` (4), `ERR_ALREADY_RESPONDED` (5), `ERR_NO_RESPONSE` (6), `ERR_ALREADY_CLAIMED` (7), `ERR_INSUFFICIENT_ESCROW` (8), `ERR_NOT_FUNDED` (9), `ERR_COUNT_MISMATCH` (10), `ERR_BAD_STATE` (11).

---

## 5. Design off-chain

### 5.1 Esquema de hash canônico (contrato ↔ API)
Resposta = `SHA-256(UTF-8 de JSON.stringify({ surveyId, answers }))` com:
- `answers`: array de índices (0–3), um por pergunta, na ordem do formulário;
- serialização **sem espaços**, chaves em ordem lexicográfica (garantir com canonical JSON util no web);
- o mesmo esquema é usado para `questions_hash` no create.

O contrato **não valida o conteúdo** (só o hash) — a validação de formato (6q/4opções) é feita no web na criação. Aceito para v0; documentado como limitação.

### 5.2 Fluxo de resposta (web + API)
1. Wizard envia `POST /api/surveys/{id}/responses` com `{ address, answers[], txHash }`.
2. API: (a) reconstrói o hash canônico; (b) busca o evento `solarvey:response` correspondente via Soroban RPC (`getEvents`) e confere se o hash bate e o `responder == address`; (c) só então persiste a resposta completa.
3. Sem correspondência on-chain → rejeita (não há storage grátis para spam).

### 5.3 Tabelas (Postgres)
```sql
surveys    (id pk, owner, questions jsonb, questions_hash, reward, max_responses,
            responded, deadline, state, merkle_root, tx_create, created_at)
responses  (id pk, survey_id fk, responder, answers jsonb, response_hash,
            tx_hash, submitted_at, unique(survey_id, response_hash))
proofs     (survey_id fk, leaf_hash pk, path jsonb)  -- pré-computado no close
```

### 5.4 Merkle (fechamento e verificação)
- **Folha:** o `response_hash` (32 bytes) de cada resposta, ordenado por ordem de submissão.
- **Nó interno:** `SHA-256(left || right)`; se nº ímpar, o último sobe duplicado.
- **Close:** API calcula a raiz, o dono chama `close(id, root, count)`; API materializa `proofs`.
- **`/verify/[id]`:** página estática que mostra a raiz on-chain, a lista de folhas e permite baixar/verificar uma proof no browser (JS puro, sem confiar no servidor).

### 5.5 Modelo de confiança (transparência honesta)
- O `close` publica a raiz, mas o **dono poderia teoricamente publicar uma raiz arbitrária** (limitação de v0, pois `count` é limitado a `responded`).
- **Mitigação v1:** o indexer recomputa a raiz a partir dos eventos públicos `solarvey:response` e exibe divergência na `/verify` ("raiz do contrato ≠ raiz recomputada") — sem custo de tx extra.
- **Mitigação v2:** desafio (challenge) on-chain com janela de contestação antes do payout final.

---

## 6. Segurança

| Vetor | Mitigação |
|---|---|
| Sybil (1 pessoa, N contas) | 1 resposta por conta (storage) + painel fechado (link com token de convite) no piloto. **Honesto:** não resolve farming com N contas criadas — aceito no piloto de comunidade; reputação/ZK é v1/v2. |
| Reentrancy | Bloqueada pelo host Soroban (sem delegatecall) — não depende do contrato. |
| Arithmetic overflow | `i128` + checked ops; `reward × max_responses` com saturação/validação. |
| Roubo de escrow | `require_auth` do owner em `fund/close/refund`; só `claim` libera para respondedores com proof de resposta. |
| TTL/archival | Bot de manutenção (§4.2); alertas se TTL < 7 dias. |
| Contrato malicioso depois do deploy | **Imutável por design no v0** (sem upgrade) — reforça a promessa de verificabilidade. Upgrade é decisão de v1 com proxy + governança. |
| Front-running do close | Raiz é determinística a partir dos eventos; fechar com raiz errada só gera divergência visível (§5.5). |
| Chave do criador comprometida | Escrow fica no contrato; compromised key não drena — só afeta futuros `refund`. |

Checklist pré-mainnet (skill `stellar-dev.smart-contracts` + OpenZeppelin Stellar): auth, reinit, aritmética, TTLs, validação cross-contract, library-first (usar token SAC nativo em vez de reescrever).

---

## 7. Privacidade & Compliance
- MVP coleta **apenas índices de resposta** (0–3) — sem PII. Superfície LGPD/GDPR mínima.
- Hashes on-chain são **irversíveis** para PII (não coletamos).
- Termos de uso: idade mínima 18+, uma conta por pessoa (ToS — enforcement é operacional).
- Pagamento por responder = micropagamento por serviço (precedente: SCF paga bounties em XLM). Escalar a "renda" muda o jogo (pesquisa de mercado com compliance) — decisão v1.

---

## 8. UX obrigatória (checklist da skill `stellar-dev.dapp`)
- [ ] Loading durante assinatura no Freighter.
- [ ] Mostrar hash da tx imediatamente após submissão.
- [ ] Estado pending → success/failed com mensagens claras: wallet não conectada, assinatura rejeitada, XLM insuficiente para fee, conta não financiada, rede errada (mainnet vs testnet), timeout.
- [ ] Prevenir double-submit (botão desabilitado durante tx).
- [ ] Mostrar destino e valor antes de assinar.

---

## 9. Riscos & mitigações (consolidado)
| Risco | Impacto | Mitigation |
|---|---|---|
| Sybil farming | Alto (drena escrow) | Painel fechado no piloto; métrica de "conta antiga"; v1 reputação |
| Sem comprador pagando | Alto (produto sem receita) | Piloto paga pouco de bolso; teste de disposição a pagar com 2 comunidades |
| QSTN evoluir | Médio | First-mover em verificabilidade; raiz/proofs como padrão aberto |
| TTL/archival do escrow | Alto (funds travados) | Bot de manutenção + testes de TTL em testnet |
| Freighter abandonment UX | Médio | Checklist §8 + fallback stellar.expert link para txs |
| Escrow insuficiente por bug aritmético | Alto | Testes unitários + fuzz de invariantes |

---

## 10. Plano de testes
| Nível | Ferramenta | Escopo |
|---|---|---|
| Unit (contrato) | `soroban contract test` | invariantes §4.4, erros §4.7, TTL |
| Integration | testnet + scripts | fluxo completo create→fund→submit→claim→close→refund |
| API | vitest | hash canônico, validação evento↔resposta |
| E2E (smoke) | Playwright | 1 pesquisa criada e respondida em testnet com Freighter |

---

## 11. Métricas de sucesso do piloto
- 2 pesquisas publicadas e financiadas na testnet/mainnet com ≥ 30 respostas cada.
- Claim rate ≥ 90%.
- Custo médio por resposta ≤ reward + 0.01 XLM.
- 1 verificação externa bem-sucedida na `/verify` (alguém de fora validou um proof).

---

## 12. Referências (checadas em 2026-10-12)
- QSTN (concorrente direto): lumenloop `qstn` (Live, SCF #20, budget $2.5K, qstn.us).
- Answerly: SCF #9 Legacy v3.0 ($150K no registro da submissão).
- Docs: `developers.stellar.org/docs/build/guides/storage/storage-strategies` (S11 Merkle/hash commitments, S8 events+indexer), `.../choosing-the-right-storage` (LoyaltyPoints), `.../learn/fundamentals/lumens#minimum-balance` (base reserve 0.5 XLM, sponsored reserves), `.../tokens/token-interface` (SEP-41).
- Skills: `stellar-dev.dapp`, `stellar-dev.smart-contracts`, `openzeppelin-stellar.develop-secure-contracts`, `stellar-dev.zk-proofs` (v2).
