import { parseHTML } from "linkedom";
import { safeFetch, validateFetchUrl } from "../fetch";
import { hash, canonicalize, toDate } from "../normalize";
import { documentSchema, type InputDocument } from "../../packages/contracts";
import type { DiscoveryContext } from "../operations";
const listing = "https://www.yeswehack.com/blog/learn-bug-bounty";
const hosts = ["www.yeswehack.com"];
export function yeswehackLinks(html: string): string[] {
  const doc = parseHTML(html).document;
  const links = Array.from(doc.querySelectorAll("a[href]")).flatMap((a) => {
    try {
      const url = new URL(a.getAttribute("href") || "", listing);
      validateFetchUrl(url.href, hosts);
      return /^\/learn-bug-bounty\/[a-z0-9-]+\/?$/.test(url.pathname)
        ? [canonicalize(url.href)]
        : [];
    } catch {
      return [];
    }
  });
  const result = [...new Set(links)];
  if (!result.length) throw new Error("YesWeHack article listing changed");
  return result;
}
export function yeswehackDocument(html: string, url: string): InputDocument {
  validateFetchUrl(url, hosts);
  const doc = parseHTML(html).document;
  const objects = Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  ).flatMap((s) => {
    try {
      const j = JSON.parse(s.textContent || "");
      return Array.isArray(j) ? j : j["@graph"] || [j];
    } catch {
      return [];
    }
  });
  const item = objects.find((j) =>
    ["Article", "BlogPosting"].includes(j["@type"]),
  );
  if (!item || !(item.headline || item.name))
    throw new Error("YesWeHack article metadata changed");
  const authors = (Array.isArray(item.author) ? item.author : [item.author])
    .map((a: string | { name?: unknown }) =>
      typeof a === "string" ? a : a?.name,
    )
    .filter((a: unknown): a is string => typeof a === "string")
    .map((a: string) => a.slice(0, 150))
    .slice(0, 50);
  return documentSchema.parse({
    sourceId: "yeswehack-research",
    sourceName: "YesWeHack Research",
    sourceUrl: listing,
    externalId: new URL(url).pathname,
    canonicalUrl: url,
    title: item.headline || item.name,
    kind: "article",
    platform: "YesWeHack",
    authors,
    topics: [],
    programs: [],
    excerpt: "",
    markdown: "",
    publishedAt: toDate(item.datePublished),
    completeness: "metadata",
    license: "Original author retains content rights",
    licenseUrl: null,
    attribution:
      "Research article metadata from YesWeHack; article text remains at the original source.",
    rightsEvidence: url,
    canArchive: false,
  });
}
export async function* yeswehack(
  limit: number,
  context?: DiscoveryContext,
): AsyncGenerator<InputDocument> {
  const r = await safeFetch(listing, hosts);
  const links = yeswehackLinks(r.body),
    snapshot = hash(JSON.stringify(links));
  const same = context?.cursor.snapshot === snapshot;
  if (context?.mode === "backfill" && same && context.cursor.complete) return;
  const start = same ? Math.max(0, Number(context?.cursor.offset) || 0) : 0;
  const end = Math.min(start + Math.min(limit, 25), links.length);
  for (let i = start; i < end; i++) {
    yield yeswehackDocument(
      (await safeFetch(links[i], hosts, {}, 2_000_000)).body,
      links[i],
    );
    await context?.checkpoint({
      snapshot,
      offset: i + 1 === links.length ? 0 : i + 1,
      complete: i + 1 === links.length,
    });
    if (i + 1 < end) await new Promise((r) => setTimeout(r, 600));
  }
}
