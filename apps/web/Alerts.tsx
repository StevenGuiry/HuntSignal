import { useEffect, useState } from "react";
import { Bell, Bookmark, Rss, Trash2 } from "lucide-react";
import { useAuth, SignInGate } from "./auth";
import { queryVector } from "./semantic";
import { EMBEDDING_MODEL } from "../../packages/embeddings/config";
import type { SavedSearch, Notifications } from "../../packages/personal";
export type SearchToSave = {
  q: string;
  source: string;
  topic: string;
  author: string;
  kind: string;
  completeness: string;
  after: string;
  before: string;
  mode: "keyword" | "hybrid";
};
export function SaveSearch({ search }: { search: SearchToSave }) {
  const auth = useAuth(),
    [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const filters = Object.fromEntries(
    ["source", "topic", "author", "kind", "completeness", "after", "before"]
      .map((key) => [key, search[key as keyof SearchToSave]])
      .filter(([, value]) => !!value),
  );
  if (!search.q && !Object.keys(filters).length) return null;
  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      const mode = search.q ? search.mode : "keyword";
      let vector: number[] | undefined;
      if (mode === "hybrid") vector = await queryVector(search.q, setMessage);
      await auth.request("/searches", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim() || search.q || search.topic || "Research watch",
          queryText: search.q,
          filters,
          mode,
          ...(vector ? { vector, modelId: EMBEDDING_MODEL.id } : {}),
        }),
      });
      setMessage("Saved. Future matching additions will appear in Alerts.");
      setOpen(false);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="save-search">
      <button
        className="secondary-button"
        disabled={busy || (!auth.user && !auth.enabled)}
        onClick={() => {
          if (!auth.user) {
            auth.signIn().catch((e) => setMessage(e.message));
            return;
          }
          setName((search.q || search.topic || "Research watch").slice(0, 80));
          setOpen(!open);
        }}
      >
        <Bookmark size={14} />
        Save search & alert
      </button>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            aria-label="Saved search name"
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button className="primary-button" disabled={busy}>
            Save
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      )}
      {message && <span role="status">{message}</span>}
    </div>
  );
}
export function AlertCenter({
  onOpen,
  onSearch,
}: {
  onOpen: (id: string) => void;
  onSearch: (s: SavedSearch) => void;
}) {
  const auth = useAuth();
  return auth.user ? (
    <SignedAlerts key={auth.user.id} onOpen={onOpen} onSearch={onSearch} />
  ) : (
    <SignInGate purpose="saved searches and alerts" />
  );
}
function SignedAlerts({
  onOpen,
  onSearch,
}: {
  onOpen: (id: string) => void;
  onSearch: (s: SavedSearch) => void;
}) {
  const auth = useAuth(),
    [searches, setSearches] = useState<SavedSearch[]>([]),
    [notifications, setNotifications] = useState<Notifications | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [feedUrl, setFeedUrl] = useState(""),
    [page, setPage] = useState(1),
    [deleting, setDeleting] = useState("");
  const refresh = async () => {
    const [s, n] = await Promise.all([
      auth.request<SavedSearch[]>("/searches"),
      auth.request<Notifications>(`/notifications?page=${page}`),
    ]);
    setSearches(s);
    setNotifications(n);
  };
  useEffect(() => {
    refresh().catch((e) => setMessage(e.message));
  }, [page]);
  const change = async (p: unknown) => {
    setBusy(true);
    setMessage("");
    try {
      await auth.request("/mutate", {
        method: "POST",
        body: JSON.stringify(p),
      });
      await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const createFeed = async (searchId: string) => {
    setBusy(true);
    setMessage("");
    setFeedUrl("");
    try {
      const r = await auth.request<{ url: string }>("/feeds", {
        method: "POST",
        body: JSON.stringify({ searchId }),
      });
      setFeedUrl(r.url);
      await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="eyebrow">PERSONAL RESEARCH SIGNALS</div>
      <h1>Keep up with your interests.</h1>
      <p className="hero-description">
        Saved searches watch future additions. Historical imports and updates
        are opt-in.
      </p>
      {message && (
        <p className="personal-message" role="status">
          {message}
        </p>
      )}
      {feedUrl && (
        <div className="feed-capability">
          <h3>Your private RSS link</h3>
          <p>
            Anyone with this link can read this saved-search feed. It contains
            matching public reports, never your private notes. Copy it now; it
            is not shown again.
          </p>
          <input aria-label="Private RSS URL" readOnly value={feedUrl} />
          <button
            onClick={() =>
              navigator.clipboard
                .writeText(feedUrl)
                .then(() => setMessage("RSS link copied."))
                .catch(() =>
                  setMessage("Select and copy the RSS link manually."),
                )
            }
          >
            Copy link
          </button>
          <button onClick={() => setFeedUrl("")}>Dismiss</button>
        </div>
      )}
      <div className="section-heading">
        <h2>Saved searches</h2>
        <span>{searches.length} / 20</span>
      </div>
      <div className="saved-search-list">
        {searches.map((s) => (
          <article className="saved-search-card" key={s.id}>
            <div className="saved-search-heading">
              <button onClick={() => onSearch(s)}>{s.name}</button>
              <span>
                {s.mode === "hybrid"
                  ? "MEANING + KEYWORDS"
                  : "KEYWORDS / FILTERS"}
              </span>
            </div>
            <p>
              {s.queryText ||
                Object.entries(s.filters)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")}
            </p>
            <div className="alert-options">
              <label>
                <input
                  type="checkbox"
                  checked={s.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    change({
                      action: "search_toggle",
                      id: s.id,
                      enabled: e.target.checked,
                    })
                  }
                />
                Enabled
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={s.includeHistory}
                  disabled={busy}
                  onChange={(e) =>
                    change({
                      action: "search_options",
                      id: s.id,
                      includeHistory: e.target.checked,
                    })
                  }
                />
                Historical additions
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={s.includeUpdates}
                  disabled={busy}
                  onChange={(e) =>
                    change({
                      action: "search_options",
                      id: s.id,
                      includeUpdates: e.target.checked,
                    })
                  }
                />
                Updates
              </label>
              {s.mode === "hybrid" && (
                <label>
                  Matching
                  <select
                    value={s.threshold >= 0.6 ? "strict" : "broad"}
                    disabled={busy}
                    onChange={(e) =>
                      change({
                        action: "search_options",
                        id: s.id,
                        threshold: e.target.value === "strict" ? 0.6 : 0.45,
                      })
                    }
                  >
                    <option value="strict">Strict</option>
                    <option value="broad">Broad</option>
                  </select>
                </label>
              )}
            </div>
            <div className="saved-search-actions">
              <button disabled={busy} onClick={() => createFeed(s.id)}>
                <Rss size={13} />
                {s.feedEnabled ? "Rotate RSS link" : "Create RSS link"}
              </button>
              {s.feedEnabled && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setFeedUrl("");
                    void change({ action: "feed_revoke", searchId: s.id });
                  }}
                >
                  Revoke RSS link
                </button>
              )}
              {deleting === s.id ? (
                <>
                  <span>Delete this search and its alerts?</span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      change({ action: "search_delete", id: s.id }).then(() =>
                        setDeleting(""),
                      )
                    }
                  >
                    Confirm
                  </button>
                  <button onClick={() => setDeleting("")}>Cancel</button>
                </>
              ) : (
                <button onClick={() => setDeleting(s.id)}>
                  <Trash2 size={13} />
                  Delete
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!searches.length && (
        <div className="empty-state">
          <Bell />
          <h2>Start with a search worth following.</h2>
          <p>
            Search the archive, set your filters, and select Save search &
            alert. Topic and author follows work the same way.
          </p>
        </div>
      )}
      <div className="section-heading notification-heading">
        <h2>Notifications</h2>
        <span>{notifications?.unread || 0} UNREAD</span>
      </div>
      <div className="notification-list">
        {notifications?.items.map((n) => (
          <article key={n.id} className={n.read_at ? "" : "unread"}>
            <small>
              {n.search_name} ·{" "}
              {n.kind === "updated" ? "UPDATED" : "NEW ADDITION"} ·{" "}
              {new Date(n.created_at).toLocaleDateString()}
            </small>
            <button
              disabled={!n.title}
              onClick={() => {
                void change({
                  action: "notification_read",
                  id: n.id,
                  read: true,
                });
                onOpen(n.document_id);
              }}
            >
              {n.title || "This document is no longer available"}
            </button>
            <p>{n.reason}</p>
            <button
              className="notification-mark"
              disabled={busy}
              onClick={() =>
                change({
                  action: "notification_read",
                  id: n.id,
                  read: !n.read_at,
                })
              }
            >
              {n.read_at ? "Mark unread" : "Mark read"}
            </button>
          </article>
        ))}
      </div>
      {notifications && !notifications.items.length && (
        <p className="semantic-note">
          No notifications yet. Alerts evaluate new publications after your
          search was saved.
        </p>
      )}
      <div className="pagination">
        <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span>Page {page}</span>
        <button
          disabled={!notifications || notifications.items.length < 50}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </>
  );
}
