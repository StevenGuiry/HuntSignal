import { z } from "zod";
import { EMBEDDING_MODEL } from "./embeddings/config";
import {
  researchFilterShape,
  validateResearchFilters,
} from "./research-filters";
const uuid = z.string().uuid();
export const personalFilters = z
  .object({
    ...researchFilterShape,
    kind: z.enum(["report", "article", "paper"]).optional(),
    source: z.string().min(1).max(80).optional(),
    topic: z.string().min(1).max(80).optional(),
    author: z.string().min(1).max(150).optional(),
    completeness: z.enum(["full", "partial", "metadata"]).optional(),
    after: z.string().date().optional(),
    before: z.string().date().optional(),
  })
  .strict()
  .superRefine(validateResearchFilters);
const vector = z
  .array(z.number().finite())
  .length(384)
  .refine((v) => {
    const norm = Math.hypot(...v);
    return norm >= 0.9 && norm <= 1.1;
  });
export const savedSearchInput = z
  .object({
    id: uuid.optional(),
    name: z.string().trim().min(1).max(80),
    queryText: z.string().trim().max(300).default(""),
    filters: personalFilters.default({}),
    mode: z.enum(["keyword", "hybrid"]).default("keyword"),
    vector: vector.optional(),
    modelId: z.literal(EMBEDDING_MODEL.id).optional(),
    threshold: z.number().min(0.35).max(0.95).default(0.6),
    includeHistory: z.boolean().default(false),
    includeUpdates: z.boolean().default(false),
  })
  .strict()
  .superRefine((p, c) => {
    if (!p.queryText && !Object.keys(p.filters).length)
      c.addIssue({ code: "custom", message: "A query or filter is required" });
    if (p.mode === "hybrid" && (!p.vector || !p.modelId || !p.queryText))
      c.addIssue({
        code: "custom",
        message: "Semantic alerts need a query and its model vector",
      });
  });
export const libraryMutation = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("bookmark"),
      documentId: uuid,
      saved: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reading"),
      documentId: uuid,
      read: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("note"),
      documentId: uuid,
      body: z.string().max(5000),
    })
    .strict(),
  z
    .object({
      action: z.literal("collection_create"),
      name: z.string().trim().min(1).max(80),
    })
    .strict(),
  z
    .object({
      action: z.literal("collection_rename"),
      id: uuid,
      name: z.string().trim().min(1).max(80),
    })
    .strict(),
  z.object({ action: z.literal("collection_delete"), id: uuid }).strict(),
  z
    .object({
      action: z.literal("collection_item"),
      collectionId: uuid,
      documentId: uuid,
      present: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("search_toggle"),
      id: uuid,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("search_options"),
      id: uuid,
      threshold: z.number().min(0.35).max(0.95).optional(),
      includeHistory: z.boolean().optional(),
      includeUpdates: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal("search_delete"), id: uuid }).strict(),
  z
    .object({
      action: z.literal("notification_read"),
      id: uuid,
      read: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal("feed_revoke"), searchId: uuid }).strict(),
]);
export type DocumentFlags = {
  id: string;
  saved: boolean;
  read: boolean;
  hasNote: boolean;
};
export type PersonalDocument = {
  saved: boolean;
  read: boolean;
  note: string;
  collections: { id: string; name: string; contains: boolean }[];
};
export type LibraryResult = {
  items: {
    document_id: string;
    title: string | null;
    canonical_url: string | null;
    kind: string | null;
    platform: string | null;
    completeness: string | null;
    published_at: string | null;
    bookmarked_at: string | null;
    note: string | null;
    read_at: string | null;
  }[];
  total: number;
  collections: { id: string; name: string; count: number }[];
};
export type SavedSearch = {
  id: string;
  name: string;
  queryText: string;
  filters: z.infer<typeof personalFilters>;
  mode: "keyword" | "hybrid";
  threshold: number;
  includeHistory: boolean;
  includeUpdates: boolean;
  enabled: boolean;
  feedEnabled: boolean;
  createdAt: string;
};
export type Notifications = {
  unread: number;
  items: {
    id: string;
    document_id: string;
    kind: string;
    reason: string;
    created_at: string;
    read_at: string | null;
    title: string | null;
    canonical_url: string | null;
    search_name: string;
  }[];
};
