import { afterEach, expect, it, vi } from "vitest";
import {
  personalApi,
  accountBackend,
  safePublishableKey,
  tokenHash,
  type AccountBackend,
} from "../apps/api/personal";
import { feedsApi, rssXml } from "../apps/api/feeds";
import { Repository, type Rpc } from "../packages/repository";
import { safeReturnPath } from "../apps/web/auth";
import { savedSearchInput } from "../packages/personal";
const userId = "10000000-0000-4000-8000-000000000001";
const searchId = "20000000-0000-4000-8000-000000000002";
function setup() {
  const calls: { name: string; p: unknown }[] = [];
  const rpc: Rpc = async <T>(name: string, p: unknown = {}) => {
    calls.push({ name, p });
    return { ok: true } as T;
  };
  const backend: AccountBackend = {
    url: "https://project.supabase.co",
    publishableKey: "sb_publishable_fixture",
    verify: vi.fn(async (token) =>
      token === "valid-session" ? { id: userId } : null,
    ),
    rpc: vi.fn(() => rpc),
    deleteAccount: vi.fn(async () => {}),
  };
  const app = personalApi(backend);
  const request = (
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) =>
    app.request("https://huntsignal.example" + path, {
      method,
      headers: {
        Authorization: "Bearer valid-session",
        Origin: "https://huntsignal.example",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { calls, backend, app, request };
}
afterEach(() => vi.unstubAllGlobals());
it("requires verified user sessions and never caches private responses", async () => {
  const { app, backend } = setup();
  for (const headers of [
    {},
    { Authorization: "Bearer expired" },
  ] as HeadersInit[]) {
    const response = await app.request("/library", { headers });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toContain("Authorization");
  }
  expect(backend.rpc).not.toHaveBeenCalled();
});
it("accepts only validated URL actions and cannot inject preview content or approval identity", async () => {
  const { request, calls } = setup();
  expect(
    (
      await request("/operations/submissions", {
        action: "request",
        url: "https://example.org/?token=secret",
        kind: "article",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request("/operations/submissions", {
        action: "approve",
        id: searchId,
        approvedBy: userId,
      })
    ).status,
  ).toBe(400);
  expect(calls).toHaveLength(0);
  expect(
    (
      await request("/operations/submissions", {
        action: "request",
        url: "https://www.hackerone.com/reports/123/?utm_source=example",
        kind: "report",
      })
    ).status,
  ).toBe(200);
  expect(calls[0]).toEqual({
    name: "hs_me_submission",
    p: {
      action: "request",
      url: "https://hackerone.com/reports/123",
      kind: "report",
    },
  });
});
it("blocks cross-origin writes and client-supplied ownership", async () => {
  const { app, request, calls } = setup();
  expect(
    (
      await app.request("https://huntsignal.example/mutate", {
        method: "POST",
        headers: {
          Authorization: "Bearer valid-session",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ action: "collection_create", name: "Test" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/mutate", {
        action: "collection_create",
        name: "Test",
        ownerId: searchId,
      })
    ).status,
  ).toBe(400);
  expect(calls).toHaveLength(0);
});
it("forwards private RPC calls through the verified bearer, with server-expanded synonyms", async () => {
  const { request, backend, calls } = setup();
  expect(
    (await request("/searches", { name: "XSS", queryText: "XSS" })).status,
  ).toBe(200);
  expect(backend.rpc).toHaveBeenCalledWith("valid-session");
  expect(calls[0].name).toBe("hs_me_mutate");
  expect(JSON.stringify(calls[0].p)).toContain("cross site scripting");
  expect(
    (await request("/searches", { name: "XSS", queryText: "XSS", groups: [] }))
      .status,
  ).toBe(400);
});
it("generates unpredictable RSS capabilities and persists only their hash", async () => {
  const { request, calls } = setup();
  const response = await request("/feeds", { searchId });
  const { url } = (await response.json()) as { url: string };
  const token = new URL(url).pathname.split("/").pop()!.replace(".xml", "");
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(calls[0].p).toEqual({
    action: "feed_rotate",
    searchId,
    tokenHash: await tokenHash(token),
  });
  expect(JSON.stringify(calls)).not.toContain(token);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("deletes only the verified identity after an exact confirmation", async () => {
  const { request, backend } = setup();
  expect(
    (await request("/account", { confirmation: "delete" }, "DELETE")).status,
  ).toBe(400);
  expect(
    (
      await request(
        "/account",
        { confirmation: "DELETE", userId: searchId },
        "DELETE",
      )
    ).status,
  ).toBe(400);
  expect(backend.deleteAccount).not.toHaveBeenCalled();
  expect(
    (await request("/account", { confirmation: "DELETE" }, "DELETE")).status,
  ).toBe(200);
  expect(backend.deleteAccount).toHaveBeenCalledExactlyOnceWith(userId);
});
it("never accepts a service-role key as browser configuration", () => {
  const jwt = (role: string) =>
    "header." + btoa(JSON.stringify({ role })) + ".signature";
  expect(safePublishableKey("sb_secret_fixture")).toBe(false);
  expect(safePublishableKey(jwt("service_role"))).toBe(false);
  expect(safePublishableKey(jwt("anon"))).toBe(true);
  expect(
    safePublishableKey("sb_publishable_fixture", "sb_publishable_fixture"),
  ).toBe(false);
});
it("uses the publishable API key and user bearer for both verification and personal SQL", async () => {
  const fetcher = vi.fn(async () => Response.json({ id: userId }));
  vi.stubGlobal("fetch", fetcher);
  const backend = accountBackend(
    "https://project.supabase.co",
    "sb_publishable_fixture",
    "sb_secret_fixture",
  )!;
  await backend.verify("user-bearer");
  await backend.rpc("user-bearer")("hs_me_library");
  for (const [, init] of fetcher.mock.calls as unknown as [
    string,
    RequestInit,
  ][]) {
    expect(init.headers).toMatchObject({
      apikey: "sb_publishable_fixture",
      Authorization: "Bearer user-bearer",
    });
    expect(JSON.stringify(init)).not.toContain("sb_secret_fixture");
  }
  await expect(backend.rpc("user-bearer")("hs_alert_run")).rejects.toThrow(
    "Invalid personal operation",
  );
});
it("escapes source strings in RSS and keeps revoked or malformed feeds unavailable", async () => {
  const text = rssXml("Test <script>", "https://example.org", [
    {
      id: "a",
      title: "<img src=x>",
      canonical_url: "https://example.org/?a=1&b=2",
      excerpt: "</description><script>bad</script>",
    },
  ]);
  expect(text).not.toContain("<script>");
  expect(text).toContain("&lt;img");
  expect(text).toContain("a=1&amp;b=2");
  const calls: unknown[] = [];
  const rpc: Rpc = async <T>(_name: string, p: unknown) => {
    calls.push(p);
    return null as T;
  };
  const app = feedsApi(new Repository(rpc, async () => ""));
  const malformed = await app.request("/saved/invalid.xml");
  expect(malformed.status).toBe(404);
  expect(calls).toHaveLength(0);
  const response = await app.request("/saved/" + "a".repeat(64) + ".xml");
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(calls).toEqual([{ tokenHash: await tokenHash("a".repeat(64)) }]);
});
it("requires normalized model-compatible semantic searches and safe return URLs", () => {
  expect(
    savedSearchInput.safeParse({
      name: "Watch",
      queryText: "OAuth takeover",
      mode: "hybrid",
    }).success,
  ).toBe(false);
  expect(
    savedSearchInput.safeParse({
      name: "Follow",
      filters: { author: "Researcher" },
    }).success,
  ).toBe(true);
  expect(safeReturnPath("//evil.example", "https://hunt.example")).toBe(
    "/?view=library",
  );
  expect(
    safeReturnPath("/auth/callback?code=secret", "https://hunt.example"),
  ).toBe("/?view=library");
  expect(safeReturnPath("/?view=archive&q=XSS", "https://hunt.example")).toBe(
    "/?view=archive&q=XSS",
  );
});
