/**
 * Pipeline de invocação do contrato — SDD §3.3/§8.
 *
 * Monta a tx → simula (`prepareTransaction`, que também gera o SorobanData) →
 * manda assinar na Freighter → envia → aguarda confirmação. Cada passo vira
 * um estado da UI (§8: loading na assinatura, hash imediatamente após enviar,
 * pending → success/failed).
 */
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { config, sorobanRpc } from "./stellar";
import {
  SolarveyError,
  friendlyContractError,
  friendlyTxError,
} from "./errors";

export interface InvokeOptions {
  /** Conta que invoca (também é a que paga a taxa). */
  address: string;
  method: string;
  args: xdr.ScVal[];
  /** Assina o XDR já preparado e devolve o XDR assinado. */
  sign: (preparedXdr: string) => Promise<string>;
  /** Chamado assim que o RPC aceita a tx — é quando o hash pode ir para a UI. */
  onSubmitted?: (hash: string) => void;
  timeoutSeconds?: number;
}

export interface InvokeResult {
  hash: string;
  ledger: number;
  /** Valor de retorno da função (§4.3) — `create_survey` devolve o id. */
  returnValue: unknown;
}

/**
 * O `ScVal` de erro do host vira `{ type: "contract", code: 3 }` — devolve o
 * número quando for erro de contrato (§4.7), senão `null`.
 */
function codeFromScVal(value: xdr.ScVal): number | null {
  try {
    const native: unknown = scValToNative(value);
    if (
      typeof native === "object" &&
      native !== null &&
      "type" in native &&
      "code" in native &&
      (native as { type: unknown }).type === "contract"
    ) {
      return Number((native as { code: unknown }).code);
    }
  } catch {
    // ScVal sem conversão para valor nativo — não carrega o código de §4.7.
  }
  return null;
}

/** Varre os diagnostic events de uma tx que falhou procurando o código. */
function codeFromDiagnosticEvents(
  events: xdr.DiagnosticEvent[] | undefined,
): number | null {
  for (const diagnostic of events ?? []) {
    const body = diagnostic.event.body;
    if (body.type !== "v0") continue;
    for (const candidate of [...body.v0.topics, body.v0.data]) {
      const code = codeFromScVal(candidate);
      if (code !== null) return code;
    }
  }
  return null;
}

/** `Error(Contract, #3)` — reserva para o caminho de simulação. */
function codeFromHostMessage(message: string): number | null {
  const match = /Error\(\s*Contract\s*,\s*#(\d+)\s*\)/.exec(message);
  return match ? Number(match[1]) : null;
}

function rejected(code: number | null, cause?: unknown): SolarveyError {
  return code !== null
    ? new SolarveyError(friendlyContractError(code), { code, cause })
    : friendlyTxError(cause ?? "Operação recusada.");
}

/**
 * Executa uma função do contrato de ponta a ponta.
 *
 * Lança `SolarveyError` com `code` preenchido quando a recusa veio de §4.7.
 */
export async function invokeSolarvey({
  address,
  method,
  args,
  sign,
  onSubmitted,
  timeoutSeconds = 180,
}: InvokeOptions): Promise<InvokeResult> {
  if (!config.contractId) {
    throw new SolarveyError(
      "Contrato não configurado — defina NEXT_PUBLIC_SOLARVEY_CONTRACT_ID.",
    );
  }

  let account;
  try {
    account = await sorobanRpc.getAccount(address);
  } catch (cause) {
    throw friendlyTxError(cause);
  }

  const contract = new Contract(config.contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(timeoutSeconds)
    .build();

  let prepared;
  try {
    prepared = await sorobanRpc.prepareTransaction(tx);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw rejected(codeFromHostMessage(message), cause);
  }

  let signedXdr: string;
  try {
    signedXdr = await sign(prepared.toXDR());
  } catch (cause) {
    throw friendlyTxError(cause);
  }

  let sent;
  try {
    sent = await sorobanRpc.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase),
    );
  } catch (cause) {
    throw friendlyTxError(cause);
  }

  if (sent.status === "ERROR") {
    throw rejected(codeFromDiagnosticEvents(sent.diagnosticEvents));
  }

  // §8 — o hash é exibível antes da confirmação.
  onSubmitted?.(sent.hash);

  const final = await pollUntilSettled(sent.hash, timeoutSeconds);

  if (final.status === "FAILED") {
    throw rejected(codeFromDiagnosticEvents(final.diagnosticEventsXdr));
  }
  if (final.status !== "SUCCESS") {
    throw new SolarveyError(
      "Não foi possível confirmar a transação. Recarregue para conferir o estado.",
    );
  }

  return {
    hash: sent.hash,
    ledger: final.ledger,
    returnValue: final.returnValue ? scValToNative(final.returnValue) : null,
  };
}

/**
 * `pollTransaction` é limitado em tentativas; aqui repetimos até assentar ou
 * estourar o orçamento de tempo, que é o estado "confirmando" da UI.
 */
async function pollUntilSettled(hash: string, timeoutSeconds: number) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const info = await sorobanRpc.pollTransaction(hash);
    if (info.status !== "NOT_FOUND") return info;
    if (Date.now() > deadline) return info;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
