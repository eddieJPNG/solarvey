/**
 * Construtores de `ScVal` para as funções de §4.3.
 *
 * Os tipos batem literalmente com a assinatura do contrato: `Address`,
 * `BytesN<32>`, `i128`, `u32`, `u64`. `u64`/`i128` passam por `BigInt` porque
 * `reward` e `deadline` estouram o `number` do JS.
 */
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

const STROOPS_PER_XLM = 10_000_000n;

export function argAddress(address: string): xdr.ScVal {
  return nativeToScVal(address, { type: "address" });
}

export function argU32(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

export function argU64(value: bigint | number): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "u64" });
}

export function argI128(value: bigint | string): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "i128" });
}

/** `BytesN<32>` — o `questions_hash` chega em hex minúsculo (SDD §5.1). */
export function argBytes32(hex: string): xdr.ScVal {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(
      `questions_hash inválido (esperado 32 bytes em hex): ${hex}`,
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return nativeToScVal(bytes, { type: "bytes" });
}

export function xlmToStroops(xlm: number | string): bigint {
  const [units, decimals = ""] = String(xlm).split(".");
  if (decimals.length > 7) {
    throw new Error("XLM aceita no máximo 7 casas decimais (stroops).");
  }
  const padded = decimals.padEnd(7, "0");
  return BigInt(units || "0") * STROOPS_PER_XLM + BigInt(padded || "0");
}

export interface CreateSurveyArgs {
  owner: string;
  questionsHash: string;
  /** Em stroops (`1 XLM = 10_000_000`). */
  reward: bigint;
  maxResponses: number;
  /** Ledger — não timestamp: `submit` compara com `env.ledger().sequence()`. */
  deadline: bigint;
}

/** `create_survey(env, owner, questions_hash, reward, max_responses, deadline)` */
export function createSurveyArgs({
  owner,
  questionsHash,
  reward,
  maxResponses,
  deadline,
}: CreateSurveyArgs): xdr.ScVal[] {
  return [
    argAddress(owner),
    argBytes32(questionsHash),
    argI128(reward),
    argU32(maxResponses),
    argU64(deadline),
  ];
}

/** `fund(env, owner, id)` — transfere `reward × max_responses` para o escrow. */
export function fundArgs(owner: string, id: bigint): xdr.ScVal[] {
  return [argAddress(owner), argU64(id)];
}
