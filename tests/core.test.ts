import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { openLocal } from "../packages/local";
import { Repository } from "../packages/repository";
import {
  documentSchema,
  searchSchema,
  type InputDocument,
} from "../packages/contracts";
import { ingestDocument } from "../ingestion/pipeline";
import { prepare } from "../ingestion/normalize";
import { expandQuery } from "../packages/taxonomy";
import { createApp } from "../apps/api/app";
import { readFile } from "node:fs/promises";
let local: Awaited<ReturnType<typeof openLocal>>;
let repo: Repository;
const objects = new Map<string, string>();
const write = async (p: string, b: string) => {
  if (!objects.has(p)) objects.set(p, b);
};
function doc(name: string, patch: Partial<InputDocument> = {}): InputDocument {
  return {
    sourceId: "fixtures",
    sourceName: "Test fixtures",
    sourceUrl: "https://example.org/",
    externalId: name,
    canonicalUrl: `https://example.org/${name}`,
    title: name,
    kind: "report",
    platform: "Test",
    authors: ["Test author"],
    topics: [],
    programs: [],
    excerpt: "",
    markdown:
      "A complete example report with sufficient text to test preservation, indexing, and content availability after the original page disappears.",
    publishedAt: "2024-01-01T00:00:00.000Z",
    completeness: "full",
    license: "CC0-1.0",
    licenseUrl: null,
    attribution: "Synthetic test fixture",
    rightsEvidence: "https://example.org/license",
    canArchive: true,
    ...patch,
  };
}
beforeAll(async () => {
  local = await openLocal(true);
  repo = new Repository(local.rpc, async (p) => {
    const value = objects.get(p);
    if (!value) throw new Error("not found");
    return value;
  });
});
afterAll(async () => {
  await local?.db.close();
});
const search = (q: string, patch: Record<string, unknown> = {}) =>
  repo.search(searchSchema.parse({ q, ...patch }));
describe("archive and production SQL search", () => {
  it("indexes full text and equivalent XSS terminology across sources", async () => {
    await ingestDocument(
      local.rpc,
      write,
      doc("Cross origin issue", {
        markdown:
          "An attacker caused cross-site scripting through an unsanitized display name. The vulnerable output was present in the user profile and could execute in another user session.",
        kind: "article",
      }),
    );
    await ingestDocument(
      local.rpc,
      write,
      doc("Metadata topic", {
        topics: ["XSS"],
        markdown: "",
        completeness: "metadata",
        canArchive: false,
      }),
    );
    const xss = await search("XSS");
    expect(xss.total).toBe(1);
    expect(
      (await search("cross-site scripting")).items.map((d) => d.id),
    ).toEqual(xss.items.map((d) => d.id));
    expect(
      xss.items.some((d) =>
        d.snippet.replace(/[⟦⟧]/g, "").includes("cross-site scripting"),
      ),
    ).toBe(true);
  });
  it("finds concepts split across different chunks", async () => {
    await ingestDocument(
      local.rpc,
      write,
      doc("Split sections", {
        markdown: `OAuth authorization was used. ${"unrelated content ".repeat(400)}The final impact was account takeover after a redirect validation error.`,
      }),
    );
    expect((await search("OAuth account takeover")).total).toBe(1);
  });
  it("does not expand XSS into unrelated injections", async () => {
    await ingestDocument(
      local.rpc,
      write,
      doc("SQLi", {
        markdown:
          "The database accepted user input in a SQL injection vulnerability. Parameterized queries were missing and the researcher reported access to application records.",
      }),
    );
    expect((await search("XSS")).items.some((x) => x.title === "SQLi")).toBe(
      false,
    );
  });
  it("is idempotent and ignores an unchanged upstream commit revision", async () => {
    const input = doc("Idempotent", { revision: "first" });
    const first = await ingestDocument(local.rpc, write, input);
    expect(
      (await ingestDocument(local.rpc, write, { ...input, revision: "second" }))
        .action,
    ).toBe("unchanged");
    const d = await repo.detail(first.id);
    expect(d?.revision_count).toBe(1);
    expect(d?.markdown).toBe(input.markdown);
  });
  it("retains history while replacing searchable current text", async () => {
    const first = await ingestDocument(
      local.rpc,
      write,
      doc("Versioned", {
        markdown:
          "Historicaltoken was present in this sufficiently long original report. Its content should be preserved in the immutable historical object.",
      }),
    );
    await ingestDocument(
      local.rpc,
      write,
      doc("Versioned", {
        markdown:
          "Currenttoken is now present in the revised document. The current search index must no longer return the previous historical keyword.",
      }),
    );
    expect((await repo.detail(first.id))?.revision_count).toBe(2);
    expect((await search("Historicaltoken")).total).toBe(0);
    expect((await search("Currenttoken")).total).toBe(1);
  });
  it("does not erase a complete archive when extraction returns metadata", async () => {
    const first = await ingestDocument(local.rpc, write, doc("Protected full"));
    expect(
      (
        await ingestDocument(
          local.rpc,
          write,
          doc("Protected full", {
            markdown: "",
            completeness: "metadata",
            canArchive: false,
          }),
        )
      ).action,
    ).toBe("preserved");
    expect((await repo.detail(first.id))?.completeness).toBe("full");
  });
  it("publishes nothing if archive storage fails", async () => {
    await expect(
      ingestDocument(
        local.rpc,
        async () => {
          throw new Error("storage failure");
        },
        doc("Storagefailtoken"),
      ),
    ).rejects.toThrow("storage failure");
    expect((await search("Storagefailtoken")).total).toBe(0);
  });
  it("enforces filters without losing the total or duplicating pagination", async () => {
    for (let i = 0; i < 27; i++)
      await ingestDocument(local.rpc, write, doc(`Paginationtoken ${i}`));
    const first = await search("Paginationtoken", { page: 1, limit: 20 }),
      second = await search("Paginationtoken", { page: 2, limit: 20 });
    expect(first.total).toBe(27);
    expect(second.items.length).toBe(7);
    expect(
      new Set([...first.items, ...second.items].map((x) => x.id)).size,
    ).toBe(27);
    expect((await search("XSS", { completeness: "full" })).total).toBe(1);
    expect((await search("XSS", { kind: "article" })).total).toBe(1);
    expect((await search("XSS", { after: "2025-01-01" })).total).toBe(0);
  });
  it("keeps withdrawn documents out of search and detail", async () => {
    const d = await ingestDocument(local.rpc, write, doc("Withdrawntoken"));
    await local.db.query(
      "update hs_documents set status='withdrawn' where id=$1",
      [d.id],
    );
    expect((await search("Withdrawntoken")).total).toBe(0);
    expect(await repo.detail(d.id)).toBeNull();
  });
  it("treats SQL metacharacters as search data", async () => {
    await search("xss'); drop table hs_documents; --");
    expect((await repo.stats()).total).toBeGreaterThan(1);
  });
  it("leases work once and postpones failed retries", async () => {
    const p = { sourceId: "fixture", externalId: "job1" };
    expect(await local.rpc("hs_job_claim", p)).toEqual({ claimed: true });
    expect(await local.rpc("hs_job_claim", p)).toEqual({ claimed: false });
    await local.rpc("hs_job_finish", { ...p, error: "HTTP 429" });
    expect(await local.rpc("hs_job_claim", p)).toEqual({ claimed: false });
  });
  it("validates API query limits and unknown routes", async () => {
    const app = createApp(repo);
    expect((await app.request("/api/search?limit=99999")).status).toBe(400);
    expect((await app.request("/api/items/not-a-uuid")).status).toBe(404);
    expect(
      (await app.request("/api/admin/refresh", { method: "POST" })).status,
    ).toBe(404);
    const response = await app.request("/api/search?q=XSS");
    expect(response.status).toBe(200);
    expect((await response.json()).expanded).toContain("XSS");
  });
  it("revokes direct public access to database tables and functions", async () => {
    await local.db.exec(
      await readFile("supabase/migrations/002_permissions.sql", "utf8"),
    );
    const privileges = await local.db.query<{
      table_access: boolean;
      function_access: boolean;
    }>(
      "select has_table_privilege('anon','hs_documents','select') as table_access,has_function_privilege('anon','hs_search(jsonb)','execute') as function_access",
    );
    expect(privileges.rows[0]).toEqual({
      table_access: false,
      function_access: false,
    });
  });
});
describe("input constraints", () => {
  it("rejects bodies with unknown archival permission and empty full text", () => {
    expect(() =>
      documentSchema.parse(doc("bad", { canArchive: false })),
    ).toThrow();
    expect(() => documentSchema.parse(doc("bad", { markdown: "" }))).toThrow();
    expect(() =>
      documentSchema.parse(doc("bad", { canonicalUrl: "javascript:alert(1)" })),
    ).toThrow();
  });
  it("retains only bounded synonyms and does not alias OAuth to OIDC", () => {
    expect(expandQuery("OAuth").groups.flat()).not.toContain("oidc");
    expect(expandQuery("xss").groups.flat()).toContain("cross site scripting");
    expect(
      prepare(
        doc("normalize", {
          canonicalUrl: "https://example.org/report?utm_source=x&id=9#part",
        }),
      ).canonicalUrl,
    ).toBe("https://example.org/report?id=9");
  });
});
