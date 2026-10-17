import { Hono } from "hono";
import type { Repository } from "../../packages/repository";
import { searchSchema } from "../../packages/contracts";
import { taxonomy } from "../../packages/taxonomy";
import { tokenHash } from "./personal";
export const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
type FeedItem = {
  id: string;
  title: string;
  canonical_url: string;
  created_at?: string;
  published_at?: string | null;
  excerpt?: string;
};
export function rssXml(title: string, link: string, items: FeedItem[]) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(title)}</title><link>${xml(link)}</link><description>Public research matched by HuntSignal</description>${items.map((i) => `<item><guid isPermaLink="false">${xml(i.id)}</guid><title>${xml(i.title)}</title><link>${xml(i.canonical_url)}</link>${i.created_at || i.published_at ? `<pubDate>${new Date(i.created_at || i.published_at!).toUTCString()}</pubDate>` : ""}<description>${xml(i.excerpt || "")}</description></item>`).join("")}</channel></rss>`;
}
export function feedsApi(repository: Repository) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Content-Type", "application/rss+xml; charset=utf-8");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/saved/:token", async (c) => {
    const token = c.req.param("token").replace(/\.xml$/, "");
    if (!/^[a-f0-9]{64}$/.test(token)) return c.body("Feed not found", 404);
    const feed = await repository.rpc<{
      name: string;
      items: FeedItem[];
    } | null>("hs_feed_resolve", { tokenHash: await tokenHash(token) });
    if (!feed) return c.body("Feed not found", 404);
    return c.body(rssXml(feed.name, new URL(c.req.url).origin, feed.items));
  });
  app.get("/topics/:slug", async (c) => {
    const topic = taxonomy.find(
      (t) => t.id === c.req.param("slug").replace(/\.xml$/, ""),
    );
    if (!topic) return c.body("Feed not found", 404);
    const result = await repository.search(
      searchSchema.parse({ topic: topic.label, sort: "newest", limit: 50 }),
    );
    c.header("Cache-Control", "public,max-age=60");
    return c.body(
      rssXml(
        `${topic.label} research`,
        new URL(c.req.url).origin,
        result.items,
      ),
    );
  });
  return app;
}
