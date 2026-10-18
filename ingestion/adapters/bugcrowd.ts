import { safeFetch, validateFetchUrl } from "../fetch";
import { documentSchema, type InputDocument } from "../../packages/contracts";
import { toDate } from "../normalize";
import type { DiscoveryContext } from "../operations";
export function bugcrowdDocument(item: any): InputDocument | null {
  if (
    item?.disclosed !== true ||
    typeof item.title !== "string" ||
    typeof item.disclosure_report_url !== "string"
  )
    return null;
  const url = new URL(item.disclosure_report_url, "https://bugcrowd.com");
  validateFetchUrl(url.href, ["bugcrowd.com"]);
  const id = url.pathname.match(
    /^\/disclosures\/([a-f0-9-]{36})(?:\/[^/]+)?\/?$/i,
  )?.[1];
  if (!id) throw new Error("Invalid Bugcrowd disclosure URL");
  return documentSchema.parse({
    sourceId: "bugcrowd",
    sourceName: "Bugcrowd public disclosures",
    sourceUrl: "https://bugcrowd.com/crowdstream",
    externalId: id,
    canonicalUrl: url.href,
    title: item.title,
    kind: "report",
    platform: "Bugcrowd",
    authors:
      item.crowdstream_name_visible &&
      typeof item.researcher_username === "string"
        ? [item.researcher_username]
        : [],
    topics: [],
    programs:
      typeof item.engagement_name === "string" ? [item.engagement_name] : [],
    excerpt: "",
    markdown: "",
    publishedAt: toDate(
      typeof item.disclosed_at === "string" &&
        /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(item.disclosed_at)
        ? `${item.disclosed_at} 00:00:00 GMT`
        : item.disclosed_at,
    ),
    completeness: "metadata",
    license: "Original report rights retained",
    licenseUrl: null,
    attribution:
      "Publicly disclosed report metadata from Bugcrowd CrowdStream; report text remains at the original source.",
    rightsEvidence:
      "https://docs.bugcrowd.com/researchers/disclosure/disclosing-submissions/",
    canArchive: false,
  });
}
export async function* bugcrowd(
  limit: number,
  context?: DiscoveryContext,
): AsyncGenerator<InputDocument> {
  let page =
    context?.mode === "backfill"
      ? Math.max(1, Number(context.cursor.page) || 1)
      : 1;
  let offset =
    context?.mode === "backfill"
      ? Math.max(0, Number(context.cursor.offset) || 0)
      : 0;
  let emitted = 0;
  for (let pages = 0; pages < 5 && emitted < limit; pages++) {
    const data = JSON.parse(
      (
        await safeFetch(
          `https://bugcrowd.com/crowdstream.json?page=${page}&filter_by=disclosures`,
          ["bugcrowd.com"],
          { Accept: "application/json" },
        )
      ).body,
    );
    if (
      !Array.isArray(data.results) ||
      !data.pagination_meta ||
      !Number.isInteger(data.pagination_meta.total_pages)
    )
      throw new Error("Bugcrowd disclosure schema changed");
    for (let i = offset; i < data.results.length && emitted < limit; i++) {
      const doc = bugcrowdDocument(data.results[i]);
      if (doc) {
        yield doc;
        if (context?.lastDocumentChanged !== false) emitted++;
      }
      if (context?.mode === "backfill")
        await context.checkpoint({ page, offset: i + 1 });
      // A bounded head scan is sufficient for recent checks; backfill has its own durable cursor.
      if (emitted >= limit) return;
    }
    if (page >= data.pagination_meta.total_pages || data.results.length === 0) {
      if (context?.mode === "backfill")
        await context.checkpoint({
          page,
          offset: data.results.length,
          complete: true,
        });
      return;
    }
    page++;
    offset = 0;
    if (context?.mode === "backfill")
      await context.checkpoint({ page, offset });
    await new Promise((r) => setTimeout(r, 1000));
  }
}
