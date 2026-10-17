import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { InputDocument } from "../../packages/contracts";
import { safeFetch, validateFetchUrl } from "../fetch";
import { toDate } from "../normalize";
import type { DiscoveryContext } from "../operations";
import { conditionalHeaders, checkpointDocuments } from "../checkpoint";
export type FeedConfig = {
  id: string;
  name: string;
  url: string;
  allowedHosts: string[];
  kind: "report" | "article" | "paper";
  fullTextPermitted: boolean;
  license: string;
  licenseUrl: string | null;
  rightsEvidence: string;
};
const text = (v: unknown) =>
  typeof v === "string"
    ? v
    : typeof v === "object" && v
      ? String((v as Record<string, unknown>)["#text"] || "")
      : "";
export function parseFeed(xml: string, config: FeedConfig): InputDocument[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("XML entities are not accepted");
  const data = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(xml);
  const raw = data.rss?.channel?.item || data.feed?.entry || [];
  const entries = Array.isArray(raw) ? raw : [raw];
  return entries.flatMap((e: Record<string, unknown>) => {
    try {
      const link = e.link;
      const url =
        typeof link === "string"
          ? link
          : Array.isArray(link)
            ? link.find((x) => x["@_rel"] === "alternate" || !x["@_rel"])?.[
                "@_href"
              ]
            : (link as Record<string, string>)?.["@_href"];
      if (!url) return [];
      validateFetchUrl(url, config.allowedHosts);
      const html = text(
        e["content:encoded"] || e.content || e.description || e.summary,
      );
      const doc = parseHTML(
        `<html><body><article>${html}</article></body></html>`,
      ).document;
      doc
        .querySelectorAll("script,style,iframe,form")
        .forEach((node) => node.remove());
      const content =
        new Readability(doc as unknown as Document).parse()?.textContent ||
        doc.body.textContent ||
        "";
      return [
        {
          sourceId: config.id,
          sourceName: config.name,
          sourceUrl: config.url,
          externalId: text(e.guid || e.id) || url,
          canonicalUrl: url,
          title: text(e.title),
          kind: config.kind,
          platform: config.name,
          authors: [text(e["dc:creator"] || e.author)].filter(Boolean),
          topics: [],
          programs: [],
          excerpt: config.fullTextPermitted ? content.slice(0, 400) : "",
          markdown: config.fullTextPermitted ? content : "",
          publishedAt: toDate(text(e.pubDate || e.published || e.updated)),
          completeness: config.fullTextPermitted ? "partial" : "metadata",
          license: config.license,
          licenseUrl: config.licenseUrl,
          attribution: `${config.name}; feed content may be an excerpt.`,
          rightsEvidence: config.rightsEvidence,
          canArchive: config.fullTextPermitted,
        } as InputDocument,
      ];
    } catch {
      return [];
    }
  });
}
export async function* rss(
  config: FeedConfig,
  limit: number,
  context?: DiscoveryContext,
) {
  const response = await safeFetch(
    config.url,
    config.allowedHosts,
    conditionalHeaders(context),
  );
  if (response.status === 304) return;
  yield* checkpointDocuments(
    parseFeed(response.body, config),
    limit,
    context,
    response,
  );
}
