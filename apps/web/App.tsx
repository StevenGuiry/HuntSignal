import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bookmark,
  Bell,
  UserRound,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  Filter,
  Globe,
  Layers,
  Menu,
  Radio,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { ArchiveMarkdown } from "./ArchiveMarkdown";
import { ResearchLinks } from "./ResearchLinks";
import { TopicDirectory, TopicIntro } from "./Topics";
import { DuplicateReview } from "./DuplicateReview";
import { useAuth } from "./auth";
import { ResearchLibrary } from "./Library";
import { AlertCenter, SaveSearch } from "./Alerts";
import { Account } from "./Account";
import { Operations, SourceHealthPanel } from "./Operations";
import { RevisionHistory } from "./RevisionHistory";
import { ReportFacts } from "./ReportFacts";
import { ResearchFilters } from "./ResearchFilters";
import {
  emptyResearchFilters,
  researchFilterKeys,
  type ResearchFilterState,
} from "../../packages/research-filters";
import {
  contentLabel,
  needsContentReview,
} from "../../packages/content-quality";
import { bountyLabel } from "../../packages/report-facts";
import { CardPersonalActions, ReaderPersonal } from "./PersonalActions";
import type { DocumentFlags } from "../../packages/personal";
import { queryVector } from "./semantic";
import {
  EMBEDDING_MODEL,
  isIdentifierQuery,
} from "../../packages/embeddings/config";
import type {
  Card,
  Detail,
  SearchResult,
  Stats,
} from "../../packages/contracts";
type View =
  | "archive"
  | "latest"
  | "research"
  | "sources"
  | "topics"
  | "library"
  | "alerts"
  | "account"
  | "operations";
// Administration uses the same signed-in API, with a separate database allowlist.
type Source = {
  id: string;
  name: string;
  url: string;
  status: string;
  detail: string;
  documents: number;
  full: number;
  partial: number;
  metadata: number;
  papers: number;
  last_success_at: string | null;
};
type Run = {
  id: string;
  source_id: string;
  started_at: string;
  status: string;
  processed: number;
  inserted: number;
  updated: number;
  failed: number;
  detail: string;
};
type State = ResearchFilterState & {
  view: View;
  q: string;
  source: string;
  author: string;
  topic: string;
  kind: string;
  completeness: string;
  sort: string;
  page: number;
  item: string;
  match: string;
  after: string;
  before: string;
  mode: "keyword" | "hybrid";
};
const initial = (): State => {
  const p = new URLSearchParams(location.search);
  return {
    ...(Object.fromEntries(
      researchFilterKeys.map((k) => [k, p.get(k) || ""]),
    ) as ResearchFilterState),
    view: (p.get("view") as View) || "archive",
    q: p.get("q") || "",
    source: p.get("source") || "",
    author: p.get("author") || "",
    topic: p.get("topic") || "",
    kind: p.get("kind") || "",
    completeness: p.get("completeness") || "",
    sort:
      p.get("mode") === "hybrid" ? "relevance" : p.get("sort") || "relevance",
    page: Number(p.get("page")) || 1,
    item: p.get("item") || "",
    match: (p.get("match") || "").slice(0, 600),
    after: p.get("after") || "",
    before: p.get("before") || "",
    mode: p.get("mode") === "hybrid" ? "hybrid" : "keyword",
  };
};
const date = (s: string | null) =>
  s
    ? new Date(s).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Date not supplied";
const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};
async function api<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error?.message || "Unable to load the archive.");
  }
  return r.json();
}
function Highlight({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(⟦.*?⟧)/g)
        .map((p, i) =>
          p.startsWith("⟦") ? <mark key={i}>{p.slice(1, -1)}</mark> : p,
        )}
    </>
  );
}
export default function App() {
  const auth = useAuth();
  const [administrator, setAdministrator] = useState("");
  useEffect(() => {
    let active = true;
    setAdministrator("");
    if (auth.user) {
      const owner = auth.user.id;
      auth
        .request<{ admin: boolean }>("/operations/status")
        .then((r) => {
          if (active && r.admin) setAdministrator(owner);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [auth.user?.id]);
  const [annotations, setAnnotations] = useState<{
    owner: string;
    items: Record<string, DocumentFlags>;
  }>({ owner: "", items: {} });
  const [state, setState] = useState(initial),
    [draft, setDraft] = useState(state.q),
    [stats, setStats] = useState<Stats | null>(null),
    [result, setResult] = useState<SearchResult | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [sources, setSources] = useState<Source[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [mobile, setMobile] = useState(false),
    [dates, setDates] = useState(false),
    [copied, setCopied] = useState(false);
  const [semanticMessage, setSemanticMessage] = useState("");
  const [semanticBusy, setSemanticBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const update = (patch: Partial<State>) => {
    const next = { ...state, page: 1, ...patch };
    setState(next);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next))
      if (v && !(k === "page" && v === 1)) params.set(k, String(v));
    history.pushState(null, "", `?${params}`);
    setMobile(false);
  };
  const navigate = (view: View) =>
    update({
      ...emptyResearchFilters,
      view,
      item: "",
      match: "",
      q: "",
      source: "",
      author: "",
      topic: "",
      kind: view === "research" ? "article" : view === "latest" ? "report" : "",
      mode: "keyword",
      completeness: "",
      sort: view === "latest" ? "newest" : "relevance",
      after: "",
      before: "",
    });
  useEffect(() => {
    const pop = () => setState(initial());
    window.addEventListener("popstate", pop);
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => setDraft(state.q), [state.q]);
  useEffect(() => {
    api<Stats>("/api/stats")
      .then(setStats)
      .catch(() => {});
    api<Source[]>("/api/sources")
      .then(setSources)
      .catch(() => {});
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setDetail(null);
    setSemanticMessage("");
    setSemanticBusy(false);
    const load = async () => {
      if (state.item) {
        setDetail(
          await api<Detail>(`/api/items/${state.item}`, controller.signal),
        );
      } else if (
        ["topics", "library", "alerts", "account", "operations"].includes(
          state.view,
        )
      ) {
        return;
      } else if (state.view === "sources") {
        const [s, r] = await Promise.all([
          api<Source[]>("/api/sources", controller.signal),
          api<Run[]>("/api/runs", controller.signal),
        ]);
        setSources(s);
        setRuns(r);
      } else {
        const p = new URLSearchParams();
        for (const key of [
          "q",
          "source",
          "author",
          "topic",
          "kind",
          "completeness",
          "sort",
          "page",
          "after",
          "before",
          ...researchFilterKeys,
        ] as const)
          if (state[key]) p.set(key, String(state[key]));
        const lexical = await api<SearchResult>(
          `/api/search?${p}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResult(lexical);
        setLoading(false);
        if (
          state.mode === "hybrid" &&
          state.q.trim() &&
          !isIdentifierQuery(state.q)
        ) {
          setSemanticBusy(true);
          try {
            const status = await api<{
              phase: number;
              indexed_documents: number;
              total_documents: number;
            }>("/api/search/status", controller.signal);
            if (status.phase < 2 || !status.indexed_documents)
              throw new Error(
                "The semantic index is not ready yet. Showing keyword results.",
              );
            const vector = await queryVector(state.q, (message) => {
              if (!controller.signal.aborted) setSemanticMessage(message);
            });
            if (controller.signal.aborted) return;
            const response = await fetch("/api/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...Object.fromEntries(p),
                mode: "hybrid",
                vector,
                modelId: EMBEDDING_MODEL.id,
              }),
              signal: controller.signal,
            });
            if (!response.ok)
              throw new Error(
                "Semantic search is temporarily unavailable. Showing keyword results.",
              );
            const hybrid = (await response.json()) as SearchResult;
            if (!controller.signal.aborted) {
              setResult(hybrid);
              setSemanticMessage(
                hybrid.warning ||
                  (status.indexed_documents < status.total_documents
                    ? `Semantic coverage: ${status.indexed_documents} of ${status.total_documents} documents. Keyword search covers the whole archive.`
                    : "Meaning and keyword matches combined. Identical archived text is grouped."),
              );
            }
          } catch (e) {
            if (!controller.signal.aborted)
              setSemanticMessage(
                e instanceof Error ? e.message : "Showing keyword results.",
              );
          } finally {
            if (!controller.signal.aborted) setSemanticBusy(false);
          }
        }
      }
    };
    load()
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [state]);
  useEffect(() => {
    const owner = auth.user?.id;
    const controller = new AbortController();
    setAnnotations({ owner: owner || "", items: {} });
    if (
      owner &&
      result?.items.length &&
      !state.item &&
      ["archive", "latest", "research"].includes(state.view)
    ) {
      auth
        .request<DocumentFlags[]>("/annotations", {
          method: "POST",
          body: JSON.stringify({ ids: result.items.map((item) => item.id) }),
          signal: controller.signal,
        })
        .then((items) => {
          if (!controller.signal.aborted)
            setAnnotations({
              owner,
              items: Object.fromEntries(items.map((item) => [item.id, item])),
            });
        })
        .catch(() => {});
    }
    return () => controller.abort();
  }, [auth.user?.id, result, state.item, state.view]);
  const activeFilters = !!(
    researchFilterKeys.some((k) => !!state[k]) ||
    state.source ||
    state.author ||
    state.topic ||
    state.kind ||
    state.completeness ||
    state.after ||
    state.before
  );
  const openItem = (item: string, match = "") => {
    update({ item, match });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const search = (q = draft) =>
    update({
      q: q.trim(),
      item: "",
      match: "",
      view: "archive",
      sort: "relevance",
    });
  const topTopics = [
    "XSS",
    "Account takeover",
    "SSRF",
    "SQL injection",
    "IDOR",
    "OAuth",
  ];
  const pages = result ? Math.ceil(result.total / result.limit) : 0;
  return (
    <div className="app-shell">
      {mobile && (
        <button
          className="scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar ${mobile ? "is-open" : ""}`}>
        <button className="brand" onClick={() => navigate("archive")}>
          <span className="brand-symbol">
            <Activity size={25} />
          </span>
          <span>
            Hunt<span className="brand-light">Signal</span>
            <small>THE RESEARCH LIBRARY</small>
          </span>
        </button>
        <div className="workspace-label">
          <span className="status-dot" /> PUBLIC COLLECTION <span>06</span>
        </div>
        <nav aria-label="Main navigation">
          <span className="nav-label">EXPLORE</span>
          <button
            className={state.view === "archive" ? "active" : ""}
            onClick={() => navigate("archive")}
          >
            <Archive size={18} /> Archive{" "}
            <span className="nav-count">
              {stats?.total.toLocaleString() || "—"}
            </span>
          </button>
          <button
            className={state.view === "latest" ? "active" : ""}
            onClick={() => navigate("latest")}
          >
            <Radio size={18} /> Latest reports
          </button>
          <button
            className={state.view === "research" ? "active" : ""}
            onClick={() => navigate("research")}
          >
            <BookOpen size={18} /> Research & techniques
          </button>
          <button
            className={state.view === "sources" ? "active" : ""}
            onClick={() => navigate("sources")}
          >
            <Layers size={18} /> Sources
          </button>
          <button
            className={state.view === "topics" ? "active" : ""}
            onClick={() => navigate("topics")}
          >
            <Globe size={18} /> Topic collections
          </button>
          <span className="nav-label personal-nav-label">YOUR WORKSPACE</span>
          <button
            className={state.view === "library" ? "active" : ""}
            onClick={() => navigate("library")}
          >
            <Bookmark size={18} />
            My library
          </button>
          <button
            className={state.view === "alerts" ? "active" : ""}
            onClick={() => navigate("alerts")}
          >
            <Bell size={18} />
            Searches & alerts
          </button>
          <button
            className={state.view === "account" ? "active" : ""}
            onClick={() => navigate("account")}
          >
            <UserRound size={18} />
            {auth.user ? "Account" : "Sign in"}
          </button>
          {administrator && administrator === auth.user?.id && (
            <button
              className={state.view === "operations" ? "active" : ""}
              onClick={() => navigate("operations")}
            >
              <ShieldCheck size={18} />
              Operations
            </button>
          )}
        </nav>
        <div className="topic-nav">
          <span className="nav-label">FOLLOW A THREAD</span>
          {topTopics.map((topic) => (
            <button
              key={topic}
              className={state.topic === topic ? "selected" : ""}
              onClick={() =>
                update({ topic, q: "", item: "", view: "archive", kind: "" })
              }
            >
              <span className="topic-hash">#</span>
              {topic}
              <span>
                {stats?.topics.find((t) => t.topic === topic)?.count || "—"}
              </span>
            </button>
          ))}
        </div>
        <div className="sidebar-note">
          <ShieldCheck size={20} />
          <p>
            Keep the original.
            <br />
            <strong>Connect the knowledge.</strong>
          </p>
          <span>Every entry links to its source.</span>
        </div>
        <div className="sidebar-footer">
          <span className="avatar">HS</span>
          <div>
            {auth.user?.name || "Research workspace"}
            <small>Research archive · v0.6</small>
          </div>
          <span className="status-dot" />
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <button
              className="mobile-menu icon-button"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={22} />
            </button>
            <span className="breadcrumb">
              LIBRARY <span>/</span>{" "}
              {state.item
                ? "DOCUMENT"
                : state.view === "latest"
                  ? "LATEST REPORTS"
                  : state.view.toUpperCase()}
            </span>
          </div>
          <div className="topbar-right">
            <span className="small-status">
              <span className="status-dot" /> PUBLIC KNOWLEDGE
            </span>
            <a
              href="https://github.com/OWASP/CheatSheetSeries"
              target="_blank"
              rel="noreferrer"
              className="quiet-link"
            >
              Built on open research <ArrowUpRight size={14} />
            </a>
          </div>
        </header>
        <div className="main-content">
          {state.item ? (
            <>
              <button
                className="back-link"
                onClick={() => update({ item: "" })}
              >
                <ArrowLeft size={16} /> Back to results
              </button>
              {loading ? (
                <Loading />
              ) : error ? (
                <ErrorBox message={error} />
              ) : detail ? (
                <article className="reader">
                  <div className="eyebrow">
                    {detail.kind === "report"
                      ? "DISCLOSURE"
                      : "RESEARCH & TECHNIQUES"}{" "}
                    <span> / </span> {detail.platform}
                  </div>
                  <h1>{detail.title}</h1>
                  <div className="reader-byline">
                    {detail.authors.join(", ") || "Author not supplied"}
                    <span>·</span>
                    {date(detail.published_at)}
                  </div>
                  <ReportFacts kind={detail.kind} facts={detail.report_facts} />
                  <div className="reader-actions">
                    <a
                      className="primary-button"
                      href={detail.canonical_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Read original <ArrowUpRight size={16} />
                    </a>
                    <button
                      className="secondary-button"
                      onClick={() => {
                        navigator.clipboard
                          .writeText(location.href)
                          .then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          })
                          .catch(() =>
                            setError(
                              "Clipboard is unavailable. Copy the URL from the address bar.",
                            ),
                          );
                      }}
                    >
                      {copied ? <Check size={15} /> : <Globe size={15} />}{" "}
                      {copied ? "Link copied" : "Copy link"}
                    </button>
                    <span
                      className={`archive-badge ${detail.completeness === "full" && !needsContentReview(detail.content_quality) ? "complete" : ""}`}
                    >
                      <Database size={12} />
                      {contentLabel(detail)}
                    </span>
                  </div>
                  <div className="reader-tags">
                    {detail.topics.map((t) => (
                      <button
                        key={t}
                        className="tag"
                        onClick={() =>
                          update({ view: "archive", topic: t, item: "", q: "" })
                        }
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  {detail.content_error ? (
                    <ErrorBox message={detail.content_error} />
                  ) : detail.markdown ? (
                    <ArchiveMarkdown
                      key={`${detail.id}:${detail.content_hash}:${auth.user?.id || "guest"}`}
                      markdown={detail.markdown}
                      originalUrl={detail.canonical_url}
                      documentId={detail.id}
                      revision={detail.content_hash}
                      owner={auth.user?.id || "guest"}
                      passage={state.match}
                      quality={detail.content_quality}
                    />
                  ) : (
                    <div className="metadata-notice">
                      <FileText size={26} />
                      <h2>This report lives at its original source.</h2>
                      <p>
                        Its title, author, publication date and vulnerability
                        tags are indexed here. The body has not been archived
                        because permission to reproduce it has not been
                        established.
                      </p>
                      <a
                        href={detail.canonical_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open {domain(detail.canonical_url)}{" "}
                        <ArrowUpRight size={15} />
                      </a>
                    </div>
                  )}
                  <footer className="provenance">
                    <h3>Source & preservation</h3>
                    <dl>
                      <dt>Original source</dt>
                      <dd>
                        <a
                          href={detail.canonical_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {detail.canonical_url}
                        </a>
                      </dd>
                      <dt>Discovered through</dt>
                      <dd>
                        <a
                          href={detail.source_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {detail.source_name}
                        </a>
                      </dd>
                      <dt>Archived / indexed</dt>
                      <dd>
                        {date(detail.fetched_at)} · {detail.revision_count}{" "}
                        revision{detail.revision_count !== 1 ? "s" : ""}
                      </dd>
                      <dt>License</dt>
                      <dd>
                        {detail.license_url ? (
                          <a
                            href={detail.license_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {detail.license}
                          </a>
                        ) : (
                          detail.license
                        )}
                      </dd>
                      <dt>Attribution</dt>
                      <dd>{detail.attribution}</dd>
                      <dt>Content SHA-256</dt>
                      <dd className="hash-value">{detail.content_hash}</dd>
                    </dl>
                  </footer>
                  <RevisionHistory id={detail.id} />
                  <ResearchLinks id={detail.id} onOpen={openItem} />
                  <ReaderPersonal id={detail.id} authors={detail.authors} />
                </article>
              ) : null}
            </>
          ) : state.view === "library" ? (
            <ResearchLibrary onOpen={openItem} />
          ) : state.view === "alerts" ? (
            <AlertCenter
              onOpen={openItem}
              onSearch={(saved) =>
                update({
                  ...emptyResearchFilters,
                  view: "archive",
                  item: "",
                  q: saved.queryText,
                  mode: saved.mode,
                  sort: "relevance",
                  source: "",
                  topic: "",
                  kind: "",
                  author: "",
                  completeness: "",
                  after: "",
                  before: "",
                  ...Object.fromEntries(
                    Object.entries(saved.filters).map(([k, v]) => [
                      k,
                      String(v),
                    ]),
                  ),
                })
              }
            />
          ) : state.view === "account" ? (
            <Account />
          ) : state.view === "operations" ? (
            <Operations onOpen={openItem} />
          ) : state.view === "topics" ? (
            <TopicDirectory
              onSelect={(topic) =>
                update({ view: "archive", topic, q: "", item: "", kind: "" })
              }
            />
          ) : state.view === "sources" ? (
            <>
              <div className="eyebrow">THE COLLECTION</div>
              <h1>Know your sources.</h1>
              <p className="hero-description">
                Original links, archive coverage, and the health of every
                import.
              </p>
              {loading ? (
                <Loading />
              ) : error ? (
                <ErrorBox message={error} />
              ) : (
                <>
                  <div className="stats-row">
                    <Stat
                      label="FULL TEXT"
                      value={stats?.full}
                      icon={<Database size={17} />}
                    />
                    <Stat
                      label="PARTIAL TEXT / ABSTRACTS"
                      value={stats?.partial}
                      icon={<BookOpen size={17} />}
                    />
                    <Stat
                      label="READABLE ENTRIES"
                      value={stats?.total}
                      icon={<FileText size={17} />}
                    />
                  </div>
                  <SourceHealthPanel />
                  <div className="source-grid">
                    {sources.map((s) => (
                      <div className="source-card" key={s.id}>
                        <span className="source-icon">
                          <Layers size={20} />
                        </span>
                        <h2>{s.name}</h2>
                        <a href={s.url} target="_blank" rel="noreferrer">
                          {domain(s.url)} <ArrowUpRight size={14} />
                        </a>
                        <div className="source-numbers">
                          <div>
                            <b>{s.documents}</b>
                            <span>indexed</span>
                          </div>
                          <div>
                            <b>{s.full}</b>
                            <span>full text</span>
                          </div>
                          <div>
                            <b>{s.partial || 0}</b>
                            <span>partial text</span>
                          </div>
                        </div>
                        <div className="source-status">
                          <span
                            className={`status-dot ${s.status === "partial" ? "warning" : ""}`}
                          />
                          {s.status === "success"
                            ? "Last import successful"
                            : s.status}
                          <small>{date(s.last_success_at)}</small>
                        </div>
                        <p>{s.detail}</p>
                      </div>
                    ))}
                  </div>
                  <div className="section-heading">
                    <h2>Ingestion activity</h2>
                    <span>LAST 20 RUNS</span>
                  </div>
                  <div className="runs-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Source</th>
                          <th>Started</th>
                          <th>Processed</th>
                          <th>New / updated</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr key={r.id}>
                            <td>{r.source_id}</td>
                            <td>{date(r.started_at)}</td>
                            <td>{r.processed}</td>
                            <td>
                              {r.inserted} / {r.updated}
                            </td>
                            <td>
                              <span className={`run-status ${r.status}`}>
                                {r.status}
                              </span>
                              {r.failed > 0 && (
                                <span className="failed-count">
                                  {" "}
                                  {r.failed} failed
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <DuplicateReview onOpen={openItem} />
                  <div className="coverage-note">
                    <ShieldCheck size={18} />
                    <p>
                      Coverage is explicit: licensed articles retain full text;
                      abstracts and permitted feed excerpts are marked partial.
                      Entries appear here after substantive source text is
                      archived. Unavailable pages remain in the capture queue.
                      Research blogs are distinct from platform report
                      disclosures.
                    </p>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="hero-row">
                <div>
                  <div className="eyebrow">
                    <span /> YOUR OPEN SECURITY RESEARCH LIBRARY
                  </div>
                  <h1>
                    {state.view === "research"
                      ? "Ideas worth exploring."
                      : state.view === "latest"
                        ? "Follow the disclosures."
                        : "The research archive."}
                  </h1>
                  <p className="hero-description">
                    {state.view === "research"
                      ? "Techniques, deep dives, and the details that make a difference."
                      : state.view === "latest"
                        ? "Public reports, ordered by their original publication date."
                        : "Public disclosures and security research. One place to connect the dots."}
                  </p>
                </div>
                <div className="hero-decoration" aria-hidden="true">
                  <Activity />
                  <span>SIGNAL FOUND</span>
                </div>
              </div>
              {state.view === "latest" && (
                <div className="feed-order" aria-label="Feed order">
                  {[
                    ["newest", "Newly published"],
                    ["indexed", "Newly indexed"],
                    ["updated", "Updated"],
                  ].map(([sort, label]) => (
                    <button
                      key={sort}
                      className={state.sort === sort ? "selected" : ""}
                      onClick={() => update({ sort, mode: "keyword" })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <form
                className="search-box"
                onSubmit={(e) => {
                  e.preventDefault();
                  search();
                }}
              >
                <Search size={23} />
                <input
                  ref={input}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Search XSS, OAuth, account takeover…"
                  aria-label="Search the archive"
                />
                <kbd>Ctrl K</kbd>
                <button type="submit">
                  Search <ArrowRight size={17} />
                </button>
              </form>
              <div className="search-hints">
                <span>FOLLOW YOUR CURIOSITY</span>
                {["XSS", "OAuth", "Account takeover", "SSRF"].map((q) => (
                  <button key={q} onClick={() => search(q)}>
                    {q}
                    <ArrowUpRight size={11} />
                  </button>
                ))}
              </div>
              <div className="search-mode">
                <div role="group" aria-label="Search mode">
                  <button
                    aria-pressed={state.mode === "keyword"}
                    className={state.mode === "keyword" ? "selected" : ""}
                    onClick={() => update({ mode: "keyword" })}
                  >
                    Keywords & synonyms
                  </button>
                  <button
                    aria-pressed={state.mode === "hybrid"}
                    className={state.mode === "hybrid" ? "selected" : ""}
                    onClick={() =>
                      update({ mode: "hybrid", sort: "relevance" })
                    }
                  >
                    Search by meaning
                  </button>
                </div>
                <span>
                  {semanticBusy
                    ? "Semantic search is loading; keyword results are ready."
                    : state.mode === "hybrid"
                      ? "Try “account takeover through OAuth mistakes”"
                      : "Every matching document, with complete pagination."}
                </span>
              </div>
              {semanticMessage && (
                <p className="semantic-note" role="status">
                  {semanticMessage}
                </p>
              )}
              {state.topic && <TopicIntro topic={state.topic} />}
              <div className="stats-row">
                <Stat
                  label="DOCUMENTS INDEXED"
                  value={stats?.total}
                  icon={<Archive size={17} />}
                />
                <Stat
                  label="REPORTS & WRITE-UPS"
                  value={stats?.reports}
                  icon={<FileText size={17} />}
                />
                <Stat
                  label="FULL TEXT PRESERVED"
                  value={stats?.full}
                  icon={<Database size={17} />}
                />
                <Stat
                  label="SOURCE PLATFORMS"
                  value={stats?.sources}
                  icon={<Globe size={17} />}
                />
              </div>
              <div className="results-bar">
                <div className="result-tabs">
                  <button
                    className={!state.kind ? "selected" : ""}
                    onClick={() => update({ kind: "" })}
                  >
                    Everything
                  </button>
                  <button
                    className={state.kind === "report" ? "selected" : ""}
                    onClick={() => update({ kind: "report" })}
                  >
                    Reports
                  </button>
                  <button
                    className={state.kind === "article" ? "selected" : ""}
                    onClick={() => update({ kind: "article" })}
                  >
                    Articles
                  </button>
                  <button
                    className={state.kind === "paper" ? "selected" : ""}
                    onClick={() => update({ kind: "paper" })}
                  >
                    Papers
                  </button>
                </div>
                <button
                  className={`filter-button ${dates ? "selected" : ""}`}
                  onClick={() => setDates(!dates)}
                >
                  <Filter size={14} /> Date range
                </button>
              </div>
              <div className="filters">
                <label>
                  <Globe size={14} />
                  <select
                    aria-label="Source platform"
                    value={state.source}
                    onChange={(e) => update({ source: e.target.value })}
                  >
                    <option value="">All sources</option>
                    {stats?.platforms.map((s) => (
                      <option key={s.platform} value={s.platform}>
                        {s.platform} ({s.count})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <Database size={14} />
                  <select
                    aria-label="Archive availability"
                    value={state.completeness}
                    onChange={(e) => update({ completeness: e.target.value })}
                  >
                    <option value="">All availability</option>
                    <option value="full">Complete text only</option>
                    <option value="partial">
                      Summaries, abstracts & partial text
                    </option>
                  </select>
                </label>
                {state.topic && (
                  <button
                    className="active-filter"
                    onClick={() => update({ topic: "" })}
                  >
                    {state.topic}
                    <X size={12} />
                  </button>
                )}
                {state.author && (
                  <button
                    className="active-filter"
                    onClick={() => update({ author: "" })}
                  >
                    Author: {state.author}
                    <X size={12} />
                  </button>
                )}
                <div className="filter-spacer" />
                {activeFilters && (
                  <button
                    className="clear-filters"
                    onClick={() =>
                      update({
                        ...emptyResearchFilters,
                        source: "",
                        author: "",
                        topic: "",
                        kind: "",
                        completeness: "",
                        after: "",
                        before: "",
                      })
                    }
                  >
                    Reset filters
                  </button>
                )}
                <label className="sort-label">
                  <ArrowDown size={14} />
                  <select
                    aria-label="Sort results"
                    disabled={state.mode === "hybrid" && !!state.q.trim()}
                    value={state.sort}
                    onChange={(e) => update({ sort: e.target.value })}
                  >
                    <option value="relevance">Most relevant</option>
                    <option value="newest">Newest published</option>
                    <option value="oldest">Oldest published</option>
                    <option value="indexed">Recently indexed</option>
                    <option value="updated">Recently updated</option>
                  </select>
                </label>
              </div>
              <ResearchFilters
                values={state}
                onApply={(filters) => update(filters)}
              />
              {dates && (
                <div className="date-filters">
                  <label>
                    Published after
                    <input
                      type="date"
                      value={state.after}
                      onChange={(e) => update({ after: e.target.value })}
                    />
                  </label>
                  <label>
                    Published before
                    <input
                      type="date"
                      value={state.before}
                      onChange={(e) => update({ before: e.target.value })}
                    />
                  </label>
                </div>
              )}
              <SaveSearch
                key={`${auth.user?.id || "guest"}:${state.q}:${JSON.stringify([state.source, state.topic, state.author, state.kind, state.completeness, state.after, state.before, state.mode, ...researchFilterKeys.map((k) => state[k])])}`}
                search={state}
              />
              <div className="result-summary">
                <span>
                  {loading
                    ? "Searching…"
                    : `${result?.total.toLocaleString() || 0} ${result?.total_type === "ranked" ? "ranked results" : "results"}`}
                  {state.q && (
                    <>
                      {" "}
                      for <strong>“{state.q}”</strong>
                    </>
                  )}
                </span>
                {!!result?.expanded.length && state.q && (
                  <span className="expansion">
                    <Check size={13} /> Including synonyms for{" "}
                    {result.expanded.join(", ")}
                  </span>
                )}
              </div>
              {result?.total_type === "ranked" && (
                <p className="semantic-note">
                  Ranked suggestions are not an exhaustive match count. Switch
                  to keywords for all lexical matches
                  {result.keyword_total !== undefined
                    ? ` (${result.keyword_total})`
                    : ""}
                  .
                </p>
              )}
              {loading ? (
                <Loading />
              ) : error ? (
                <ErrorBox message={error} />
              ) : result?.items.length ? (
                <div className="result-list">
                  {result.items.map((item) => (
                    <ResultCard
                      key={item.id}
                      item={item}
                      onOpen={() => openItem(item.id)}
                      onMatch={
                        state.q && item.snippet
                          ? () => openItem(item.id, item.snippet.slice(0, 600))
                          : undefined
                      }
                      onTopic={(topic) => update({ topic, q: "" })}
                      flags={
                        annotations.owner === auth.user?.id
                          ? annotations.items[item.id]
                          : undefined
                      }
                      onFlags={(flags) =>
                        setAnnotations((current) => ({
                          owner: auth.user?.id || "",
                          items: {
                            ...(current.owner === auth.user?.id
                              ? current.items
                              : {}),
                            [flags.id]: flags,
                          },
                        }))
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <Search size={28} />
                  <h2>
                    {stats?.total
                      ? "No matching research yet."
                      : "Your archive starts here."}
                  </h2>
                  <p>
                    {stats?.total
                      ? "Try a broader phrase or remove a filter. Synonyms such as XSS and cross-site scripting are searched together."
                      : "Run the pilot ingestion to add public report metadata and licensed full-text research."}
                  </p>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setDraft("");
                      update({
                        q: "",
                        topic: "",
                        source: "",
                        author: "",
                        kind: "",
                        completeness: "",
                        after: "",
                        before: "",
                      });
                    }}
                  >
                    Clear search
                  </button>
                </div>
              )}
              {!!result?.total && (
                <div className="pagination">
                  <span>
                    Showing {(state.page - 1) * result.limit + 1}–
                    {Math.min(state.page * result.limit, result.total)} of{" "}
                    {result.total}
                  </span>
                  <div>
                    <button
                      aria-label="Previous page"
                      disabled={state.page <= 1 || loading}
                      onClick={() => update({ page: state.page - 1 })}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span>
                      {state.page} <span>/ {pages}</span>
                    </span>
                    <button
                      aria-label="Next page"
                      disabled={state.page >= pages || loading}
                      onClick={() => update({ page: state.page + 1 })}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              )}
              <div className="bottom-note">
                <span>BUILT FOR THE CURIOUS.</span>
                <p>
                  Original work belongs to its authors. Source links and archive
                  status are always visible.
                </p>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value?: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="stat">
      <div>
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value === undefined ? "—" : value.toLocaleString()}</strong>
    </div>
  );
}
function ResultCard({
  item,
  onOpen,
  onMatch,
  onTopic,
  flags,
  onFlags,
}: {
  item: Card;
  onOpen: () => void;
  onMatch?: () => void;
  onTopic: (t: string) => void;
  flags?: DocumentFlags;
  onFlags: (flags: DocumentFlags) => void;
}) {
  return (
    <article className="result-card">
      <div className="result-icon">
        {item.kind === "report" ? (
          <FileText size={21} />
        ) : (
          <BookOpen size={21} />
        )}
      </div>
      <div className="result-main">
        <div className="result-meta">
          <span className={`platform platform-${item.platform.toLowerCase()}`}>
            {item.platform}
          </span>
          <span className="meta-dot">·</span>
          <span>
            {item.kind === "report"
              ? "WRITE-UP / DISCLOSURE"
              : "RESEARCH / TECHNIQUE"}
          </span>
          <span className="result-date">{date(item.published_at)}</span>
        </div>
        <h2>
          <button onClick={onOpen}>{item.title}</button>
        </h2>
        {item.kind === "report" && (
          <div className="result-outcomes">
            <span>Bounty: {bountyLabel(item.report_facts)}</span>
            <span
              className={`severity-${item.report_facts?.severity || "unknown"}`}
            >
              {item.report_facts
                ? item.report_facts.severityFinal
                  ? "Final severity"
                  : "Current severity"
                : "Severity"}
              :{" "}
              {item.report_facts?.severity
                ? item.report_facts.severity[0].toUpperCase() +
                  item.report_facts.severity.slice(1)
                : item.report_facts
                  ? "Not disclosed"
                  : "Not available"}
              {item.report_facts?.priority
                ? ` · ${item.report_facts.priority}`
                : ""}
            </span>
          </div>
        )}
        <p className="snippet">
          {item.snippet ? (
            <Highlight text={item.snippet} />
          ) : item.programs.length ? (
            `Research involving ${item.programs.join(", ")}. Follow the original source for the complete write-up.`
          ) : (
            "Public report metadata. Follow the original source for the complete write-up."
          )}
        </p>
        {onMatch && (
          <button className="passage-link" onClick={onMatch}>
            Jump to matching passage <ArrowRight size={13} />
          </button>
        )}
        <div className="result-tags">
          {item.topics.slice(0, 4).map((t) => (
            <button className="tag" key={t} onClick={() => onTopic(t)}>
              {t}
            </button>
          ))}
          {item.topics.length > 4 && (
            <span className="more-tags">+{item.topics.length - 4}</span>
          )}
        </div>
        <div className="result-footer">
          <span className="author">
            {item.authors[0] || "Author not supplied"}
            {item.authors.length > 1 ? ` +${item.authors.length - 1}` : ""}
          </span>
          <span
            className={`archive-badge ${item.completeness === "full" && !needsContentReview(item.content_quality) ? "complete" : ""}`}
          >
            {item.completeness === "full" &&
            !needsContentReview(item.content_quality) ? (
              <Check size={12} />
            ) : (
              <Globe size={12} />
            )}{" "}
            {contentLabel(item)}
          </span>
          <a
            href={item.canonical_url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Original source: ${item.title}`}
          >
            Original <ArrowUpRight size={13} />
          </a>
        </div>
        <CardPersonalActions id={item.id} flags={flags} onChange={onFlags} />
        {!!item.match_reasons?.length && (
          <div className="match-reasons">
            {item.match_reasons.map((reason) => (
              <span key={reason}>{reason}</span>
            ))}
            {!!item.duplicate_count && (
              <span>
                {item.duplicate_count} additional source
                {item.duplicate_count === 1 ? "" : "s"} with identical text
              </span>
            )}
          </div>
        )}
      </div>
      <button
        className="open-arrow"
        onClick={onOpen}
        aria-label={`Read ${item.title}`}
      >
        <ArrowUpRight size={18} />
      </button>
    </article>
  );
}
function Loading() {
  return (
    <div className="loading" role="status">
      <span />
      <span />
      <span />
      <p>Loading the research…</p>
    </div>
  );
}
function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="error-box">
      <strong>Something needs attention.</strong>
      <p>{message}</p>
    </div>
  );
}
