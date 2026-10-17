import { readFile, mkdir, copyFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chunkText } from "../ingestion/normalize";
const args = process.argv.slice(2),
  from = args[args.indexOf("--from") + 1],
  target = args[args.indexOf("--target") + 1];
if (!args.includes("--from") || !args.includes("--target") || !from || !target)
  throw new Error(
    "Use restore --from <export directory> --target <new data directory>",
  );
const destination = resolve(target);
try {
  await access(destination);
  throw new Error("Restore target already exists. Choose a new directory.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const folder = resolve(from);
const manifest = JSON.parse(
  await readFile(resolve(folder, "manifest.json"), "utf8"),
) as { schemaVersion: number; objects: { path: string; sha256: string }[] };
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.objects))
  throw new Error("Unsupported export manifest");
const contents = new Map<string, string>();
for (const object of manifest.objects) {
  if (!/^[a-f0-9]{64}\.json\.gz$/.test(object.path))
    throw new Error("Unsafe archive path in manifest");
  const raw = await readFile(resolve(folder, "archive", object.path));
  if (createHash("sha256").update(raw).digest("hex") !== object.sha256)
    throw new Error(`Checksum mismatch: ${object.path}`);
  contents.set(
    object.path,
    gunzipSync(raw, { maxOutputLength: 3_000_000 }).toString("utf8"),
  );
}
process.env.HUNTSIGNAL_DATA_DIR = destination;
const { openLocal, archivePath } = await import("../packages/local");
const { db } = await openLocal();
try {
  const tables = [
    "hs_sources",
    "hs_documents",
    "hs_revisions",
    "hs_runs",
    "hs_jobs",
    "hs_state",
  ] as const;
  const records = new Map<string, Record<string, unknown>[]>();
  for (const table of tables) {
    const rows = JSON.parse(
      await readFile(resolve(folder, `${table}.json`), "utf8"),
    );
    if (!Array.isArray(rows)) throw new Error("Invalid table export");
    records.set(table, rows);
  }
  for (const revision of records.get("hs_revisions") || [])
    if (!contents.has(String(revision.object_path)))
      throw new Error("Missing referenced archive object");
  await mkdir(resolve(destination, "archive"), { recursive: true });
  for (const object of manifest.objects)
    await copyFile(
      resolve(folder, "archive", object.path),
      archivePath(object.path),
    );
  await db.transaction(async (tx) => {
    for (const table of tables)
      for (const row of records.get(table) || [])
        await tx.query(
          `insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`,
          [JSON.stringify(row)],
        );
    const { rows } = await tx.query<{
      id: string;
      title: string;
      topics: string[];
      authors: string[];
      programs: string[];
      excerpt: string;
      object_path: string;
    }>(
      "select d.*,r.object_path from hs_documents d join hs_revisions r on r.id=d.current_revision_id",
    );
    for (const d of rows) {
      const archive = JSON.parse(contents.get(d.object_path)!);
      const chunks = [
        [d.title, ...d.topics, ...d.authors, ...d.programs, d.excerpt].join(
          "\n",
        ),
        ...chunkText(archive.markdown || ""),
      ];
      for (let i = 0; i < chunks.length; i++)
        await tx.query(
          "insert into hs_chunks(document_id,ordinal,body) values($1,$2,$3)",
          [d.id, i, chunks[i]],
        );
    }
  });
  const { rows } = await db.query<{ stats: unknown }>(
    "select hs_stats() as stats",
  );
  console.log(JSON.stringify({ restoredTo: destination, ...rows[0] }));
} finally {
  await db.close();
}
