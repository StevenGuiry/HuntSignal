import { z } from "zod";
import { EMBEDDING_MODEL } from "./embeddings/config";
export const safeUrl = z
  .string()
  .url()
  .refine(
    (v) => ["http:", "https:"].includes(new URL(v).protocol),
    "Expected an HTTP(S) URL",
  );
export const documentSchema = z
  .object({
    sourceId: z.string().regex(/^[a-z0-9-]{1,60}$/),
    sourceName: z.string().min(1).max(100),
    sourceUrl: safeUrl,
    externalId: z.string().min(1).max(2048),
    canonicalUrl: safeUrl,
    title: z.string().min(1).max(600),
    kind: z.enum(["report", "article", "paper"]),
    platform: z.string().max(80),
    authors: z.array(z.string().max(150)).max(50).default([]),
    topics: z.array(z.string().max(80)).max(60).default([]),
    programs: z.array(z.string().max(150)).max(50).default([]),
    excerpt: z.string().max(5000).default(""),
    markdown: z.string().max(2_000_000).default(""),
    publishedAt: z.string().datetime().nullable().default(null),
    completeness: z.enum(["full", "partial", "metadata"]),
    license: z.string().max(120),
    licenseUrl: safeUrl.nullable().default(null),
    attribution: z.string().max(1000),
    rightsEvidence: safeUrl,
    canArchive: z.boolean(),
    revision: z.string().max(200).optional(),
  })
  .superRefine((d, ctx) => {
    if ((!d.canArchive || d.completeness === "metadata") && d.markdown)
      ctx.addIssue({
        code: "custom",
        message:
          "Body text requires archival permission and a non-metadata status",
      });
    if (d.completeness === "full" && d.markdown.trim().length < 80)
      ctx.addIssue({
        code: "custom",
        message: "Full text cannot be an empty or placeholder body",
      });
  });
export type InputDocument = z.infer<typeof documentSchema>;
export const searchSchema = z
  .object({
    q: z.string().max(300).default(""),
    kind: z.enum(["", "report", "article", "paper"]).default(""),
    source: z.string().max(80).default(""),
    author: z.string().max(150).default(""),
    topic: z.string().max(80).default(""),
    completeness: z.enum(["", "full", "partial", "metadata"]).default(""),
    sort: z
      .enum(["relevance", "newest", "oldest", "indexed", "updated"])
      .default("relevance"),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    after: z.string().date().optional(),
    before: z.string().date().optional(),
    mode: z.enum(["keyword", "hybrid"]).default("keyword"),
    modelId: z.literal(EMBEDDING_MODEL.id).optional(),
    vector: z
      .array(z.number().finite())
      .length(384)
      .refine((values) => {
        const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
        return norm >= 0.9 && norm <= 1.1;
      }, "Vector must be normalized")
      .optional(),
  })
  .superRefine((p, ctx) => {
    if (p.mode === "hybrid" && p.q.trim() && (!p.vector || !p.modelId))
      ctx.addIssue({
        code: "custom",
        message: "Hybrid search requires the active model and a query vector",
      });
    if (p.mode === "hybrid" && p.sort !== "relevance")
      ctx.addIssue({
        code: "custom",
        message: "Hybrid search ranks by relevance",
      });
  });
export type SearchInput = z.infer<typeof searchSchema>;
export type Card = {
  id: string;
  title: string;
  canonical_url: string;
  kind: string;
  platform: string;
  source_id: string;
  source_name: string;
  authors: string[];
  topics: string[];
  programs: string[];
  excerpt: string;
  snippet: string;
  published_at: string | null;
  first_seen_at: string;
  completeness: string;
  rank: number;
  duplicate_count?: number;
  match_reasons?: string[];
  similarity?: number;
};
export type SearchResult = {
  items: Card[];
  total: number;
  page: number;
  limit: number;
  expanded: string[];
  mode: "keyword" | "hybrid";
  total_type?: "exact" | "ranked";
  keyword_total?: number;
  warning?: string;
};
export type ArchiveContent = {
  markdown: string;
  title: string;
  originalUrl: string;
  license: string;
  licenseUrl: string | null;
  attribution: string;
  revision?: string;
};
export type Detail = Card & {
  license: string;
  license_url: string | null;
  attribution: string;
  rights_evidence: string;
  object_path: string;
  content_hash: string;
  fetched_at: string;
  revision_count: number;
  markdown?: string;
  content_error?: string;
  source_url: string;
};
export type Stats = {
  total: number;
  full: number;
  partial: number;
  metadata: number;
  papers: number;
  feed_sources: number;
  reports: number;
  articles: number;
  sources: number;
  last_ingested_at: string | null;
  oldest: string | null;
  newest: string | null;
  topics: { topic: string; count: number }[];
  platforms: { platform: string; count: number }[];
};
export type RelatedResult = {
  items: {
    id: string;
    title: string;
    canonical_url: string;
    platform: string;
    kind: string;
    completeness: string;
    relation: "duplicate" | "cites" | "cited_by" | "related";
    reason: string;
    topics: string[];
    score: number;
  }[];
  citations: string[];
};
export type Phase2Status = {
  phase: number;
  model_id: string;
  dimensions: number;
  indexed_documents: number;
  total_documents: number;
  database_bytes: number;
};
