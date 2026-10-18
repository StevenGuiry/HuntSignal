import { useEffect, useState } from "react";
import { Activity, RefreshCw, ShieldCheck } from "lucide-react";
import { useAuth, SignInGate } from "./auth";
type SourceHealth = {
  source_id: string;
  name: string;
  enabled: boolean;
  status: string;
  poll_seconds: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  latest_publication: string | null;
  documents: number;
  full: number;
  pending: number;
  failed: number;
};
type Health = {
  sources: SourceHealth[];
  indexPending: number;
  lastBackup: string | null;
};
type OperationsData = Health & {
  capacity: {
    databaseBytes: number;
    databaseLimit: number;
    storageBytes: number;
    storageLimit: number;
    unknownObjects: number;
    warning: boolean;
  };
  jobs: {
    source_id: string;
    external_id: string;
    status: string;
    attempts: number;
    last_error: string;
  }[];
  reviews: {
    id: string;
    source_id: string;
    document_id: string | null;
    kind: string;
    detail: string;
  }[];
  audit: {
    action: string;
    target: string;
    reason: string;
    created_at: string;
  }[];
  daily: {
    day: string;
    runs: number;
    successes: number;
    failures: number;
    documents: number;
  }[];
};
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString("en-GB") : "Not recorded";
const mb = (n: number) => `${(n / 1000000).toFixed(1)} MB`;
export function SourceHealthPanel() {
  const [data, setData] = useState<Health | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    fetch("/api/operations/health", { signal: c.signal, cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setFailed(true);
      });
    return () => c.abort();
  }, []);
  if (failed)
    return (
      <p className="error-box">
        Source health is unavailable. Archive freshness could not be verified.
      </p>
    );
  return (
    <section className="source-health">
      <div className="section-heading">
        <h2>
          <Activity size={17} />
          Discovery health
        </h2>
        <span>
          {data ? `${data.indexPending} AWAITING INDEXING` : "CHECKING"}
        </span>
      </div>
      {data && (
        <div className="health-grid">
          {data.sources.map((s) => (
            <div key={s.source_id}>
              <strong>{s.name}</strong>
              <span className={`health-status ${s.status}`}>{s.status}</span>
              <dl>
                <dt>Last check</dt>
                <dd>{time(s.last_attempt_at)}</dd>
                <dt>Last success</dt>
                <dd>{time(s.last_success_at)}</dd>
                <dt>Latest publication</dt>
                <dd>{time(s.latest_publication)}</dd>
                <dt>Polling interval</dt>
                <dd>
                  {s.poll_seconds >= 86400
                    ? `${Math.round(s.poll_seconds / 86400)} day(s)`
                    : `${Math.round(s.poll_seconds / 3600)} hours`}
                </dd>
                <dt>Pending / failed</dt>
                <dd>
                  {s.pending} / {s.failed}
                </dd>
              </dl>
            </div>
          ))}
        </div>
      )}
      <p className="semantic-note">
        A successful check can find no new publications. Publication dates and
        source freshness are shown separately.
      </p>
    </section>
  );
}
export function Operations({ onOpen }: { onOpen: (id: string) => void }) {
  const auth = useAuth();
  return auth.user ? (
    <SignedOperations key={auth.user.id} onOpen={onOpen} />
  ) : (
    <SignInGate purpose="administration" />
  );
}
function SignedOperations({ onOpen }: { onOpen: (id: string) => void }) {
  const auth = useAuth(),
    [data, setData] = useState<OperationsData | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reason, setReason] = useState(""),
    [selected, setSelected] = useState("");
  const refresh = () =>
    auth.request<OperationsData>("/operations").then(setData);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  const mutate = async (p: unknown) => {
    setBusy(true);
    setError("");
    try {
      await auth.request("/operations", {
        method: "POST",
        body: JSON.stringify(p),
      });
      await refresh();
      setSelected("");
      setReason("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="eyebrow">OPERATIONS · ADMINISTRATOR</div>
      <h1>Keep the archive healthy.</h1>
      <p className="hero-description">
        Source controls, failed work and preservation reviews. Every change is
        recorded.
      </p>
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="ops-capacity">
            <div>
              <span>DATABASE</span>
              <strong>
                {mb(data.capacity.databaseBytes)} /{" "}
                {mb(data.capacity.databaseLimit)}
              </strong>
            </div>
            <div>
              <span>ARCHIVE STORAGE</span>
              <strong>
                {mb(data.capacity.storageBytes)} /{" "}
                {mb(data.capacity.storageLimit)}
              </strong>
            </div>
            <div>
              <span>LAST COMPLETED BACKUP</span>
              <strong>{time(data.lastBackup)}</strong>
            </div>
          </div>
          {(data.capacity.warning || data.capacity.unknownObjects > 0) && (
            <p className="error-box">
              Capacity needs attention. Backfill and archive writes pause before
              the free-tier limits; existing material is preserved.
            </p>
          )}
          <div className="section-heading">
            <h2>Sources</h2>
            {(!data.lastBackup ||
              Date.now() - Date.parse(data.lastBackup) > 36 * 3600000) && (
              <span className="backup-stale">BACKUP OVERDUE</span>
            )}
            <button
              className="secondary-button"
              onClick={() => refresh().catch((e) => setError(e.message))}
            >
              <RefreshCw size={13} />
              Refresh status
            </button>
          </div>
          <div className="ops-list">
            {data.sources.map((s) => (
              <article key={s.source_id}>
                <div>
                  <h3>{s.name}</h3>
                  <p>
                    {s.status} · {s.pending} pending · {s.failed} failed
                  </p>
                  <small>Last success: {time(s.last_success_at)}</small>
                </div>
                <div className="ops-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={busy}
                      onChange={(e) =>
                        mutate({
                          action: "source_enabled",
                          sourceId: s.source_id,
                          enabled: e.target.checked,
                        })
                      }
                    />
                    Enabled
                  </label>
                  <button
                    disabled={busy || !s.enabled}
                    onClick={() =>
                      mutate({
                        action: "source_refresh",
                        sourceId: s.source_id,
                      })
                    }
                  >
                    Queue next poll
                  </button>
                </div>
              </article>
            ))}
          </div>
          <p className="semantic-note">
            Queued polls run when the ingestion runner next starts. Provider
            cooldowns remain in effect.
          </p>
          <div className="section-heading">
            <h2>Failed and delayed work</h2>
            <span>LATEST 50</span>
          </div>
          <div className="ops-list">
            {data.jobs.map((j) => (
              <article key={j.source_id + j.external_id}>
                <div>
                  <h3>
                    {j.source_id} · {j.status}
                  </h3>
                  <p>{j.last_error}</p>
                  <small>
                    {j.attempts} attempts · {j.external_id}
                  </small>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    mutate({
                      action: "retry_job",
                      sourceId: j.source_id,
                      externalId: j.external_id,
                    })
                  }
                >
                  Retry
                </button>
              </article>
            ))}
          </div>
          {!data.jobs.length && (
            <p className="semantic-note">No failed or delayed document jobs.</p>
          )}
          <div className="section-heading">
            <h2>Review queue</h2>
            <ShieldCheck size={17} />
          </div>
          <div className="ops-list">
            {data.reviews.map((r) => (
              <article key={r.id}>
                <div>
                  <h3>
                    {r.kind} · {r.source_id}
                  </h3>
                  <p>{r.detail}</p>
                  {r.document_id && (
                    <button onClick={() => onOpen(r.document_id!)}>
                      View document
                    </button>
                  )}
                  {selected === r.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void mutate({
                          action: "resolve_review",
                          id: r.id,
                          reason,
                        });
                      }}
                    >
                      <input
                        aria-label="Resolution reason"
                        value={reason}
                        minLength={5}
                        maxLength={500}
                        required
                        onChange={(e) => setReason(e.target.value)}
                      />
                      <button disabled={busy}>Resolve review</button>
                      <button type="button" onClick={() => setSelected("")}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button onClick={() => setSelected(r.id)}>
                      Record resolution
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {!data.reviews.length && (
            <p className="semantic-note">No open reviews.</p>
          )}
          <div className="section-heading">
            <h2>Daily operation</h2>
            <span>30 DAYS</span>
          </div>
          <div className="runs-table">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Runs</th>
                  <th>Success</th>
                  <th>Partial / failed</th>
                  <th>Processed</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td>{d.runs}</td>
                    <td>{d.successes}</td>
                    <td>{d.failures}</td>
                    <td>{d.documents}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="ops-audit">
            <summary>Recent administrative changes</summary>
            {data.audit.map((a, i) => (
              <p key={i}>
                {time(a.created_at)} · {a.action} · {a.target}
                {a.reason ? ` — ${a.reason}` : ""}
              </p>
            ))}
          </details>
          <Withdrawal />
        </>
      )}
    </>
  );
}
function Withdrawal() {
  const auth = useAuth(),
    [link, setLink] = useState(""),
    [reason, setReason] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [document, setDocument] = useState<{ id: string; title: string } | null>(
      null,
    ),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const preview = async () => {
    setBusy(true);
    setMessage("");
    try {
      const url = new URL(link, location.origin);
      if (url.origin !== location.origin)
        throw new Error("Use a HuntSignal reader link.");
      const id = url.searchParams.get("item");
      if (!id || !/^[0-9a-f-]{36}$/i.test(id))
        throw new Error("Paste a reader link with a document selected.");
      const response = await fetch(`/api/items/${id}`);
      if (!response.ok) throw new Error("Document could not be found.");
      const d = await response.json();
      setDocument({ id: d.id, title: d.title });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async () => {
    if (!document || confirmation !== "WITHDRAW") return;
    setBusy(true);
    try {
      await auth.request("/operations", {
        method: "POST",
        body: JSON.stringify({
          action: "withdraw",
          documentId: document.id,
          reason,
        }),
      });
      setMessage(
        "The document is withdrawn. Public reader and search access are disabled; archive-object removal will run during housekeeping.",
      );
      setDocument(null);
      setLink("");
      setReason("");
      setConfirmation("");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="withdrawal-panel">
      <h2>Withdraw an archive item</h2>
      {document ? (
        <>
          <p>{document.title}</p>
          <p>
            This removes the item from public search and reading, prevents
            rediscovery from republishing it, and queues removal of its archived
            objects. Existing bookmarks may show the item as unavailable.
          </p>
          <label>
            Type WITHDRAW to confirm
            <input
              aria-label="Confirm withdrawal"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            className="danger-button"
            disabled={busy || confirmation !== "WITHDRAW"}
            onClick={withdraw}
          >
            Withdraw this document
          </button>
          <button
            className="secondary-button"
            onClick={() => {
              setDocument(null);
              setConfirmation("");
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void preview();
          }}
        >
          <label>
            HuntSignal reader link
            <input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              required
              placeholder="Paste the link from the reader"
            />
          </label>
          <label>
            Reason
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={5}
              maxLength={500}
              required
            />
          </label>
          <button className="secondary-button" disabled={busy}>
            Review withdrawal
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
