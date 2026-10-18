import { Hono } from "hono";
import { z } from "zod";
import type { Rpc } from "../../packages/repository";
import { RpcError } from "../../packages/repository";
import { backendHeaders } from "../../packages/supabase";
import { libraryMutation, savedSearchInput } from "../../packages/personal";
import { expandQuery, expandNaturalQuery } from "../../packages/taxonomy";
import { submissionInput } from "../../packages/submissions";
export type AuthUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};
export type AccountBackend = {
  url: string;
  publishableKey: string;
  verify: (token: string) => Promise<AuthUser | null>;
  rpc: (token: string) => Rpc;
  deleteAccount: (id: string) => Promise<void>;
  limit?: (id: string) => Promise<boolean>;
};
export function safePublishableKey(
  key: string | undefined,
  backendKey?: string,
) {
  if (!key || key === backendKey || key.startsWith("sb_secret_")) return false;
  if (key.startsWith("sb_publishable_")) return true;
  try {
    return (
      JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))
        .role === "anon"
    );
  } catch {
    return false;
  }
}
export function accountBackend(
  url: string,
  key: string | undefined,
  serverKey: string,
): AccountBackend | undefined {
  if (!safePublishableKey(key, serverKey)) return undefined;
  const publishableKey = key!;
  return {
    url,
    publishableKey,
    async verify(token) {
      const response = await fetch(`${url}/auth/v1/user`, {
        headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) throw new Error("Auth unavailable");
      const user = (await response.json()) as AuthUser & {
        is_anonymous?: boolean;
      };
      return z.string().uuid().safeParse(user.id).success && !user.is_anonymous
        ? user
        : null;
    },
    rpc:
      (token) =>
      async <T>(name: string, p: unknown = {}) => {
        if (!/^hs_me_[a-z_]+$/.test(name))
          throw new Error("Invalid personal operation");
        const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: {
            apikey: publishableKey,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new RpcError(name, response.status);
        return response.json() as Promise<T>;
      },
    async deleteAccount(id) {
      if (!z.string().uuid().safeParse(id).success)
        throw new Error("Invalid user");
      const response = await fetch(`${url}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: backendHeaders(serverKey),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Account deletion failed");
    },
  };
}
export async function tokenHash(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export function personalApi(backend: AccountBackend | undefined) {
  const app = new Hono<{ Variables: { user: AuthUser; userRpc: Rpc } }>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Vary", "Authorization");
    c.header("Referrer-Policy", "no-referrer");
    if (!backend)
      return c.json(
        {
          error: {
            code: "ACCOUNTS_UNAVAILABLE",
            message: "Accounts are being configured.",
          },
        },
        503,
      );
    const authorization = c.req.header("Authorization") || "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 12000)
      return c.json(
        {
          error: {
            code: "SIGN_IN_REQUIRED",
            message: "Sign in to use your research library.",
          },
        },
        401,
      );
    const token = authorization.slice(7);
    const user = await backend.verify(token);
    if (!user)
      return c.json(
        {
          error: {
            code: "SIGN_IN_REQUIRED",
            message: "Your session has expired. Please sign in again.",
          },
        },
        401,
      );
    if (backend.limit && !(await backend.limit(user.id))) {
      c.header("Retry-After", "60");
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests. Try again in a minute.",
          },
        },
        429,
      );
    }
    if (!["GET", "HEAD"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      if (origin && origin !== new URL(c.req.url).origin)
        return c.json(
          {
            error: {
              code: "ORIGIN_REJECTED",
              message: "Request origin is not allowed.",
            },
          },
          403,
        );
    }
    c.set("user", user);
    c.set("userRpc", backend.rpc(token));
    await next();
  });
  app.onError((error, c) => {
    const status =
      error instanceof RpcError &&
      [400, 401, 403, 404, 409].includes(error.status)
        ? error.status
        : 503;
    return c.json(
      {
        error: {
          code: "PERSONAL_REQUEST_FAILED",
          message:
            status === 503
              ? "Your library is temporarily unavailable."
              : "The change was not accepted. Check ownership, limits, and values.",
        },
      },
      status as 400 | 401 | 403 | 404 | 409 | 503,
    );
  });
  app.get("/profile", (c) =>
    c.json({
      id: c.get("user").id,
      name: String(
        c.get("user").user_metadata?.user_name ||
          c.get("user").user_metadata?.full_name ||
          "Researcher",
      ),
    }),
  );
  app.get("/operations/status", async (c) => {
    try {
      return c.json(await c.get("userRpc")("hs_me_ops_status"));
    } catch {
      return c.json({ admin: false });
    }
  });
  app.get("/operations", async (c) =>
    c.json(await c.get("userRpc")("hs_me_ops")),
  );
  app.get("/operations/submissions", async (c) =>
    c.json(await c.get("userRpc")("hs_me_submissions")),
  );
  app.post("/operations/submissions", async (c) => {
    const parsed = submissionInput.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          error: {
            message:
              parsed.error.issues[0]?.message || "Invalid source submission.",
          },
        },
        400,
      );
    return c.json(await c.get("userRpc")("hs_me_submission", parsed.data));
  });
  app.post("/operations", async (c) => {
    const id = z.string().min(1).max(120),
      reason = z.string().trim().min(5).max(500);
    const schema = z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("source_enabled"),
          sourceId: id,
          enabled: z.boolean(),
        })
        .strict(),
      z.object({ action: z.literal("source_refresh"), sourceId: id }).strict(),
      z
        .object({
          action: z.literal("retry_job"),
          sourceId: id,
          externalId: z.string().min(1).max(2048),
        })
        .strict(),
      z
        .object({
          action: z.literal("resolve_review"),
          id: z.string().uuid(),
          reason,
        })
        .strict(),
      z
        .object({
          action: z.literal("withdraw"),
          documentId: z.string().uuid(),
          reason,
        })
        .strict(),
    ]);
    const p = schema.safeParse(await c.req.json().catch(() => null));
    if (!p.success)
      return c.json({ error: { message: "Invalid admin operation." } }, 400);
    return c.json(await c.get("userRpc")("hs_me_ops_mutate", p.data));
  });
  app.get("/library", async (c) => {
    const parsed = z
      .object({
        tab: z
          .enum(["all", "bookmarks", "notes", "read", "unread"])
          .default("bookmarks"),
        collectionId: z.string().uuid().optional(),
        page: z.coerce.number().int().min(1).max(1000).default(1),
      })
      .safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: { message: "Invalid library filter." } }, 400);
    return c.json(await c.get("userRpc")("hs_me_library", parsed.data));
  });
  app.get("/documents/:id", async (c) => {
    const id = z.string().uuid().safeParse(c.req.param("id"));
    if (!id.success)
      return c.json({ error: { message: "Invalid document." } }, 400);
    return c.json(await c.get("userRpc")("hs_me_document", { id: id.data }));
  });
  app.post("/annotations", async (c) => {
    const parsed = z
      .object({ ids: z.array(z.string().uuid()).max(50) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: { message: "Invalid document list." } }, 400);
    return c.json(await c.get("userRpc")("hs_me_annotations", parsed.data));
  });
  app.post("/mutate", async (c) => {
    const parsed = libraryMutation.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: { message: "Invalid library change." } }, 400);
    return c.json(await c.get("userRpc")("hs_me_mutate", parsed.data));
  });
  app.get("/searches", async (c) =>
    c.json(await c.get("userRpc")("hs_me_searches")),
  );
  app.post("/searches", async (c) => {
    const parsed = savedSearchInput.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        { error: { message: "Provide a name and valid search or filters." } },
        400,
      );
    const query = parsed.data;
    const { groups } =
      query.mode === "hybrid"
        ? expandNaturalQuery(query.queryText)
        : expandQuery(query.queryText);
    return c.json(
      await c.get("userRpc")("hs_me_mutate", {
        ...query,
        action: "search_save",
        groups,
      }),
    );
  });
  app.get("/notifications", async (c) => {
    const p = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .safeParse(c.req.query("page") || 1);
    if (!p.success) return c.json({ error: { message: "Invalid page." } }, 400);
    return c.json(
      await c.get("userRpc")("hs_me_notifications", { page: p.data }),
    );
  });
  app.post("/feeds", async (c) => {
    const parsed = z
      .object({ searchId: z.string().uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: { message: "Invalid saved search." } }, 400);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    await c.get("userRpc")("hs_me_mutate", {
      action: "feed_rotate",
      searchId: parsed.data.searchId,
      tokenHash: await tokenHash(token),
    });
    return c.json({
      url: `${new URL(c.req.url).origin}/feeds/saved/${token}.xml`,
    });
  });
  app.get("/export", async (c) => {
    c.header(
      "Content-Disposition",
      `attachment; filename="huntsignal-library-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return c.json(await c.get("userRpc")("hs_me_export"));
  });
  app.delete("/account", async (c) => {
    const p = z
      .object({ confirmation: z.literal("DELETE") })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!p.success)
      return c.json(
        { error: { message: "Type DELETE to confirm account deletion." } },
        400,
      );
    await backend!.deleteAccount(c.get("user").id);
    return c.json({ deleted: true });
  });
  return app;
}
