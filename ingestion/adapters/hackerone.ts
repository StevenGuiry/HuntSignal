import type { InputDocument } from "../../packages/contracts";
import { safeFetch } from "../fetch";
import { toDate } from "../normalize";
import { z } from "zod";
import type { DiscoveryContext } from "../operations";
const resource = z.object({
  id: z.union([z.string(), z.number()]),
  attributes: z.object({
    title: z.string().min(1),
    disclosed: z.boolean(),
    disclosed_at: z.string().nullable().optional(),
    cwe: z.string().nullable().optional(),
  }),
  relationships: z
    .object({
      reporter: z
        .object({
          data: z
            .object({
              attributes: z.object({
                name: z.string().nullable().optional(),
                username: z.string().optional(),
              }),
            })
            .nullable(),
        })
        .optional(),
      program: z
        .object({
          data: z
            .object({
              attributes: z.object({
                name: z.string().nullable().optional(),
                handle: z.string().optional(),
              }),
            })
            .nullable(),
        })
        .optional(),
    })
    .optional(),
});
// Documented top-level report objects, not relationship identifiers:
// https://api.hackerone.com/hacker-reference/#hacktivity_item
export function hackeroneDocument(input: unknown): InputDocument | null {
  const parsed = resource.safeParse(input);
  if (!parsed.success || !parsed.data.attributes.disclosed) return null;
  const item = parsed.data,
    id = String(item.id),
    a = item.attributes;
  if (!/^\d+$/.test(id)) return null;
  const author = item.relationships?.reporter?.data?.attributes;
  const program = item.relationships?.program?.data?.attributes;
  return {
    sourceId: "hackerone",
    sourceName: "HackerOne",
    sourceUrl: "https://hackerone.com/hacktivity",
    externalId: id,
    canonicalUrl: `https://hackerone.com/reports/${id}`,
    title: a.title,
    kind: "report",
    platform: "HackerOne",
    authors: [author?.name || author?.username || ""].filter(Boolean),
    topics: a.cwe ? [a.cwe] : [],
    programs: [program?.name || program?.handle || ""].filter(Boolean),
    excerpt: "",
    markdown: "",
    publishedAt: toDate(a.disclosed_at),
    completeness: "metadata",
    license: "Original report rights retained",
    licenseUrl: null,
    attribution: "Public disclosure metadata from HackerOne.",
    rightsEvidence: "https://api.hackerone.com/hacker-resources/",
    canArchive: false,
  };
}
export async function* hackerone(
  limit: number,
  context?: DiscoveryContext,
): AsyncGenerator<InputDocument> {
  const user = process.env.HACKERONE_USERNAME,
    token = process.env.HACKERONE_API_TOKEN;
  if (!user || !token)
    throw new Error(
      "HackerOne discovery requires HACKERONE_USERNAME and HACKERONE_API_TOKEN",
    );
  const first =
    "https://api.hackerone.com/v1/hackers/hacktivity?queryString=disclosed%3Atrue&sort=-disclosed_at&page[size]=100";
  if (context?.mode === "backfill" && context.cursor.complete) return;
  // Recent polling always checks the head first; completed fingerprints avoid
  // spending the new-document budget repeatedly on the same overlap window.
  let next: string | undefined =
    context?.mode === "recent" ? first : context?.cursor.next || first;
  let offset =
      context?.mode === "recent" ? 0 : Number(context?.cursor.offset) || 0,
    pages = 0;
  const cycleStarted = context?.cursor.cycleStarted || new Date().toISOString();
  const watermark = context?.cursor.watermark;
  const cutoff =
    context?.mode === "recent"
      ? watermark
        ? Date.parse(watermark) - 48 * 3600000
        : Date.now() - 7 * 86400000
      : null;
  let count = 0;
  const visited = new Set<string>();
  while (next && count < limit && pages++ < 20) {
    if (new URL(next).pathname !== "/v1/hackers/hacktivity")
      throw new Error("Unexpected HackerOne pagination endpoint");
    if (visited.has(next)) throw new Error("HackerOne pagination loop");
    visited.add(next);
    const page = JSON.parse(
      (
        await safeFetch(next, ["api.hackerone.com"], {
          Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
        })
      ).body,
    );
    if (!Array.isArray(page.data))
      throw new Error("HackerOne discovery schema changed");
    let finished = false;
    for (let index = offset; index < page.data.length; index++) {
      const item = page.data[index];
      const document = hackeroneDocument(item);
      if (!document) continue;
      if (
        cutoff !== null &&
        document.publishedAt &&
        Date.parse(document.publishedAt) < cutoff
      ) {
        finished = true;
        break;
      }
      yield document;
      const changed =
        context?.mode !== "recent" || context.lastDocumentChanged !== false;
      if (changed) count++;
      if (context && changed && (count % 20 === 0 || count >= limit))
        await context.checkpoint({
          next,
          offset: index + 1,
          cycleStarted,
          watermark,
        });
      if (count >= limit) return;
    }
    next =
      !finished && page.links?.next
        ? new URL(page.links.next, "https://api.hackerone.com").href
        : undefined;
    offset = 0;
    if (context)
      await context.checkpoint(
        next
          ? { next, offset: 0, cycleStarted, watermark }
          : {
              offset: 0,
              watermark: cycleStarted,
              complete: context.mode === "backfill",
            },
      );
    if (next) await new Promise((r) => setTimeout(r, 1000));
  }
}
