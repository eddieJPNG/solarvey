/**
 * JSON canônico — SDD §5.1.
 *
 * Regras do SDD:
 *  - serialização **sem espaços**;
 *  - chaves em **ordem lexicográfica**;
 *  - array `answers` preserva a ordem do formulário (a ordem é o dado).
 *
 * O SDD exemplifica `JSON.stringify({ surveyId, answers })`, cuja ordem de
 * inserção (surveyId antes de answers) **não** é lexicográfica; a regra
 * escrita vence o exemplo, então as chaves são ordenadas recursivamente — é
 * o "canonical JSON util no web" que o próprio SDD pede.
 */

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Devolve uma cópia com todas as chaves (em todo o nível) em ordem lexicográfica. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;

  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    // Campos undefined são omitidos pelo JSON.stringify — reproduzimos isso
    // para que a forma canônica seja idêntica à string final.
    if (entry !== undefined) out[key] = canonicalize(entry);
  }
  return out;
}

/** `{"answers":[0,2],"surveyId":1}` — sem espaços, chaves ordenadas. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
