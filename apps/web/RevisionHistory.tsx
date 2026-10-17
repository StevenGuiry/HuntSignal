import { useEffect, useState } from "react";
import type { RevisionDiff } from "../../packages/revision-diff";
type Revision = {
  id: string;
  fetched_at: string;
  content_hash: string;
  source_revision: string | null;
  current: boolean;
  changes: RevisionDiff | { unavailable: boolean } | null;
};
export function RevisionHistory({ id }: { id: string }) {
  const [items, setItems] = useState<Revision[]>([]),
    [selected, setSelected] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setSelected("");
    setItems([]);
    fetch(`/api/items/${id}/revisions`, { signal: c.signal, cache: "no-store" })
      .then((r) => {
        if (!r.ok)
          throw new Error("Revision history is temporarily unavailable.");
        return r.json();
      })
      .then(setItems)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [id]);
  const revision = items.find((r) => r.id === selected),
    diff =
      revision?.changes && "before" in revision.changes
        ? revision.changes
        : null;
  return (
    <section className="revision-history">
      <h2>Revision history</h2>
      {error && <p>{error}</p>}
      <div className="revision-timeline">
        {items.map((r) => (
          <button
            className={r.id === selected ? "selected" : ""}
            key={r.id}
            onClick={() => setSelected(r.id === selected ? "" : r.id)}
          >
            <span>
              {new Date(r.fetched_at).toLocaleString("en-GB")}
              {r.current ? " · Current" : ""}
            </span>
            <code>{r.content_hash.slice(0, 12)}</code>
          </button>
        ))}
      </div>
      {revision && (
        <div className="revision-diff">
          {diff ? (
            <>
              <p>
                {diff.metadataOnly
                  ? "Metadata changed; archived text is unchanged."
                  : `${diff.removed} removed and ${diff.added} added lines in the changed region.`}
              </p>
              {diff.truncated && (
                <p>
                  The comparison is shortened. Original archived revisions are
                  retained.
                </p>
              )}
              {!diff.metadataOnly && (
                <div className="diff-columns">
                  <div>
                    <h3>Previous text</h3>
                    <pre>{diff.before.join("\n") || "(empty)"}</pre>
                  </div>
                  <div>
                    <h3>Updated text</h3>
                    <pre>{diff.after.join("\n") || "(empty)"}</pre>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p>
              A text comparison is not available for this revision. Earlier
              revisions created before revision tracking do not have a stored
              comparison.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
