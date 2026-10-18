import { afterAll, beforeAll, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { hackerOneFacts, bugcrowdFacts } from "../ingestion/report-facts";
import { ReportFacts } from "../apps/web/ReportFacts";
import { bountyLabel } from "../packages/report-facts";
import { openLocal } from "../packages/local";
import { ingestDocument } from "../ingestion/pipeline";

const publicReport = {
  id: 123,
  public: true,
  can_view_report: true,
  disclosed_at: "2026-01-01",
  state: "Closed",
  substate: "resolved",
  severity_rating: "critical",
  bounty_amount: "12000.0",
  formatted_bounty: "$12,000",
  team: { default_currency: "usd", awards_miles: false },
};
it("uses disclosed currency and distinguishes zero, undisclosed, and non-cash rewards", () => {
  const f = hackerOneFacts(publicReport, "123");
  expect(f).toMatchObject({
    bountyAmount: 12000,
    currency: "USD",
    severity: "critical",
    severityFinal: true,
  });
  expect(bountyLabel(f)).toBe("USD 12,000");
  expect(
    bountyLabel(hackerOneFacts({ ...publicReport, bounty_amount: 0 }, "123")),
  ).toBe("USD 0");
  expect(
    bountyLabel(
      hackerOneFacts(
        { ...publicReport, bounty_amount: null, formatted_bounty: null },
        "123",
      ),
    ),
  ).toBe("Not disclosed");
  expect(
    bountyLabel(
      hackerOneFacts(
        {
          ...publicReport,
          team: { awards_miles: true },
          formatted_bounty: "12,000 miles",
        },
        "123",
      ),
    ),
  ).toBe("12,000 miles");
  expect(
    hackerOneFacts({ ...publicReport, team: {} }, "123").currency,
  ).toBeNull();
  expect(() =>
    hackerOneFacts({ ...publicReport, public: false }, "123"),
  ).toThrow("not_public");
  expect(() => hackerOneFacts(publicReport, "124")).toThrow("not_public");
});
const stat = (label: string, value: string) =>
  `<li class="bc-stat"><span class="bc-stat__title">${label}</span><span class="bc-stat__fig">${value}</span></li>`;
it("reads Bugcrowd public priority/status without mistaking points or program reward ranges for a bounty", () => {
  const html =
    stat("Priority", "P3") +
    stat("Status", "Resolved") +
    stat("All-time points", "12000") +
    '<script>{"amount":5000,"crowdstream_amount_visible":false}</script>';
  const f = bugcrowdFacts(html, "https://bugcrowd.com/disclosures/test");
  expect(f).toMatchObject({
    bountyDisplay: null,
    severity: "medium",
    priority: "P3",
    severityFinal: true,
  });
  expect(
    bugcrowdFacts(html + stat("Reward", "€1,000"), f.sourceUrl).bountyDisplay,
  ).toBe("€1,000");
  expect(() =>
    bugcrowdFacts("<title>Access denied</title>", f.sourceUrl),
  ).toThrow("report_facts_unavailable");
});
it("renders both report facts near the header and never labels an open report's rating final", () => {
  const f = hackerOneFacts(
    { ...publicReport, state: "Open", bounty_amount: 0 },
    "123",
  );
  const html = renderToStaticMarkup(<ReportFacts kind="report" facts={f} />);
  expect(html).toContain("USD 0");
  expect(html).toContain("Current severity");
  expect(html).toContain("Not finalised");
  expect(html).not.toContain("Final severity");
  expect(renderToStaticMarkup(<ReportFacts kind="article" facts={f} />)).toBe(
    "",
  );
  expect(renderToStaticMarkup(<ReportFacts kind="report" />)).toContain(
    "Not available",
  );
});

let local: Awaited<ReturnType<typeof openLocal>>;
beforeAll(async () => {
  local = await openLocal(true);
}, 60000);
afterAll(async () => {
  await local.db.close();
});
it("updates facts without revising text or republishing; rejects stale and foreign source updates", async () => {
  const { id } = await ingestDocument(local.rpc, async () => {}, {
    sourceId: "hackerone",
    sourceName: "HackerOne",
    sourceUrl: "https://hackerone.com",
    externalId: "123",
    canonicalUrl: "https://hackerone.com/reports/123",
    title: "Synthetic disclosure",
    kind: "report",
    platform: "HackerOne",
    authors: [],
    topics: [],
    programs: [],
    excerpt: "",
    markdown:
      "A synthetic disclosure with substantive reproduction details and impact. ".repeat(
        5,
      ),
    publishedAt: "2026-01-01T00:00:00Z",
    completeness: "full",
    license: "Fixture",
    licenseUrl: null,
    attribution: "Fixture",
    rightsEvidence: "https://hackerone.com",
    canArchive: true,
  });
  const before = await local.rpc<any>("hs_detail", { id });
  const facts = hackerOneFacts(publicReport, "123");
  expect(await local.rpc<any[]>("hs_report_facts_candidates")).toEqual([
    { id, url: facts.sourceUrl },
  ]);
  await local.rpc("hs_report_facts_put", { id, facts });
  const after = await local.rpc<any>("hs_detail", { id });
  expect(after.report_facts).toEqual(facts);
  expect(after.current_revision_id).toBe(before.current_revision_id);
  expect(after.revision_count).toBe(before.revision_count);
  expect(after.updated_at).toBe(before.updated_at);
  expect(
    await local.rpc("hs_report_facts_put", {
      id,
      facts: { ...facts, bountyAmount: 1, checkedAt: "2020-01-01T00:00:00Z" },
    }),
  ).toEqual({ state: "stale" });
  await expect(
    local.rpc("hs_report_facts_put", {
      id,
      facts: { ...facts, sourceUrl: "https://example.org" },
    }),
  ).rejects.toThrow("Invalid public report facts");
  await local.rpc("hs_report_facts_put", { id });
  expect((await local.rpc<any>("hs_detail", { id })).report_facts).toEqual(
    facts,
  );
  expect(await local.rpc("hs_report_facts_candidates")).toEqual([]);
  for (const fn of ["hs_report_facts_put", "hs_report_facts_candidates"]) {
    await expect(
      local.db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query(`select ${fn}($1::jsonb)`, [
          JSON.stringify({ id, facts }),
        ]);
      }),
    ).rejects.toThrow("permission denied");
  }
});
