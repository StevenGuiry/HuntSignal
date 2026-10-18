import { parseHTML } from "linkedom";
import { documentSchema, type InputDocument } from "../packages/contracts";
import { submissionUrl, type SubmissionWork } from "../packages/submissions";
import { assessContent } from "../packages/content-quality";
import {
  articleBody,
  publicHackerOneBody,
  fetchPublicSource,
  CaptureUnavailable,
  CAPTURE_VERSION,
} from "./capture";
import { canonicalize, hash, prepare, toDate } from "./normalize";
import { platform } from "./adapters/pentesterland";
import { safeError } from "./operations";
import { SourceFetchError } from "./fetch";
import { ingestDocument, type Writer } from "./pipeline";
import type { Rpc, ObjectReader } from "../packages/repository";

export async function extractSubmission(request: {
  url: string;
  kind: "report" | "article";
}): Promise<InputDocument> {
  const requested = submissionUrl(request.url);
  const { response, reportId } = await fetchPublicSource(requested);
  const url = reportId
    ? `https://hackerone.com/reports/${reportId}`
    : submissionUrl(canonicalize(response.url || requested));
  let title = "",
    authors: string[] = [],
    programs: string[] = [],
    publishedAt: string | null = null,
    kind = request.kind;
  let body: { markdown: string; completeness: "full" | "partial" };
  if (reportId) {
    const data = JSON.parse(response.body);
    body = publicHackerOneBody(data, reportId);
    kind = "report";
    title = typeof data.title === "string" ? data.title : "";
    const author = data.reporter?.username || data.reporter?.name;
    if (typeof author === "string") authors = [author.slice(0, 150)];
    if (typeof data.team?.name === "string")
      programs = [data.team.name.slice(0, 150)];
    publishedAt = toDate(data.disclosed_at);
  } else {
    body = articleBody(response.body, url);
    const page = parseHTML(response.body).document;
    title =
      page
        .querySelector('meta[property="og:title"]')
        ?.getAttribute("content") ||
      page.querySelector("h1")?.textContent ||
      page.querySelector("title")?.textContent ||
      "";
    const author = page
      .querySelector('meta[name="author"]')
      ?.getAttribute("content");
    if (author) authors = [author.trim().slice(0, 150)];
    publishedAt = toDate(
      page
        .querySelector('meta[property="article:published_time"]')
        ?.getAttribute("content"),
    );
    if (
      new URL(url).hostname === "bugcrowd.com" &&
      new URL(url).pathname.startsWith("/disclosures/")
    )
      kind = "report";
  }
  if (!title.trim()) throw new CaptureUnavailable("missing_title");
  if (body.markdown.length > 200000)
    throw new CaptureUnavailable("manual_preview_size_limit");
  return documentSchema.parse({
    sourceId: "manual-submissions",
    sourceName: "Manually added public sources",
    sourceUrl: "https://github.com/StevenGuiry/HuntSignal",
    externalId: url,
    canonicalUrl: url,
    title: title.trim().slice(0, 600),
    kind,
    platform: platform(url),
    authors,
    programs,
    topics: [],
    publishedAt,
    ...body,
    excerpt: body.markdown
      .replace(/[`#*_]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 400),
    license: "Original author rights retained; public-source capture",
    licenseUrl: null,
    rightsEvidence: url,
    canArchive: true,
    attribution: `${authors.join(", ") || new URL(url).hostname}. Public source text submitted and reviewed by a HuntSignal administrator. Original rights remain with the author; capture does not grant a reuse license. Linked attachments and images are not archived.`,
    revision: CAPTURE_VERSION,
  });
}

export async function processSubmissions(
  rpc: Rpc,
  write: Writer,
  read: ObjectReader,
  limit = 10,
  extract = extractSubmission,
) {
  const sourceId = "manual-submissions";
  const claim = await rpc<{ claimed: boolean; token: string; status: string }>(
    "hs_ops_source",
    { action: "claim", sourceId, force: true },
  );
  if (!claim.claimed)
    return { status: claim.status, previewed: 0, published: 0, failed: 0 };
  const control = (action: string, extra = {}) =>
    rpc("hs_ops_source", { action, sourceId, token: claim.token, ...extra });
  let lost = false,
    previewed = 0,
    published = 0,
    failed = 0,
    error = "",
    retrySeconds = 0;
  const timer = setInterval(() => {
    void control("heartbeat").catch(() => {
      lost = true;
    });
  }, 60000);
  timer.unref();
  try {
    for (let i = 0; i < limit; i++) {
      if (lost) throw Error("Source lease lost");
      const work = await rpc<SubmissionWork | null>("hs_submission_work", {
        action: "claim",
        sourceToken: claim.token,
      });
      if (!work) break;
      const finish = (action: string, extra = {}) =>
        rpc("hs_submission_work", {
          action,
          id: work.id,
          token: work.token,
          sourceToken: claim.token,
          ...extra,
        });
      try {
        if (work.phase === "preview") {
          const doc = prepare(
            await extract({ url: work.url, kind: work.kind }),
          );
          await finish("preview", {
            document: documentSchema.parse(doc),
            contentHash: doc.contentHash,
            bodyHash: hash(doc.markdown.replace(/\s+/g, " ").trim()),
            quality: assessContent(doc.markdown),
          });
          previewed++;
        } else {
          const doc = documentSchema.parse(work.document);
          if (prepare(doc).contentHash !== work.contentHash)
            throw Error("Approved preview integrity check failed");
          const result = await ingestDocument(
            rpc,
            write,
            doc,
            read,
            undefined,
            { id: work.id, token: work.token, sourceToken: claim.token },
          );
          await finish("published", { documentId: result.id });
          published++;
        }
      } catch (e) {
        failed++;
        error = e instanceof CaptureUnavailable ? e.code : safeError(e);
        await finish("failed", { error });
        if (e instanceof SourceFetchError && e.status === 429) {
          retrySeconds = e.retrySeconds;
          break;
        }
      }
    }
  } catch (e) {
    failed++;
    error = safeError(e);
  } finally {
    clearInterval(timer);
    if (!lost)
      await control("release", {
        ok: failed === 0,
        error,
        retrySeconds,
        processed: previewed + published,
      });
  }
  return {
    status: failed ? "partial" : "success",
    previewed,
    published,
    failed,
    error,
  };
}
