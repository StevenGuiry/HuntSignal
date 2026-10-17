import { afterEach, it, expect, vi } from "vitest";
import worker from "../apps/api/worker";
afterEach(() => vi.unstubAllGlobals());
const env = {
  SUPABASE_URL: "https://example.test",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture",
  ARCHIVE_BUCKET: "archive",
  ASSETS: { fetch: async () => new Response("static") },
};
it("caches only the explicit public statistics and topic routes", async () => {
  const match = vi.fn(async () => undefined),
    put = vi.fn(async () => {});
  vi.stubGlobal("caches", { default: { match, put } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ total: 1 })),
  );
  const publicResponse = await worker.fetch(
    new Request("https://hunt.example/api/stats"),
    env,
  );
  expect(publicResponse.headers.get("Cache-Control")).toBe(
    "public, max-age=60",
  );
  expect(put).toHaveBeenCalledTimes(1);
  const privateResponse = await worker.fetch(
    new Request("https://hunt.example/api/me/library"),
    env,
  );
  expect(privateResponse.headers.get("Cache-Control")).toBe("no-store");
  expect(match).toHaveBeenCalledTimes(1);
  expect(put).toHaveBeenCalledTimes(1);
  await worker.fetch(
    new Request("https://hunt.example/api/stats", {
      headers: { Authorization: "Bearer session" },
    }),
    env,
  );
  expect(match).toHaveBeenCalledTimes(1);
});
it("returns bounded backoff responses when the native limiter rejects a request", async () => {
  const response = await worker.fetch(
    new Request("https://hunt.example/api/stats"),
    { ...env, PUBLIC_LIMITER: { limit: async () => ({ success: false }) } },
  );
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
