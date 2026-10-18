import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import {
  readFile,
  mkdir,
  writeFile,
  rename,
  access,
  unlink,
  open,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { Rpc } from "./repository";
export const dataRoot = resolve(process.env.HUNTSIGNAL_DATA_DIR || ".data");
export function archivePath(path: string) {
  if (!/^[a-f0-9]{64}\.json\.gz$/.test(path))
    throw new Error("Invalid archive object path");
  return resolve(dataRoot, "archive", path);
}
export async function openLocal(memory = false) {
  const lock = resolve(dataRoot, "database.lock");
  if (!memory) {
    await mkdir(dataRoot, { recursive: true });
    try {
      const previous = Number(await readFile(lock, "utf8"));
      try {
        process.kill(previous, 0);
        throw new Error(
          "HuntSignal database is already open. Stop npm run dev before ingestion/export.",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await unlink(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = await open(lock, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
  }
  const db = new PGlite({
    dataDir: memory ? undefined : resolve(dataRoot, "postgres"),
    extensions: { vector, pg_trgm },
  });
  const close = db.close.bind(db);
  db.close = async () => {
    try {
      await close();
    } finally {
      if (!memory) await unlink(lock).catch(() => {});
    }
  };
  await db.exec(
    "create table if not exists hs_migrations(name text primary key)",
  );
  const existing = await db.query(
    "select name from hs_migrations where name='001_archive'",
  );
  if (!existing.rows.length) {
    const sql = await readFile(
      resolve("supabase/migrations/001_archive.sql"),
      "utf8",
    );
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("insert into hs_migrations(name) values('001_archive')");
    });
  }
  await db.exec(await readFile(resolve("packages/local-auth.sql"), "utf8"));
  for (const migration of [
    "003_search_enrichment",
    "004_query_planning",
    "005_personal_library",
    "006_personal_search_filters",
    "007_operations",
    "008_capacity_recovery",
    "009_revision_feed",
    "010_filtered_lexical_ranking",
    "011_atomic_ingestion_fence",
    "012_source_coverage",
    "013_source_precedence",
  ]) {
    const applied = await db.query(
      "select name from hs_migrations where name=$1",
      [migration],
    );
    if (!applied.rows.length) {
      try {
        await db.exec(
          await readFile(
            resolve(`supabase/migrations/${migration}.sql`),
            "utf8",
          ),
        );
        await db.query(
          "insert into hs_migrations(name) values($1) on conflict do nothing",
          [migration],
        );
      } catch (error) {
        await db.close();
        throw error;
      }
    }
  }
  const rpc: Rpc = async <T>(name: string, p: unknown = {}) => {
    if (!/^hs_[a-z][a-z0-9_]*$/.test(name))
      throw new Error("Invalid operation");
    const result = await db.query<{ data: T }>(
      `select ${name}($1::jsonb) as data`,
      [JSON.stringify(p)],
    );
    return result.rows[0]?.data;
  };
  return { db, rpc };
}
export async function writeLocalObject(path: string, body: string) {
  const target = archivePath(path);
  await mkdir(dirname(target), { recursive: true });
  try {
    await access(target);
    return;
  } catch {}
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, gzipSync(body));
  await rename(temporary, target);
}
export async function readLocalObject(path: string) {
  return gunzipSync(await readFile(archivePath(path))).toString("utf8");
}
