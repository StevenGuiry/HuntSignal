import { z } from "zod";
import type { InputDocument } from "./contracts";
import type { ContentQuality } from "./content-quality";

export function submissionUrl(value: string) {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.href.length > 2048
  )
    throw new Error(
      "Use a public HTTPS article or report URL without credentials.",
    );
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(
      url.hostname,
    ) ||
    /(?:^|\.)(localhost|local|internal|invalid|test|example)$/i.test(
      url.hostname,
    )
  )
    throw new Error(
      "Use a public domain name, not a local host or IP address.",
    );
  if (
    [...url.searchParams.keys()].some((k) =>
      /^(?:access_token|token|api_key|apikey|secret|password|authorization|signature|x-amz-signature)$/i.test(
        k,
      ),
    )
  )
    throw new Error(
      "Remove credentials or signed access parameters from the URL.",
    );
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key))
      url.searchParams.delete(key);
  if (
    ["hackerone.com", "www.hackerone.com"].includes(url.hostname) &&
    /^\/reports\/\d+\/?$/.test(url.pathname)
  ) {
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
  return url.href;
}
export const submissionInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("request"),
      url: z
        .string()
        .max(2048)
        .transform((v, c) => {
          try {
            return submissionUrl(v);
          } catch (e) {
            c.addIssue({ code: "custom", message: (e as Error).message });
            return z.NEVER;
          }
        }),
      kind: z.enum(["report", "article"]),
    })
    .strict(),
  z
    .object({
      action: z.enum(["approve", "cancel", "retry"]),
      id: z.string().uuid(),
    })
    .strict(),
]);
export type Submission = {
  id: string;
  url: string;
  kind: "report" | "article";
  status: string;
  requestedAt: string;
  updatedAt?: string;
  title?: string;
  authors?: string[];
  publishedAt?: string | null;
  completeness?: string;
  characters?: number;
  previewMarkdown?: string;
  previewExpiresAt?: string;
  quality?: ContentQuality;
  error?: string;
  duplicates?: { id: string; title: string; match: string }[];
  documentId?: string;
};
export type SubmissionWork = Submission & {
  token: string;
  phase: "preview" | "ingest";
  document?: InputDocument;
  contentHash?: string;
};
