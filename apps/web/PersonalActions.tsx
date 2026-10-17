import { useEffect, useState } from "react";
import { Bookmark, Check, BookOpen } from "lucide-react";
import { useAuth, SignInGate } from "./auth";
import type { DocumentFlags, PersonalDocument } from "../../packages/personal";
export function CardPersonalActions({
  id,
  flags,
  onChange,
}: {
  id: string;
  flags?: DocumentFlags;
  onChange: (flags: DocumentFlags) => void;
}) {
  const auth = useAuth(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const toggle = async () => {
    setError("");
    if (!auth.user) {
      await auth.signIn();
      return;
    }
    setBusy(true);
    try {
      const saved = !flags?.saved;
      await auth.request("/mutate", {
        method: "POST",
        body: JSON.stringify({ action: "bookmark", documentId: id, saved }),
      });
      onChange({
        id,
        saved,
        read: flags?.read || false,
        hasNote: flags?.hasNote || false,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card-personal">
      <button
        disabled={busy || (!auth.user && !auth.enabled)}
        aria-label={flags?.saved ? "Remove bookmark" : "Bookmark document"}
        title={auth.user ? "Private bookmark" : "Sign in to bookmark"}
        className={flags?.saved ? "is-saved" : ""}
        onClick={() => toggle().catch((e) => setError(e.message))}
      >
        <Bookmark size={14} fill={flags?.saved ? "currentColor" : "none"} />
        {flags?.saved ? "Saved" : "Save"}
      </button>
      {flags?.read && (
        <span>
          <Check size={12} />
          Read
        </span>
      )}
      {flags?.hasNote && <span>Private note</span>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
export function ReaderPersonal({
  id,
  authors,
}: {
  id: string;
  authors: string[];
}) {
  const auth = useAuth();
  if (!auth.user)
    return <SignInGate purpose="bookmarks, private notes and reading status" />;
  return (
    <ReaderPersonalSigned
      key={`${auth.user.id}:${id}`}
      id={id}
      authors={authors}
    />
  );
}
function ReaderPersonalSigned({
  id,
  authors,
}: {
  id: string;
  authors: string[];
}) {
  const auth = useAuth(),
    [data, setData] = useState<PersonalDocument | null>(null),
    [note, setNote] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    const d = await auth.request<PersonalDocument>(`/documents/${id}`);
    setData(d);
    return d;
  };
  useEffect(() => {
    let live = true;
    auth
      .request<PersonalDocument>(`/documents/${id}`)
      .then((d) => {
        if (live) {
          setData(d);
          setNote(d.note);
        }
      })
      .catch((e) => {
        if (live) setMessage(e.message);
      });
    return () => {
      live = false;
    };
  }, [id, auth.user?.id]);
  const change = async (payload: unknown) => {
    setBusy(true);
    setMessage("");
    try {
      await auth.request("/mutate", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      await load();
      return true;
    } catch (e) {
      setMessage((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const follow = async (author: string) => {
    setBusy(true);
    try {
      await auth.request("/searches", {
        method: "POST",
        body: JSON.stringify({
          name: `Author: ${author}`.slice(0, 80),
          queryText: "",
          filters: { author },
          mode: "keyword",
        }),
      });
      setMessage(
        "Author followed. New matching additions will appear in Alerts.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="personal-panel">
      <div className="section-heading">
        <h2>
          <BookOpen size={17} /> Your reading workspace
        </h2>
        <span>PRIVATE</span>
      </div>
      {data ? (
        <>
          <div className="personal-toolbar">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                change({
                  action: "bookmark",
                  documentId: id,
                  saved: !data.saved,
                })
              }
            >
              <Bookmark size={14} />
              {data.saved ? "Remove bookmark" : "Bookmark"}
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                change({ action: "reading", documentId: id, read: !data.read })
              }
            >
              <Check size={14} />
              {data.read ? "Mark unread" : "Mark read"}
            </button>
            {authors[0] && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => follow(authors[0])}
              >
                Follow author
              </button>
            )}
          </div>
          <div className="collection-checks">
            {data.collections.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={c.contains}
                  disabled={busy}
                  onChange={(e) =>
                    change({
                      action: "collection_item",
                      collectionId: c.id,
                      documentId: id,
                      present: e.target.checked,
                    })
                  }
                />
                {c.name}
              </label>
            ))}
            {!data.collections.length && (
              <span>
                Create collections in My library to organize this document.
              </span>
            )}
          </div>
          <label className="private-note-label">
            Private note
            <textarea
              maxLength={5000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What is useful here? Capture a technique, an idea, or a follow-up."
              rows={5}
            />
          </label>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() =>
              change({ action: "note", documentId: id, body: note }).then(
                (ok) => {
                  if (ok) setMessage("Note saved.");
                },
              )
            }
          >
            Save private note
          </button>
        </>
      ) : (
        <p>Loading your reading workspace…</p>
      )}
      {message && (
        <p role="status" className="personal-message">
          {message}
        </p>
      )}
    </section>
  );
}
