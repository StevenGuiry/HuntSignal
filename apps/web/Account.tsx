import { useState } from "react";
import { Download, LogOut } from "lucide-react";
import { useAuth, SignInGate } from "./auth";
export function Account() {
  const auth = useAuth();
  return auth.user ? (
    <SignedAccount key={auth.user.id} />
  ) : (
    <SignInGate purpose="account settings and exports" />
  );
}
function SignedAccount() {
  const auth = useAuth(),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const exportData = async () => {
    setBusy(true);
    try {
      const data = await auth.request("/export");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `huntsignal-library-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Your library export is ready.");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setMessage("");
    try {
      await auth.request("/account", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: confirm }),
      });
      await auth.signOut();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="eyebrow">YOUR ACCOUNT</div>
      <h1>{auth.user?.name}</h1>
      <p className="hero-description">
        Your library belongs to you. Export it at any time.
      </p>
      <div className="account-actions">
        <button className="primary-button" disabled={busy} onClick={exportData}>
          <Download size={15} />
          Export my library
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => auth.signOut().catch((e) => setMessage(e.message))}
        >
          <LogOut size={15} />
          Sign out on this device
        </button>
      </div>
      <p className="semantic-note">
        Exports include your bookmarks, collections, notes, reading state, saved
        searches and notifications. RSS bearer links and authentication tokens
        are excluded.
      </p>
      <section className="delete-account">
        <h2>Delete your account</h2>
        <p>
          This permanently removes your HuntSignal identity, bookmarks,
          collections, notes, searches and alerts, and revokes your RSS links.
          Public archive documents remain available.
        </p>
        <label>
          Type DELETE to confirm
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            aria-label="Confirm account deletion"
          />
        </label>
        <button
          className="danger-button"
          disabled={busy || confirm !== "DELETE"}
          onClick={remove}
        >
          Permanently delete my account
        </button>
      </section>
      {message && (
        <p className="personal-message" role="status">
          {message}
        </p>
      )}
    </>
  );
}
