import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import robotsParser from "robots-parser";
import { safeFetch, SourceFetchError, validateFetchUrl } from "./fetch";
import { documentSchema, type InputDocument } from "../packages/contracts";
import { toDate } from "./normalize";
export const CAPTURE_VERSION = "public-text-v2";
export function captureInput(input: InputDocument) {
  return documentSchema.parse({
    ...input,
    publishedAt: toDate(input.publishedAt),
  });
}

export class CaptureUnavailable extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const markdownConverter = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
markdownConverter.remove([
  "script",
  "style",
  "iframe",
  "form",
  "button",
  "input",
  "noscript",
]);
markdownConverter.addRule("imageReferences", {
  filter: "img",
  replacement: (_content, node) => {
    const image = node as unknown as Element;
    return image.getAttribute("alt")
      ? `[Image: ${image.getAttribute("alt")}]`
      : "";
  },
});
export function publicHackerOneBody(
  raw: unknown,
  expectedId: string,
): { markdown: string; completeness: "full" | "partial" } {
  const data = raw as Record<string, any>;
  if (
    !data ||
    String(data.id) !== expectedId ||
    data.public !== true ||
    !data.disclosed_at ||
    data.can_view_report !== true
  )
    throw new CaptureUnavailable("not_public");
  if (
    data.visibility === "full" &&
    typeof data.vulnerability_information === "string" &&
    data.vulnerability_information.trim().length >= 80
  ) {
    return {
      markdown: data.vulnerability_information.trim(),
      completeness: "full",
    };
  }
  const summaries = Array.isArray(data.summaries) ? data.summaries : [];
  const text = summaries
    .map((s: any) => (typeof s.content === "string" ? s.content : ""))
    .filter(Boolean)
    .join("\n\n");
  if (text.trim().length >= 80)
    return {
      markdown: `## Public disclosure summary\n\n${text.trim()}`,
      completeness: "partial",
    };
  throw new CaptureUnavailable("no_public_body");
}
export function articleBody(
  html: string,
  url: string,
): { markdown: string; completeness: "full" | "partial" } {
  const doc = parseHTML(html).document;
  const title = doc.querySelector("title")?.textContent?.trim() || "";
  if (
    /^(just a moment|access denied|sign in|log in|verify you are human|attention required|page not found|404\b|content unavailable)/i.test(
      title,
    )
  )
    throw new CaptureUnavailable("access_blocked");
  if (
    Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).some(
      (s) =>
        /"isAccessibleForFree"\s*:\s*(?:false|"false")/.test(
          s.textContent || "",
        ),
    )
  )
    throw new CaptureUnavailable("paywall");
  doc
    .querySelectorAll("script,style,iframe,form,noscript,svg")
    .forEach((e) => e.remove());
  // Resolve references before Markdown conversion. This does not fetch linked resources.
  for (const element of doc.querySelectorAll("[href]")) {
    try {
      const target = new URL(element.getAttribute("href") || "", url);
      if (
        !["https:", "http:"].includes(target.protocol) ||
        target.username ||
        target.password
      )
        element.removeAttribute("href");
      else element.setAttribute("href", target.href);
    } catch {
      element.removeAttribute("href");
    }
  }
  if (new URL(url).hostname === "bugcrowd.com") {
    const section = Array.from(doc.querySelectorAll("section")).find((e) =>
      /^Summary by\s/.test(e.textContent?.trim() || ""),
    );
    if (!section) throw new CaptureUnavailable("no_public_summary");
    const markdown = markdownConverter.turndown(section.innerHTML).trim();
    if (markdown.length < 150)
      throw new CaptureUnavailable("insufficient_text");
    return { markdown, completeness: "partial" };
  }
  const article = new Readability(doc as unknown as Document).parse();
  const text = article?.textContent?.trim() || "";
  if (!article?.content || text.length < 600 || text.split(/\s+/).length < 70)
    throw new CaptureUnavailable("insufficient_text");
  const markdown = markdownConverter.turndown(article.content).trim();
  if (markdown.length < 600) throw new CaptureUnavailable("insufficient_text");
  return { markdown, completeness: "full" };
}

const rules = new Map<string, ReturnType<typeof robotsParser>>();
const lastRequest = new Map<string, number>();
async function pace(host: string, delay = 1100) {
  const wait = delay - (Date.now() - (lastRequest.get(host) || 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest.set(host, Date.now());
}
async function crawlGate(url: URL, hosts: string[]) {
  if (!rules.has(url.origin)) {
    await pace(url.hostname);
    let robots = "";
    try {
      robots = (await safeFetch(`${url.origin}/robots.txt`, hosts, {}, 250_000))
        .body;
    } catch (e) {
      if (!(e instanceof SourceFetchError && e.status === 404))
        throw new CaptureUnavailable("robots_unavailable");
    }
    rules.set(url.origin, robotsParser(`${url.origin}/robots.txt`, robots));
  }
  const robot = rules.get(url.origin)!;
  if (robot.isAllowed(url.href, "HuntSignal") === false)
    throw new CaptureUnavailable("robots_disallowed");
  const delay = Math.max(1100, (robot.getCrawlDelay("HuntSignal") || 0) * 1000);
  if (delay > 30000) throw new CaptureUnavailable("source_crawl_delay");
  await pace(url.hostname, delay);
}
export async function captureDocument(
  input: InputDocument,
): Promise<InputDocument> {
  const doc = captureInput(input);
  const url = new URL(doc.canonicalUrl);
  if (/\.(pdf|zip|gz|png|jpe?g|gif|webp|mp4|docx?)$/i.test(url.pathname))
    throw new CaptureUnavailable("unsupported_content_type");
  url.protocol = "https:";
  const hosts = [
    url.hostname,
    url.hostname.startsWith("www.")
      ? url.hostname.slice(4)
      : "www." + url.hostname,
  ];
  if (["medium.com", "infosecwriteups.com"].includes(url.hostname))
    hosts.push("medium.com", "infosecwriteups.com");
  validateFetchUrl(url.href, hosts);
  const report =
    url.hostname === "hackerone.com"
      ? url.pathname.match(/^\/reports\/(\d+)\/?$/)
      : null;
  if (report) url.pathname = `/reports/${report[1]}.json`;
  await crawlGate(url, hosts);
  let firstRequest = true;
  const response = await safeFetch(
    url.href,
    hosts,
    report ? { Accept: "application/json" } : {},
    5_000_000,
    0,
    async (next) => {
      if (firstRequest) {
        firstRequest = false;
        return;
      }
      await crawlGate(next, hosts);
    },
  );
  if (
    !report &&
    response.contentType &&
    !/text\/html|application\/xhtml\+xml/i.test(response.contentType)
  )
    throw new CaptureUnavailable("unsupported_content_type");
  const capture = report
    ? publicHackerOneBody(JSON.parse(response.body), report[1])
    : articleBody(response.body, response.url || url.href);
  return documentSchema.parse({
    ...doc,
    ...capture,
    excerpt: capture.markdown
      .replace(/[`#*_]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 400),
    canArchive: true,
    license: "Original author rights retained; public-source capture",
    licenseUrl: null,
    rightsEvidence: doc.canonicalUrl,
    attribution: `${doc.authors.join(", ").slice(0, 650) || doc.sourceName}. Text captured from the public source at the operator's request. Original rights remain with the author; this capture does not grant a reuse license. Linked attachments and images are not archived.`,
    revision: CAPTURE_VERSION,
  });
}
