"use client";

/**
 * `/create` — Sprint 1.
 *
 * O criador monta o formulário (até 6 perguntas × 4 opções), revisa destino e
 * valor (§8) e assina duas transações: `create_survey` e `fund`. O hash
 * canônico de §5.1 é calculado aqui, antes de assinar.
 */
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { ConnectButton } from "@/components/ConnectButton";
import { TxStatus } from "@/components/TxStatus";
import { useWallet } from "@/components/WalletProvider";
import { useContractTx } from "@/hooks/useContractTx";
import { createSurveyArgs, fundArgs, xlmToStroops } from "@/lib/args";
import { explorerContractUrl, sorobanRpc } from "@/lib/stellar";
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MAX_SURVEY_DAYS,
  MIN_OPTIONS,
  daysToLedgers,
  questionsHash,
  validateSurveyContent,
  type Question,
} from "@/lib/survey";
import styles from "./create.module.css";

const STROOPS_PER_XLM = 10_000_000n;

const blankQuestion = (): Question => ({ text: "", options: ["", ""] });

export default function CreatePage() {
  const { connected, address } = useWallet();
  const tx = useContractTx();

  const [questions, setQuestions] = useState<Question[]>(() => [
    blankQuestion(),
  ]);
  const [rewardXlm, setRewardXlm] = useState("1");
  const [maxResponses, setMaxResponses] = useState("10");
  const [durationDays, setDurationDays] = useState("7");

  const [reviewing, setReviewing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<bigint | null>(null);

  /** Resumo calculado só para exibir no passo de revisão. */
  const summary = useMemo(() => {
    try {
      const reward = xlmToStroops(rewardXlm || "0");
      const max = Number(maxResponses);
      if (!Number.isInteger(max) || max < 1 || reward <= 0n) return null;
      const total = (reward * BigInt(max)) / STROOPS_PER_XLM;
      const remainder = (reward * BigInt(max)) % STROOPS_PER_XLM;
      return {
        reward,
        max,
        totalXlm: `${total}.${remainder.toString().padStart(7, "0")}`,
        days: Number(durationDays),
        ledgers: daysToLedgers(Number(durationDays) || 0),
      };
    } catch {
      return null;
    }
  }, [durationDays, maxResponses, rewardXlm]);

  const update = useCallback((index: number, patch: Partial<Question>) => {
    setQuestions((prev) =>
      prev.map((q, i) => (i === index ? { ...q, ...patch } : q)),
    );
    setReviewing(false);
  }, []);

  const updateOption = useCallback(
    (qIndex: number, oIndex: number, value: string) => {
      setQuestions((prev) =>
        prev.map((q, i) =>
          i === qIndex
            ? {
                ...q,
                options: q.options.map((o, j) => (j === oIndex ? value : o)),
              }
            : q,
        ),
      );
      setReviewing(false);
    },
    [],
  );

  const addQuestion = useCallback(() => {
    setQuestions((prev) =>
      prev.length < MAX_QUESTIONS ? [...prev, blankQuestion()] : prev,
    );
    setReviewing(false);
  }, []);

  const removeQuestion = useCallback((index: number) => {
    setQuestions((prev) =>
      prev.length > 1 ? prev.filter((_, i) => i !== index) : prev,
    );
    setReviewing(false);
  }, []);

  const addOption = useCallback((qIndex: number) => {
    setQuestions((prev) =>
      prev.map((q, i) =>
        i === qIndex && q.options.length < MAX_OPTIONS
          ? { ...q, options: [...q.options, ""] }
          : q,
      ),
    );
    setReviewing(false);
  }, []);

  const removeOption = useCallback((qIndex: number, oIndex: number) => {
    setQuestions((prev) =>
      prev.map((q, i) =>
        i === qIndex && q.options.length > MIN_OPTIONS
          ? { ...q, options: q.options.filter((_, j) => j !== oIndex) }
          : q,
      ),
    );
    setReviewing(false);
  }, []);

  const validation = useMemo(
    () => validateSurveyContent({ questions }),
    [questions],
  );

  function handleReview(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    if (validation.length > 0) {
      setFormError(validation[0]);
      return;
    }
    if (!summary) {
      setFormError("Confira recompensa, respostas e duração.");
      return;
    }
    if (!connected || !address) {
      setFormError("Conecte a Freighter para continuar.");
      return;
    }
    setReviewing(true);
  }

  async function handleConfirm() {
    if (!address || !summary) return;
    setFormError(null);

    try {
      const hash = await questionsHash({ questions });
      const { sequence } = await sorobanRpc.getLatestLedger();
      const deadline = BigInt(sequence + summary.ledgers);

      const created = await tx.run(
        "create_survey",
        createSurveyArgs({
          owner: address,
          questionsHash: hash,
          reward: summary.reward,
          maxResponses: summary.max,
          deadline,
        }),
      );
      if (!created) return;

      const id = BigInt(String(created.returnValue));
      const funded = await tx.run("fund", fundArgs(address, id));
      if (!funded) return;

      setCreatedId(id);
      setReviewing(false);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div>
          <Link href="/" className={styles.back}>
            ← Solarvey
          </Link>
          <h1 className={styles.title}>Criar pesquisa</h1>
        </div>
        <ConnectButton />
      </header>

      <p className={styles.lede}>
        Até {MAX_QUESTIONS} perguntas com {MAX_OPTIONS} opções cada. A
        recompensa fica travada em escrow on-chain e cada respondente recebe ao
        confirmar a resposta.
      </p>

      {createdId !== null && (
        <section className={styles.done} role="status">
          <h2 className={styles.doneTitle}>
            Pesquisa #{String(createdId)} criada
          </h2>
          <p className={styles.doneText}>
            Escrow financiado. Compartilhe o link dos respondentes:
          </p>
          <p className={styles.doneLink}>
            <code>/s/{String(createdId)}</code>
          </p>
          <Link className={styles.doneButton} href={`/s/${String(createdId)}`}>
            Abrir página de resposta
          </Link>
        </section>
      )}

      <form className={styles.form} onSubmit={handleReview}>
        <fieldset className={styles.fieldset} disabled={tx.busy}>
          <legend className={styles.legend}>Perguntas</legend>

          {questions.map((question, qIndex) => (
            <section key={qIndex} className={styles.question}>
              <div className={styles.questionHead}>
                <span className={styles.badge}>Pergunta {qIndex + 1}</span>
                {questions.length > 1 && (
                  <button
                    type="button"
                    className={styles.remove}
                    onClick={() => removeQuestion(qIndex)}
                  >
                    Remover
                  </button>
                )}
              </div>

              <input
                className={styles.input}
                value={question.text}
                onChange={(e) => update(qIndex, { text: e.target.value })}
                placeholder="Enunciado da pergunta"
                aria-label={`Enunciado da pergunta ${qIndex + 1}`}
              />

              <ul className={styles.options}>
                {question.options.map((option, oIndex) => (
                  <li key={oIndex} className={styles.optionRow}>
                    <input
                      className={styles.input}
                      value={option}
                      onChange={(e) =>
                        updateOption(qIndex, oIndex, e.target.value)
                      }
                      placeholder={`Opção ${oIndex + 1}`}
                      aria-label={`Opção ${oIndex + 1} da pergunta ${qIndex + 1}`}
                    />
                    {question.options.length > MIN_OPTIONS && (
                      <button
                        type="button"
                        className={styles.remove}
                        onClick={() => removeOption(qIndex, oIndex)}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              {question.options.length < MAX_OPTIONS && (
                <button
                  type="button"
                  className={styles.addSmall}
                  onClick={() => addOption(qIndex)}
                >
                  + Adicionar opção
                </button>
              )}
            </section>
          ))}

          {questions.length < MAX_QUESTIONS && (
            <button type="button" className={styles.add} onClick={addQuestion}>
              + Adicionar pergunta
            </button>
          )}
        </fieldset>

        <fieldset className={styles.fieldset} disabled={tx.busy}>
          <legend className={styles.legend}>Escrow</legend>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Recompensa por resposta (XLM)</span>
              <input
                className={styles.input}
                inputMode="decimal"
                value={rewardXlm}
                onChange={(e) => setRewardXlm(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Máximo de respostas</span>
              <input
                className={styles.input}
                inputMode="numeric"
                value={maxResponses}
                onChange={(e) => setMaxResponses(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Duração (dias, máx. {MAX_SURVEY_DAYS})</span>
              <input
                className={styles.input}
                inputMode="numeric"
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
              />
            </label>
          </div>
          {summary && (
            <p className={styles.total}>
              Total travado em escrow: <strong>{summary.totalXlm} XLM</strong> (
              {summary.max} × {rewardXlm} XLM)
            </p>
          )}
        </fieldset>

        {formError && (
          <p className={styles.error} role="alert">
            {formError}
          </p>
        )}
        {validation.length > 0 && !formError && (
          <ul className={styles.validation}>
            {validation.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}

        {!reviewing ? (
          <button
            type="submit"
            className={styles.primary}
            disabled={validation.length > 0 || tx.busy}
          >
            Revisar antes de assinar
          </button>
        ) : (
          <section className={styles.review}>
            <h2 className={styles.reviewTitle}>Confira antes de assinar</h2>
            <dl className={styles.reviewList}>
              <div>
                <dt>Destino do escrow</dt>
                <dd>
                  <a
                    href={explorerContractUrl(
                      process.env.NEXT_PUBLIC_SOLARVEY_CONTRACT_ID ?? "",
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    contrato Solarvey
                  </a>
                </dd>
              </div>
              <div>
                <dt>Valor travado</dt>
                <dd>{summary?.totalXlm} XLM</dd>
              </div>
              <div>
                <dt>Perguntas / respostas</dt>
                <dd>
                  {questions.length} × {summary?.max}
                </dd>
              </div>
              <div>
                <dt>Duração</dt>
                <dd>
                  {durationDays} dias (
                  {summary?.ledgers.toLocaleString("pt-BR")} ledgers)
                </dd>
              </div>
            </dl>
            <p className={styles.reviewNote}>
              Serão duas transações: <code>create_survey</code> e{" "}
              <code>fund</code>. A Freighter pedirá a assinatura de cada uma.
            </p>
            <div className={styles.reviewActions}>
              <button
                type="button"
                className={styles.primary}
                onClick={() => void handleConfirm()}
                disabled={tx.busy}
              >
                {tx.busy ? "Processando…" : "Criar e financiar"}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setReviewing(false)}
                disabled={tx.busy}
              >
                Voltar e editar
              </button>
            </div>
          </section>
        )}
      </form>

      <TxStatus
        phase={tx.phase}
        hash={tx.hash}
        ledger={tx.ledger}
        error={tx.error}
        onDismiss={tx.reset}
      />
    </main>
  );
}
