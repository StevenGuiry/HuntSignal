import { z } from "zod";

const optionalAmount = z.preprocess(
  (v) =>
    v === "" || v === undefined
      ? undefined
      : typeof v === "number" ||
          (typeof v === "string" && /^\d+(\.\d+)?$/.test(v))
        ? v
        : Number.NaN,
  z.coerce.number().finite().min(0).max(1e12).optional(),
);
export const researchFilterShape = {
  program: z.string().trim().max(150).optional(),
  severity: z
    .enum([
      "",
      "high-critical",
      "critical",
      "high",
      "medium",
      "low",
      "informational",
      "none",
    ])
    .optional(),
  bounty: z.enum(["", "disclosed", "undisclosed"]).optional(),
  currency: z
    .string()
    .regex(/^(|[A-Z]{3})$/)
    .optional(),
  bountyMin: optionalAmount,
  bountyMax: optionalAmount,
};
export function validateResearchFilters(
  p: { currency?: string; bountyMin?: number; bountyMax?: number },
  ctx: z.RefinementCtx,
) {
  if ((p.bountyMin !== undefined || p.bountyMax !== undefined) && !p.currency)
    ctx.addIssue({
      code: "custom",
      message: "Choose a currency for bounty ranges",
      path: ["currency"],
    });
  if (
    p.bountyMin !== undefined &&
    p.bountyMax !== undefined &&
    p.bountyMin > p.bountyMax
  )
    ctx.addIssue({
      code: "custom",
      message: "Minimum bounty must not exceed maximum",
      path: ["bountyMin"],
    });
}
export const researchFilterKeys = [
  "program",
  "severity",
  "bounty",
  "currency",
  "bountyMin",
  "bountyMax",
] as const;
export type ResearchFilterState = Record<
  (typeof researchFilterKeys)[number],
  string
>;
export const emptyResearchFilters: ResearchFilterState = {
  program: "",
  severity: "",
  bounty: "",
  currency: "",
  bountyMin: "",
  bountyMax: "",
};
