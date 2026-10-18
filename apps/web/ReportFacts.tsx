import {
  bountyLabel,
  type ReportFacts as Facts,
} from "../../packages/report-facts";

export function ReportFacts({
  kind,
  facts,
}: {
  kind: string;
  facts?: Facts | null;
}) {
  if (kind !== "report") return null;
  const severity = facts?.severity;
  const label = severity
    ? severity[0].toUpperCase() + severity.slice(1)
    : facts
      ? "Not disclosed"
      : "Not available";
  return (
    <section className="report-facts" aria-label="Report outcome">
      <dl>
        <div>
          <dt>Bounty</dt>
          <dd>{bountyLabel(facts)}</dd>
        </div>
        <div>
          <dt>
            {facts && !facts.severityFinal
              ? "Current severity"
              : "Final severity"}
          </dt>
          <dd>
            <span
              className={`severity-value severity-${severity || "unknown"}`}
            >
              {label}
              {facts?.priority ? ` · ${facts.priority}` : ""}
            </span>
          </dd>
        </div>
      </dl>
      {facts && (
        <p>
          {!facts.severityFinal && "Not finalised · "}Source checked{" "}
          {new Date(facts.checkedAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            timeZone: "UTC",
          })}
        </p>
      )}
    </section>
  );
}
