import { beforeAll, afterAll, it, expect } from "vitest";
import { openLocal } from "../packages/local";
import { ingestDocument } from "../ingestion/pipeline";
import { expandQuery } from "../packages/taxonomy";
import type { InputDocument } from "../packages/contracts";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
let local: Awaited<ReturnType<typeof openLocal>>;
const alice = "10000000-0000-4000-8000-000000000001",
  bob = "20000000-0000-4000-8000-000000000002";
let docId: string, collectionId: string, searchId: string;
const fixture = (
  name: string,
  patch: Partial<InputDocument> = {},
): InputDocument => ({
  sourceId: "test",
  sourceName: "Test",
  sourceUrl: "https://example.org",
  externalId: name,
  canonicalUrl: `https://example.org/${name}`,
  title: name,
  kind: "report",
  platform: "Test",
  authors: ["Researcher"],
  topics: [],
  programs: [],
  excerpt: "",
  markdown:
    "A sufficiently long synthetic research document for ownership tests and notification processing. No actual user information is included.",
  publishedAt: new Date().toISOString(),
  completeness: "full",
  license: "CC0",
  licenseUrl: null,
  attribution: "Synthetic fixture",
  rightsEvidence: "https://example.org/license",
  canArchive: true,
  ...patch,
});
async function asUser<T = unknown>(
  user: string,
  name: string,
  p: unknown = {},
) {
  return local.db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: "authenticated" }),
    ]);
    await tx.exec("set local role authenticated");
    const r = await tx.query<{ data: T }>(`select ${name}($1::jsonb) as data`, [
      JSON.stringify(p),
    ]);
    return r.rows[0].data;
  });
}
async function userSql<T = Record<string, unknown>>(
  user: string,
  sql: string,
  params: unknown[] = [],
) {
  return local.db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: user, role: "authenticated" }),
    ]);
    await tx.exec("set local role authenticated");
    return tx.query<T>(sql, params);
  });
}
beforeAll(async () => {
  local = await openLocal(true);
  await local.db.query("insert into auth.users(id) values($1),($2)", [
    alice,
    bob,
  ]);
  docId = (
    await ingestDocument(local.rpc, async () => {}, fixture("Initial report"))
  ).id;
});
afterAll(async () => {
  await local?.db.close();
});
it("keeps bookmarks, reading state and notes isolated by signed-in user", async () => {
  await asUser(alice, "hs_me_mutate", {
    action: "bookmark",
    documentId: docId,
    saved: true,
  });
  await asUser(alice, "hs_me_mutate", {
    action: "reading",
    documentId: docId,
    read: true,
  });
  await asUser(alice, "hs_me_mutate", {
    action: "note",
    documentId: docId,
    body: "Alice-private-needle",
  });
  expect(await asUser(alice, "hs_me_document", { id: docId })).toMatchObject({
    saved: true,
    read: true,
    note: "Alice-private-needle",
  });
  expect(await asUser(bob, "hs_me_document", { id: docId })).toMatchObject({
    saved: false,
    read: false,
    note: "",
  });
  expect((await userSql(bob, "select * from hs_notes")).rows).toHaveLength(0);
  await expect(
    userSql(alice, "update hs_notes set owner_id=$1 where document_id=$2", [
      bob,
      docId,
    ]),
  ).rejects.toThrow();
  expect(
    await local.rpc("hs_search", {
      groups: expandQuery("Alice-private-needle").groups,
      page: 1,
      limit: 20,
    }),
  ).toMatchObject({ total: 0 });
});
it("enforces collection ownership in RPC and in the relational constraint", async () => {
  collectionId = (
    await asUser<{ id: string }>(alice, "hs_me_mutate", {
      action: "collection_create",
      name: "Private collection",
    })
  ).id;
  await asUser(alice, "hs_me_mutate", {
    action: "collection_item",
    collectionId,
    documentId: docId,
    present: true,
  });
  await expect(
    asUser(bob, "hs_me_mutate", {
      action: "collection_item",
      collectionId,
      documentId: docId,
      present: true,
    }),
  ).rejects.toThrow("Collection not found");
  await expect(
    userSql(
      bob,
      "insert into hs_collection_items(owner_id,collection_id,document_id) values($1,$2,$3)",
      [bob, collectionId, docId],
    ),
  ).rejects.toThrow();
  await expect(
    asUser(bob, "hs_me_mutate", {
      action: "collection_delete",
      id: collectionId,
    }),
  ).rejects.toThrow("Collection not found");
  expect(
    await asUser(alice, "hs_me_library", { tab: "all", collectionId }),
  ).toMatchObject({ total: 1 });
});
it("creates owned saved searches and starts after the current event watermark", async () => {
  searchId = (
    await asUser<{ id: string }>(alice, "hs_me_mutate", {
      action: "search_save",
      name: "XSS reports",
      queryText: "XSS",
      groups: expandQuery("XSS").groups,
      filters: {},
      mode: "keyword",
    })
  ).id;
  expect(await asUser(bob, "hs_me_searches")).toEqual([]);
  await expect(
    asUser(bob, "hs_me_mutate", {
      action: "search_save",
      id: searchId,
      name: "Stolen",
      queryText: "XSS",
      groups: [],
      filters: {},
    }),
  ).rejects.toThrow("Saved search not found");
  expect(await local.rpc("hs_alert_run")).toMatchObject({ created: 0 });
});
it("matches future disclosures once and suppresses historical backfills and updates by default", async () => {
  const recent = fixture("New XSS disclosure", { topics: ["XSS"] });
  await ingestDocument(local.rpc, async () => {}, recent);
  await ingestDocument(
    local.rpc,
    async () => {},
    fixture("Old XSS disclosure", {
      topics: ["XSS"],
      publishedAt: "2020-01-01T00:00:00.000Z",
    }),
  );
  expect(await local.rpc("hs_alert_run")).toMatchObject({ created: 1 });
  expect(await local.rpc("hs_alert_run")).toMatchObject({ created: 0 });
  await ingestDocument(local.rpc, async () => {}, {
    ...recent,
    markdown: recent.markdown + " An update was published.",
  });
  expect(await local.rpc("hs_alert_run")).toMatchObject({ created: 0 });
  const a = await asUser<{ items: unknown[] }>(alice, "hs_me_notifications");
  expect(a.items).toHaveLength(1);
  expect(await asUser(bob, "hs_me_notifications")).toMatchObject({
    items: [],
    unread: 0,
  });
});
it("supports explicit update alerts and scoped read state", async () => {
  await asUser(alice, "hs_me_mutate", {
    action: "search_options",
    id: searchId,
    includeUpdates: true,
  });
  const r = fixture("Another XSS report", { topics: ["XSS"] });
  await ingestDocument(local.rpc, async () => {}, r);
  await local.rpc("hs_alert_run");
  await ingestDocument(local.rpc, async () => {}, {
    ...r,
    markdown: r.markdown + " Revised evidence.",
  });
  expect(await local.rpc("hs_alert_run")).toMatchObject({ created: 1 });
  const a = await asUser<{ items: { id: string; read_at: string | null }[] }>(
    alice,
    "hs_me_notifications",
  );
  await asUser(bob, "hs_me_mutate", {
    action: "notification_read",
    id: a.items[0].id,
    read: true,
  });
  expect(
    (await asUser<typeof a>(alice, "hs_me_notifications")).items[0].read_at,
  ).toBeNull();
  await asUser(alice, "hs_me_mutate", {
    action: "notification_read",
    id: a.items[0].id,
    read: true,
  });
  expect(
    (await asUser<typeof a>(alice, "hs_me_notifications")).items[0].read_at,
  ).not.toBeNull();
});
it("rotates and revokes hashed RSS capabilities without exporting them", async () => {
  await asUser(alice, "hs_me_mutate", {
    action: "feed_rotate",
    searchId,
    tokenHash: "a".repeat(64),
  });
  expect(
    await local.rpc("hs_feed_resolve", { tokenHash: "a".repeat(64) }),
  ).toHaveProperty("name", "XSS reports");
  await expect(
    asUser(bob, "hs_me_mutate", {
      action: "feed_rotate",
      searchId,
      tokenHash: "b".repeat(64),
    }),
  ).rejects.toThrow("Saved search not found");
  await asUser(alice, "hs_me_mutate", {
    action: "feed_rotate",
    searchId,
    tokenHash: "c".repeat(64),
  });
  expect(
    await local.rpc("hs_feed_resolve", { tokenHash: "a".repeat(64) }),
  ).toBeNull();
  expect(JSON.stringify(await asUser(alice, "hs_me_export"))).not.toContain(
    "c".repeat(64),
  );
  await asUser(alice, "hs_me_mutate", { action: "feed_revoke", searchId });
  expect(
    await local.rpc("hs_feed_resolve", { tokenHash: "c".repeat(64) }),
  ).toBeNull();
});
it("queues semantic alerts until the matching revision is indexed", async () => {
  const v = [1, ...Array(383).fill(0)];
  await asUser(bob, "hs_me_mutate", {
    action: "search_save",
    name: "Semantic watch",
    queryText: "unmatched-language",
    groups: expandQuery("unmatched-language").groups,
    filters: { source: "Semantic" },
    mode: "hybrid",
    modelId: EMBEDDING_MODEL.id,
    vector: v,
  });
  const d = await ingestDocument(
    local.rpc,
    async () => {},
    fixture("Semantic event", { platform: "Semantic" }),
  );
  expect(await local.rpc("hs_alert_run")).toMatchObject({ created: 0 });
  const { rows } = await local.db.query<{ current_revision_id: string }>(
    "select current_revision_id from hs_documents where id=$1",
    [d.id],
  );
  await local.rpc("hs_index_put", {
    document_id: d.id,
    revision_id: rows[0].current_revision_id,
    model_id: EMBEDDING_MODEL.id,
    word_count: 200,
    body_hash: null,
    citations: [],
    passages: [{ text: "A related semantic passage", vector: v }],
  });
  expect(await local.rpc("hs_alert_run")).toMatchObject({ created: 1 });
  expect(await local.rpc("hs_alert_run")).toMatchObject({ created: 0 });
});
it("preserves exact author filters in keyword and hybrid search", async () => {
  const input = {
    groups: [],
    q: "",
    author: "Missing author",
    page: 1,
    limit: 20,
  };
  expect(await local.rpc("hs_search", input)).toMatchObject({ total: 0 });
  expect(await local.rpc("hs_search_v2", input)).toMatchObject({ total: 0 });
  const result = await local.rpc<{ items: { authors: string[] }[] }>(
    "hs_search",
    { ...input, author: "Researcher" },
  );
  expect(result.items.length).toBeGreaterThan(0);
  expect(result.items.every((d) => d.authors.includes("Researcher"))).toBe(
    true,
  );
});
it("allows removal of owned annotations after the public document is withdrawn", async () => {
  const d = (
    await ingestDocument(
      local.rpc,
      async () => {},
      fixture("Withdrawn fixture"),
    )
  ).id;
  await asUser(bob, "hs_me_mutate", {
    action: "bookmark",
    documentId: d,
    saved: true,
  });
  await local.db.query(
    "update hs_documents set status='withdrawn' where id=$1",
    [d],
  );
  await expect(
    asUser(bob, "hs_me_mutate", {
      action: "bookmark",
      documentId: d,
      saved: true,
    }),
  ).rejects.toThrow("Document unavailable");
  expect(
    await asUser(bob, "hs_me_mutate", {
      action: "bookmark",
      documentId: d,
      saved: false,
    }),
  ).toMatchObject({ ok: true });
});
it("enforces collection and search quotas even through direct table writes", async () => {
  const owner = "30000000-0000-4000-8000-000000000003";
  await local.db.query("insert into auth.users(id) values($1)", [owner]);
  try {
    await userSql(
      owner,
      "insert into hs_collections(name) select 'Collection '||n from generate_series(1,50) n",
    );
    await expect(
      asUser(owner, "hs_me_mutate", {
        action: "collection_create",
        name: "Too many",
      }),
    ).rejects.toThrow("limit reached");
    await userSql(
      owner,
      "insert into hs_saved_searches(name,query_text) select 'Watch '||n,'XSS' from generate_series(1,20) n",
    );
    await expect(
      asUser(owner, "hs_me_mutate", {
        action: "search_save",
        name: "Too many",
        queryText: "XSS",
      }),
    ).rejects.toThrow("limit reached");
  } finally {
    await local.db.query("delete from auth.users where id=$1", [owner]);
  }
});
it("resumes the bounded alert cursor across separate invocations", async () => {
  const owners = [
    "40000000-0000-4000-8000-000000000004",
    "50000000-0000-4000-8000-000000000005",
  ];
  await local.db.query("insert into auth.users(id) values($1),($2)", owners);
  try {
    for (const owner of owners)
      await userSql(
        owner,
        "insert into hs_saved_searches(name,filters) select 'Follow '||n,'{\"source\":\"Cursor fixture\"}'::jsonb from generate_series(1,13) n",
      );
    const d = await ingestDocument(
      local.rpc,
      async () => {},
      fixture("Cursor fixture report", { platform: "Cursor fixture" }),
    );
    expect(await local.rpc("hs_alert_run")).toMatchObject({
      processedSearches: 25,
    });
    expect(
      (
        await local.db.query(
          "select after_search_id from hs_alert_runner_state",
        )
      ).rows[0],
    ).not.toEqual({ after_search_id: null });
    const second = await local.rpc<{
      processedSearches: number;
      afterSearchId: string | null;
    }>("hs_alert_run");
    expect(second.processedSearches).toBeGreaterThan(0);
    expect(second.afterSearchId).toBeNull();
    const r = await local.db.query<{ n: number }>(
      "select count(*)::int n from hs_notifications where owner_id=any($1::uuid[]) and document_id=$2",
      [owners, d.id],
    );
    expect(r.rows[0].n).toBe(26);
  } finally {
    await local.db.query("delete from auth.users where id=any($1::uuid[])", [
      owners,
    ]);
  }
});
it("treats updates to old reports separately from historical imports", async () => {
  const report = fixture("Old XSS disclosure", {
    topics: ["XSS"],
    publishedAt: "2020-01-01T00:00:00.000Z",
  });
  await ingestDocument(local.rpc, async () => {}, {
    ...report,
    markdown: report.markdown + " Freshly disclosed revision evidence.",
  });
  expect(await local.rpc("hs_alert_run")).toMatchObject({ created: 1 });
});
it("isolates a malformed direct-write search instead of interrupting other owners", async () => {
  const bad = (
    await userSql<{ id: string }>(
      bob,
      "insert into hs_saved_searches(name,filters) values('Malformed fixture','{\"after\":\"not-a-date\"}') returning id",
    )
  ).rows[0].id;
  try {
    await ingestDocument(
      local.rpc,
      async () => {},
      fixture("Fresh XSS after invalid search", { topics: ["XSS"] }),
    );
    expect(await local.rpc("hs_alert_run")).toMatchObject({
      created: 1,
      invalidSearches: 1,
    });
    expect(
      (
        await userSql<{ enabled: boolean }>(
          bob,
          "select enabled from hs_saved_searches where id=$1",
          [bad],
        )
      ).rows[0].enabled,
    ).toBe(false);
  } finally {
    await asUser(bob, "hs_me_mutate", { action: "search_delete", id: bad });
  }
});
it("exports only owned data and cascades personal deletion without deleting public reports", async () => {
  const exported = await asUser<{
    notes: { body: string }[];
    bookmarks: unknown[];
  }>(alice, "hs_me_export");
  expect(exported.notes[0].body).toBe("Alice-private-needle");
  expect(exported.bookmarks).toHaveLength(1);
  expect(await asUser(bob, "hs_me_export")).toMatchObject({
    notes: [],
    bookmarks: [],
  });
  await local.db.query("delete from auth.users where id=$1", [alice]);
  expect(
    (await local.db.query("select * from hs_notes where owner_id=$1", [alice]))
      .rows,
  ).toHaveLength(0);
  expect(
    (await local.db.query("select id from hs_documents where id=$1", [docId]))
      .rows,
  ).toHaveLength(1);
});
