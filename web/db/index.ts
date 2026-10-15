/**
 * Camada de dados — PGlite (Postgres embarcado, zero dependência de Docker).
 *
 * Decisão registrada no README: o Postgres local via Docker não existe neste
 * ambiente (sem docker/podman/sudo), então a S0 usa `@electric-sql/pglite` e a
 * migração para Supabase/Postgres troca **apenas este arquivo** — o schema de
 * `db/migrations/` é Postgres puro.
 *
 * Só é importado em código de servidor (route handlers).
 */
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

declare global {
  var __solarveyDb: PGlite | undefined;
  var __solarveyMigrated: boolean | undefined;
}

function migrationsDirFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"),
    }));
}

async function runMigrations(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const applied = await db.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const done = new Set(applied.rows.map((row) => row.name));

  for (const migration of migrationsDirFiles()) {
    if (done.has(migration.name)) continue;
    await db.exec("BEGIN");
    try {
      await db.exec(migration.sql);
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        migration.name,
      ]);
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw new Error(
        `Falha na migração ${migration.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Singleton do banco (o HMR do dev recriaria o módulo a cada hot reload). */
export async function getDb(): Promise<PGlite> {
  if (!globalThis.__solarveyDb) {
    const db = new PGlite(
      process.env.DATABASE_PATH ??
        path.join(process.cwd(), ".data", "solarvey"),
    );
    globalThis.__solarveyDb = db;
    await runMigrations(db);
    globalThis.__solarveyMigrated = true;
  }
  return globalThis.__solarveyDb;
}
