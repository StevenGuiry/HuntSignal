import { useEffect, useState } from "react";
import { ArrowUpRight, Code2 } from "lucide-react";
import {
  techniqueSourceUrl,
  type TechniqueCard,
  type TechniqueResult,
} from "../../packages/techniques";

export function TechniqueEvidenceCard({
  item,
  onEvidence,
}: {
  item: TechniqueCard;
  onEvidence: (item: TechniqueCard) => void;
}) {
  const [copied, setCopied] = useState("");
  return (
    <article className="technique-card">
      <div className="technique-meta">
        <span>{item.topic}</span>
        <span>
          {item.kind === "payload"
            ? "PAYLOAD / POC EXCERPT"
            : "TECHNIQUE DESCRIBED"}
        </span>
        <span>Automatic classification</span>
      </div>
      <h2>{item.label}</h2>
      <p className="technique-report">
        From{" "}
        <a
          href={techniqueSourceUrl(item)}
          onClick={(e) => {
            e.preventDefault();
            onEvidence(item);
          }}
        >
          {item.title}
        </a>
      </p>
      <div className="technique-evidence">
        <pre>
          <code>{item.text}</code>
        </pre>
      </div>
      <div className="technique-actions">
        <button
          className="secondary-button"
          onClick={() => {
            if (!navigator.clipboard) {
              setCopied("Clipboard unavailable. Select the text to copy it.");
              return;
            }
            void navigator.clipboard
              .writeText(item.text)
              .then(() => setCopied("Copied exactly as archived"))
              .catch(() =>
                setCopied("Clipboard unavailable. Select the text to copy it."),
              );
          }}
        >
          {item.kind === "payload" ? "Copy payload / code" : "Copy evidence"}
        </button>
        <a
          className="secondary-button"
          href={techniqueSourceUrl(item)}
          onClick={(e) => {
            e.preventDefault();
            onEvidence(item);
          }}
        >
          View source passage
        </a>
        <a href={item.canonical_url} target="_blank" rel="noreferrer">
          Original source <ArrowUpRight size={13} />
        </a>
      </div>
      {copied && (
        <p role="status" className="semantic-note">
          {copied}
        </p>
      )}
      <small>
        {item.platform} · Archived Markdown lines {item.lineStart}–
        {item.lineEnd} · {item.format}
        {item.completeness === "partial" ? " · Public summary" : ""}
      </small>
      <details className="technique-context">
        <summary>Source context</summary>
        <pre>
          {item.before}
          <mark>{item.text}</mark>
          {item.after}
        </pre>
      </details>
    </article>
  );
}
type Filters = {
  q: string;
  topic: string;
  technique: string;
  evidence: string;
  reportId: string;
  page: number;
};
export function TechniqueLibrary({
  filters,
  onChange,
  onEvidence,
}: {
  filters: Filters;
  onChange: (p: Partial<Filters>) => void;
  onEvidence: (item: TechniqueCard) => void;
}) {
  const [draft, setDraft] = useState(filters.q),
    [data, setData] = useState<TechniqueResult | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => setDraft(filters.q), [filters.q]);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({
      q: filters.q,
      topic: filters.topic,
      technique: filters.technique,
      kind: filters.evidence,
      page: String(filters.page),
      limit: "20",
    });
    if (filters.reportId) query.set("reportId", filters.reportId);
    fetch(`/api/techniques?${query}`, { signal: c.signal, cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw Error("Technique evidence could not be loaded.");
        return r.json();
      })
      .then((r) => {
        if (!c.signal.aborted) setData(r);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [
    filters.q,
    filters.topic,
    filters.technique,
    filters.evidence,
    filters.reportId,
    filters.page,
  ]);
  return (
    <>
      <div className="eyebrow">EXTRACTED FROM ARCHIVED REPORTS</div>
      <h1>Techniques & payloads.</h1>
      <p className="hero-description">
        Explore the examples researchers published. Each excerpt links to its
        report and exact source passage.
      </p>
      <p className="semantic-note">
        Text is copied from the archive, never generated or executed. Labels are
        automatic; inspect the surrounding report to establish how an example
        was used.
      </p>
      {data && (
        <div className="technique-coverage">
          <strong>
            {data.coverage.indexed} / {data.coverage.reports}
          </strong>{" "}
          reports processed · <strong>{data.coverage.withEvidence}</strong> with
          technique evidence · <strong>{data.coverage.withPayloads}</strong>{" "}
          with payload examples
          {data.coverage.limited > 0
            ? ` · ${data.coverage.limited} reports have large or additional excerpts available in the reader`
            : ""}
        </div>
      )}
      <form
        className="technique-search"
        onSubmit={(e) => {
          e.preventDefault();
          onChange({ q: draft.trim() });
        }}
      >
        <input
          aria-label="Search techniques and payloads"
          placeholder="XSS, cross-site scripting, UNION SELECT…"
          maxLength={200}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="primary-button">Search techniques</button>
      </form>
      <div className="technique-filters">
        <label>
          Vulnerability
          <select
            aria-label="Technique vulnerability"
            value={filters.topic}
            onChange={(e) => onChange({ topic: e.target.value, technique: "" })}
          >
            <option value="">All vulnerability types</option>
            {data?.topics.map((t) => (
              <option key={t.topic} value={t.topic}>
                {t.topic} · {t.reports} reports
              </option>
            ))}
          </select>
        </label>
        <label>
          Technique
          <select
            aria-label="Technique type"
            value={filters.technique}
            onChange={(e) => onChange({ technique: e.target.value })}
          >
            <option value="">All techniques</option>
            {data?.techniques.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} · {t.reports} reports
              </option>
            ))}
          </select>
        </label>
        <label>
          Evidence
          <select
            aria-label="Evidence type"
            value={filters.evidence}
            onChange={(e) => onChange({ evidence: e.target.value })}
          >
            <option value="">All extracted evidence</option>
            <option value="payload">Payloads / PoCs</option>
            <option value="technique">Technique descriptions</option>
          </select>
        </label>
      </div>
      {filters.reportId && (
        <button
          className="secondary-button"
          onClick={() => onChange({ reportId: "" })}
        >
          Show evidence from all reports
        </button>
      )}
      {error ? (
        <p role="alert" className="error-box">
          {error}
        </p>
      ) : loading ? (
        <p role="status">Loading extracted evidence…</p>
      ) : (
        <>
          <p className="result-summary">
            {data?.total || 0} extracted examples
          </p>
          {data?.items.map((item) => (
            <TechniqueEvidenceCard
              key={`${item.document_id}:${item.revision_id}:${item.ordinal}`}
              item={item}
              onEvidence={onEvidence}
            />
          ))}
          {!data?.items.length && (
            <div className="empty-state">
              <Code2 size={28} />
              <h2>No extracted evidence matches.</h2>
              <p>
                Try a broader filter. Some reports describe an issue without
                publishing a payload, or use a technique the extractor does not
                yet recognise.
              </p>
            </div>
          )}
          {!!data?.total && (
            <div className="technique-pagination">
              <button
                className="secondary-button"
                disabled={filters.page <= 1}
                onClick={() => onChange({ page: filters.page - 1 })}
              >
                Previous evidence
              </button>
              <span>
                {filters.page} / {Math.ceil(data.total / data.limit)}
              </span>
              <button
                className="secondary-button"
                disabled={filters.page * data.limit >= data.total}
                onClick={() => onChange({ page: filters.page + 1 })}
              >
                Next evidence
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
export function ReportTechniques({
  id,
  onEvidence,
}: {
  id: string;
  onEvidence: (item: TechniqueCard) => void;
}) {
  const [data, setData] = useState<TechniqueResult | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    fetch(`/api/techniques?reportId=${id}&limit=6`, { signal: c.signal })
      .then((r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then(setData)
      .catch(() => {
        if (!c.signal.aborted) setFailed(true);
      });
    return () => c.abort();
  }, [id]);
  return (
    <details className="report-techniques">
      <summary>
        Techniques & payloads {data ? `· ${data.total} extracted examples` : ""}
      </summary>
      <p className="semantic-note">
        Verbatim excerpts with automatic classifications. Verify each example in
        context.
      </p>
      {failed ? (
        <p>Extracted evidence is temporarily unavailable.</p>
      ) : !data ? (
        <p>Loading evidence…</p>
      ) : (
        <>
          {data.items.map((item) => (
            <TechniqueEvidenceCard
              key={item.ordinal}
              item={item}
              onEvidence={onEvidence}
            />
          ))}
          {!data.items.length && (
            <p>
              {data.coverage.indexed
                ? "No technique or payload was extracted from this report. This does not establish that the report contains none."
                : "This report is awaiting technique extraction."}
            </p>
          )}
          {data.total > 6 && (
            <a
              className="secondary-button"
              href={`?view=techniques&reportId=${id}`}
            >
              View all {data.total} examples
            </a>
          )}
        </>
      )}
    </details>
  );
}
