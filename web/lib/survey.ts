/**
 * Formulário de pesquisa — regras de formato do SDD §1.1/§5.1.
 *
 * O contrato **não valida conteúdo** (só o hash), então a validação 6q/4opções
 * acontece aqui, na criação (limitação assumida e documentada no §5.1).
 */
import { hashCanonical } from "./hash";

/** Máximo de perguntas (SDD §1.1). */
export const MAX_QUESTIONS = 6;
/** Máximo de opções por pergunta (SDD §1.1). */
export const MAX_OPTIONS = 4;
/** Mínimo de perguntas — 1 pesquisas sem pergunta não é pesquisa. */
export const MIN_QUESTIONS = 1;
/**
 * Mínimo de opções — o SDD só fixa o máximo, mas uma "escolha" com 1 opção
 * não é escolha; abaixo de 2 não há o que responder.
 */
export const MIN_OPTIONS = 2;

export interface Question {
  text: string;
  options: string[];
}

export interface SurveyContent {
  questions: Question[];
}

/** Erros de formato, na ordem em que devem aparecer ao usuário. */
export function validateSurveyContent(content: SurveyContent): string[] {
  const errors: string[] = [];
  const questions = content.questions ?? [];

  if (questions.length < MIN_QUESTIONS) {
    errors.push(`A pesquisa precisa de ao menos ${MIN_QUESTIONS} pergunta.`);
  }
  if (questions.length > MAX_QUESTIONS) {
    errors.push(`Máximo de ${MAX_QUESTIONS} perguntas no MVP.`);
  }

  questions.forEach((question, index) => {
    const label = `Pergunta ${index + 1}`;
    if (!question.text.trim()) errors.push(`${label}: texto vazio.`);
    if (question.options.length < MIN_OPTIONS) {
      errors.push(`${label}: mínimo de ${MIN_OPTIONS} opções.`);
    }
    if (question.options.length > MAX_OPTIONS) {
      errors.push(`${label}: máximo de ${MAX_OPTIONS} opções.`);
    }
    question.options.forEach((option, optionIndex) => {
      if (!option.trim()) {
        errors.push(`${label}: opção ${optionIndex + 1} vazia.`);
      }
    });
  });

  return errors;
}

/**
 * `questions_hash` (SDD §5.1) — SHA-256 do JSON canônico do formulário.
 * O mesmo esquema é usado para o `response_hash`.
 */
export async function questionsHash(content: SurveyContent): Promise<string> {
  return hashCanonical(content);
}

/* ------------------------------------------------------------------ prazo
   O contrato trabalha em **ledgers**, não em datas: `submit` compara
   `env.ledger().sequence()` com `deadline`. As constantes abaixo espelham
   §4.2 de `contracts/solarvey-escrow/src/lib.rs`.                          */

/** §4.2 — ~5 s por ledger ⇒ 17 280 ledgers por dia. */
export const DAY_IN_LEDGERS = 17_280;

const MAX_ENTRY_TTL = 3_110_400;
const MAX_TEMPORARY_TTL = MAX_ENTRY_TTL - 1;
const RESPONSE_GRACE = 30 * DAY_IN_LEDGERS;
const MAX_SURVEY_LIFETIME = MAX_TEMPORARY_TTL - RESPONSE_GRACE;

/** Teto do `deadline` — acima disso `create_survey` devolve ERR_BAD_STATE. */
export const MAX_SURVEY_DAYS = Math.floor(MAX_SURVEY_LIFETIME / DAY_IN_LEDGERS);

/** Dias em ledgers, validando o teto antes de assinar. */
export function daysToLedgers(days: number): number {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("A duração precisa ser um número de dias positivo.");
  }
  if (days > MAX_SURVEY_DAYS) {
    throw new Error(
      `O prazo máximo no MVP é de ${MAX_SURVEY_DAYS} dias (limite do TTL da rede).`,
    );
  }
  return Math.floor(days * DAY_IN_LEDGERS);
}
