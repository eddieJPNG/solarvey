/**
 * SHA-256 — SDD §5.1 (`questions_hash` e `response_hash`).
 *
 * O SDD cita `sha2` no contrato e `node:crypto` no web. Aqui usamos a
 * **Web Crypto** (`crypto.subtle`), exposta globalmente pelo Node ≥ 18 e por
 * todo browser: mesmo algoritmo/digest, e o **mesmo módulo** serve a route
 * handlers e o cliente. O valor é fixado por teste com vetor conhecido
 * (SDD §10, trilha "API"), então a equivalência é verificada, não assumida.
 */
import { canonicalJson } from "./canonical";

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function digest(input: string): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "crypto.subtle indisponível — requer contexto seguro (https ou localhost)",
    );
  }
  const buf = await subtle.digest("SHA-256", encoder.encode(input));
  return new Uint8Array(buf);
}

/** SHA-256 de uma string UTF-8, como bytes (formato esperado por `BytesN<32>`). */
export async function sha256Bytes(input: string): Promise<Uint8Array> {
  return digest(input);
}

/** SHA-256 de uma string UTF-8, em hex minúsculo. */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await digest(input));
}

/** SHA-256 de um valor já convertido para JSON canônico (§5.1). */
export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** Idem, devolvendo os 32 bytes para montar a `BytesN<32>` da tx. */
export async function hashCanonicalBytes(value: unknown): Promise<Uint8Array> {
  return sha256Bytes(canonicalJson(value));
}
