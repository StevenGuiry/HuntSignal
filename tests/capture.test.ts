import { beforeAll, afterAll, it, expect, vi } from "vitest";
import {
  articleBody,
  publicHackerOneBody,
  captureDocument,
  captureInput,
} from "../ingestion/capture";
import { openLocal } from "../packages/local";
import { ingestDocument } from "../ingestion/pipeline";
import { runSource } from "../ingestion/operations";
import { expandQuery } from "../packages/taxonomy";
import { safeFetch, SourceFetchError } from "../ingestion/fetch";
import type { InputDocument } from "../packages/contracts";
vi.mock("../ingestion/fetch", async (original) => ({
  ...(await original<typeof import("../ingestion/fetch")>()),
  safeFetch: vi.fn(),
}));
const base = (suffix: string): InputDocument => ({
  sourceId: "capture-fixture",
  sourceName: "Capture fixture",
  sourceUrl: "https://example.org",
  externalId: suffix,
  canonicalUrl: `https://example.org/${suffix}`,
  title: "Synthetic XSS report " + suffix,
  kind: "report",
  platform: "Synthetic",
  authors: ["Researcher"],
  topics: ["XSS"],
  programs: [],
  excerpt: "",
  markdown: "",
  publishedAt: new Date().toISOString(),
  completeness: "metadata",
  license: "Original author",
  licenseUrl: null,
  attribution: "Synthetic fixture",
  rightsEvidence: "https://example.org",
  canArchive: false,
});
const body =
  "A substantive synthetic vulnerability report describing cross-site scripting, the vulnerable parameter, reproduction steps, and impact. ".repeat(
    10,
  );
it("captures only explicitly public HackerOne report text and labels limited disclosures partial", () => {
  const report = {
    id: 123,
    public: true,
    can_view_report: true,
    disclosed_at: "2026-01-01",
    visibility: "full",
    vulnerability_information: body,
  };
  expect(publicHackerOneBody(report, "123")).toMatchObject({
    markdown: body.trim(),
    completeness: "full",
  });
  expect(() =>
    publicHackerOneBody({ ...report, public: false }, "123"),
  ).toThrow("not_public");
  expect(() => publicHackerOneBody(report, "124")).toThrow("not_public");
  expect(
    publicHackerOneBody(
      { ...report, visibility: "limited", summaries: [{ content: body }] },
      "123",
    ).completeness,
  ).toBe("partial");
  expect(() =>
    publicHackerOneBody(
      { ...report, visibility: "limited", summaries: [] },
      "123",
    ),
  ).toThrow("no_public_body");
});
it("extracts article text while preserving code and links without embedding scripts or remote images", () => {
  const html = `<html><head><title>Synthetic report</title></head><body><article><h1>Synthetic report</h1><p>${body}</p><pre><code>GET /?q=&lt;script&gt; HTTP/1.1\n  indented</code></pre><p><a href="/reference">Reference</a><img alt="diagram" src="https://tracker.example/pixel"/></p><script>malicious()</script></article></body></html>`;
  const result = articleBody(html, "https://example.org/report");
  expect(result.completeness).toBe("full");
  expect(result.markdown).toContain("```");
  expect(result.markdown).toContain("  indented");
  expect(result.markdown).toContain("https://example.org/reference");
  expect(result.markdown).not.toContain("malicious()");
  expect(result.markdown).not.toContain("tracker.example");
});
it("rejects paywalls, access gates, and trivial HTML placeholders", () => {
  expect(() =>
    articleBody(
      "<title>Just a moment...</title><p>" + body + "</p>",
      "https://example.org",
    ),
  ).toThrow("access_blocked");
  expect(() =>
    articleBody(
      '<script type="application/ld+json">{"isAccessibleForFree":false}</script><p>' +
        body +
        "</p>",
      "https://example.org",
    ),
  ).toThrow("paywall");
  expect(() =>
    articleBody("<title>Story</title><p>Removed.</p>", "https://example.org"),
  ).toThrow("insufficient_text");
});
it("labels a publicly provided Bugcrowd summary as partial rather than a complete report", () => {
  const result = articleBody(
    `<section class="col-md-9"><div>Summary by researcher</div><p>${body}</p></section>`,
    "https://bugcrowd.com/disclosures/example",
  );
  expect(result.completeness).toBe("partial");
  expect(() =>
    articleBody(
      "<p>" + body + "</p>",
      "https://bugcrowd.com/disclosures/example",
    ),
  ).toThrow("no_public_summary");
});
it("does not fetch bodies disallowed by robots and leaves HTTP denials as capture failures", async () => {
  const mock = vi.mocked(safeFetch);
  mock.mockReset();
  mock.mockResolvedValueOnce({
    status: 200,
    body: "User-agent: *\nDisallow: /",
  });
  await expect(
    captureDocument({
      ...base("blocked"),
      canonicalUrl: "https://blocked.example/story",
    }),
  ).rejects.toThrow("robots_disallowed");
  expect(mock).toHaveBeenCalledTimes(1);
  mock.mockReset();
  mock.mockImplementation(async (url) => {
    if (url.endsWith("/robots.txt")) return { status: 200, body: "" };
    throw new SourceFetchError(403);
  });
  await expect(
    captureDocument({
      ...base("denied"),
      canonicalUrl: "https://denied.example/story",
    }),
  ).rejects.toThrow("HTTP 403");
});
let local: Awaited<ReturnType<typeof openLocal>>;
const objects = new Map<string, string>();
const write = async (path: string, value: string) => {
  objects.set(path, value);
};
beforeAll(async () => {
  local = await openLocal(true);
}, 60000);
afterAll(async () => {
  await local.db.close();
});
it("holds metadata in a private candidate queue and publishes the same document after a substantive capture", async () => {
  const d = base("upgrade");
  const first = await ingestDocument(local.rpc, write, d);
  expect(await local.rpc("hs_detail", { id: first.id })).toBeNull();
  expect(await local.rpc("hs_stats")).toMatchObject({ total: 0, metadata: 0 });
  expect(
    await local.rpc("hs_search", { groups: expandQuery("XSS").groups }),
  ).toMatchObject({ total: 0 });
  expect(
    (
      await local.db.query(
        "select count(*)::integer n from hs_publication_events",
      )
    ).rows[0],
  ).toMatchObject({ n: 0 });
  const queued = await local.rpc<any[]>("hs_capture_candidates", {
    version: "test",
  });
  expect(queued[0].id).toBe(first.id);
  expect(captureInput(queued[0].document).publishedAt).toBe(d.publishedAt);
  const full = {
    ...d,
    markdown: body,
    completeness: "full" as const,
    canArchive: true,
  };
  const second = await ingestDocument(local.rpc, write, full);
  expect(second.id).toBe(first.id);
  expect(await local.rpc("hs_detail", { id: first.id })).toMatchObject({
    completeness: "full",
  });
  expect(
    await local.rpc("hs_search", { groups: expandQuery("XSS").groups }),
  ).toMatchObject({ total: 1 });
  expect(
    (
      await local.db.query(
        "select kind from hs_publication_events where document_id=$1",
        [first.id],
      )
    ).rows,
  ).toEqual([{ kind: "published" }]);
});
it("backoffs unavailable candidates and denies ordinary users access to the capture queue", async () => {
  const { id } = await ingestDocument(local.rpc, write, base("retry"));
  await local.rpc("hs_capture_record", {
    id,
    version: "test",
    state: "retry",
    reason: "HTTP 403",
  });
  expect(
    (await local.rpc<any[]>("hs_capture_candidates", { version: "test" })).some(
      (d) => d.id === id,
    ),
  ).toBe(false);
  expect(
    (
      await local.rpc<any[]>("hs_capture_candidates", { version: "new-parser" })
    ).some((d) => d.id === id),
  ).toBe(true);
  await expect(
    local.db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select hs_capture_candidates($1::jsonb)", ["{}"]);
    }),
  ).rejects.toThrow("permission denied");
});
it("uses independent job keys for sources sharing an external identifier while preserving source identity", async () => {
  async function* docs() {
    for (const sourceId of ["capture-one", "capture-two"])
      yield {
        ...base("same"),
        sourceId,
        canonicalUrl: `https://example.org/${sourceId}`,
        markdown: body,
        completeness: "full" as const,
        canArchive: true,
      };
  }
  const result = await runSource(
    local.rpc,
    write,
    async (p) => objects.get(p)!,
    "fulltext-capture",
    () => docs(),
    { force: true, jobKey: (d) => d.sourceId + ":" + d.externalId },
  );
  expect(result).toMatchObject({ inserted: 2, failed: 0 });
  expect(
    (
      await local.db.query(
        "select external_id from hs_documents where source_id in ('capture-one','capture-two')",
      )
    ).rows,
  ).toEqual([{ external_id: "same" }, { external_id: "same" }]);
});
