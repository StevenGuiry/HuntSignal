import { it, expect } from "vitest";
import { resolve, join, dirname } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { openLocal } from "../packages/local";
import { ingestDocument } from "../ingestion/pipeline";
import {
  seal,
  pack,
  checksum,
  type Snapshot,
  type PrivacyLedger,
} from "../packages/backup";
it("restores an encrypted database and archive into a fresh directory with working RLS", async () => {
  const base = resolve(".data", `restore-test-${randomUUID()}`),
    target = join(base, "restored");
  await mkdir(join(base, "objects"), { recursive: true });
  await mkdir(join(base, "snapshots"), { recursive: true });
  const key = randomBytes(32),
    keyPath = join(base, "test-key");
  await writeFile(keyPath, key);
  const local = await openLocal(true);
  const alice = "80000000-0000-4000-8000-000000000008",
    bob = "90000000-0000-4000-8000-000000000009";
  let restored: PGlite | undefined;
  try {
    await local.db.query("insert into auth.users(id) values($1),($2)", [
      alice,
      bob,
    ]);
    const rawObjects = new Map<string, Buffer>();
    const d = await ingestDocument(
      local.rpc,
      async (p, b) => {
        rawObjects.set(p, gzipSync(b));
      },
      {
        sourceId: "recovery",
        sourceName: "Recovery fixture",
        sourceUrl: "https://example.org",
        externalId: "1",
        canonicalUrl: "https://example.org/recovery",
        title: "XSS recovery fixture",
        kind: "report",
        platform: "Fixture",
        authors: [],
        topics: ["XSS"],
        programs: [],
        excerpt: "",
        markdown:
          "Synthetic cross-site scripting research material sufficiently long to exercise a complete full-text archive and a restored lexical index.",
        publishedAt: new Date().toISOString(),
        completeness: "full",
        license: "CC0",
        licenseUrl: null,
        attribution: "Synthetic fixture",
        rightsEvidence: "https://example.org/license",
        canArchive: true,
      },
    );
    await local.db.query(
      "insert into hs_notes(owner_id,document_id,body) values($1,$2,$3)",
      [alice, d.id, "Synthetic private recovery note"],
    );
    const snapshot = await local.rpc<Snapshot>("hs_ops_backup_snapshot");
    snapshot.project = "fixture";
    snapshot.objects = [];
    for (const [path, raw] of rawObjects) {
      await writeFile(
        join(base, "objects", path + ".enc"),
        seal(raw, key, path),
      );
      snapshot.objects.push({ path, bytes: raw.length, sha256: checksum(raw) });
    }
    await writeFile(
      join(base, "snapshots", "fixture.json.enc"),
      seal(pack(snapshot), key, "fixture.json.enc"),
    );
    const ledger = await local.rpc<PrivacyLedger>("hs_ops_privacy_ledger");
    ledger.project = "fixture";
    await writeFile(
      join(base, "privacy.json.enc"),
      seal(pack(ledger), key, "privacy.json.enc"),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/restore-hosted-backup.ts",
        "--from",
        join(base, "snapshots", "fixture.json.enc"),
        "--target",
        target,
        "--include-personal",
        "--privacy-ledger",
        join(base, "privacy.json.enc"),
        "--key-file",
        keyPath,
      ],
      { encoding: "utf8", timeout: 30000, windowsHide: true },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    restored = new PGlite({
      dataDir: join(target, "postgres"),
      extensions: { vector, pg_trgm },
    });
    expect(
      (await restored.query("select id from hs_documents")).rows,
    ).toHaveLength(1);
    const counts = await restored.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: bob }),
      ]);
      await tx.exec("set local role authenticated");
      return (await tx.query("select body from hs_notes")).rows;
    });
    expect(counts).toEqual([]);
    expect(
      (
        await restored.query<{ n: number }>(
          "select count(*)::int n from hs_notes where owner_id=$1",
          [alice],
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await restored.query("select * from hs_feed_tokens")).rows).toEqual(
      [],
    );
    expect(
      (
        await restored.query(
          'select hs_search(\'{"groups":[["xss"]],"page":1,"limit":20}\'::jsonb)->>\'total\' n',
        )
      ).rows[0],
    ).toEqual({ n: "1" });
  } finally {
    await restored?.close();
    await local.db.close();
    // Only this generated fixture directory may be removed.
    if (
      dirname(base) !== resolve(".data") ||
      !base.startsWith(resolve(".data", "restore-test-"))
    )
      throw new Error("Unsafe fixture cleanup path");
    await rm(base, { recursive: true, force: true });
  }
}, 60000);
