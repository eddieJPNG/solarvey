/**
 * Erros amigáveis — SDD §8 ("mensagens claras").
 *
 * Os códigos numéricos são os de `contracts/solarvey-escrow/src/lib.rs`
 * (§4.7). O host Soroban devolve `HostError: Error(Contract, #N)` tanto na
 * simulação quanto nos diagnostic events, então o código sai por regex.
 */

/** §4.7 — espelha o enum `Error` do contrato. */
export const CONTRACT_ERRORS: Record<
  number,
  { name: string; text: string; action?: string }
> = {
  1: {
    name: "ERR_NOT_AUTH",
    text: "Esta ação só pode ser feita pelo dono da pesquisa.",
  },
  2: { name: "ERR_CLOSED", text: "A pesquisa já foi fechada." },
  3: {
    name: "ERR_DEADLINE",
    text: "O prazo desta pesquisa já passou.",
    action: "O dono pode reembolsar o escrow e encerrar.",
  },
  4: {
    name: "ERR_FULL",
    text: "A pesquisa já atingiu o número máximo de respostas.",
  },
  5: {
    name: "ERR_ALREADY_RESPONDED",
    text: "Esta carteira já respondeu esta pesquisa.",
    action: "Uma resposta por conta — regra garantida pelo contrato.",
  },
  6: {
    name: "ERR_NO_RESPONSE",
    text: "Só é possível reivindicar depois de responder.",
  },
  7: {
    name: "ERR_ALREADY_CLAIMED",
    text: "A recompensa já foi reivindicada por esta carteira.",
  },
  8: {
    name: "ERR_INSUFFICIENT_ESCROW",
    text: "O escrow desta pesquisa não tem saldo suficiente.",
  },
  9: { name: "ERR_NOT_FUNDED", text: "A pesquisa ainda não foi financiada." },
  10: {
    name: "ERR_COUNT_MISMATCH",
    text: "O número informado não bate com as respostas registradas.",
  },
  11: {
    name: "ERR_BAD_STATE",
    text: "Operação não permitida no estado atual da pesquisa.",
  },
};

/** Erros do nosso domínio, com o código de contrato já extraído quando houver. */
export class SolarveyError extends Error {
  readonly code: number | null;
  readonly contractName: string | null;

  constructor(
    message: string,
    options: { code?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "SolarveyError";
    this.code = options.code ?? null;
    this.contractName =
      this.code !== null ? (CONTRACT_ERRORS[this.code]?.name ?? null) : null;
  }
}

/** `Error(Contract, #3)` -> 3. Devolve `null` quando não é erro de contrato. */
export function parseContractErrorCode(text: string): number | null {
  const match = /Error\(\s*Contract\s*,\s*#(\d+)\s*\)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** Texto de §4.7 em linguagem de gente, com `code` em parênteses para suporte. */
export function friendlyContractError(code: number): string {
  const entry = CONTRACT_ERRORS[code];
  if (!entry) return `O contrato recusou a operação (código ${code}).`;
  return entry.action ? `${entry.text} ${entry.action}` : entry.text;
}

const REJECTION_RE = /reject|denied|cancel|recusad|fechou a extens/i;
const ACCOUNT_RE = /account not found|does not exist|getaccount/i;
const FEE_RE = /insufficient (?:balance|fee)|txinsufficient|fee too low/i;
const NETWORK_RE = /network|passphrase/i;

/**
 * Qualquer `throw` do pipeline vira uma mensagem acionável (§8).
 *
 * A ordem importa: erro de contrato antes das heurísticas, porque o texto do
 * host também contém "balance" em erros de escrow.
 */
export function friendlyTxError(cause: unknown): SolarveyError {
  if (cause instanceof SolarveyError) return cause;

  const raw =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : JSON.stringify(cause);

  const code = parseContractErrorCode(raw);
  if (code !== null) {
    return new SolarveyError(friendlyContractError(code), { code, cause });
  }

  if (REJECTION_RE.test(raw)) {
    return new SolarveyError("Assinatura rejeitada na carteira.", { cause });
  }
  if (ACCOUNT_RE.test(raw)) {
    return new SolarveyError(
      "Conta não encontrada nesta rede. Financie-a com o Friendbot e tente de novo.",
      { cause },
    );
  }
  if (FEE_RE.test(raw)) {
    return new SolarveyError(
      "XLM insuficiente para pagar a taxa da transação.",
      { cause },
    );
  }
  if (/timeout|tempo esgotado|timed? ?out/i.test(raw)) {
    return new SolarveyError(
      "Tempo esgotado aguardando a confirmação. Recarregue para conferir o estado.",
      { cause },
    );
  }
  if (NETWORK_RE.test(raw)) {
    return new SolarveyError(
      "Problema de rede ao falar com o RPC — confira a conexão.",
      { cause },
    );
  }

  return new SolarveyError(
    "Não foi possível concluir a transação. Tente de novo.",
    { cause },
  );
}
