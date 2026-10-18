import { parseHTML } from "linkedom";
import { reportFactsSchema, type ReportFacts } from "../packages/report-facts";
import { CaptureUnavailable, fetchPublicSource } from "./capture";

function empty(sourceUrl: string, checkedAt: string): ReportFacts {
  return {
    bountyAmount: null,
    currency: null,
    bountyDisplay: null,
    severity: null,
    priority: null,
    severityFinal: false,
    outcome: null,
    sourceUrl,
    checkedAt,
  };
}
const clean = (v: unknown, max = 120) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
function amount(value: unknown) {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value))
  )
    return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null;
}
export function hackerOneFacts(
  raw: unknown,
  id: string,
  checkedAt = new Date().toISOString(),
): ReportFacts {
  const d = raw as Record<string, any>;
  if (
    !d ||
    String(d.id) !== id ||
    d.public !== true ||
    d.can_view_report !== true ||
    !d.disclosed_at
  )
    throw new CaptureUnavailable("not_public");
  const f = empty(`https://hackerone.com/reports/${id}`, checkedAt);
  const rating = String(
    d.severity_rating || d.severity?.rating || "",
  ).toLowerCase();
  if (
    ["critical", "high", "medium", "low", "informational", "none"].includes(
      rating,
    )
  )
    f.severity = rating as ReportFacts["severity"];
  f.outcome = clean(d.substate || d.state, 80);
  f.severityFinal = String(d.state).toLowerCase() === "closed";
  f.bountyDisplay = clean(d.formatted_bounty);
  // Non-cash rewards must retain the platform's display text, never a currency guess.
  if (d.team?.awards_miles !== true) {
    f.bountyAmount = amount(d.bounty_amount);
    const currency = String(d.team?.default_currency || "").toUpperCase();
    if (/^[A-Z]{3}$/.test(currency)) f.currency = currency;
  }
  return reportFactsSchema.parse(f);
}
export function bugcrowdFacts(
  html: string,
  url: string,
  checkedAt = new Date().toISOString(),
): ReportFacts {
  const doc = parseHTML(html).document;
  const stats = new Map<string, string>();
  for (const el of doc.querySelectorAll(".bc-stat")) {
    const label = el
      .querySelector(".bc-stat__title")
      ?.textContent?.trim()
      .toLowerCase();
    const value = el.querySelector(".bc-stat__fig")?.textContent?.trim();
    if (label && value) stats.set(label, value);
  }
  // A challenge page or a changed template is a failed check, not undisclosed data.
  if (!stats.has("priority") || !stats.has("status"))
    throw new CaptureUnavailable("report_facts_unavailable");
  const f = empty(url, checkedAt),
    priority = stats.get("priority")!;
  if (/^P[1-5]$/.test(priority)) {
    f.priority = priority as ReportFacts["priority"];
    f.severity = (
      ["critical", "high", "medium", "low", "informational"] as const
    )[Number(priority[1]) - 1];
  }
  f.outcome = clean(stats.get("status"), 80);
  f.severityFinal =
    /^(resolved|closed|duplicate|not applicable|won['’]?t fix)$/i.test(
      f.outcome || "",
    );
  // Only read the reward explicitly rendered on the public disclosure page.
  const reward = clean(stats.get("bounty") || stats.get("reward"));
  if (reward && !/^(not disclosed|undisclosed|hidden|n\/a|—|-)$/i.test(reward))
    f.bountyDisplay = reward;
  return reportFactsSchema.parse(f);
}
export async function fetchReportFacts(url: string) {
  if (
    !/^https:\/\/(hackerone\.com\/reports\/\d+|bugcrowd\.com\/disclosures\/[^?#]+)\/?$/.test(
      url,
    )
  )
    throw new CaptureUnavailable("unsupported_report_source");
  const { response, reportId } = await fetchPublicSource(url);
  return reportId
    ? hackerOneFacts(JSON.parse(response.body), reportId)
    : bugcrowdFacts(response.body, url);
}
