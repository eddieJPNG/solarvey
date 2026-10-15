/**
 * Onboarding da Freighter para o e2e: importa a carteira testnet do `.env`.
 *
 * Uso: node e2e/onboard-freighter.mjs
 * Lê CREATOR_SEED/ADMIN_SEED do .env da raiz e para em cada etapa com um
 * dump de texto + screenshot, para depurar onde a UI mudou.
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const EXT = "/tmp/opencode/freighter/ext";
const PROFILE = "/tmp/opencode/freighter-profile";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raiz do repositório, relativa a este arquivo (web/e2e/).
const REPO = new URL("../../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(fileURLToPath(new URL(".env", REPO)), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
      ];
    }),
);
const SEED = env.CREATOR_SEED;
if (!SEED) throw new Error("falta CREATOR_SEED no .env");

const step = async (page, label) => {
  await sleep(2500);
  console.log(`\n=== ${label} :: ${page.url()} ===`);
  const t = await page
    .locator("body")
    .innerText()
    .catch(() => "(vazio)");
  console.log(t.slice(0, 700).replace(/\n{3,}/g, "\n\n"));
  const buttons = [];
  for (const b of await page.locator("button").all()) {
    const txt = (await b.innerText().catch(() => ""))
      .trim()
      .replace(/\s+/g, " ");
    if (txt && (await b.isVisible())) buttons.push(txt);
  }
  console.log("botões:", JSON.stringify(buttons));
  for (const i of await page.locator("input").all()) {
    if (!(await i.isVisible())) continue;
    console.log(
      "  input:",
      (await i.getAttribute("type")) ?? "text",
      "| placeholder:",
      (await i.getAttribute("placeholder")) ?? "-",
      "| name:",
      (await i.getAttribute("name")) ?? "-",
    );
  }
  for (const cb of await page.locator("input[type=checkbox]").all()) {
    console.log("  checkbox marcada:", await cb.isChecked());
  }
  await page.screenshot({
    path: `/tmp/opencode/freighter-${label}.png`,
    fullPage: true,
  });
};

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await sleep(4000);

// A extensão costuma abrir `index.html#/welcome` sozinha; se não abrir, a
// página nova navega para lá usando o host do service worker.
const extId = new URL(context.serviceWorkers()[0].url()).host;
const page =
  context.pages().find((p) => p.url().includes("index.html")) ??
  (await context.newPage());
if (!page.url().includes("index.html")) {
  await page.goto(`chrome-extension://${extId}/index.html`);
}
await step(page, "1-welcome");

await page.getByRole("button", { name: "Já tenho uma carteira" }).click();
await step(page, "2-import");

// --- senha + termos -------------------------------------------------------
// O `<input type=checkbox>` é controlado pelo React e o `<label>` envolve um
// SVG que intercepta o ponteiro. Um click sintético bolha até o handler.
await page.locator("input[name=termsOfUse]").dispatchEvent("click");
await sleep(400);
console.log(
  "termos marcados:",
  await page.locator("input[name=termsOfUse]").isChecked(),
);
const PASSWORD = "Solarvey-e2e-2026";
const pwFields = page.locator("input[type=password]");
const pwCount = await pwFields.count();
console.log(`campos de senha: ${pwCount}`);
for (let i = 0; i < pwCount; i += 1) await pwFields.nth(i).fill(PASSWORD);
console.log(
  "valores preenchidos:",
  await page.evaluate(() =>
    Array.from(document.querySelectorAll("input[type=password]")).map(
      (i) => i.value.length,
    ),
  ),
);
await step(page, "3-password");

// --- frase de recuperação -------------------------------------------------
// Só aparece depois que a senha é confirmada.
const passwordConfirm = page.getByRole("button", { name: "Confirmar" });
if (!(await passwordConfirm.isEnabled())) {
  console.log("Confirmar desabilitado (senha/termos incompletos) — parando.");
  await context.close();
  process.exit(1);
}
await passwordConfirm.click();
await sleep(1500);

const words = SEED.trim().split(/\s+/);
console.log(`seed com ${words.length} palavras`);
if (words.length !== 12) {
  // "12 word"/"24 word" são duas <div> sem classe nem handler visível; nem
  // click sintético nem click normal registram. Tenta em cascata.
  const toggle = page.getByText(`${words.length} word`, { exact: true });
  const strategies = [
    async () => {
      const box = await toggle.boundingBox();
      if (box)
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
    () => toggle.locator("xpath=..").dispatchEvent("click"),
    () => toggle.locator("xpath=..").click({ force: true }),
  ];
  for (const attempt of strategies) {
    await attempt().catch(() => {});
    await sleep(900);
    const n = await page.locator("input[name^=MnemonicPhrase]").count();
    console.log(
      `inputs de mnemonic após tentativa: ${n} (esperado ${words.length})`,
    );
    if (n === words.length) break;
  }
}
// A própria tela diz "Você também pode colar a frase na primeira caixa",
// então a seed inteira vai no campo 01 e a Freighter separa as palavras.
await page.locator("input[name=MnemonicPhrase-1]").fill(SEED.trim());
await sleep(1200);
const filled = await page.evaluate(
  () =>
    Array.from(document.querySelectorAll("input[name^=MnemonicPhrase]")).filter(
      (i) => i.value.trim().length > 0,
    ).length,
);
console.log(
  `campos de mnemonic preenchidos: ${filled} (de ${words.length} palavras)`,
);
await step(page, "4-mnemonic");

await page.getByRole("button", { name: "Importar" }).click();
await step(page, "5-after-import");

await context.close();
