import { XMLParser } from "fast-xml-parser";
import { safeFetch } from "../fetch";
import { documentSchema, type InputDocument } from "../../packages/contracts";
import { toDate } from "../normalize";
import type { DiscoveryContext } from "../operations";
export const arxivQuery =
  'cat:cs.CR AND (all:"cross-site scripting" OR all:OAuth OR all:"web security" OR all:"SQL injection" OR all:"server-side request forgery" OR all:"bug bounty" OR all:"HTTP request smuggling")';
const clean = (v: unknown) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
export function parseArxiv(xml: string): {
  documents: InputDocument[];
  count: number;
  total: number;
} {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("XML entities are not accepted");
  const data = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(xml);
  if (!data.feed || data.feed.entry?.id === "http://arxiv.org/api/errors")
    throw new Error("arXiv response schema changed");
  const entries = data.feed.entry
    ? Array.isArray(data.feed.entry)
      ? data.feed.entry
      : [data.feed.entry]
    : [];
  const documents = entries.map((e: any) => {
    const match = clean(e.id).match(
      /^https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/,
    );
    if (!match) throw new Error("Invalid arXiv identifier");
    const authors = (Array.isArray(e.author) ? e.author : [e.author])
      .map((a: { name?: unknown }) => clean(a?.name))
      .filter(Boolean)
      .slice(0, 50);
    const abstract = clean(e.summary);
    if (!abstract) throw new Error("arXiv abstract is missing");
    return documentSchema.parse({
      sourceId: "arxiv-security",
      sourceName: "arXiv web security research",
      sourceUrl: "https://arxiv.org/list/cs.CR/recent",
      externalId: match[1],
      canonicalUrl: `https://arxiv.org/abs/${match[1]}`,
      title: clean(e.title),
      kind: "paper",
      platform: "arXiv",
      authors,
      topics: [],
      programs: [],
      excerpt: abstract.slice(0, 500),
      markdown: `## Abstract\n\n${abstract}`,
      publishedAt: toDate(e.published),
      completeness: "partial",
      license: "CC0-1.0 (descriptive metadata and abstract only)",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: `${authors.join(", ").slice(0, 700)}. Abstract and descriptive metadata from arXiv; the complete paper remains at the original source and has its own license.`,
      rightsEvidence: "https://info.arxiv.org/help/api/tou.html",
      canArchive: true,
      revision: match[1] + (match[2] || ""),
    });
  });
  return {
    documents,
    count: entries.length,
    total: Number(data.feed["opensearch:totalResults"]) || 0,
  };
}
export async function* arxiv(
  limit: number,
  context?: DiscoveryContext,
): AsyncGenerator<InputDocument> {
  const start =
    context?.mode === "backfill"
      ? Math.max(0, Number(context.cursor.offset) || 0)
      : 0;
  const size = Math.min(limit, 50);
  const url = new URL("https://export.arxiv.org/api/query");
  url.search = new URLSearchParams({
    search_query: arxivQuery,
    start: String(start),
    max_results: String(size),
    sortBy: "submittedDate",
    sortOrder: "descending",
  }).toString();
  // Only one API request per invocation; also respect arXiv's three-second interval on rapid manual reruns.
  await new Promise((r) => setTimeout(r, 3100));
  const parsed = parseArxiv(
    (await safeFetch(url.href, ["export.arxiv.org"])).body,
  );
  for (let i = 0; i < parsed.documents.length; i++) {
    yield parsed.documents[i];
    await context?.checkpoint({
      offset: context.mode === "backfill" ? start + i + 1 : 0,
      total: parsed.total,
    });
  }
}
