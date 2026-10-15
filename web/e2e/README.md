# e2e — scripts de verificação

Scripts de execução real em navegador. Não fazem parte do `pnpm test` (que é só
o contrato); rodam manualmente porque dependem de rede, de extensão e de
servidor de pé.

## Pré-requisitos comuns

```bash
pnpm dev                 # em outro terminal — http://localhost:3000
```

## Scripts

| Script                  | O que verifica                                                                                        | Precisa de                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------- |
| `s1-create-ui.mjs`      | limites do formulário (6q × 4op), validação que trava a revisão, ausência de exceções — tudo headless | só o dev server                   |
| `onboard-freighter.mjs` | implanta a Freighter no perfil de teste (importa o `CREATOR_SEED` do `.env`)                          | uma vez; gera o perfil            |
| `s1-create-sign.mjs`    | **DoD da S1**: conectar → preencher → revisar destino/valor (§8) → assinar `create_survey` e `fund`   | perfil do onboarding + dev server |

```bash
node e2e/s1-create-ui.mjs
node e2e/onboard-freighter.mjs     # só na primeira vez
node e2e/s1-create-sign.mjs
```

Os artefatos (PNG) caem em `e2e/artifacts/`.

## O que a extensão exige

A Freighter é carregada como extensão _unpacked_ a partir de
`/tmp/opencode/freighter/ext` (baixada da Chrome Web Store e extraída de dentro
do cabeçalho CRX3), num perfil persistente em `/tmp/opencode/freighter-profile`.

Duas peculiaridades da UI da extensão que os scripts contornam — o click normal
não chega ao handler porque um SVG/decorativo intercepta o ponteiro, então usa-se
`dispatchEvent("click")`:

- o checkbox "Li e concordo com Termos de Uso";
- o seletor de rede (`AccountHeader__network-selector__row`) — o ✓ é a prova
  de qual rede está ativa e é lido de volta para não assumir.

Os prompts da extensão (conectar / assinar) são aprovados por um observador de
novas páginas.
