import assert from "node:assert/strict";
const base = process.env.HUNTSIGNAL_API_URL || "http://127.0.0.1:8787";
async function get(path: string) {
  const r = await fetch(base + path);
  assert.equal(r.status, 200, path);
  return r.json();
}
const stats = await get("/api/stats");
const a = await get("/api/search?q=XSS"),
  b = await get("/api/search?q=cross-site%20scripting");
assert.equal(a.total, b.total);
assert.deepEqual(
  a.items.map((d: { id: string }) => d.id),
  b.items.map((d: { id: string }) => d.id),
);
const full = await get("/api/search?completeness=full&limit=1");
assert.ok(full.total > 0);
const reader = await get(`/api/items/${full.items[0].id}`);
assert.ok(reader.markdown.length > 80);
assert.equal(reader.license, "CC-BY-SA-4.0");
const metadata = await get("/api/search?completeness=metadata&limit=1");
const entry = await get(`/api/items/${metadata.items[0].id}`);
assert.equal(entry.markdown, undefined);
const combined = await get("/api/search?q=OAuth%20account%20takeover");
console.log(
  JSON.stringify({
    total: stats.total,
    full: full.total,
    metadata: metadata.total,
    xss: a.total,
    oauthTakeover: combined.total,
    readerCharacters: reader.markdown.length,
    keywordParity: "passed",
    metadataIsolation: "passed",
  }),
);
