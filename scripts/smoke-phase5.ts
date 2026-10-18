import assert from "node:assert/strict";
const base = process.env.HUNTSIGNAL_API_URL || "http://127.0.0.1:8787";
async function get(path: string) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200, path);
  return r.json();
}
const health = await get("/api/health");
assert.equal(health.version, "0.5.0");
const stats = await get("/api/stats");
assert.equal(stats.full + stats.partial + stats.metadata, stats.total);
assert.ok(stats.papers >= 1);
const sources = await get("/api/sources");
for (const id of [
  "owasp-wstg",
  "arxiv-security",
  "bugcrowd",
  "portswigger-research",
  "intigriti-research",
  "yeswehack-research",
  "infosec-writeups",
])
  assert.ok(
    sources.some((s: any) => s.id === id && s.documents > 0),
    id,
  );
const papers = await get("/api/search?kind=paper&limit=5");
assert.ok(papers.items.length);
assert.ok(
  papers.items.every(
    (d: any) => d.kind === "paper" && d.completeness === "partial",
  ),
);
const abstract = await get(`/api/items/${papers.items[0].id}`);
assert.ok(abstract.markdown.startsWith("## Abstract"));
assert.ok(abstract.license.includes("metadata"));
const guides = await get(
  "/api/search?q=information+gathering&source=OWASP&completeness=full&limit=20",
);
const guide = guides.items.find((d: any) => d.source_id === "owasp-wstg");
assert.ok(guide);
const body = await get(`/api/items/${guide.id}`);
assert.ok(body.markdown.length >= 80);
assert.equal(body.license, "CC-BY-SA-4.0");
const xss = await get("/api/search?q=XSS&limit=5");
const synonym = await get("/api/search?q=cross-site+scripting&limit=5");
assert.equal(xss.total, synonym.total);
console.log(
  JSON.stringify({
    version: health.version,
    total: stats.total,
    full: stats.full,
    partial: stats.partial,
    metadata: stats.metadata,
    papers: stats.papers,
    configuredSources: sources.length,
    coverage: "passed",
    paperReader: "passed",
    licensedReader: "passed",
    synonyms: "passed",
  }),
);
