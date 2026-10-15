-- Solarvey — migração inicial (SDD §5.3).
-- Banco: PGlite (Postgres embarcado) na S0; trocar por Supabase/Postgres
-- gerando o mesmo schema — só a camada `web/db/index.ts` muda.

CREATE TABLE IF NOT EXISTS surveys (
  id              BIGINT PRIMARY KEY,
  owner           TEXT NOT NULL,
  questions       JSONB NOT NULL,
  questions_hash  TEXT NOT NULL,
  reward          BIGINT NOT NULL,
  max_responses   INTEGER NOT NULL,
  responded       INTEGER NOT NULL DEFAULT 0,
  deadline        BIGINT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'Open'
                  CHECK (state IN ('Open', 'Closed')),
  merkle_root     TEXT,
  tx_create       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS responses (
  id             BIGSERIAL PRIMARY KEY,
  survey_id      BIGINT NOT NULL REFERENCES surveys (id) ON DELETE CASCADE,
  responder      TEXT NOT NULL,
  answers        JSONB NOT NULL,
  response_hash  TEXT NOT NULL,
  tx_hash        TEXT NOT NULL,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (survey_id, response_hash)
);

-- Índices usados pelo fluxo de leitura das páginas.
CREATE INDEX IF NOT EXISTS responses_survey_id_idx ON responses (survey_id);
CREATE INDEX IF NOT EXISTS surveys_owner_idx ON surveys (owner);

-- Pré-computado no close (SDD §5.4) — vazia até a Sprint 3.
CREATE TABLE IF NOT EXISTS proofs (
  survey_id   BIGINT NOT NULL REFERENCES surveys (id) ON DELETE CASCADE,
  leaf_hash   TEXT NOT NULL,
  path        JSONB NOT NULL,
  PRIMARY KEY (survey_id, leaf_hash)
);
