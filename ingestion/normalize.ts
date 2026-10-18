import { createHash } from "node:crypto";
import { documentSchema, type InputDocument } from "../packages/contracts";
import { classifyTopics } from "../packages/taxonomy";
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function canonicalize(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid source URL");
  url.hash = "";
  // Only normalize aliases with known equivalent public article/report identities.
  if (
    ["www.hackerone.com", "hackerone.com"].includes(url.hostname) &&
    /^\/reports\/\d+\/?$/.test(url.pathname)
  ) {
    url.protocol = "https:";
    url.hostname = "hackerone.com";
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
  }
  if (
    url.hostname === "medium.com" ||
    url.hostname.endsWith(".medium.com") ||
    url.hostname === "infosecwriteups.com"
  )
    url.searchParams.delete("source");
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key))
      url.searchParams.delete(key);
  return url.href;
}
export function toDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
export function chunkText(text: string, max = 4500) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max - 200)
    chunks.push(text.slice(i, i + max));
  return chunks;
}
export function prepare(input: InputDocument) {
  const doc = documentSchema.parse(input);
  doc.canonicalUrl = canonicalize(doc.canonicalUrl);
  doc.topics = classifyTopics(
    `${doc.title}\n${doc.excerpt}\n${doc.markdown}`,
    doc.topics,
  );
  doc.markdown = doc.markdown.replace(/\r\n/g, "\n").trim();
  const {
    revision: _revision,
    expectedRevisionId: _expectedRevisionId,
    ...stableContent
  } = doc;
  const contentHash = hash(JSON.stringify(stableContent));
  const archive = {
    title: doc.title,
    originalUrl: doc.canonicalUrl,
    markdown: doc.markdown,
    license: doc.license,
    licenseUrl: doc.licenseUrl,
    attribution: doc.attribution,
    revision: doc.revision,
  };
  const metadata = [
    doc.title,
    ...doc.topics,
    ...doc.authors,
    ...doc.programs,
    doc.excerpt,
  ].join("\n");
  return {
    ...doc,
    contentHash,
    objectPath: `${contentHash}.json.gz`,
    chunks: [metadata, ...chunkText(doc.markdown)],
    archive,
  };
}
