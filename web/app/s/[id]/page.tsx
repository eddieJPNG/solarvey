import Link from "next/link";
import { friendlyContractError, parseContractErrorCode } from "@/lib/errors";
import { config, explorerContractUrl, sorobanRpc } from "@/lib/stellar";
import { DAY_IN_LEDGERS } from "@/lib/survey";
import styles from "./survey.module.css";

/**
 * `/s/[id]` — stub da Sprint 1.
 *
 * A Sprint 2 transforma isto no wizard de resposta (1 pergunta por tela +
 * `POST /api/surveys/{id}/responses`). Por enquanto só lê o estado on-chain,
 * o que já valida o caminho de leitura e o encaminhamento para o respondente.
 */

function formatLedgers(value: bigint): string {
  return `${value.toLocaleString("pt-BR")} (≈ ${Math.ceil(Number(value) / DAY_IN_LEDGERS)} dias)`;
}

interface SurveyView {
  id: bigint;
  owner: string;
  reward: bigint;
  maxResponses: number;
  responded: number;
  deadline: bigint;
  state: string;
}

function normalize(raw: Record<string, unknown>): SurveyView {
  // `State` é enum do contrato: `scValToNative` devolve `{ tag: "Open" }`.
  const rawState = raw.state as { tag?: unknown } | string | undefined;
  const state =
    typeof rawState === "string" ? rawState : String(rawState?.tag ?? "");

  return {
    id: BigInt(String(raw.id)),
    owner: String(raw.owner),
    reward: BigInt(String(raw.reward)),
    maxResponses: Number(raw.max_responses),
    responded: Number(raw.responded),
    deadline: BigInt(String(raw.deadline)),
    state,
  };
}

export default async function SurveyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!/^\d+$/.test(id)) {
    return (
      <main className={styles.main}>
        <h1 className={styles.title}>Identificador inválido</h1>
        <Link className={styles.link} href="/">
          ← Voltar
        </Link>
      </main>
    );
  }

  let survey: SurveyView | null = null;
  let failure: string | null = null;

  try {
    const { result } = await sorobanRpc.queryContract<Record<string, unknown>>(
      config.contractId,
      "get_survey",
      { id },
    );
    survey = normalize(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    const code = parseContractErrorCode(message);
    // `get_survey` devolve ERR_BAD_STATE(11) tanto para "não existe" quanto
    // para "não inicializado" — aqui a leitura é pública, então traduzimos.
    failure =
      code === null
        ? "Não foi possível ler esta pesquisa."
        : code === 11
          ? "Pesquisa não encontrada nesta rede."
          : friendlyContractError(code);
  }

  return (
    <main className={styles.main}>
      <Link className={styles.link} href="/">
        ← Solarvey
      </Link>

      {survey ? (
        <>
          <h1 className={styles.title}>Pesquisa #{survey.id.toString()}</h1>
          <p className={styles.badge} data-state={survey.state}>
            {survey.state === "Open" ? "Aberta" : "Fechada"}
          </p>
          <dl className={styles.meta}>
            <div>
              <dt>Recompensa</dt>
              <dd>{(Number(survey.reward) / 10_000_000).toFixed(7)} XLM</dd>
            </div>
            <div>
              <dt>Respostas</dt>
              <dd>
                {survey.responded} / {survey.maxResponses}
              </dd>
            </div>
            <div>
              <dt>Prazo (ledger)</dt>
              <dd>{formatLedgers(survey.deadline)}</dd>
            </div>
            <div>
              <dt>Criador</dt>
              <dd className={styles.mono}>
                {survey.owner.slice(0, 6)}…{survey.owner.slice(-4)}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          <h1 className={styles.title}>Pesquisa #{id}</h1>
          <p className={styles.warning} role="alert">
            {failure ?? "Pesquisa não encontrada."}
          </p>
        </>
      )}

      <section className={styles.notice}>
        <h2 className={styles.noticeTitle}>Responder chega na Sprint 2</h2>
        <p>
          O wizard de resposta (uma pergunta por tela), a gravação da resposta
          com validação do evento <code>solarvey:response</code> e o botão de
          reivindicar a recompensa estão no próximo sprint. Agora a página só
          mostra o estado on-chain.
        </p>
        <p className={styles.mono}>
          contrato{" "}
          <a
            href={explorerContractUrl(config.contractId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {config.contractId.slice(0, 8)}…{config.contractId.slice(-4)}
          </a>{" "}
          · rede {config.network}
        </p>
      </section>
    </main>
  );
}
