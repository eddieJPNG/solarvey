/**
 * Verificação headless da UI da Sprint 1 — sem carteira.
 *
 * Cobre o que é verificável em navegador puro: limites do MVP (6 perguntas ×
 * 4 opções), validação que trava a revisão e a mensagem de carteira que o
 * §8 do SDD exige quando não há Freighter conectada.
 *
 * O caminho com carteira (conectar → revisar destino/valor → assinar as duas
 * transações) está em `s1-create-sign.mjs`, que precisa do perfil gerado por
 * `onboard-freighter.mjs`.
 *
 * Uso: node e2e/s1-create-ui.mjs   (com `pnpm dev` em outro terminal)
 */
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.SOLARVEY_BASE_URL ?? "http://localhost:3000";
const failures = [];

const ok = (name, cond, extra = "") => {
  console.log(
    `${cond ? "  ok " : "FALHA"}  ${name}${extra ? ` — ${extra}` : ""}`,
  );
  if (!cond) failures.push(name);
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const questionInputs = page.locator("input[aria-label^='Enunciado']");
const optionInputs = page.locator("input[aria-label^='Opção']");

try {
  await page.goto(`${BASE}/create`, { waitUntil: "networkidle" });

  // --- estado inicial -----------------------------------------------------
  ok(
    "renderiza /create",
    (await page.locator("h1").first().innerText()) === "Criar pesquisa",
  );
  ok("1 pergunta por padrão", (await questionInputs.count()) === 1);
  ok("2 opções por padrão", (await optionInputs.count()) === 2);

  // --- limites do MVP (6 perguntas × 4 opções) ----------------------------
  for (let i = 0; i < 8; i += 1) {
    const add = page.getByRole("button", { name: "+ Adicionar pergunta" });
    if (await add.count()) await add.click();
  }
  ok("teto de 6 perguntas", (await questionInputs.count()) === 6);
  ok(
    "botão de pergunta some no teto",
    (await page
      .getByRole("button", { name: "+ Adicionar pergunta" })
      .count()) === 0,
  );

  const addOption = page
    .getByRole("button", { name: "+ Adicionar opção" })
    .first();
  for (let i = 0; i < 6; i += 1) {
    if (await addOption.count()) await addOption.click();
  }
  const firstQuestionOptions = page
    .locator("section[class*=question]")
    .first()
    .locator("input[aria-label^='Opção']");
  ok(
    "teto de 4 opções na 1ª pergunta",
    (await firstQuestionOptions.count()) === 4,
  );
  ok(
    "botão de opção some no teto",
    (await page
      .locator("section[class*=question]")
      .first()
      .getByRole("button", { name: "+ Adicionar opção" })
      .count()) === 0,
  );

  // --- validação bloqueia a revisão ---------------------------------------
  const reviewButton = page.getByRole("button", {
    name: "Revisar antes de assinar",
  });
  ok(
    "revisão bloqueada enquanto o formulário é inválido",
    await reviewButton.isDisabled(),
  );
  ok(
    "mensagens de validação visíveis",
    (await page.locator("ul[class*=validation] li").count()) > 0,
  );
  ok(
    "painel de revisão ausente",
    (await page.locator("[class*=review]").count()) === 0,
  );

  // --- sem carteira, o §8 pede conexão em vez de assinar às cegas ---------
  ok(
    "botão de conectar presente (§8)",
    (await page.getByRole("button", { name: "Conectar Freighter" }).count()) ===
      1,
  );
  ok(
    "sem exceção JavaScript não tratada",
    errors.length === 0,
    errors[0] ?? "",
  );

  mkdirSync("e2e/artifacts", { recursive: true });
  await page.screenshot({
    path: "e2e/artifacts/s1-create-form.png",
    fullPage: true,
  });
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} verificação(ões) falharam.`);
  process.exit(1);
}
console.log("\nTodas as verificações headless da UI da S1 passaram.");
