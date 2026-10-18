import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import { ArchiveMarkdown } from "./ArchiveMarkdown";
import { contentLabel } from "../../packages/content-quality";
import type { Submission } from "../../packages/submissions";

const labels: Record<string, string> = {
  preview_queued: "Preview queued",
  previewing: "Fetching public source",
  ready: "Ready to review",
  ingest_queued: "Approved · ingestion queued",
  ingesting: "Archiving",
  published: "Published",
  duplicate: "Already archived",
  failed: "Capture failed",
  cancelled: "Cancelled",
  expired: "Preview expired",
  blocked: "Source withdrawn",
};
export function Submissions({ onOpen }: { onOpen: (id: string) => void }) {
  const auth = useAuth();
  const [items, setItems] = useState<Submission[]>([]),
    [url, setUrl] = useState(""),
    [kind, setKind] = useState<"article" | "report">("article"),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const refresh = () =>
    auth.request<Submission[]>("/operations/submissions").then(setItems);
  useEffect(() => {
    let active = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      auth
        .request<Submission[]>("/operations/submissions")
        .then((r) => {
          if (active) setItems(r);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    };
    load();
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const change = async (p: unknown) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await auth.request<Submission>("/operations/submissions", {
        method: "POST",
        body: JSON.stringify(p),
      });
      if (result.status === "duplicate") {
        setNotice(`Already archived: ${result.title}`);
        if (result.documentId) onOpen(result.documentId);
      } else if (result.status === "blocked")
        setError(result.error || "This source cannot be submitted.");
      else {
        setSelected(result.id);
        setNotice(labels[result.status] || result.status);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const current = items.find((s) => s.id === selected);
  return (
    <section
      className="source-submissions"
      aria-label="Add a report or article"
    >
      <div className="section-heading">
        <h2>Add a report or article</h2>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => refresh().catch((e) => setError(e.message))}
        >
          Refresh submissions
        </button>
      </div>
      <p>
        Submit a public source, review the extracted text, then approve it for
        the archive. Preview and ingestion jobs run on the existing roughly
        four-hour schedule.
      </p>
      <form
        className="submission-form"
        onSubmit={(e) => {
          e.preventDefault();
          void change({ action: "request", url, kind });
        }}
      >
        <label>
          Source URL
          <input
            type="url"
            required
            maxLength={2048}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://researcher.example/write-up"
            aria-label="Source URL"
          />
        </label>
        <label>
          Content type
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "report" | "article")}
            aria-label="Content type"
          >
            <option value="article">Article / research</option>
            <option value="report">Report / disclosure</option>
          </select>
        </label>
        <button className="primary-button" disabled={busy} type="submit">
          Request preview
        </button>
      </form>
      <p className="semantic-note">
        Public HTML and supported platform disclosures are accepted. Blocked
        pages and unsupported files stay unpublished. Up to 20 active
        submissions; previews expire after seven days.
      </p>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="submission-list">
        {items.map((item) => (
          <article
            key={item.id}
            className={selected === item.id ? "selected" : ""}
          >
            <button onClick={() => setSelected(item.id)}>
              <strong>{item.title || item.url}</strong>
              <span>{labels[item.status] || item.status}</span>
            </button>
            {item.documentId && (
              <button
                className="secondary-button"
                onClick={() => onOpen(item.documentId!)}
              >
                Open archived document
              </button>
            )}
          </article>
        ))}
      </div>
      {current && (
        <div className="submission-preview">
          <h3>{current.title || "Source submission"}</h3>
          <a href={current.url} target="_blank" rel="noreferrer">
            Open original source
          </a>
          <p>{labels[current.status] || current.status}</p>
          {current.error && <p role="alert">{current.error}</p>}
          {!!current.duplicates?.length && (
            <aside className="quality-notice">
              <strong>Possible duplicates</strong>
              {current.duplicates.map((d) => (
                <p key={d.id}>
                  <button onClick={() => onOpen(d.id)}>{d.title}</button> ·{" "}
                  {d.match}
                </p>
              ))}
              <p>Review these entries before adding another source.</p>
            </aside>
          )}
          {current.previewMarkdown && (
            <>
              <p>
                {contentLabel({
                  kind: current.kind,
                  completeness: current.completeness || "partial",
                  content_quality: current.quality,
                })}{" "}
                · {current.characters?.toLocaleString()} characters ·{" "}
                {current.authors?.join(", ") || "Author not supplied"}
              </p>
              <p>
                {current.characters && current.characters > 12000
                  ? "Showing the first 12,000 characters of the captured text."
                  : "Captured text preview."}{" "}
                The approved capture will be archived with its original source
                and attribution.
              </p>
              <div className="submission-body">
                <ArchiveMarkdown
                  markdown={current.previewMarkdown}
                  originalUrl={current.url}
                  quality={current.quality}
                  preview
                />
              </div>
            </>
          )}
          <div className="ops-actions">
            {current.status === "ready" && (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => change({ action: "approve", id: current.id })}
              >
                Approve and queue ingestion
              </button>
            )}
            {["failed", "expired"].includes(current.status) && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => change({ action: "retry", id: current.id })}
              >
                Retry preview
              </button>
            )}
            {[
              "preview_queued",
              "previewing",
              "ready",
              "ingest_queued",
              "failed",
              "expired",
            ].includes(current.status) && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => change({ action: "cancel", id: current.id })}
              >
                Discard submission
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
