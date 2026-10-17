import { mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { openLocal, dataRoot, archivePath } from "../packages/local";
const { db } = await openLocal();
try {
  const folder = resolve(
    dataRoot,
    "exports",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(resolve(folder, "archive"), { recursive: true });
  for (const table of [
    "hs_sources",
    "hs_documents",
    "hs_revisions",
    "hs_runs",
    "hs_jobs",
    "hs_state",
  ]) {
    const { rows } = await db.query(`select * from ${table}`);
    await writeFile(
      resolve(folder, `${table}.json`),
      JSON.stringify(rows, null, 2),
    );
  }
  const { rows } = await db.query<{ object_path: string }>(
    "select distinct object_path from hs_revisions",
  );
  const objects = [];
  for (const { object_path } of rows) {
    await copyFile(
      archivePath(object_path),
      resolve(folder, "archive", object_path),
    );
    objects.push({
      path: object_path,
      sha256: createHash("sha256")
        .update(await readFile(archivePath(object_path)))
        .digest("hex"),
    });
  }
  await writeFile(
    resolve(folder, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        objects,
        format: "JSON tables and immutable gzip archives",
      },
      null,
      2,
    ),
  );
  console.log(`Exported ${rows.length} archive objects to ${folder}`);
} finally {
  await db.close();
}
