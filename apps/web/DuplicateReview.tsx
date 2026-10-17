import { useState, useEffect } from "react";
type Pair = {
  left_id: string;
  left_title: string;
  left_url: string;
  right_id: string;
  right_title: string;
  right_url: string;
  status: "exact" | "suggested";
};
export function DuplicateReview({ onOpen }: { onOpen: (id: string) => void }) {
  const [pairs, setPairs] = useState<Pair[] | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    fetch("/api/duplicates")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setPairs)
      .catch(() => setFailed(true));
  }, []);
  return (
    <section className="duplicate-review">
      <h2>Duplicate coverage</h2>
      <p>
        Identical archived text is grouped in semantic results. Similar titles
        are suggestions only; every original source is preserved.
      </p>
      {failed ? (
        <p>
          Duplicate analysis is unavailable until the Phase 2 index is ready.
        </p>
      ) : pairs?.length ? (
        <div>
          {pairs.map((p) => (
            <article key={`${p.left_id}:${p.right_id}`}>
              <span>
                {p.status === "exact"
                  ? "Identical text"
                  : "Possible duplicate — not merged"}
              </span>
              <button onClick={() => onOpen(p.left_id)}>{p.left_title}</button>
              <button onClick={() => onOpen(p.right_id)}>
                {p.right_title}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p>
          {pairs
            ? "No duplicate candidates in the indexed collection."
            : "Checking indexed coverage…"}
        </p>
      )}
    </section>
  );
}
