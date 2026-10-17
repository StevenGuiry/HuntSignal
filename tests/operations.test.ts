import { beforeAll, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { expandQuery } from "../packages/taxonomy";
import { prepare } from "../ingestion/normalize";
import { openLocal } from "../packages/local";
import { ingestDocument } from "../ingestion/pipeline";
import {
  runSource,
  dueWithTolerance,
  type DiscoveryContext,
} from "../ingestion/operations";
import {
  checkpointDocuments,
  conditionalHeaders,
} from "../ingestion/checkpoint";
import { retryAfter } from "../ingestion/fetch";
import { revisionDiff } from "../packages/revision-diff";
import type { InputDocument } from "../packages/contracts";
const owner = "60000000-0000-4000-8000-000000000006",
  other = "70000000-0000-4000-8000-000000000007";
let local: Awaited<ReturnType<typeof openLocal>>;
const objects = new Map<string, string>();
const write = async (p: string, b: string) => {
  objects.set(p, b);
};
const read = async (p: string) => {
  if (!objects.has(p)) throw new Error("Object missing");
  return objects.get(p)!;
};
const doc = (name: string): InputDocument => ({
  sourceId: "ops-fixture",
  sourceName: "Ops fixture",
  sourceUrl: "https://example.org",
  externalId: name,
  canonicalUrl: `https://example.org/${encodeURIComponent(name)}`,
  title: name,
  kind: "report",
  platform: "Fixture",
  authors: ["Synthetic researcher"],
  topics: ["XSS"],
  programs: [],
  excerpt: "",
  markdown:
    "A complete synthetic disclosure describing cross-site scripting. This licensed fixture is used only for testing operations and preservation.",
  publishedAt: new Date().toISOString(),
  completeness: "full",
  license: "CC0",
  licenseUrl: null,
  attribution: "Synthetic fixture",
  rightsEvidence: "https://example.org/license",
  canArchive: true,
});
async function asUser<T = any>(id: string, name: string, p: unknown = {}) {
  return local.db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: id, role: "authenticated" }),
    ]);
    await tx.exec("set local role authenticated");
    return (
      await tx.query<{ data: T }>(`select ${name}($1::jsonb) data`, [
        JSON.stringify(p),
      ])
    ).rows[0].data;
  });
}
beforeAll(async () => {
  local = await openLocal(true);
  await local.db.query("insert into auth.users(id) values($1),($2)", [
    owner,
    other,
  ]);
  await local.db.query("insert into hs_admins(owner_id) values($1)", [owner]);
});
afterAll(async () => {
  await local?.db.close();
});
it("fences source checkpoints against a stale lease holder", async () => {
  const first = await local.rpc<{ token: string }>("hs_ops_source", {
    action: "claim",
    sourceId: "lease-fixture",
    force: true,
  });
  expect(
    await local.rpc("hs_ops_source", {
      action: "claim",
      sourceId: "lease-fixture",
      force: true,
    }),
  ).toMatchObject({ claimed: false, status: "busy" });
  await local.db.exec(
    "update hs_source_control set lease_until=now()-interval '1 minute' where source_id='lease-fixture'",
  );
  const second = await local.rpc<{ token: string }>("hs_ops_source", {
    action: "claim",
    sourceId: "lease-fixture",
    force: true,
  });
  await expect(
    local.rpc("hs_ops_source", {
      action: "checkpoint",
      sourceId: "lease-fixture",
      token: first.token,
      cursor: { offset: 100 },
    }),
  ).rejects.toThrow("lease lost");
  await local.rpc("hs_ops_source", {
    action: "checkpoint",
    sourceId: "lease-fixture",
    token: second.token,
    cursor: { offset: 20 },
  });
  expect(
    (
      await local.db.query<{ recent_cursor: { offset: number } }>(
        "select recent_cursor from hs_source_control where source_id='lease-fixture'",
      )
    ).rows[0].recent_cursor.offset,
  ).toBe(20);
});
it("honors source cooldowns even when a caller requests a forced poll", async () => {
  const claim = await local.rpc<{ token: string }>("hs_ops_source", {
    action: "claim",
    sourceId: "rate-fixture",
    force: true,
  });
  await local.rpc("hs_ops_source", {
    action: "release",
    sourceId: "rate-fixture",
    token: claim.token,
    ok: false,
    retrySeconds: 3600,
  });
  expect(
    await local.rpc("hs_ops_source", {
      action: "claim",
      sourceId: "rate-fixture",
      force: true,
    }),
  ).toMatchObject({ claimed: false, status: "retry_delay" });
});
it("keeps durable retry payloads independently of source rediscovery", async () => {
  const fixture = doc("retry");
  async function* discovery(c: DiscoveryContext) {
    yield fixture;
    await c.checkpoint({ offset: 1 });
  }
  const failed = await runSource(
    local.rpc,
    async () => {
      throw new Error("Storage offline");
    },
    read,
    "retry-fixture",
    discovery,
    { force: true },
  );
  expect(failed.failed).toBe(1);
  const job = (
    await local.db.query<{ payload: unknown }>(
      "select payload from hs_jobs where source_id=$1",
      ["retry-fixture"],
    )
  ).rows[0];
  expect(job.payload).not.toBeNull();
  await local.db.exec(
    "update hs_jobs set next_attempt_at=now()-interval '1 minute' where source_id='retry-fixture';update hs_source_control set retry_at=null where source_id='retry-fixture'",
  );
  async function* empty() {}
  const resumed = await runSource(
    local.rpc,
    write,
    read,
    "retry-fixture",
    empty,
    { force: true },
  );
  expect(resumed).toMatchObject({ processed: 1, failed: 0 });
  expect(
    (
      await local.db.query("select payload from hs_jobs where source_id=$1", [
        "retry-fixture",
      ])
    ).rows[0],
  ).toEqual({ payload: null });
  expect(
    (
      await local.db.query("select id from hs_documents where external_id=$1", [
        "retry",
      ])
    ).rows,
  ).toHaveLength(1);
});
it("rejects stale job completion tokens", async () => {
  await local.rpc("hs_ops_job", {
    action: "enqueue",
    sourceId: "fence",
    externalId: "1",
    fingerprint: "first",
    document: doc("fenced"),
  });
  const a = await local.rpc<{ token: string }>("hs_ops_job", {
    action: "claim",
    sourceId: "fence",
    externalId: "1",
  });
  await local.db.exec(
    "update hs_jobs set lease_until=now()-interval '1 minute' where source_id='fence'",
  );
  const b = await local.rpc<{ token: string }>("hs_ops_job", {
    action: "claim",
    sourceId: "fence",
    externalId: "1",
  });
  await expect(
    local.rpc("hs_ops_job", {
      action: "finish",
      sourceId: "fence",
      externalId: "1",
      token: a.token,
    }),
  ).rejects.toThrow("lease lost");
  await local.rpc("hs_ops_job", {
    action: "finish",
    sourceId: "fence",
    externalId: "1",
    token: b.token,
  });
});
it("fences revision activation, not just checkpoint completion", async () => {
  const oldDoc = doc("atomic-fence"),
    newDoc = { ...oldDoc, title: "Newer revision" };
  const sourceId = "atomic-fence-source",
    externalId = oldDoc.externalId;
  const first = await local.rpc<{ token: string }>("hs_ops_source", {
    action: "claim",
    sourceId,
    force: true,
  });
  await local.rpc("hs_ops_job", {
    action: "enqueue",
    sourceId,
    externalId,
    fingerprint: prepare(oldDoc).contentHash,
    document: oldDoc,
  });
  const oldJob = await local.rpc<{ token: string }>("hs_ops_job", {
    action: "claim",
    sourceId,
    externalId,
  });
  await local.db.query(
    "update hs_jobs set lease_until=now()-interval '1 minute' where source_id=$1",
    [sourceId],
  );
  await local.db.query(
    "update hs_source_control set lease_until=now()-interval '1 minute' where source_id=$1",
    [sourceId],
  );
  const second = await local.rpc<{ token: string }>("hs_ops_source", {
    action: "claim",
    sourceId,
    force: true,
  });
  await local.rpc("hs_ops_job", {
    action: "enqueue",
    sourceId,
    externalId,
    fingerprint: prepare(newDoc).contentHash,
    document: newDoc,
  });
  const newJob = await local.rpc<{ token: string }>("hs_ops_job", {
    action: "claim",
    sourceId,
    externalId,
  });
  const result = await ingestDocument(local.rpc, write, newDoc, read, {
    sourceId,
    externalId,
    jobToken: newJob.token,
    sourceToken: second.token,
  });
  await expect(
    ingestDocument(local.rpc, write, oldDoc, read, {
      sourceId,
      externalId,
      jobToken: oldJob.token,
      sourceToken: first.token,
    }),
  ).rejects.toThrow("lease lost before activation");
  expect(await local.rpc("hs_detail", { id: result.id })).toMatchObject({
    title: "Newer revision",
  });
});
it("commits feed validators only after every document has been durably consumed", async () => {
  const c: DiscoveryContext = {
    mode: "backfill",
    cursor: {},
    checkpoint: async (value) => {
      c.cursor = value;
    },
  };
  const fixtures = [doc("one"), doc("two")];
  const response = { status: 200, body: "", etag: "version-one" };
  const first = [];
  for await (const d of checkpointDocuments(fixtures, 1, c, response))
    first.push(d.externalId);
  expect(first).toEqual(["one"]);
  expect(conditionalHeaders(c)).toEqual({});
  const second = [];
  for await (const d of checkpointDocuments(fixtures, 1, c, response))
    second.push(d.externalId);
  expect(second).toEqual(["two"]);
  expect(c.cursor.complete).toBe(true);
  expect(conditionalHeaders(c)).toEqual({ "If-None-Match": "version-one" });
  const replay = [];
  for await (const d of checkpointDocuments(fixtures, 2, c, response))
    replay.push(d);
  expect(replay).toEqual([]);
});
it("requires the immutable admin allowlist for administrative RPCs", async () => {
  expect(await asUser(owner, "hs_me_ops_status")).toEqual({ admin: true });
  expect(await asUser(other, "hs_me_ops_status")).toEqual({ admin: false });
  await expect(asUser(other, "hs_me_ops")).rejects.toThrow(
    "Administrator required",
  );
  await expect(
    asUser(other, "hs_me_ops_mutate", {
      action: "source_enabled",
      sourceId: "lease-fixture",
      enabled: false,
    }),
  ).rejects.toThrow("Administrator required");
  await asUser(owner, "hs_me_ops_mutate", {
    action: "source_enabled",
    sourceId: "lease-fixture",
    enabled: false,
  });
  const state = await asUser(owner, "hs_me_ops");
  expect(state.capacity.databaseLimit).toBe(500000000);
  expect(state.audit[0].action).toBe("source_enabled");
});
it("preserves full text on failed extraction and records bounded text changes", async () => {
  const fixture = doc("revision");
  const result = await ingestDocument(local.rpc, write, fixture, read);
  expect(
    await ingestDocument(
      local.rpc,
      write,
      { ...fixture, markdown: "", completeness: "metadata", canArchive: false },
      read,
    ),
  ).toMatchObject({ action: "preserved" });
  await ingestDocument(
    local.rpc,
    write,
    { ...fixture, markdown: fixture.markdown + "\nA new line." },
    read,
  );
  const history = await local.rpc<{ changes: { added: number } }[]>(
    "hs_ops_revisions",
    { id: result.id },
  );
  expect(history).toHaveLength(2);
  expect(history[0].changes.added).toBe(1);
  const updated = await local.rpc<{ items: { id: string }[] }>("hs_search", {
    sort: "updated",
    groups: [],
    limit: 50,
    page: 1,
  });
  expect(updated.items.map((x) => x.id)).toContain(result.id);
  expect(revisionDiff("same", "same").metadataOnly).toBe(true);
  expect(revisionDiff("old", "<script>alert(1)</script>").after).toEqual([
    "<script>alert(1)</script>",
  ]);
});
it("withdraws every published read path and prevents rediscovery from restoring content", async () => {
  const fixture = doc("suppression");
  const result = await ingestDocument(local.rpc, write, fixture, read);
  await asUser(owner, "hs_me_ops_mutate", {
    action: "withdraw",
    documentId: result.id,
    reason: "Synthetic rights withdrawal",
  });
  expect(await local.rpc("hs_detail", { id: result.id })).toBeNull();
  expect(await local.rpc("hs_ops_revisions", { id: result.id })).toEqual([]);
  expect(
    await ingestDocument(
      local.rpc,
      write,
      { ...fixture, title: "Rediscovered" },
      read,
    ),
  ).toMatchObject({ action: "preserved" });
  expect(
    (
      await local.db.query("select id from hs_chunks where document_id=$1", [
        result.id,
      ])
    ).rows,
  ).toEqual([]);
});
it("stops before storage exhaustion without deleting existing objects", async () => {
  const path = "f".repeat(64) + ".json.gz";
  await local.db.query(
    "insert into hs_archive_objects(path,bytes) values($1,900000000)",
    [path],
  );
  try {
    expect(await local.rpc("hs_ops_capacity")).toMatchObject({
      warning: true,
      writeAllowed: false,
      backfillAllowed: false,
    });
    await expect(
      ingestDocument(local.rpc, write, doc("capacity"), read),
    ).rejects.toThrow("capacity stop");
    expect(objects.size).toBeGreaterThan(0);
  } finally {
    await local.db.query("delete from hs_archive_objects where path=$1", [
      path,
    ]);
  }
});
it("includes private-data dependencies in backups, omits feed capabilities, and records deletions", async () => {
  const id = (await ingestDocument(local.rpc, write, doc("backup"), read)).id;
  await asUser(other, "hs_me_mutate", {
    action: "note",
    documentId: id,
    body: "Synthetic private backup note",
  });
  const snapshot = await local.rpc<{ tables: Record<string, unknown[]> }>(
    "hs_ops_backup_snapshot",
  );
  expect(snapshot.tables.hs_notes).toHaveLength(1);
  expect(snapshot.tables["auth.users"]).toHaveLength(2);
  expect(snapshot.tables.hs_feed_tokens).toBeUndefined();
  await local.db.query("delete from auth.users where id=$1", [other]);
  const ledger = await local.rpc<{ deletions: { owner_id: string }[] }>(
    "hs_ops_privacy_ledger",
  );
  expect(ledger.deletions.some((t) => t.owner_id === other)).toBe(true);
});
it("tolerates cron jitter without polling a freshly checked source", () => {
  const now = Date.parse("2026-10-17T12:17:00Z");
  expect(dueWithTolerance("2026-10-17T11:18:00Z", 3600, now)).toBe(true);
  expect(dueWithTolerance("2026-10-17T12:00:00Z", 3600, now)).toBe(false);
});
it("parses Retry-After dates and bounds diagnostic comparisons", () => {
  expect(retryAfter("120")).toBe(120);
  expect(retryAfter("nonsense")).toBe(0);
  expect(
    retryAfter(
      "Wed, 21 Oct 2015 07:28:00 GMT",
      Date.parse("Wed, 21 Oct 2015 07:27:00 GMT"),
    ),
  ).toBe(60);
  const d = revisionDiff("", Array(1000).fill("new").join("\n"));
  expect(d.truncated).toBe(true);
  expect(d.after.length).toBe(150);
});
it("preserves lexical results and scores when filtering before ranking", async () => {
  const sql = await readFile(
    "supabase/migrations/009_revision_feed.sql",
    "utf8",
  );
  const definition = sql
    .slice(
      sql.indexOf("create or replace function hs_search("),
      sql.indexOf("alter function hs_search"),
    )
    .replace("function hs_search(", "function hs_test_legacy_search(");
  await local.db.exec(definition);
  for (const q of [
    "XSS",
    "cross site scripting",
    "synthetic research",
    "missing concept",
  ]) {
    const p = {
      q,
      groups: expandQuery(q).groups,
      sort: "relevance",
      page: 1,
      limit: 50,
    };
    expect(await local.rpc("hs_search", p)).toEqual(
      await local.rpc("hs_test_legacy_search", p),
    );
  }
});
