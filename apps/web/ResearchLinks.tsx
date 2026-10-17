import { useEffect, useState } from "react";
import { ArrowUpRight, Layers, Link } from "lucide-react";
import type { RelatedResult } from "../../packages/contracts";
export function ResearchLinks({
  id,
  onOpen,
}: {
  id: string;
  onOpen: (id: string) => void;
}) {
  const [result, setResult] = useState<RelatedResult | null>(null),
    [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setResult(null);
    setError(false);
    fetch(`/api/items/${id}/related`, { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setResult)
      .catch((e) => {
        if (e.name !== "AbortError") setError(true);
      });
    return () => abort.abort();
  }, [id]);
  if (error)
    return (
      <p className="semantic-note">
        Related research is temporarily unavailable.
      </p>
    );
  if (!result)
    return <p className="semantic-note">Finding related research…</p>;
  return (
    <section className="research-links">
      <div className="section-heading">
        <h2>
          <Layers size={18} /> Connected research
        </h2>
        <span>SOURCES RETAINED</span>
      </div>
      {result.items.length ? (
        <div className="related-grid">
          {result.items.map((item) => (
            <article className="related-card" key={item.id}>
              <small>
                {item.relation === "duplicate"
                  ? "SAME ARCHIVED TEXT"
                  : item.relation === "cites"
                    ? "CITED SOURCE"
                    : item.relation === "cited_by"
                      ? "CITED BY"
                      : "RELATED RESEARCH"}
              </small>
              <button onClick={() => onOpen(item.id)}>{item.title}</button>
              <p>{item.reason}</p>
              <a href={item.canonical_url} target="_blank" rel="noreferrer">
                {item.platform} <ArrowUpRight size={12} />
              </a>
            </article>
          ))}
        </div>
      ) : (
        <p className="semantic-note">No related items have been indexed yet.</p>
      )}
      {!!result.citations.length && (
        <details className="citation-list">
          <summary>
            <Link size={14} /> URLs mentioned in archived text (
            {result.citations.length})
          </summary>
          <ul>
            {result.citations.map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noreferrer">
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
