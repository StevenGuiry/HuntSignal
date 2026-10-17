import { it, expect, vi, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { hackeroneDocument } from "../ingestion/adapters/hackerone";
import worker from "../apps/api/worker";
afterEach(() => vi.unstubAllGlobals());
it("parses the documented HackerOne top-level report shape and rejects nonpublic reports", () => {
  const item = {
    id: 123,
    attributes: {
      title: "Example disclosed report",
      disclosed: true,
      disclosed_at: "2024-01-01T00:00:00Z",
      cwe: "XSS",
    },
    relationships: {
      reporter: {
        data: { attributes: { name: "Researcher", username: "researcher" } },
      },
      program: {
        data: { attributes: { name: "Example program", handle: "example" } },
      },
    },
  };
  expect(hackeroneDocument(item)).toMatchObject({
    externalId: "123",
    canonicalUrl: "https://hackerone.com/reports/123",
    authors: ["Researcher"],
    programs: ["Example program"],
    topics: ["XSS"],
    completeness: "metadata",
  });
  expect(
    hackeroneDocument({
      ...item,
      attributes: { ...item.attributes, disclosed: false },
    }),
  ).toBeNull();
  expect(hackeroneDocument({ ...item, id: "../me" })).toBeNull();
});
it("fails clearly without cloud configuration", async () => {
  const response = await worker.fetch(
    new Request("https://app.example/api/stats"),
    {
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      ARCHIVE_BUCKET: "archive",
      ASSETS: { fetch: async () => new Response("static") },
    },
  );
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("NOT_CONFIGURED");
});
it("reads compressed private Storage objects through the production Worker path", async () => {
  const key = "test-backend-secret";
  const fetchMock = vi.fn(async (input: string, options: RequestInit) => {
    expect((options.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${key}`,
    );
    if (input.includes("/rest/v1/rpc/hs_detail"))
      return Response.json({
        id: "00000000-0000-4000-8000-000000000001",
        title: "Archived research",
        completeness: "full",
        object_path: `${"a".repeat(64)}.json.gz`,
      });
    return new Response(
      new Uint8Array(
        gzipSync(JSON.stringify({ markdown: "# Preserved body" })),
      ),
      { headers: { "Content-Type": "application/gzip" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const response = await worker.fetch(
    new Request(
      "https://app.example/api/items/00000000-0000-4000-8000-000000000001",
    ),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: key,
      ARCHIVE_BUCKET: "archive",
      ASSETS: { fetch: async () => new Response("static") },
    },
  );
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.markdown).toBe("# Preserved body");
  expect(JSON.stringify(body)).not.toContain(key);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
