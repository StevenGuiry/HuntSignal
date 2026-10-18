import { z } from "zod";

export const reportFactsSchema = z.object({
  bountyAmount: z.number().finite().min(0).max(1e12).nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  bountyDisplay: z.string().min(1).max(120).nullable(),
  severity: z
    .enum(["critical", "high", "medium", "low", "informational", "none"])
    .nullable(),
  priority: z.enum(["P1", "P2", "P3", "P4", "P5"]).nullable(),
  severityFinal: z.boolean(),
  outcome: z.string().max(80).nullable(),
  sourceUrl: z
    .string()
    .url()
    .refine((v) => new URL(v).protocol === "https:"),
  checkedAt: z.string().datetime(),
});
export type ReportFacts = z.infer<typeof reportFactsSchema>;

export function bountyLabel(facts: ReportFacts | null | undefined) {
  if (!facts) return "Not available";
  if (facts.bountyAmount !== null && facts.currency)
    return `${facts.currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(facts.bountyAmount)}`;
  return (
    facts.bountyDisplay ||
    (facts.bountyAmount !== null
      ? `${facts.bountyAmount.toLocaleString("en-US")} (currency unavailable)`
      : "Not disclosed")
  );
}
