import { useEffect, useState } from "react";
import { ArrowUpRight, Bookmark, Plus, Trash2 } from "lucide-react";
import { useAuth, SignInGate } from "./auth";
import type { LibraryResult } from "../../packages/personal";
export function ResearchLibrary({ onOpen }: { onOpen: (id: string) => void }) {
  const auth = useAuth();
  return auth.user ? (
    <SignedLibrary key={auth.user.id} onOpen={onOpen} />
  ) : (
    <SignInGate />
  );
}
function SignedLibrary({ onOpen }: { onOpen: (id: string) => void }) {
  const auth = useAuth(),
    [tab, setTab] = useState("bookmarks"),
    [collection, setCollection] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState<LibraryResult | null>(null),
    [name, setName] = useState(""),
    [rename, setRename] = useState<string | null>(null),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0),
    [busy, setBusy] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    const q = new URLSearchParams({ tab, page: String(page) });
    if (collection) q.set("collectionId", collection);
    auth
      .request<LibraryResult>(`/library?${q}`, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [tab, collection, page, version]);
  const mutate = async (p: unknown) => {
    setBusy(true);
    setError("");
    try {
      await auth.request("/mutate", {
        method: "POST",
        body: JSON.stringify(p),
      });
      setVersion((v) => v + 1);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="eyebrow">PRIVATE RESEARCH LIBRARY</div>
      <h1>Keep a thread going.</h1>
      <p className="hero-description">
        Your bookmarks, notes and reading progress. Visible only to your
        account.
      </p>
      <div className="library-controls">
        <div className="result-tabs">
          {[
            ["bookmarks", "Bookmarks"],
            ["unread", "Unread"],
            ["read", "Read"],
            ["notes", "Notes"],
            ["all", "Everything"],
          ].map(([id, label]) => (
            <button
              className={tab === id ? "selected" : ""}
              key={id}
              onClick={() => {
                setTab(id);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          aria-label="Private collection"
          value={collection}
          onChange={(e) => {
            setCollection(e.target.value);
            setTab("all");
            setPage(1);
            setConfirmDelete(false);
            setRename(null);
          }}
        >
          <option value="">All collections</option>
          {data?.collections.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name} ({c.count})
            </option>
          ))}
        </select>
      </div>
      <form
        className="collection-create"
        onSubmit={(e) => {
          e.preventDefault();
          mutate({ action: "collection_create", name }).then((ok) => {
            if (ok) setName("");
          });
        }}
      >
        <input
          aria-label="New collection name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
          placeholder="New collection name"
        />
        <button className="secondary-button" disabled={busy}>
          <Plus size={14} />
          Create collection
        </button>
      </form>
      {collection && (
        <div className="collection-manage">
          {rename !== null ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                mutate({
                  action: "collection_rename",
                  id: collection,
                  name: rename,
                }).then((ok) => {
                  if (ok) setRename(null);
                });
              }}
            >
              <input
                aria-label="Rename collection"
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                maxLength={80}
                required
              />
              <button disabled={busy}>Save name</button>
              <button type="button" onClick={() => setRename(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <button
              onClick={() =>
                setRename(
                  data?.collections.find((c) => c.id === collection)?.name ||
                    "",
                )
              }
            >
              Rename collection
            </button>
          )}
          {confirmDelete ? (
            <>
              <span>
                Delete this collection? Notes and bookmarks will remain.
              </span>
              <button
                disabled={busy}
                onClick={() =>
                  mutate({ action: "collection_delete", id: collection }).then(
                    (ok) => {
                      if (ok) {
                        setCollection("");
                        setConfirmDelete(false);
                      }
                    },
                  )
                }
              >
                Confirm deletion
              </button>
              <button onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} />
              Delete selected collection
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {data ? (
        <>
          <p className="result-summary">{data.total} items</p>
          <div className="library-list">
            {data.items.map((item) => (
              <article className="library-card" key={item.document_id}>
                <div>
                  <span className="eyebrow">
                    {item.platform || "UNAVAILABLE SOURCE"} ·{" "}
                    {item.read_at ? "READ" : "UNREAD"}
                  </span>
                  <button
                    className="library-title"
                    disabled={!item.title}
                    onClick={() => onOpen(item.document_id)}
                  >
                    {item.title || "Document is no longer publicly available"}
                  </button>
                  {item.note && <p className="note-preview">{item.note}</p>}
                  <div className="library-card-actions">
                    <button
                      disabled={busy || (!item.title && !item.bookmarked_at)}
                      onClick={() =>
                        mutate({
                          action: "bookmark",
                          documentId: item.document_id,
                          saved: !item.bookmarked_at,
                        })
                      }
                    >
                      <Bookmark size={13} />
                      {item.bookmarked_at ? "Remove bookmark" : "Bookmark"}
                    </button>
                    <button
                      disabled={busy || (!item.title && !item.read_at)}
                      onClick={() =>
                        mutate({
                          action: "reading",
                          documentId: item.document_id,
                          read: !item.read_at,
                        })
                      }
                    >
                      {item.read_at ? "Mark unread" : "Mark read"}
                    </button>
                    {item.canonical_url && (
                      <a
                        href={item.canonical_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Original
                        <ArrowUpRight size={13} />
                      </a>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
          {!data.items.length && (
            <div className="empty-state">
              <Bookmark />
              <h2>Start with something worth keeping.</h2>
              <p>
                Save documents from search results or add a private note in the
                reader.
              </p>
            </div>
          )}
          <div className="pagination">
            <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span>Page {page}</span>
            <button
              disabled={page * 50 >= data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      ) : (
        !error && <p>Loading your library…</p>
      )}
    </>
  );
}
