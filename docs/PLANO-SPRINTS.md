# Solarvey — Plano de Sprints (MVP v0)

> Guia de implementação em sequência lógica. Base: `docs/SDD-MVP.md`.
> Cadência: sprints de **1 semana** (dev solo + IA). Review na sexta; daily mental de 15 min (o que avancei / bloqueios).
> Rede: **Testnet** do Sprint 1 ao 4; decisão de mainnet no gate S4.

---

## Visão de sequência (por que esta ordem)

```
S0 toolchain ──▶ S1 contrato fundido ──▶ S2 responder+claim ──▶ S3 verificabilidade ──▶ S4 piloto+SCF
     (sem nada disso, nada roda)      (o contrato é o espinha   (é o diferencial vs   (é a prova de
                                        dorsal — testar cedo)     QSTN — não cortar)     demanda)
```

Regra de ouro: **cada sprint termina com algo executando** (tx na testnet, página no ar). Nada de "quase pronto".

---

## Sprint 0 — Fundação (toolchain + repo)

**Objetivo:** ambiente reproduzível e repo organizado; zero funcionalidade de produto.

### Tarefas
| Trilha | Tarefa |
|---|---|
| Toolchain | Instalar `stellar CLI`, `soroban CLI`, Rust stable + target `wasm32v1-none`; validar com `stellar contract build` num hello-world |
| Toolchain | Contas na **testnet**: criador, respondedor, admin; funding via faucet; guardar chaves em `.env` (gitignored) |
| Repo | Monorepo: `contracts/` (workspace Rust), `web/` (Next.js + TS), `docs/`; `.gitignore`, lint/format (rustfmt, eslint/prettier) |
| Repo | Reescrever `README.md` (hoje cita Solana/Anchor — corrigir para Stellar/Soroban) |
| Frontend | Scaffold Next.js + `@stellar/stellar-sdk` + `@stellar/freighter-api`; hook `useFreighter` (skill `stellar-dev.dapp`) |
| DB | Postgres local (Docker) ou Supabase; migration inicial com as tabelas do SDD §5.3 |
| Spike | **ADR-001:** testar se `env.create_claimable_balance`/`claim` funcionam internamente ao contrato; decidir mecanismo de recompensa (SDD §4.5). Prazo: meio-dia de S0. |
| Design | Extrair design tokens da identidade (amarelo/azul-marinho/branco-nuvem/laranja) para o tema do web — só tokens, sem telas. |

### Definition of Done (DoD)
- `stellar contract build` roda e gera `.wasm` (< 128KB).
- `pnpm dev` sobe com Freighter detectado (rede testnet).
- ADR-001 escrito em `docs/adr/`.
- README novo no ar.

### Risco da sprint
Freighter + versões do SDK causando dor de cabeça inicial → mitigar instalando cedo (primeira tarefa da trilha frontend).

---

## Sprint 1 — Contrato vivo na testnet

**Objetivo:** `SolarveyEscrow` implementado, testado e **invocável via CLI/testnet**. Frontend com criação de pesquisa.

### Tarefas
| Trilha | Tarefa |
|---|---|
| Contrato | Estruturas + `initialize` + `create_survey` (SDD §4.1–4.3) |
| Contrato | `fund` (validação `reward × max_responses`, transição de estado) |
| Contrato | `submit` (trava 1-resp/conta, grava hash temporary, evento `response`) |
| Contrato | `claim` + `refund` (transfer SAC/XLM, erros §4.7) |
| Contrato | `close` (raiz + count) |
| Testes | Unit: todas as invariantes §4.4 + todos os erros; edge: deadline exato, max_responses exato, refund duplicado |
| Deploy | Deploy na testnet; script `scripts/deploy.sh` versionado |
| Frontend | `/create`: formulário (6q/4opções), hash canônico do questions_hash, tx `create_survey` + `fund` assinada no Freighter |
| Frontend | Página `/s/[id]` stub (mostra "em breve") |

### DoD
- Testes verdes; `.wasm` deployado; ID da contrato anotado.
- Consegue-se criar + financiar uma pesquisa pela UI e conferir no explorer (stellar.expert).
- Eventos `survey_created`/`funded` visíveis via `getEvents`.

### Risco da sprint
`fund` com transfer de XLM nativo via SAC exigir a address do SAC na testnet → resolver mapeando a address oficial na S0/começo de S1.

---

## Sprint 2 — Responder e receber (o coração)

**Objetivo:** respondente completa a pesquisa e **recebe a recompensa** ponta a ponta. É o gate de viabilidade — se isso funciona, o produto existe.

### Tarefas
| Trilha | Tarefa |
|---|---|
| Frontend | `/s/[id]` wizard 1-pergunta-por-tela; envia `submit` on-chain + `POST /responses` |
| API | Endpoint de resposta: reconstrói hash, valida contra evento `solarvey:response` (RPC), persiste (SDD §5.2) |
| Frontend | Botão **claim** após submit (ou na página de agradecimento); trata erros `ERR_ALREADY_CLAIMED` etc. |
| Frontend | `/results/[id]`: agregado simples (contagem por opção, nº respostas) — ainda sem Merkle |
| Testes | E2E smoke com Playwright + Freighter (testnet): criar → responder → claim |
| QA | Checklist UX do SDD §8 completo |

### DoD
- Fluxo completo na testnet com **duas contas** (criador/respondente) sem tocar CLI.
- Saldo do respondedor aumenta visivelmente após claim.
- Double-submit bloqueado; erros amigáveis.

### **Gate de decisão (fim de S2)**
- [ ] Fluxo funciona sem intervenção manual? → segue S3.
- [ ] Se não: **1 semana de correção** antes de S3 (não paralelizar com verificabilidade).

---

## Sprint 3 — Verificabilidade (o diferencial)

**Objetivo:** raiz de Merkle publicada, provas de inclusão e página `/verify` — o que separa Solarvey de "formulário + pagamento".

### Tarefas
| Trilha | Tarefa |
|---|---|
| API | Cálculo de Merkle no fechamento (folhas = response_hash em ordem de submissão, SDD §5.4) |
| Frontend | Fluxo de **close** para o dono: calcula raiz, assina `close(id, root, count)` |
| Frontend | `/verify/[id]`: mostra raiz on-chain, lista de folhas, proof por respondedor, verificação client-side (JS puro) |
| API | Tabela `proofs` materializada; endpoint de proof |
| Divergência | Exibição "raiz do contrato vs raiz recomputada dos eventos" (SDD §5.5 mitigação v1) |
| Ops | **Bot de manutenção de TTL** (script semanal estendendo entries persistentes) + alertas |
| Hardening | Revisão de segurança interna (checklist OpenZeppelin Stellar: auth, reinit, aritmética, TTL, cross-contract) |
| Docs | Página de metodologia (como hashes/raiz são calculados) — conteúdo para `/verify` |

### DoD
- Fechar uma pesquisa publica raiz; `/verify` valida um proof de ponta a ponta.
- Divergência de raiz (se forçada) fica visível.
- Bot de TTL roda na schedule e documentado.

### **Gate de decisão (fim de S3)**
- [ ] Terceiro não-envolvido conseguiu verificar um proof? → pronto para piloto.
- [ ] Auditoria interna sem achados críticos? → mainnet pilot consideration.

---

## Sprint 4 — Piloto + submissão SCF

**Objetivo:** provar demanda (respostas reais de humanos reais) e transformar em candidatura a funding.

### Tarefas
| Trilha | Tarefa |
|---|---|
| Pilot | Definir 2 pesquisas pagas para a comunidade Stellar (ex.: feedback de builders, preferências de wallet) |
| Pilot | Financiar escrows modestos (ex.: 0.5–2 XLM/resp) e divulgar nos canais (Lumenloop/Scout/Discord) |
| Monitor | Dashboard mínimo: respostas, claim rate, custo/resp, contas análicas (idade) |
| Feedback | Entrevistar 3–5 respondedores + 1 criador; anotar objeções |
| SCF | Escrever submissão **track Build**: problema, diferencial (verificabilidade), métricas do piloto, roadmap v1 (USDC, widget, reputação); links de demo |
| Decisão | Mainnet sim/não + escopo v1 |

### DoD
- ≥ 30 respostas humanas no total; claim rate medido; 1 verificação externa concluída.
- Submissão SCF enviada com demo gravada (Loom/similar) e repo público.

---

## Tabela-resumo

| Sprint | Tema | Entregável executável | Gate |
|---|---|---|---|
| S0 | Fundação | build + dev server + ADR-001 | toolchain OK |
| S1 | Contrato | pesquisa criada/financiada via UI na testnet | eventos visíveis |
| S2 | Responder+claim | fluxo completo E2E | **go/no-go viabilidade** |
| S3 | Verificabilidade | `/verify` com proof validado | **go/no-go diferencial** |
| S4 | Piloto+SCF | dados reais + submissão | decisão mainnet |

---

## Dependências externas (antecipar)
1. **Faucet testnet** — ter saldo reservado para os 4 sprints (não depender de rate limit no meio da S2).
2. **Freighter instalado** como wallet de desenvolvimento — S0.
3. **Postgres** (Supabase ou Docker) — S0; bloqueia S2.
4. **Divulgação do piloto** (canais da comunidade) — preparar copy na S3, executar na S4.

## Fora do escapo destas sprints (v1+, não distrair)
USDC/SAC, sponsored reserves, widget/API embutida, reputação, ZK de humano único, upgrade de contrato, marketplace.
