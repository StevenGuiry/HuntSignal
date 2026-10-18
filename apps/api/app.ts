import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { searchSchema } from "../../packages/contracts";
import { Repository } from "../../packages/repository";
import { taxonomy } from "../../packages/taxonomy";
import { personalApi, type AccountBackend } from "./personal";
import { feedsApi } from "./feeds";
export function createApp(
  repository: Repository,
  mode = "local",
  accounts?: AccountBackend,
) {
  const app = new Hono();
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) =>
        c.json(
          { error: { code: "TOO_LARGE", message: "Request is too large." } },
          413,
        ),
    }),
  );
  app.use(
    "/api/*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    }),
  );
  app.onError((error, c) => {
    console.error("api_error", error.name);
    return c.json(
      {
        error: {
          code: "UNAVAILABLE",
          message: "The archive is temporarily unavailable.",
          retryable: true,
        },
      },
      503,
    );
  });
  app.get("/api/health", (c) =>
    c.json({ status: "ok", mode, version: "0.5.1", search: "hybrid-capable" }),
  );
  app.get("/api/auth/config", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!accounts) return c.json({ enabled: false });
    try {
      const status = await repository.rpc<{ schemaVersion: number }>(
        "hs_phase3_status",
      );
      if (status.schemaVersion < 6 || !status.schemaVersion)
        return c.json({ enabled: false });
    } catch {
      return c.json({ enabled: false });
    }
    return c.json({
      enabled: true,
      url: accounts.url,
      publishableKey: accounts.publishableKey,
    });
  });
  app.route("/api/me", personalApi(accounts));
  app.route("/feeds", feedsApi(repository));
  app.get("/api/operations/health", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await repository.rpc("hs_ops_health"));
  });
  app.get("/api/items/:id/revisions", async (c) => {
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(c.req.param("id")))
      return c.json({ error: { message: "Invalid document" } }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(
      await repository.rpc("hs_ops_revisions", { id: c.req.param("id") }),
    );
  });
  app.get("/api/stats", async (c) => c.json(await repository.stats()));
  app.get("/api/search", async (c) => {
    const parsed = searchSchema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: "INVALID_QUERY",
            message: "Check the query and filter values.",
            retryable: false,
          },
        },
        400,
      );
    return c.json(await repository.search(parsed.data));
  });
  app.post("/api/search", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = searchSchema.safeParse(body);
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: "INVALID_QUERY",
            message: "Check the query, filters, and embedding model.",
            retryable: false,
          },
        },
        400,
      );
    return c.json(await repository.search(parsed.data));
  });
  app.get("/api/search/status", async (c) => {
    try {
      return c.json(await repository.rpc("hs_phase2_status"));
    } catch {
      return c.json({
        phase: 1,
        indexed_documents: 0,
        warning: "Phase 2 database migration is pending.",
      });
    }
  });
  app.get("/api/topics", async (c) => {
    const topics = await Promise.all(
      taxonomy.map(async (t) => {
        const summary = await repository.rpc<{ total: number }>(
          "hs_topic_summary",
          { topic: t.label },
        );
        return {
          id: t.id,
          label: t.label,
          aliases: [...t.aliases] as string[],
          related: [...t.related] as string[],
          count: summary.total,
        };
      }),
    );
    c.header("Cache-Control", "public, max-age=60");
    return c.json(topics);
  });
  app.get("/api/topics/:id", async (c) => {
    const topic = taxonomy.find((t) => t.id === c.req.param("id"));
    if (!topic)
      return c.json(
        { error: { code: "NOT_FOUND", message: "Topic not found." } },
        404,
      );
    const summary = await repository.rpc<{
      total: number;
      reports: number;
      research: number;
      full: number;
    }>("hs_topic_summary", { topic: topic.label });
    return c.json({
      id: topic.id,
      label: topic.label,
      aliases: [...topic.aliases] as string[],
      related: [...topic.related] as string[],
      summary,
    });
  });
  app.get("/api/duplicates", async (c) =>
    c.json(await repository.rpc("hs_duplicate_candidates")),
  );
  app.get("/api/items/:id/related", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return c.json(
        { error: { code: "NOT_FOUND", message: "Document not found." } },
        404,
      );
    return c.json(await repository.rpc("hs_related", { id }));
  });
  app.get("/api/items/:id", async (c) => {
    const id = c.req.param("id");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      return c.json(
        { error: { code: "NOT_FOUND", message: "Document not found." } },
        404,
      );
    const d = await repository.detail(id);
    return d
      ? c.json(d)
      : c.json(
          { error: { code: "NOT_FOUND", message: "Document not found." } },
          404,
        );
  });
  app.get("/api/sources", async (c) =>
    c.json(await repository.rpc("hs_sources_list")),
  );
  app.get("/api/runs", async (c) =>
    c.json(await repository.rpc("hs_runs_list")),
  );
  app.notFound((c) =>
    c.json(
      { error: { code: "NOT_FOUND", message: "Endpoint not found." } },
      404,
    ),
  );
  return app;
}
