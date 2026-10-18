import { z } from "zod";

export const TECHNIQUE_VERSION = "archive-techniques-v1";
export const techniqueEvidenceSchema = z
  .object({
    topic: z.string().min(1).max(80),
    techniqueId: z.string().regex(/^[a-z0-9-]{1,80}$/),
    label: z.string().min(1).max(150),
    kind: z.enum(["payload", "technique"]),
    format: z.enum([
      "fenced code",
      "inline code",
      "indented code",
      "report wording",
    ]),
    text: z.string().min(1).max(8000),
    before: z.string().max(400),
    after: z.string().max(400),
    sourceStart: z.number().int().min(0).max(2000000),
    sourceEnd: z.number().int().min(1).max(2000000),
    lineStart: z.number().int().min(1),
    lineEnd: z.number().int().min(1),
  })
  .refine((v) => v.sourceEnd > v.sourceStart && v.lineEnd >= v.lineStart);
export type TechniqueEvidence = z.infer<typeof techniqueEvidenceSchema>;
export const techniqueQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  topic: z.string().max(80).default(""),
  technique: z
    .string()
    .regex(/^[a-z0-9-]{0,80}$/)
    .default(""),
  kind: z.enum(["", "payload", "technique"]).default(""),
  reportId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type TechniqueCard = TechniqueEvidence & {
  document_id: string;
  revision_id: string;
  title: string;
  canonical_url: string;
  platform: string;
  completeness: string;
  published_at: string | null;
  ordinal: number;
};
export type TechniqueResult = {
  items: TechniqueCard[];
  total: number;
  page: number;
  limit: number;
  coverage: {
    reports: number;
    indexed: number;
    withEvidence: number;
    withPayloads: number;
    limited: number;
  };
  topics: { topic: string; reports: number }[];
  techniques: { id: string; label: string; topic: string; reports: number }[];
};

export function techniqueSourceUrl(
  item: Pick<TechniqueCard, "document_id" | "revision_id" | "sourceStart">,
) {
  return `?view=techniques&item=${encodeURIComponent(item.document_id)}&at=${item.sourceStart}&rev=${encodeURIComponent(item.revision_id)}`;
}
