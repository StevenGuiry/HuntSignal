import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadIngestionEnvironment } from "../ingestion/config";
import {
  backupTables,
  unseal,
  unpack,
  checksum,
  applyPrivacy,
  type Snapshot,
  type PrivacyLedger,
} from "../packages/backup";
import { chunkText } from "../ingestion/normalize";
loadIngestionEnvironment();
const args = process.argv.slice(2),
  option = (name: string, fallback = "") => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
const from = option("--from"),
  target = option("--target"),
  includePersonal = args.includes("--include-personal"),
  ledgerPath = option("--privacy-ledger");
if (!from || !target)
  throw new Error("Use --from <encrypted snapshot> --target <new directory>");
if (includePersonal && !ledgerPath)
  throw new Error(
    "Personal recovery requires a fresh --privacy-ledger export from the live project",
  );
const destination = resolve(target);
try {
  await access(destination);
  throw new Error("Restore target already exists; choose a new directory");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const key = await readFile(
  resolve(
    option(
      "--key-file",
      process.env.HUNTSIGNAL_BACKUP_KEY_FILE || ".data/backup-key",
    ),
  ),
);
const source = resolve(from),
  folder = dirname(dirname(source));
const original = unpack<Snapshot>(
  unseal(await readFile(source), key, basename(source)),
);
const ledger = ledgerPath
  ? unpack<PrivacyLedger>(
      unseal(await readFile(resolve(ledgerPath)), key, basename(ledgerPath)),
    )
  : { checkedAt: original.createdAt, deletions: [], suppressions: [] };
if (includePersonal && Date.now() - Date.parse(ledger.checkedAt) > 3600000)
  throw new Error(
    "Refresh the privacy ledger within one hour before restoring personal data",
  );
const snapshot = applyPrivacy(original, ledger, includePersonal);
const objects = new Map<string, Buffer>();
for (const object of snapshot.objects || []) {
  if (!/^[a-f0-9]{64}\.json\.gz$/.test(object.path))
    throw new Error("Unsafe archive path");
  const raw = unseal(
    await readFile(join(folder, "objects", object.path + ".enc")),
    key,
    object.path,
  );
  if (checksum(raw) !== object.sha256)
    throw new Error("Archive checksum mismatch");
  objects.set(object.path, raw);
}
const published = new Set(
  snapshot.tables.hs_documents
    .filter((d) => d.status === "published")
    .map((d) => d.id),
);
for (const revision of snapshot.tables.hs_revisions)
  if (published.has(revision.document_id) && !objects.has(revision.object_path))
    throw new Error("Snapshot is missing a referenced public object");
process.env.HUNTSIGNAL_DATA_DIR = destination;
const { openLocal, archivePath } = await import("../packages/local");
const { db } = await openLocal();
try {
  await mkdir(join(destination, "archive"), { recursive: true });
  const approvedPaths = new Set(
    snapshot.tables.hs_revisions
      .filter((r) => published.has(r.document_id))
      .map((r) => r.object_path),
  );
  for (const [path, raw] of objects)
    if (approvedPaths.has(path))
      await writeFile(archivePath(path), raw, { flag: "wx" });
  await db.transaction(async (tx) => {
    for (const table of backupTables) {
      const exists = await tx.query<{ present: boolean }>(
        "select to_regclass($1) is not null present",
        [table],
      );
      if (!exists.rows[0].present) continue;
      for (const row of snapshot.tables[table] || []) {
        if (table === "hs_state")
          await tx.query(
            "insert into hs_state select * from jsonb_populate_record(null::hs_state,$1::jsonb) on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at",
            [JSON.stringify(row)],
          );
        else if (table === "hs_embedding_models")
          await tx.query(
            "insert into hs_embedding_models select * from jsonb_populate_record(null::hs_embedding_models,$1::jsonb) on conflict(id) do nothing",
            [JSON.stringify(row)],
          );
        else
          await tx.query(
            `insert into ${table} overriding system value select * from jsonb_populate_record(null::${table},$1::jsonb) on conflict do nothing`,
            [JSON.stringify(row)],
          );
      }
    }
    for (const document of snapshot.tables.hs_documents) {
      if (document.status !== "published") continue;
      const revision = snapshot.tables.hs_revisions.find(
        (r) => r.id === document.current_revision_id,
      );
      if (!revision) throw new Error("Current revision missing");
      const body = JSON.parse(
        gunzipSync(objects.get(revision.object_path)!, {
          maxOutputLength: 3000000,
        }).toString(),
      );
      const metadata = [
        document.title,
        ...document.topics,
        ...document.authors,
        ...document.programs,
        document.excerpt,
      ].join("\n");
      const chunks = [metadata, ...chunkText(body.markdown || "")];
      for (let i = 0; i < chunks.length; i++)
        await tx.query(
          "insert into hs_chunks(document_id,ordinal,body) values($1,$2,$3)",
          [document.id, i, chunks[i]],
        );
    }
    for (const table of ["hs_admin_audit", "hs_publication_events"]) {
      await tx.exec(
        `select setval(pg_get_serial_sequence('${table}','id'),greatest(coalesce((select max(id) from ${table}),0),1),coalesce((select max(id) from ${table}),0)>0)`,
      );
    }
  });
  const count = (
    await db.query<{ n: number }>("select count(*)::int n from hs_documents")
  ).rows[0].n;
  if (count !== snapshot.tables.hs_documents.length)
    throw new Error("Document count mismatch");
  console.log(
    JSON.stringify({
      target: destination,
      documents: count,
      objects: approvedPaths.size,
      personalIncluded: includePersonal,
      feedTokensRestored: false,
      sessionsRestored: false,
      semanticIndex: "rebuild with enrich",
      status: "restored",
    }),
  );
} catch {
  console.error(
    "Restore failed. The original encrypted backup is unchanged; the new target is retained for inspection.",
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
