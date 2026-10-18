import assert from "node:assert/strict";
const base = process.env.HUNTSIGNAL_API_URL || "http://127.0.0.1:8787";
async function get(path: string) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200, path);
  return r.json();
}
const stats = await get("/api/stats");
assert.equal(stats.metadata, 0);
assert.equal((await get("/api/search?completeness=metadata")).total, 0);
const found = await get(
  "/api/search?source=HackerOne&completeness=full&limit=1",
);
assert.ok(found.items.length, "No full public report captured yet");
const d = await get(`/api/items/${found.items[0].id}`);
assert.ok(d.markdown.length >= 80);
const metadata = [d.title, d.excerpt, ...d.authors, ...d.topics, ...d.programs]
  .join(" ")
  .toLowerCase();
const words = [...new Set<string>(d.markdown.match(/[A-Za-z]{12,26}/g) || [])]
  .filter((w) => !metadata.includes(w.toLowerCase()))
  .slice(0, 5);
let bodyMatch = false;
for (const word of words) {
  const result = await get(
    `/api/search?q=${encodeURIComponent(word)}&limit=50`,
  );
  if (result.items.some((item: any) => item.id === d.id)) {
    bodyMatch = true;
    break;
  }
}
assert.ok(bodyMatch, "A body-only term must find the captured report");
console.log(
  JSON.stringify({
    readableEntries: stats.total,
    full: stats.full,
    partial: stats.partial,
    metadata: stats.metadata,
    report: d.id,
    reportCharacters: d.markdown.length,
    bodyOnlyKeywordSearch: "passed",
  }),
);
