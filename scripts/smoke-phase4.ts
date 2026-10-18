import assert from "node:assert/strict";
const base = process.env.HUNTSIGNAL_API_URL || "http://127.0.0.1:8787";
const get = (path: string) =>
  fetch(base + path, { signal: AbortSignal.timeout(20000) });
const health = await (await get("/api/health")).json();
assert.ok(["0.4.0", "0.5.0", "0.5.1"].includes(health.version));
const response = await get("/api/operations/health");
assert.equal(response.status, 200);
assert.equal(response.headers.get("Cache-Control"), "no-store");
const operations = await response.json();
assert.ok([4, 5].includes(operations.phase));
assert.ok(Array.isArray(operations.sources));
assert.ok(!JSON.stringify(operations).includes("lease_token"));
assert.ok(!JSON.stringify(operations).includes("recent_cursor"));
const privateResponse = await get("/api/me/operations");
assert.ok([401, 503].includes(privateResponse.status));
const result = await (await get("/api/search?limit=1")).json();
assert.ok(result.items.length);
const revisions = await (
  await get(`/api/items/${result.items[0].id}/revisions`)
).json();
assert.ok(revisions.length);
assert.ok(revisions.some((r: { current: boolean }) => r.current));
assert.ok(!JSON.stringify(revisions).includes("object_path"));
assert.equal((await get("/api/search?sort=updated")).status, 200);
console.log(
  JSON.stringify({
    version: health.version,
    sourceHealth: "passed",
    adminWithoutSession: privateResponse.status,
    revisionHistory: "passed",
    updatedFeed: "passed",
    sources: operations.sources.length,
    status: "passed",
  }),
);
