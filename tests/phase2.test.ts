import { beforeAll, afterAll, it, expect } from "vitest";
import { openLocal } from "../packages/local";
import { ingestDocument } from "../ingestion/pipeline";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
import { searchSchema, type InputDocument } from "../packages/contracts";
import { expandQuery } from "../packages/taxonomy";
let local: Awaited<ReturnType<typeof openLocal>>;
const ids: string[] = [];
const vector = (axis: number) =>
  Array.from({ length: 384 }, (_, i) => (i === axis ? 1 : 0));
async function insert(
  name: string,
  axis: number,
  bodyHash: string | null = null,
  citations: string[] = [],
) {
  const doc: InputDocument = {
    sourceId: "test",
    sourceName: "Test",
    sourceUrl: "https://example.org",
    externalId: name,
    canonicalUrl: `https://example.org/${name}`,
    title: name,
    kind: "article",
    platform: axis === 0 ? "Research" : "Other",
    authors: ["Researcher"],
    topics: axis === 0 ? ["OAuth"] : ["XSS"],
    programs: [],
    excerpt: "A synthetic research fixture.",
    markdown:
      "A substantive synthetic document for checking vector retrieval and related source preservation. ".repeat(
        30,
      ),
    publishedAt: "2024-01-01T00:00:00.000Z",
    completeness: "full",
    license: "CC0",
    licenseUrl: null,
    attribution: "Synthetic fixture",
    rightsEvidence: "https://example.org/license",
    canArchive: true,
  };
  const d = await ingestDocument(local.rpc, async () => {}, doc);
  ids.push(d.id);
  const { rows } = await local.db.query<{ current_revision_id: string }>(
    "select current_revision_id from hs_documents where id=$1",
    [d.id],
  );
  const payload = {
    document_id: d.id,
    revision_id: rows[0].current_revision_id,
    model_id: EMBEDDING_MODEL.id,
    word_count: 300,
    body_hash: bodyHash,
    citations,
    passages: [
      {
        text: `A passage about ${axis === 0 ? "OAuth redirect validation and account takeover" : "unrelated cross site scripting"}`,
        vector: vector(axis),
      },
    ],
  };
  expect(await local.rpc("hs_index_put", payload)).toMatchObject({
    status: "indexed",
  });
  return { id: d.id, payload };
}
beforeAll(async () => {
  local = await openLocal(true);
});
afterAll(async () => {
  await local?.db.close();
});
it("retrieves semantic candidates outside keyword matches and applies filters before ranking", async () => {
  await insert("Opaque title A", 0);
  await insert("Opaque title B", 1);
  const query = {
    ...searchSchema.parse({ q: "incorrect redirect permits hijacking" }),
    groups: expandQuery("incorrect redirect permits hijacking").groups,
    mode: "hybrid",
    vector: vector(0),
    modelId: EMBEDDING_MODEL.id,
  };
  const r = await local.rpc<{ items: { id: string }[]; total: number }>(
    "hs_search_v2",
    query,
  );
  expect(r.items[0].id).toBe(ids[0]);
  expect(r.total).toBe(1);
  expect(
    await local.rpc("hs_search_v2", { ...query, source: "Other" }),
  ).toMatchObject({ total: 0 });
});
it("groups exact archived text in hybrid results while preserving complete keyword pagination", async () => {
  await insert("Duplicate fixture one", 0, "a".repeat(64));
  await insert("Duplicate fixture two", 0, "a".repeat(64));
  const r = await local.rpc<{
    items: { title: string; duplicate_count: number }[];
    total: number;
  }>("hs_search_v2", {
    ...searchSchema.parse({ q: "Duplicate fixture" }),
    groups: expandQuery("Duplicate fixture").groups,
    mode: "hybrid",
    vector: vector(0),
    modelId: EMBEDDING_MODEL.id,
  });
  expect(r.items.filter((x) => x.title.startsWith("Duplicate"))).toHaveLength(
    1,
  );
  expect(r.items.some((x) => x.duplicate_count === 1)).toBe(true);
  const lexical = await local.rpc("hs_search_v2", {
    ...searchSchema.parse({ q: "Duplicate fixture" }),
    groups: expandQuery("Duplicate fixture").groups,
  });
  expect(lexical).toMatchObject({ total: 2, total_type: "exact" });
});
it("retains explicit citation links and labels duplicate suggestions separately", async () => {
  const cited = await insert("Cited source", 1);
  const citing = await insert("Citing source", 0, null, [
    "https://example.org/Cited source",
  ]);
  // Canonical URL normalization encodes the source path.
  await local.db.query(
    "update hs_citations set target_url=$1 where document_id=$2",
    ["https://example.org/Cited%20source", citing.id],
  );
  const related = await local.rpc<{
    items: { id: string; relation: string }[];
  }>("hs_related", { id: citing.id });
  expect(related.items.find((x) => x.id === cited.id)?.relation).toBe("cites");
  const candidates = await local.rpc<{ status: string }[]>(
    "hs_duplicate_candidates",
  );
  expect(candidates.some((x) => x.status === "exact")).toBe(true);
});
it("rejects mismatched models and stale indexing without publishing stale vectors", async () => {
  const d = await insert("Stale vector", 0);
  expect(
    await local.rpc("hs_index_put", {
      ...d.payload,
      revision_id: "00000000-0000-4000-8000-000000000000",
    }),
  ).toMatchObject({ status: "stale" });
  await expect(
    local.rpc("hs_search_v2", {
      q: "test",
      mode: "hybrid",
      groups: [],
      vector: vector(0),
      modelId: "other",
    }),
  ).rejects.toThrow("Embedding model mismatch");
  await local.db.query(
    "update hs_documents set status='withdrawn' where id=$1",
    [d.id],
  );
  const r = await local.rpc<{ items: { id: string }[] }>("hs_search_v2", {
    ...searchSchema.parse({ q: "test" }),
    mode: "hybrid",
    groups: [],
    vector: vector(0),
    modelId: EMBEDDING_MODEL.id,
  });
  expect(r.items.some((x) => x.id === d.id)).toBe(false);
});
