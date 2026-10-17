import { createApp } from "./app";
import { Repository, supabaseRpc } from "../../packages/repository";
import { readSupabaseObject } from "../../packages/supabase";
import { accountBackend } from "./personal";
import { processAlerts } from "../../packages/alerts";
type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  ARCHIVE_BUCKET: string;
  PUBLIC_LIMITER?: {
    limit: (p: { key: string }) => Promise<{ success: boolean }>;
  };
  PERSONAL_LIMITER?: {
    limit: (p: { key: string }) => Promise<{ success: boolean }>;
  };
  ASSETS: { fetch: (r: Request) => Promise<Response> };
};
export default {
  async fetch(
    request: Request,
    env: Env,
    execution?: { waitUntil: (promise: Promise<unknown>) => void },
  ) {
    if (!/^\/(api|feeds)\//.test(new URL(request.url).pathname))
      return env.ASSETS.fetch(request);
    if (env.PUBLIC_LIMITER) {
      const key = request.headers.get("CF-Connecting-IP") || "unknown";
      const limited = await env.PUBLIC_LIMITER.limit({ key });
      if (!limited.success)
        return Response.json(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests. Try again in a minute.",
            },
          },
          {
            status: 429,
            headers: { "Retry-After": "60", "Cache-Control": "no-store" },
          },
        );
    }
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)
      return Response.json(
        {
          error: {
            code: "NOT_CONFIGURED",
            message:
              "The production archive connection has not been configured.",
          },
        },
        { status: 503 },
      );
    const cacheable =
      request.method === "GET" &&
      !request.headers.has("Authorization") &&
      ["/api/stats", "/api/topics"].includes(new URL(request.url).pathname);
    const cache = cacheable
      ? (globalThis.caches as (CacheStorage & { default?: Cache }) | undefined)
          ?.default
      : undefined;
    if (cache) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    const repository = new Repository(
      supabaseRpc(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
      (path) =>
        readSupabaseObject(
          env.SUPABASE_URL,
          env.SUPABASE_SERVICE_ROLE_KEY,
          env.ARCHIVE_BUCKET || "archive",
          path,
        ),
    );
    const accounts = accountBackend(
      env.SUPABASE_URL,
      env.SUPABASE_PUBLISHABLE_KEY,
      env.SUPABASE_SERVICE_ROLE_KEY,
    );
    if (accounts && env.PERSONAL_LIMITER)
      accounts.limit = async (id) =>
        (await env.PERSONAL_LIMITER!.limit({ key: id })).success;
    const response = await createApp(repository, "supabase", accounts).fetch(
      request,
    );
    if (cacheable && response.ok) {
      response.headers.set("Cache-Control", "public, max-age=60");
      if (cache) {
        const saved = cache.put(request, response.clone()).catch(() => {});
        if (execution) execution.waitUntil(saved);
        else await saved;
      }
    }
    return response;
  },
  async scheduled(_event: unknown, env: Env) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
    const rpc = supabaseRpc(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    const results = await Promise.allSettled([
      processAlerts(rpc, 4),
      rpc<{ sources: { status: string }[] }>("hs_ops_housekeeping"),
    ]);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected")
        console.error(i ? "watchdog_failed" : "alert_run_failed");
      else if (i === 0) console.log("alert_run", r.value);
      else console.log("watchdog", { checked: true });
    }
  },
};
