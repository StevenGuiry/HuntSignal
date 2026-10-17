import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createEncoder } from "../packages/embeddings/runtime";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
const base = process.env.HUNTSIGNAL_API_URL || "http://127.0.0.1:8787";
async function get(path: string) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200, path);
  return r.json();
}
const health = await get("/api/health");
assert.ok(["0.2.0", "0.3.0", "0.4.0"].includes(health.version));
const status = await get("/api/search/status");
assert.equal(status.model_id, EMBEDDING_MODEL.id);
assert.ok(status.indexed_documents > 0);
const topics = await get("/api/topics");
assert.ok(topics.length >= 10);
assert.ok(
  topics.some(
    (t: { id: string; count: number }) => t.id === "xxe" && t.count > 0,
  ),
);
const encoder = await createEncoder(resolve("public/models") + "/");
try {
  const q = "account takeover through OAuth mistakes";
  const [vector] = await encoder.embed([q]);
  const r = await fetch(base + "/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q,
      mode: "hybrid",
      modelId: EMBEDDING_MODEL.id,
      vector,
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.equal(result.mode, "hybrid");
  assert.ok(result.items.length > 0);
  const related = await get(`/api/items/${result.items[0].id}/related`);
  assert.ok(Array.isArray(related.items));
  const duplicates = await get("/api/duplicates");
  assert.ok(Array.isArray(duplicates));
  console.log(
    JSON.stringify({
      version: health.version,
      indexed: status.indexed_documents,
      total: status.total_documents,
      topics: topics.length,
      semanticResults: result.total,
      related: related.items.length,
      duplicateCandidates: duplicates.length,
      status: "passed",
    }),
  );
} finally {
  await encoder.dispose();
}
