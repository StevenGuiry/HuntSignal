import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { parseArxiv } from "../ingestion/adapters/arxiv";
import { bugcrowdDocument, bugcrowd } from "../ingestion/adapters/bugcrowd";
import {
  yeswehackLinks,
  yeswehackDocument,
} from "../ingestion/adapters/yeswehack";
import { wstgDocument, wstgPaths, wstg } from "../ingestion/adapters/wstg";
import { parseFeed, rss, type FeedConfig } from "../ingestion/adapters/rss";
import { canonicalize, prepare } from "../ingestion/normalize";
import { platform } from "../ingestion/adapters/pentesterland";
import { openLocal } from "../packages/local";
import { ingestDocument } from "../ingestion/pipeline";
import { safeFetch } from "../ingestion/fetch";
import type { DiscoveryContext } from "../ingestion/operations";
vi.mock("../ingestion/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ingestion/fetch")>()),
  safeFetch: vi.fn(),
}));
const atom = (
  title = "Cross-site scripting in web applications",
  abstract = "An abstract describing cross-site scripting, browser origins and OAuth authorization errors for a synthetic research paper.",
) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2601.12345v2</id><title>${title}</title><published>2026-01-15T00:00:00Z</published><summary>${abstract}</summary><author><name>First Researcher</name></author><author><name>Second Researcher</name></author></entry></feed>`;
const bc = {
  disclosed: true,
  disclosure_report_url:
    "/disclosures/62063e9b-cd95-4772-a3e8-890da44c1d4a/example-csrf",
  title: "Synthetic CSRF disclosure",
  disclosed_at: "14 Oct 2026",
  researcher_username: "synthetic",
  crowdstream_name_visible: true,
  engagement_name: "Synthetic Program",
};
const feed: FeedConfig = {
  id: "synthetic-feed",
  name: "Synthetic Research",
  url: "https://example.org/feed",
  allowedHosts: ["example.org"],
  kind: "article",
  fullTextPermitted: false,
  license: "Original author retains content rights",
  licenseUrl: null,
  rightsEvidence: "https://example.org/",
};
const path =
  "document/4-Web_Application_Security_Testing/05-Authorization_Testing/01-Testing_Traversal.md";
const body =
  "# Synthetic Traversal Guide\n\nA complete synthetic testing guide with enough content for an archival document.\n\n```http\nGET /?path=../../etc/passwd HTTP/1.1\n  preserved indentation\n```";
it("archives arXiv abstracts as partial text with the correct metadata license and stable identity", () => {
  const d = parseArxiv(atom()).documents[0];
  expect(d).toMatchObject({
    kind: "paper",
    completeness: "partial",
    canonicalUrl: "https://arxiv.org/abs/2601.12345",
    externalId: "2601.12345",
    authors: ["First Researcher", "Second Researcher"],
  });
  expect(d.markdown).toContain("## Abstract");
  expect(d.attribution).toContain("complete paper remains");
  expect(d.license).toContain("metadata");
  expect(prepare(d).contentHash).toBe(
    prepare({ ...d, revision: "2601.12345v3" }).contentHash,
  );
});
it("rejects invalid arXiv identities, entity declarations and response shapes", () => {
  expect(() =>
    parseArxiv(
      atom().replace(
        "http://arxiv.org/abs/2601.12345v2",
        "https://evil.example/paper",
      ),
    ),
  ).toThrow();
  expect(() => parseArxiv("<html>Unavailable</html>")).toThrow();
  expect(() => parseArxiv("<!DOCTYPE x>" + atom())).toThrow();
});
it("imports only disclosed Bugcrowd reports and honors researcher visibility", () => {
  expect(bugcrowdDocument(bc)).toMatchObject({
    kind: "report",
    completeness: "metadata",
    authors: ["synthetic"],
    publishedAt: "2026-10-14T00:00:00.000Z",
  });
  expect(bugcrowdDocument({ ...bc, disclosed: false })).toBeNull();
  expect(bugcrowdDocument({ ...bc, disclosed: null })).toBeNull();
  expect(
    bugcrowdDocument({
      ...bc,
      disclosure_report_url: bc.disclosure_report_url.replace(
        "example-csrf",
        "cgi-bin-bib_ui",
      ),
    }),
  ).not.toBeNull();
  expect(
    bugcrowdDocument({ ...bc, crowdstream_name_visible: false })?.authors,
  ).toEqual([]);
  expect(() =>
    bugcrowdDocument({
      ...bc,
      disclosure_report_url: "https://evil.example/disclosures/123",
    }),
  ).toThrow();
});
it("keeps YesWeHack research separate from platform disclosures and rejects off-site listing links", () => {
  expect(
    yeswehackLinks(
      '<a href="/learn-bug-bounty/synthetic">Guide</a><a href="/learn-bug-bounty/synthetic">Duplicate</a><a href="https://evil.example/learn-bug-bounty/fake">Bad</a>',
    ),
  ).toEqual(["https://www.yeswehack.com/learn-bug-bounty/synthetic"]);
  const d = yeswehackDocument(
    '<script type="application/ld+json">{"@type":"Article","name":"Synthetic OAuth testing","author":{"name":"Researcher"},"datePublished":"2026-01-02"}</script>',
    "https://www.yeswehack.com/learn-bug-bounty/synthetic",
  );
  expect(d).toMatchObject({
    kind: "article",
    markdown: "",
    completeness: "metadata",
    authors: ["Researcher"],
  });
  expect(() =>
    yeswehackDocument("<html>Login</html>", d.canonicalUrl),
  ).toThrow();
});
it("preserves full WSTG code blocks and pins license evidence to the captured revision", () => {
  const d = wstgDocument(path, body, "a".repeat(40));
  expect(d.markdown).toBe(body);
  expect(d.completeness).toBe("full");
  expect(d.rightsEvidence).toContain("a".repeat(40));
  expect(d.publishedAt).toBeNull();
  expect(
    wstgPaths([
      { path, type: "blob" },
      { path: "document/other.md", type: "blob" },
      { path: path + "/../../evil.md", type: "blob" },
      { path: path + ".png", type: "blob" },
      { path: path.replace("01-", "03-"), type: "blob", size: 46 },
    ]),
  ).toEqual([path]);
});
it("parses Atom authors and categories, deduplicates tracking aliases and rejects HTML disguised as a feed", () => {
  const xml =
    '<feed><entry><title>OAuth testing</title><link rel="alternate" href="https://example.org/story?utm_source=rss"/><author><name>Alice</name></author><category term="OAuth"/><summary>Do not archive this body.</summary></entry><entry><title>Duplicate</title><link href="https://example.org/story"/></entry></feed>';
  const docs = parseFeed(xml, feed);
  expect(docs).toHaveLength(1);
  expect(docs[0]).toMatchObject({
    authors: ["Alice"],
    topics: ["OAuth"],
    canonicalUrl: "https://example.org/story",
    markdown: "",
  });
  expect(() => parseFeed("<html>Rate limited</html>", feed)).toThrow();
  expect(parseFeed(xml, { ...feed, includePaths: ["/other/"] })).toEqual([]);
});
it("normalizes known report aliases without conflating unrelated query identities or lookalike platforms", () => {
  expect(
    canonicalize("http://www.hackerone.com/reports/123/?utm_source=x"),
  ).toBe("https://hackerone.com/reports/123");
  expect(canonicalize("https://infosecwriteups.com/story?source=rss-x")).toBe(
    "https://infosecwriteups.com/story",
  );
  expect(canonicalize("https://example.org/article?id=1")).not.toBe(
    canonicalize("https://example.org/article?id=2"),
  );
  expect(platform("https://evilbugcrowd.com/report")).toBe("Independent");
});
it("resumes WSTG at the next document after the consumer advances the checkpoint", async () => {
  const mock = vi.mocked(safeFetch);
  mock.mockReset();
  mock.mockImplementation(async (url) => ({
    status: 200,
    body: url.includes("/commits/")
      ? JSON.stringify({ sha: "b".repeat(40) })
      : url.endsWith("/LICENSE")
        ? "Attribution-ShareAlike 4.0 International"
        : url.includes("/git/trees/")
          ? JSON.stringify({
              tree: [
                { path, type: "blob" },
                { path: path.replace("01-", "02-"), type: "blob" },
              ],
            })
          : body,
  }));
  const context: DiscoveryContext = {
    mode: "backfill",
    cursor: { revision: "b".repeat(40), offset: 1 },
    checkpoint: async (c) => {
      context.cursor = c;
    },
  };
  const results = [];
  for await (const d of wstg(1, context)) results.push(d);
  expect(results).toHaveLength(1);
  expect(results[0].externalId).toContain("02-");
  expect(context.cursor.complete).toBe(true);
  mock.mockClear();
  for await (const _ of wstg(1, context)) throw new Error("Already complete");
  expect(mock).toHaveBeenCalledTimes(1);
});
it("resumes partial Bugcrowd pages without skipping unconsumed disclosures", async () => {
  const mock = vi.mocked(safeFetch);
  mock.mockReset();
  mock.mockResolvedValue({
    status: 200,
    body: JSON.stringify({
      results: [
        bc,
        {
          ...bc,
          title: "Second disclosure",
          disclosure_report_url: bc.disclosure_report_url.replace(
            "62063e9b",
            "72063e9b",
          ),
        },
      ],
      pagination_meta: { total_pages: 1 },
    }),
  });
  const c: DiscoveryContext = {
    mode: "backfill",
    cursor: { page: 1, offset: 1 },
    checkpoint: async (x) => {
      c.cursor = x;
    },
  };
  const docs = [];
  for await (const d of bugcrowd(1, c)) docs.push(d);
  expect(docs).toHaveLength(1);
  expect(docs[0].title).toBe("Second disclosure");
  expect(c.cursor.offset).toBe(2);
});

it("invalidates feed validators when local source configuration changes", async () => {
  const mock = vi.mocked(safeFetch);
  mock.mockReset();
  mock.mockResolvedValue({
    status: 200,
    etag: "unchanged-provider-etag",
    body: "<rss><channel><item><title>Article</title><link>https://example.org/story</link></item></channel></rss>",
  });
  const c: DiscoveryContext = {
    mode: "recent",
    cursor: { etag: "old-etag", configHash: "old-configuration" },
    checkpoint: async (value) => {
      c.cursor = value;
    },
  };
  for await (const _ of rss({ ...feed, platform: "Medium" }, 5, c)) {
  }
  expect(mock.mock.calls[0][2]).toEqual({});
  expect(c.cursor.etag).toBe("unchanged-provider-etag");
  expect(c.cursor.configHash).not.toBe("old-configuration");
  mock.mockClear();
  mock.mockResolvedValue({ status: 304, body: "" });
  for await (const _ of rss({ ...feed, platform: "Medium" }, 5, c)) {
  }
  expect(mock.mock.calls[0][2]).toMatchObject({
    "If-None-Match": "unchanged-provider-etag",
  });
});
let local: Awaited<ReturnType<typeof openLocal>>;
beforeAll(async () => {
  local = await openLocal(true);
}, 60000);
afterAll(async () => {
  await local?.db.close();
});
it("registers sources without overriding operator pauses and denies ordinary accounts", async () => {
  const config = {
    id: "arxiv-security",
    name: "Research",
    url: "https://arxiv.org/",
    pollSeconds: 86400,
  };
  await local.rpc("hs_ops_register_source", config);
  await local.db.query(
    "update hs_source_control set enabled=false where source_id=$1",
    [config.id],
  );
  await local.rpc("hs_ops_register_source", { ...config, pollSeconds: 14400 });
  expect(
    (
      await local.db.query(
        "select enabled,poll_seconds from hs_source_control where source_id=$1",
        [config.id],
      )
    ).rows[0],
  ).toMatchObject({ enabled: false, poll_seconds: 14400 });
  await expect(
    local.db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      return tx.query("select hs_ops_register_source($1::jsonb)", [
        JSON.stringify(config),
      ]);
    }),
  ).rejects.toThrow(/permission denied/);
});
it("indexes paper abstracts and records explicit completeness counts without duplicate canonical records", async () => {
  const d = parseArxiv(atom()).documents[0];
  const write = async () => {};
  await ingestDocument(local.rpc, write, d);
  await ingestDocument(local.rpc, write, {
    ...d,
    sourceId: "another-discovery",
    sourceName: "Another discovery",
  });
  const stats = await local.rpc<any>("hs_stats");
  expect(stats).toMatchObject({
    total: 1,
    papers: 1,
    partial: 1,
    full: 0,
    metadata: 0,
  });
  const sources = await local.rpc<any[]>("hs_sources_list");
  expect(sources.find((s) => s.documents === 1)).toMatchObject({
    papers: 1,
    partial: 1,
  });
  const { expandQuery } = await import("../packages/taxonomy");
  const search = await local.rpc<any>("hs_search", {
    groups: expandQuery("XSS").groups,
    limit: 20,
    page: 1,
  });
  expect(search.total).toBe(1);
});

it("prefers direct sources over directory metadata without duplicate IDs or revision churn", async () => {
  const index = {
    ...bugcrowdDocument(bc)!,
    canonicalUrl: "https://bugcrowd.com/disclosures/synthetic-overlap",
    sourceId: "pentester-land",
    sourceName: "Index",
    title: "Index title",
  };
  const direct = {
    ...index,
    sourceId: "bugcrowd",
    sourceName: "Bugcrowd",
    title: "Direct title",
  };
  const write = async () => {};
  const first = await ingestDocument(local.rpc, write, index);
  const second = await ingestDocument(local.rpc, write, direct);
  expect(second).toMatchObject({ id: first.id, action: "updated" });
  expect(
    await ingestDocument(local.rpc, write, {
      ...index,
      title: "Changed directory title",
    }),
  ).toMatchObject({ id: first.id, action: "unchanged" });
  expect(await local.rpc("hs_detail", { id: first.id })).toMatchObject({
    source_id: "bugcrowd",
    title: "Direct title",
    revision_count: 2,
  });
});
it("preserves partial text against metadata downgrades, including a later lower-quality source", async () => {
  const partial = {
    ...parseArxiv(atom()).documents[0],
    canonicalUrl: "https://arxiv.org/abs/2601.99999",
    externalId: "2601.99999",
  };
  const first = await ingestDocument(local.rpc, async () => {}, partial);
  expect(
    await ingestDocument(local.rpc, async () => {}, {
      ...partial,
      markdown: "",
      completeness: "metadata",
      canArchive: false,
    }),
  ).toMatchObject({ action: "preserved" });
  expect(
    await ingestDocument(local.rpc, async () => {}, {
      ...partial,
      sourceId: "pentester-land",
      markdown: "",
      completeness: "metadata",
      canArchive: false,
    }),
  ).toMatchObject({ action: "unchanged" });
  expect(await local.rpc("hs_detail", { id: first.id })).toMatchObject({
    completeness: "partial",
    revision_count: 1,
  });
});
