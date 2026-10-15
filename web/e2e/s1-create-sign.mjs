/**
 * Sprint 1 — verificação ponta a ponta pela UI (DoD do plano).
 *
 * Fluxo: destrava a Freighter do perfil persistido → muda para testnet →
 * abre `/create` → conecta → preenche → revisa (destino + valor, §8) →
 * assina `create_survey` e `fund`. Os prompts da extensão são aprovados por
 * um observador de novas páginas.
 *
 * Pré-requisitos:
 *   - `pnpm dev` em http://localhost:3000
 *   - perfil gerado por `node e2e/onboard-freighter.mjs`
 *
 * Uso: node e2e/s1-create-sign.mjs
 */
import { chromium } from "@playwright/test";

const EXT = "/tmp/opencode/freighter/ext";
const PROFILE = "/tmp/opencode/freighter-profile";
const BASE = process.env.SOLARVEY_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "Solarvey-e2e-2026";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await sleep(4000);

const extId = new URL(context.serviceWorkers()[0].url()).host;

// --- aprovador automático de prompts da extensão ---------------------------
const prompts = [];
context.on("page", async (p) => {
  await p.waitForLoadState("domcontentloaded").catch(() => {});
  if (!p.url().startsWith(`chrome-extension://${extId}`)) return;
  await sleep(1500);
  const text = (
    await p
      .locator("body")
      .innerText()
      .catch(() => "")
  ).slice(0, 400);
  prompts.push({ url: p.url(), text: text.replace(/\s+/g, " ").slice(0, 160) });
  console.log(
    `  [prompt] ${p.url().split("#")[1] ?? ""} :: ${prompts.at(-1).text}`,
  );

  // Os botões reais são varridos via evaluate: a página re-renderiza e os
  // handles de `locator.all()` passam a reportar `isVisible() === false`.
  console.log(
    "  [prompt] controles:",
    JSON.stringify(
      await p.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            "button, a, input[type=submit], [role=button]",
          ),
        )
          .filter((e) => e.offsetParent !== null)
          .map(
            (e) =>
              `${e.tagName}[${(e.innerText || e.value || "").trim().replace(/\s+/g, " ").slice(0, 30)}]`,
          )
          .slice(0, 14),
      ),
    ),
  );
  // Reconsulta no momento do clique: a página re-renderiza e os handles
  // antigos passam a reportar isVisible() === false.
  const approve = p
    .getByRole("button", {
      name: /Conectar|Assinar|Aprovar|Confirmar|Permitir|Continuar/i,
    })
    .filter({ hasNotText: /Cancelar|Rejeitar|Recusar/i });
  if (await approve.count()) {
    const label = (await approve.first().innerText())
      .trim()
      .replace(/\s+/g, " ");
    console.log(`  [prompt] aprovando com "${label}"`);
    await approve
      .first()
      .click({ force: true })
      .catch((e) => console.log("  [prompt] falha:", e.message.split("\n")[0]));
    return;
  }
  console.log("  [prompt] nenhum botão de aprovar reconhecido");
});

// --- 1. destravar + testnet ------------------------------------------------
const ext = await context.newPage();
await ext.goto(`chrome-extension://${extId}/index.html`);
await sleep(2500);

if (ext.url().includes("unlock")) {
  await ext.locator("input[type=password]").first().fill(PASSWORD);
  await ext.getByRole("button", { name: "Desbloquear" }).click();
  await sleep(2500);
}
console.log("freighter:", ext.url().split("#")[1] ?? ext.url());

// O ✓ marca a rede ativa. O clique normal não registra (o handler vive no
// `.row` e o ponteiro é interceptado); um click sintético chega nele.
const activeNetwork = () =>
  ext.evaluate(() => {
    const item = Array.from(
      document.querySelectorAll(".AccountHeader__options__item"),
    ).find((i) => i.querySelector(".AccountHeader__network-selector__check"));
    return item ? (item.textContent ?? "").trim() : "(nenhuma)";
  });

if ((await activeNetwork()) !== "Testnet") {
  await ext
    .locator(".AccountHeader__options__item")
    .filter({ hasText: "Testnet" })
    .locator(".AccountHeader__network-selector__row")
    .first()
    .dispatchEvent("click");
  await sleep(1400);
}
const network = await activeNetwork();
console.log("rede ativa na Freighter:", network);
if (network !== "Testnet") {
  console.log("não consegui trocar para testnet — parando.");
  await context.close();
  process.exit(1);
}

// --- 2. conectar no app ----------------------------------------------------
const page = await context.newPage();
await page.goto(`${BASE}/create`, { waitUntil: "networkidle" });

// O app restaura a sessão salva; se a permissão já foi concedida nesta origem,
// ele conecta sozinho e o botão nem aparece.
const connectButton = page.getByRole("button", { name: "Conectar Freighter" });
if (await connectButton.count()) {
  await connectButton.click();
  await sleep(6000);
} else {
  await sleep(2000);
}

const headerText = await page
  .locator("header")
  .first()
  .innerText()
  .catch(() => "");
console.log(
  "header após conectar:",
  headerText.replace(/\s+/g, " ").slice(0, 160),
);

const connected = /GCCP|GBFI|GA6OF|[A-Z0-9]{8}/.test(headerText);
console.log("conectado:", connected);
await page.screenshot({
  path: "/tmp/opencode/s1-connected.png",
  fullPage: true,
});

if (!connected) {
  console.log(
    "não conectou — prompts vistos:",
    JSON.stringify(prompts, null, 1),
  );
  await context.close();
  process.exit(1);
}

// --- 3. preencher e revisar -----------------------------------------------
await page
  .locator("input[aria-label^='Enunciado']")
  .first()
  .fill("Você recomendaria o produto?");
await page.locator("input[aria-label^='Opção']").nth(0).fill("Sim");
await page.locator("input[aria-label^='Opção']").nth(1).fill("Não");
await page.getByLabel("Recompensa por resposta (XLM)").fill("0.5");
await page.getByLabel("Máximo de respostas").fill("2");
await page.getByLabel(/^Duração/).fill("7");

await page.getByRole("button", { name: "Revisar antes de assinar" }).click();
const review = (
  await page.locator("[class*=review]").first().innerText()
).replace(/\s+/g, " ");
console.log("revisão:", review.slice(0, 200));

// --- 4. assinar as duas transações ----------------------------------------
await page.getByRole("button", { name: "Criar e financiar" }).click();

let success = false;
for (let i = 0; i < 60; i += 1) {
  await sleep(2000);
  const phase = await page
    .locator("[data-phase]")
    .first()
    .getAttribute("data-phase")
    .catch(() => null);
  if (phase === "success" || phase === "failed") {
    console.log("fase final:", phase);
    success = phase === "success";
    break;
  }
}

const status = await page
  .locator("[role=status], [role=alert]")
  .first()
  .innerText()
  .catch(() => "");
console.log("status:", status.replace(/\s+/g, " ").slice(0, 300));
console.log(
  "criado:",
  (await page.locator("body").innerText()).match(/Pesquisa #\d+/)?.[0] ??
    "(sem id)",
);

await page.screenshot({ path: "/tmp/opencode/s1-result.png", fullPage: true });
await context.close();
process.exit(success ? 0 : 1);
