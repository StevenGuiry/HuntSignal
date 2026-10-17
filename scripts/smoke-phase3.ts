import assert from "node:assert/strict";
const base = process.env.HUNTSIGNAL_API_URL || "http://127.0.0.1:8787";
const request = (path: string) =>
  fetch(base + path, { signal: AbortSignal.timeout(20000) });
const health = await (await request("/api/health")).json();
assert.ok(["0.3.0", "0.4.0"].includes(health.version));
const configResponse = await request("/api/auth/config");
assert.equal(configResponse.headers.get("Cache-Control"), "no-store");
const config = (await configResponse.json()) as { enabled: boolean };
const privateResponse = await request("/api/me/library");
assert.ok([401, 503].includes(privateResponse.status));
assert.equal(privateResponse.headers.get("Cache-Control"), "no-store");
const rss = await request("/feeds/topics/xss.xml");
assert.equal(rss.status, 200);
assert.match(rss.headers.get("Content-Type") || "", /application\/rss\+xml/);
assert.ok((await rss.text()).includes('<rss version="2.0">'));
assert.equal((await request("/feeds/saved/not-a-capability.xml")).status, 404);
const filtered = await (
  await request("/api/search?author=__phase3_missing_author__")
).json();
assert.equal(filtered.total, 0, "Apply migration 006 for exact author filters");
console.log(
  JSON.stringify({
    version: health.version,
    accountsEnabled: config.enabled,
    privateWithoutSession: privateResponse.status,
    publicRss: "passed",
    authorFilter: "passed",
    status: "passed",
  }),
);
