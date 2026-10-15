"use client";

/**
 * Painel de estado da transação — SDD §8.
 *
 * Mostra loading durante a assinatura, o hash imediatamente após a submissão
 * (com link para o explorer) e a transição pendente → sucesso/falha.
 */
import type { TxPhase } from "@/hooks/useContractTx";
import { explorerTxUrl, shortAddress } from "@/lib/stellar";
import styles from "./TxStatus.module.css";

export interface TxStatusProps {
  phase: TxPhase;
  hash: string | null;
  ledger: number | null;
  error: string | null;
  onDismiss?: () => void;
}

const PHASE_TEXT: Partial<Record<TxPhase, string>> = {
  preparing: "Simulando a transação…",
  signing: "Aguardando assinatura na Freighter…",
  confirming: "Enviada — aguardando confirmação na rede…",
  success: "Confirmado on-chain.",
  failed: "A transação falhou.",
};

export function TxStatus({
  phase,
  hash,
  ledger,
  error,
  onDismiss,
}: TxStatusProps) {
  if (phase === "idle") return null;

  const label = PHASE_TEXT[phase];
  const pending = phase === "preparing" || phase === "signing";

  return (
    <section
      className={styles.box}
      data-phase={phase}
      role={phase === "failed" ? "alert" : "status"}
      aria-live="polite"
    >
      <p className={styles.phase}>
        {pending && <span className={styles.spinner} aria-hidden="true" />}
        {label}
      </p>

      {hash && (
        <p className={styles.hash}>
          Tx{" "}
          <a
            href={explorerTxUrl(hash)}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.hashLink}
          >
            {shortAddress(hash, 8, 8)}
          </a>
          {ledger !== null && (
            <span className={styles.ledger}> · ledger {ledger}</span>
          )}
        </p>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {onDismiss && (
        <button type="button" className={styles.dismiss} onClick={onDismiss}>
          Fechar
        </button>
      )}
    </section>
  );
}
