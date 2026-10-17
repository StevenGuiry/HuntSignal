import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { taxonomy } from "../../packages/taxonomy";
type Topic = {
  id: string;
  label: string;
  aliases: string[];
  related: string[];
  count: number;
};
export function TopicDirectory({
  onSelect,
}: {
  onSelect: (topic: string) => void;
}) {
  const [topics, setTopics] = useState<Topic[]>([]),
    [error, setError] = useState(false);
  useEffect(() => {
    fetch("/api/topics")
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setTopics)
      .catch(() => setError(true));
  }, []);
  return (
    <>
      <div className="eyebrow">EXPLORE BY VULNERABILITY</div>
      <h1>Follow a research thread.</h1>
      <p className="hero-description">
        Reports and techniques connected by topic, including the terms
        researchers use for the same weakness.
      </p>
      {error ? (
        <p role="alert">Topics could not be loaded.</p>
      ) : (
        <div className="topic-grid">
          {topics.map((t) => (
            <button
              className="topic-card"
              key={t.id}
              onClick={() => onSelect(t.label)}
            >
              <span>
                # {t.label}
                <ArrowUpRight size={17} />
              </span>
              <strong>{t.count}</strong>
              <small>indexed items</small>
              <p>{t.aliases.join(" · ")}</p>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
export function TopicIntro({ topic }: { topic: string }) {
  const [data, setData] = useState<{
    label: string;
    aliases: string[];
    related: string[];
    summary: { total: number; reports: number; research: number; full: number };
  } | null>(null);
  useEffect(() => {
    let stopped = false;
    setData(null);
    const found = taxonomy.find((t) => t.label === topic);
    (found
      ? fetch(`/api/topics/${found.id}`).then((r) => {
          if (!r.ok) throw new Error();
          return r.json();
        })
      : Promise.resolve(null)
    )
      .then((d) => {
        if (!stopped) setData(d);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [topic]);
  if (!data) return null;
  return (
    <section className="topic-intro">
      <div>
        <span className="eyebrow">TOPIC COLLECTION</span>
        <h2>{data.label}</h2>
        <p>Also indexed as {data.aliases.join(", ")}.</p>
        <a
          className="topic-feed"
          href={`/feeds/topics/${taxonomy.find((t) => t.label === topic)?.id}.xml`}
        >
          Subscribe to topic RSS <ArrowUpRight size={12} />
        </a>
        {data.related.length > 0 && (
          <p className="muted">Related concepts: {data.related.join(", ")}.</p>
        )}
      </div>
      <div className="topic-summary">
        <b>{data.summary.reports}</b>
        <span>reports</span>
        <b>{data.summary.research}</b>
        <span>research</span>
        <b>{data.summary.full}</b>
        <span>full text</span>
      </div>
    </section>
  );
}
