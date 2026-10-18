import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { InputDocument } from "../../packages/contracts";
import { safeFetch, validateFetchUrl } from "../fetch";
import { toDate } from "../normalize";
import type { DiscoveryContext } from "../operations";
import { conditionalHeaders, checkpointDocuments } from "../checkpoint";
import { z } from "zod";
import { documentSchema } from "../../packages/contracts";
import { canonicalize, hash } from "../normalize";
export const feedConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  name: z.string().min(1).max(100),
  platform: z.string().min(1).max(80).optional(),
  url: z.string().url(),
  allowedHosts: z.array(z.string().min(1)).min(1).max(10),
  kind: z.enum(["article", "report", "paper"]),
  fullTextPermitted: z.boolean(),
  license: z.string().max(120),
  licenseUrl: z.string().url().nullable(),
  rightsEvidence: z.string().url(),
  includePaths: z.array(z.string()).optional(),
  pollSeconds: z.number().int().min(14400).max(2592000).optional(),
});
export type FeedConfig = {
  id: string;
  name: string;
  platform?: string;
  url: string;
  allowedHosts: string[];
  kind: "report" | "article" | "paper";
  fullTextPermitted: boolean;
  license: string;
  licenseUrl: string | null;
  rightsEvidence: string;
  includePaths?: string[];
  pollSeconds?: number;
};
const text = (v: unknown) =>
  typeof v === "string"
    ? v
    : typeof v === "object" && v
      ? String((v as Record<string, unknown>)["#text"] || "")
      : "";
export function parseFeed(xml: string, config: FeedConfig): InputDocument[] {
  config = feedConfigSchema.parse(config);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("XML entities are not accepted");
  const data = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
  }).parse(xml);
  if (!data.rss?.channel && !data.feed)
    throw new Error("Feed schema changed: expected RSS or Atom");
  const raw = data.rss?.channel?.item || data.feed?.entry || [];
  const entries = Array.isArray(raw) ? raw : [raw];
  const seen = new Set<string>();
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
      const canonicalUrl = canonicalize(url);
      if (
        config.includePaths &&
        !config.includePaths.some((p) =>
          new URL(canonicalUrl).pathname.startsWith(p),
        )
      )
        return [];
      if (seen.has(canonicalUrl)) return [];
      seen.add(canonicalUrl);
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
      const author = e["dc:creator"] || e.author;
      const authors = (Array.isArray(author) ? author : [author])
        .map((a) =>
          text(typeof a === "object" && a && "name" in a ? (a as any).name : a),
        )
        .filter(Boolean)
        .map((a) => a.slice(0, 150))
        .slice(0, 50);
      const categories = (Array.isArray(e.category) ? e.category : [e.category])
        .map((c) => text(c) || text((c as any)?.["@_term"]))
        .filter(Boolean)
        .map((c) => c.slice(0, 80))
        .slice(0, 60);
      return [
        documentSchema.parse({
          sourceId: config.id,
          sourceName: config.name,
          sourceUrl: config.url,
          externalId: text(e.guid || e.id) || url,
          canonicalUrl,
          title: text(e.title).trim(),
          kind: config.kind,
          platform: config.platform || config.name,
          authors,
          topics: categories,
          programs: [],
          excerpt: config.fullTextPermitted ? content.slice(0, 400) : "",
          markdown: config.fullTextPermitted ? content : "",
          publishedAt: toDate(text(e.pubDate || e.published || e.updated)),
          completeness: config.fullTextPermitted ? "partial" : "metadata",
          license: config.license,
          licenseUrl: config.licenseUrl,
          attribution: config.fullTextPermitted
            ? `${config.name}; preserved feed content may be an excerpt.`
            : `Discovery metadata from ${config.name}; article text remains at the original source.`,
          rightsEvidence: config.rightsEvidence,
          canArchive: config.fullTextPermitted,
        }),
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
  config = feedConfigSchema.parse(config);
  const configHash = hash("rss-v2:" + JSON.stringify(config));
  // A feed's HTTP validators say nothing about changed local extraction/rights settings.
  const current = context
    ? {
        ...context,
        cursor: context.cursor.configHash === configHash ? context.cursor : {},
        checkpoint: async (value: Record<string, unknown>) =>
          context.checkpoint({ ...value, configHash }),
      }
    : undefined;
  const response = await safeFetch(
    config.url,
    config.allowedHosts,
    conditionalHeaders(current),
  );
  if (response.status === 304) return;
  yield* checkpointDocuments(
    parseFeed(response.body, config),
    limit,
    current,
    response,
  );
}
