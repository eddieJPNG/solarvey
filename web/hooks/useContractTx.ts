"use client";

/**
 * Ciclo de vida de uma transação, exposto como estado para a UI.
 *
 * Implementa o checklist §8 do SDD: loading durante a assinatura, hash
 * exibível logo após a submissão, transição pending → success/failed com
 * mensagens claras e bloqueio de double-submit.
 */
import { useCallback, useRef, useState } from "react";
import type { xdr } from "@stellar/stellar-sdk";
import { useWallet } from "@/components/WalletProvider";
import { invokeSolarvey, type InvokeResult } from "@/lib/contract";
import { SolarveyError } from "@/lib/errors";
import { FREIGHTER_NETWORK, config } from "@/lib/stellar";

export type TxPhase =
  "idle" | "preparing" | "signing" | "confirming" | "success" | "failed";

export interface TxState {
  phase: TxPhase;
  /** Preenche assim que o RPC aceita a tx — visível antes da confirmação. */
  hash: string | null;
  ledger: number | null;
  error: string | null;
  /** Código de §4.7 quando a recusa veio do contrato. */
  contractCode: number | null;
}

const IDLE: TxState = {
  phase: "idle",
  hash: null,
  ledger: null,
  error: null,
  contractCode: null,
};

const IN_FLIGHT: ReadonlySet<TxPhase> = new Set(["preparing", "signing"]);

export function useContractTx() {
  const { address, connected, network, sign, refresh } = useWallet();
  const [state, setState] = useState<TxState>(IDLE);
  // Trava síncrona: o `phase` só muda no re-render seguinte, então o ref é que
  // impede o clique duplo real.
  const inFlight = useRef(false);

  const busy = IN_FLIGHT.has(state.phase);

  const run = useCallback(
    async (method: string, args: xdr.ScVal[]): Promise<InvokeResult | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setState(IDLE);

      try {
        if (!connected || !address) {
          throw new SolarveyError("Conecte a Freighter antes de continuar.");
        }
        if (
          network !== null &&
          network.toUpperCase() !== FREIGHTER_NETWORK[config.network]
        ) {
          throw new SolarveyError(
            `A carteira está em ${network}, mas o app usa ${config.network}. ` +
              "Troque a rede na Freighter.",
          );
        }

        setState((prev) => ({ ...prev, phase: "preparing" }));
        await refresh();

        setState((prev) => ({ ...prev, phase: "signing" }));
        const result = await invokeSolarvey({
          address,
          method,
          args,
          sign: (preparedXdr) => sign(preparedXdr, config.networkPassphrase),
          onSubmitted: (hash) =>
            setState((prev) => ({ ...prev, phase: "confirming", hash })),
        });

        setState({
          phase: "success",
          hash: result.hash,
          ledger: result.ledger,
          error: null,
          contractCode: null,
        });
        return result;
      } catch (cause) {
        const error =
          cause instanceof SolarveyError
            ? cause
            : new SolarveyError(
                cause instanceof Error ? cause.message : String(cause),
              );
        // Mantém o hash, se já houver: a tx pode estar na chain mesmo com a
        // UI em falha, e o link do explorer resolve isso (§8).
        setState((prev) => ({
          ...prev,
          phase: "failed",
          error: error.message,
          contractCode: error.code,
        }));
        return null;
      } finally {
        inFlight.current = false;
      }
    },
    [address, connected, network, refresh, sign],
  );

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, busy, run, reset };
}
