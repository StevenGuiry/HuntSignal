import { afterAll, beforeAll, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { openLocal } from "../packages/local";
import { ingestDocument } from "../ingestion/pipeline";
import { hackerOneFacts } from "../ingestion/report-facts";
import { searchSchema, type InputDocument } from "../packages/contracts";
import { personalFilters } from "../packages/personal";
import { expandQuery } from "../packages/taxonomy";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
import {
  assessContent,
  cleanRepeatedSections,
  contentLabel,
} from "../packages/content-quality";
import { passageOffset, rememberPosition } from "../packages/reader";
import { ArchiveMarkdown } from "../apps/web/ArchiveMarkdown";
import { publicHackerOneBody, articleBody } from "../ingestion/capture";

it("requires currency for bounty ranges and validates saved filters identically", () => {
  for (const schema of [searchSchema, personalFilters]) {
    expect(schema.safeParse({ bountyMin: 100 }).success).toBe(false);
    expect(
      schema.safeParse({ currency: "USD", bountyMin: 100, bountyMax: 50 })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ currency: "USD", bountyMin: 0, bountyMax: 100 })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ currency: "GBP", bountyMin: "0" }).success).toBe(
      true,
    );
  }
});
const body =
  "## Reproduction\n\n" +
  "This synthetic report explains an OAuth validation issue, the prerequisites, reproduction steps and impact. ".repeat(
    5,
  );
it("cleans exact summary sections, preserves code and distinguishes explicit truncation from ordinary prose", () => {
  const code =
    "\n\n```http\nGET / HTTP/1.1\n# A comment inside code\n  two spaces\n```\n";
  const repeated = body + code + "\n" + body + code;
  const clean = cleanRepeatedSections(repeated);
  expect(clean.removedSections).toBe(1);
  expect(clean.markdown).toContain("  two spaces");
  expect(assessContent(body).issues).toEqual([]);
  expect(assessContent(body + "\n[truncated]").issues).toContain(
    "possible_truncation",
  );
  expect(
    assessContent("Home\nSign in\nSubscribe\nPrivacy policy\nTerms of service")
      .issues,
  ).toContain("navigation_text");
  expect(
    contentLabel({
      kind: "paper",
      source_id: "arxiv-security",
      completeness: "partial",
    }),
  ).toBe("Paper abstract");
  expect(contentLabel({ kind: "report", completeness: "partial" })).toBe(
    "Public summary",
  );
  expect(
    contentLabel({
      kind: "report",
      completeness: "full",
      content_quality: assessContent(body + "\n[truncated]"),
    }),
  ).toBe("Text needs review");
  const report = {
    id: 123,
    public: true,
    can_view_report: true,
    disclosed_at: "2026-01-01",
    visibility: "limited",
    summaries: [{ content: body }, { content: body }],
  };
  expect(
    publicHackerOneBody(report, "123").markdown.match(/## Reproduction/g),
  ).toHaveLength(1);
  expect(
    articleBody(
      `<html><head><title>Synthetic research article</title></head><body><article><h1>Synthetic research article</h1><p>${body.repeat(5)}</p><p>Continue reading</p></article></body></html>`,
      "https://example.org",
    ).completeness,
  ).toBe("partial");
});
it("locates the original snippet through highlights/whitespace and bounds local reading history", () => {
  const source =
    "# A\n\nThe first body paragraph is unrelated.\n\n## B\n\nOAuth redirect\nvalidation permits account takeover.";
  expect(
    passageOffset(
      source,
      "⟦OAuth⟧ redirect validation permits account takeover.",
    ),
  ).toBe(source.indexOf("OAuth"));
  expect(
    passageOffset(source, "Only found in metadata of a different document"),
  ).toBeNull();
  const entry = {
    documentId: "new",
    revision: "r",
    anchor: "hs-text-2",
    label: "A",
    at: Date.now(),
  };
  expect(
    rememberPosition(
      Array.from({ length: 110 }, (_, i) => ({
        ...entry,
        documentId: String(i),
      })),
      entry,
    ),
  ).toHaveLength(100);
  const html = renderToStaticMarkup(
    <ArchiveMarkdown
      markdown={
        "## Steps\n\n```http\nGET /?q=<script> HTTP/1.1\n  indentation\n```"
      }
      originalUrl="https://example.org"
    />,
  );
  expect(html).toContain('id="hs-text-0"');
  expect(html).toContain("Copy code");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("  indentation");
  expect(html).not.toContain("<script>");
});
let local: Awaited<ReturnType<typeof openLocal>>;
const docs: { id: string; revision: string; input: InputDocument }[] = [];
const vector = [1, ...Array(383).fill(0)];
beforeAll(async () => {
  local = await openLocal(true);
  for (let i = 0; i < 5; i++) {
    const input: InputDocument = {
      sourceId: "hackerone",
      sourceName: "HackerOne",
      sourceUrl: "https://hackerone.com",
      externalId: String(900 + i),
      canonicalUrl: `https://hackerone.com/reports/${900 + i}`,
      title: `OAuth fixture ${i}`,
      kind: "report",
      platform: "HackerOne",
      authors: ["Fixture"],
      topics: [],
      programs: [i === 4 ? "Other" : "Example"],
      excerpt: "Fixture",
      markdown: body,
      publishedAt: new Date().toISOString(),
      completeness: "full",
      license: "Fixture",
      licenseUrl: null,
      attribution: "Fixture",
      rightsEvidence: "https://hackerone.com",
      canArchive: true,
    };
    const { id } = await ingestDocument(local.rpc, async () => {}, input);
    const detail = await local.rpc<any>("hs_detail", { id });
    const revision = detail.current_revision_id;
    docs.push({ id, revision, input });
    const facts = hackerOneFacts(
      {
        id: 900 + i,
        public: true,
        can_view_report: true,
        disclosed_at: "2026-01-01",
        state: "Closed",
        severity_rating: i === 1 ? "medium" : "high",
        bounty_amount: i === 2 ? 0 : i === 3 ? null : 3000,
        formatted_bounty: null,
        team: { default_currency: i === 4 ? "eur" : "usd" },
      },
      String(900 + i),
    );
    await local.rpc("hs_report_facts_put", { id, facts });
    await local.rpc("hs_index_put", {
      document_id: id,
      revision_id: revision,
      model_id: EMBEDDING_MODEL.id,
      word_count: 50,
      body_hash: null,
      citations: [],
      passages: [{ text: body, vector }],
    });
  }
}, 60000);
afterAll(async () => {
  await local?.db.close();
});
it("filters before lexical and semantic pagination, includes badges, and keeps zero separate from unknown", async () => {
  const filters = {
    program: "Example",
    severity: "high-critical",
    currency: "USD",
    bountyMin: 1000,
  };
  const keyword = await local.rpc<any>("hs_search_v2", {
    ...searchSchema.parse({ q: "OAuth", ...filters }),
    groups: expandQuery("OAuth").groups,
  });
  const semantic = await local.rpc<any>("hs_search_v2", {
    ...searchSchema.parse({
      q: "Opaque semantic wording",
      mode: "hybrid",
      modelId: EMBEDDING_MODEL.id,
      vector,
      ...filters,
    }),
    groups: [],
  });
  for (const result of [keyword, semantic]) {
    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe(docs[0].id);
    expect(result.items[0].report_facts.bountyAmount).toBe(3000);
  }
  const zero = await local.rpc<any>("hs_search", {
    ...searchSchema.parse({ currency: "USD", bountyMin: 0, bountyMax: 0 }),
    groups: [],
  });
  expect(zero.items.map((d: any) => d.id)).toEqual([docs[2].id]);
  const unknown = await local.rpc<any>("hs_search", {
    ...searchSchema.parse({ bounty: "undisclosed" }),
    groups: [],
  });
  expect(unknown.items.map((d: any) => d.id)).toEqual([docs[3].id]);
  const facets = await local.rpc<any>("hs_search_facets");
  expect(facets.currencies).toEqual(["EUR", "USD"]);
});
it("excludes questionable captures from complete-only search and rejects stale quality repairs", async () => {
  await local.rpc("hs_quality_put", {
    id: docs[1].id,
    revisionId: docs[1].revision,
    quality: assessContent(body + "\n[truncated]"),
  });
  expect(
    (
      await local.rpc<any>("hs_search", {
        ...searchSchema.parse({ completeness: "full" }),
        groups: [],
      })
    ).total,
  ).toBe(4);
  expect(
    await local.rpc("hs_quality_put", {
      id: docs[0].id,
      revisionId: docs[1].revision,
      quality: assessContent(body),
    }),
  ).toMatchObject({ stale: true });
  await expect(
    ingestDocument(local.rpc, async () => {}, {
      ...docs[0].input,
      markdown: body + " new revision",
      expectedRevisionId: docs[1].revision,
    }),
  ).rejects.toThrow("Revision changed");
  await expect(
    local.db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select hs_quality_candidates('{}')");
    }),
  ).rejects.toThrow("permission denied");
});
it("applies report filters to alert decisions and waits for newly disclosed outcomes", async () => {
  const owner = "10000000-0000-4000-8000-000000000001";
  await local.db.query("insert into auth.users(id) values($1)", [owner]);
  await local.db.query(
    "insert into hs_saved_searches(owner_id,name,filters,groups) values($1,'High USD', $2::jsonb,'[]')",
    [
      owner,
      JSON.stringify({
        program: "Example",
        severity: "high",
        currency: "USD",
        bountyMin: 1000,
      }),
    ],
  );
  const decide = async (id: string) =>
    (
      await local.db.query<{ decision: string }>(
        "select hs_event_matches(s,e) as decision from hs_saved_searches s cross join hs_publication_events e where e.document_id=$1",
        [id],
      )
    ).rows[0].decision;
  expect(await decide(docs[0].id)).toBe("Keyword or followed-filter match");
  expect(await decide(docs[4].id)).toBe("skip");
  await local.db.query("delete from hs_state where key=$1", [
    `report-facts:${docs[0].id}`,
  ]);
  expect(await decide(docs[0].id)).toBe("pending");
});
