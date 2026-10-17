import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
type Identity = { id: string; name: string };
type AuthContextValue = {
  user: Identity | null;
  ready: boolean;
  enabled: boolean;
  error: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};
const AuthContext = createContext<AuthContextValue | null>(null);
let boot:
  Promise<{ client: SupabaseClient | null; user: User | null }> | undefined;
const storageKey = "huntsignal-auth-v1";
const storage = {
  getItem: (key: string) => localStorage.getItem(key),
  removeItem: (key: string) => localStorage.removeItem(key),
  setItem: (key: string, value: string) => {
    let safe = value;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        delete parsed.provider_token;
        delete parsed.provider_refresh_token;
        safe = JSON.stringify(parsed);
      }
    } catch {}
    localStorage.setItem(key, safe);
  },
};
export function safeReturnPath(value: string | null, origin: string) {
  try {
    const url = new URL(value || "/?view=library", origin);
    return url.origin === origin && !url.pathname.startsWith("/auth/")
      ? url.pathname + url.search
      : "/?view=library";
  } catch {
    return "/?view=library";
  }
}
function initialize() {
  return (boot ??= (async () => {
    const response = await fetch("/api/auth/config");
    if (!response.ok) throw new Error("Sign-in is temporarily unavailable.");
    const config = (await response.json()) as {
      enabled: boolean;
      url?: string;
      publishableKey?: string;
    };
    if (!config.enabled || !config.url || !config.publishableKey)
      return { client: null, user: null };
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(config.url, config.publishableKey, {
      auth: {
        flowType: "pkce",
        detectSessionInUrl: false,
        persistSession: true,
        autoRefreshToken: true,
        storageKey,
        storage,
      },
    });
    if (location.pathname === "/auth/callback") {
      const params = new URLSearchParams(location.search);
      const code = params.get("code");
      const target = safeReturnPath(
        sessionStorage.getItem("hs.auth.returnTo"),
        location.origin,
      );
      sessionStorage.removeItem("hs.auth.returnTo");
      history.replaceState(null, "", target);
      if (params.has("error") || !code)
        throw new Error("GitHub sign-in was cancelled or could not complete.");
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error)
        throw new Error(
          "Sign-in could not complete. Please start again from this browser.",
        );
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
    const { data } = await client.auth.getSession();
    return { client, user: data.session?.user || null };
  })());
}
const identity = (user: User | null): Identity | null =>
  user
    ? {
        id: user.id,
        name: String(
          user.user_metadata.user_name ||
            user.user_metadata.full_name ||
            "Researcher",
        ),
      }
    : null;
export function AuthProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SupabaseClient | null>(null),
    [user, setUser] = useState<Identity | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: undefined | (() => void);
    initialize()
      .then((result) => {
        if (cancelled) return;
        setClient(result.client);
        setUser(identity(result.user));
        if (result.client) {
          const { data } = result.client.auth.onAuthStateChange(
            (_event, session) => setUser(identity(session?.user || null)),
          );
          unsubscribe = () => data.subscription.unsubscribe();
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Sign-in could not initialize. Reload to try again.");
          setReady(true);
        }
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      ready,
      enabled: !!client,
      error,
      async signIn() {
        if (!client) throw new Error("Accounts are being configured.");
        sessionStorage.setItem(
          "hs.auth.returnTo",
          location.pathname + location.search,
        );
        const { error } = await client.auth.signInWithOAuth({
          provider: "github",
          options: {
            redirectTo: location.origin + "/auth/callback",
            scopes: "read:user user:email",
          },
        });
        if (error) throw new Error("GitHub sign-in could not start.");
      },
      async signOut() {
        if (client) {
          const { error } = await client.auth.signOut({ scope: "local" });
          if (error)
            throw new Error("Sign-out could not complete. Please try again.");
        }
        setUser(null);
      },
      async request<T>(path: string, init: RequestInit = {}) {
        if (!client) throw new Error("Sign in to continue.");
        const { data } = await client.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error("Sign in to continue.");
        const response = await fetch("/api/me" + path, {
          ...init,
          cache: "no-store",
          headers: {
            ...init.headers,
            Authorization: `Bearer ${token}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error?.message || "The library request failed.");
        }
        return response.json() as Promise<T>;
      },
    }),
    [client, user, ready, error],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("AuthProvider missing");
  return context;
}
export function SignInGate({
  purpose = "your private research library",
}: {
  purpose?: string;
}) {
  const auth = useAuth(),
    [error, setError] = useState("");
  return (
    <div className="signin-gate">
      <span className="eyebrow">YOUR RESEARCH, ORGANIZED</span>
      <h2>Keep what matters.</h2>
      <p>
        Sign in with GitHub to use {purpose}. Bookmarks, notes, collections and
        saved searches stay private.
      </p>
      <button
        className="primary-button"
        disabled={!auth.ready || !auth.enabled}
        onClick={() => auth.signIn().catch((e) => setError(e.message))}
      >
        {!auth.ready
          ? "Checking sign-in…"
          : auth.enabled
            ? "Continue with GitHub"
            : "Sign-in is being configured"}
      </button>
      {(error || auth.error) && <p role="alert">{error || auth.error}</p>}
    </div>
  );
}
