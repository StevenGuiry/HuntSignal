import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { openLocal } from "../packages/local";
import {
  submissionInput,
  submissionUrl,
  type Submission,
} from "../packages/submissions";
import {
  extractSubmission,
  processSubmissions,
} from "../ingestion/submissions";
import { safeFetch } from "../ingestion/fetch";
import { prepare } from "../ingestion/normalize";
import { ingestDocument } from "../ingestion/pipeline";
import type { InputDocument } from "../packages/contracts";
vi.mock("../ingestion/fetch", async (original) => ({
  ...(await original<typeof import("../ingestion/fetch")>()),
  safeFetch: vi.fn(),
}));
const admin = "80000000-0000-4000-8000-000000000008",
  other = "90000000-0000-4000-8000-000000000009";
let local: Awaited<ReturnType<typeof openLocal>>;
const objects = new Map<string, string>(),
  write = async (path: string, body: string) => {
    objects.set(path, body);
  },
  read = async (path: string) => objects.get(path)!;
const fixture = (url: string): InputDocument => ({
  sourceId: "manual-submissions",
  sourceName: "Manually added public sources",
  sourceUrl: "https://github.com/StevenGuiry/HuntSignal",
  externalId: url,
  canonicalUrl: url,
  title: "Synthetic public write-up",
  kind: "article",
  platform: "Independent",
  authors: ["Synthetic researcher"],
  programs: [],
  topics: [],
  markdown:
    "## Reproduction\n\nA substantive synthetic disclosure with sufficient reproduction detail, prerequisites and impact to test the review-before-publication workflow. ".repeat(
      5,
    ),
  excerpt: "Synthetic public source",
  publishedAt: null,
  completeness: "full",
  license: "Original rights retained",
  licenseUrl: null,
  attribution: "Synthetic fixture",
  rightsEvidence: url,
  canArchive: true,
});
async function user<T = any>(id: string, name: string, p: unknown = {}) {
  return local.db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: id, role: "authenticated" }),
    ]);
    await tx.exec("set local role authenticated");
    return (
      await tx.query<{ data: T }>(`select ${name}($1::jsonb) as data`, [
        JSON.stringify(p),
      ])
    ).rows[0].data;
  });
}
beforeAll(async () => {
  local = await openLocal(true);
  await local.db.query("insert into auth.users(id) values($1),($2)", [
    admin,
    other,
  ]);
  await local.db.query("insert into hs_admins(owner_id) values($1)", [admin]);
}, 60000);
afterAll(async () => {
  await local?.db.close();
});
it("validates public URLs without accepting credentials, IP forms, alternate ports or injected payloads", () => {
  for (const url of [
    "http://example.org/article",
    "https://127.0.0.1/",
    "https://0x7f000001/",
    "https://[::1]/",
    "https://localhost/",
    "https://foo.internal/a",
    "https://name:pass@example.org/a",
    "https://example.org:8443/a",
    "https://example.org/?access_token=secret",
  ])
    expect(() => submissionUrl(url)).toThrow();
  expect(
    submissionUrl(
      "https://www.hackerone.com/reports/123/?utm_source=x#comment",
    ),
  ).toBe("https://hackerone.com/reports/123");
  expect(
    submissionInput.safeParse({
      action: "approve",
      id: admin,
      document: fixture("https://example.org/a"),
    }),
  ).toMatchObject({ success: false });
});
it("extracts metadata and substantive text through the existing public fetch gate", async () => {
  vi.mocked(safeFetch).mockImplementation(async (url) => ({
    status: 200,
    body: url.endsWith("robots.txt")
      ? ""
      : `<html><head><title>Fixture article</title><meta name="author" content="Fixture author"/></head><body><article><h1>Fixture article</h1><p>${fixture(url).markdown.repeat(3)}</p></article></body></html>`,
    contentType: "text/html",
    url,
  }));
  const doc = await extractSubmission({
    url: "https://fixture-public.org/research",
    kind: "article",
  });
  expect(doc).toMatchObject({
    sourceId: "manual-submissions",
    title: "Fixture article",
    authors: ["Fixture author"],
    completeness: "full",
  });
  expect(doc.markdown.length).toBeGreaterThan(600);
  expect(
    vi
      .mocked(safeFetch)
      .mock.calls.some(([url]) => url.endsWith("/robots.txt")),
  ).toBe(true);
});
it("requires an administrator even for direct database calls", async () => {
  await expect(user(other, "hs_me_submissions")).rejects.toThrow(
    "Administrator required",
  );
  await expect(
    user(other, "hs_me_submission", {
      action: "request",
      url: "https://example.org/unauthorized",
      kind: "article",
    }),
  ).rejects.toThrow("Administrator required");
  await expect(
    user(admin, "hs_submission_work", { action: "claim", sourceToken: admin }),
  ).rejects.toThrow("permission denied");
});
it("previews privately, detects possible duplicates, and publishes only approved immutable text", async () => {
  const requested = await user<Submission>(admin, "hs_me_submission", {
    action: "request",
    url: "https://example.org/manual",
    kind: "article",
  });
  expect(requested.status).toBe("preview_queued");
  await expect(
    user(admin, "hs_me_submission", { action: "approve", id: requested.id }),
  ).rejects.toThrow("current preview");
  let fetches = 0;
  const extractor = async ({
    url,
  }: {
    url: string;
    kind: "article" | "report";
  }) => {
    fetches++;
    return fixture(url);
  };
  const first = await processSubmissions(local.rpc, write, read, 10, extractor);
  expect(first, first.error).toMatchObject({
    previewed: 1,
    published: 0,
    failed: 0,
  });
  const rows = await user<Submission[]>(admin, "hs_me_submissions");
  expect(rows[0]).toMatchObject({ id: requested.id, status: "ready" });
  expect(rows[0]).not.toHaveProperty("document");
  expect(rows[0]).not.toHaveProperty("token");
  expect(await local.rpc("hs_stats")).toMatchObject({ total: 0 });
  expect(objects.size).toBe(0);
  await user(admin, "hs_me_submission", {
    action: "approve",
    id: requested.id,
  });
  const second = await processSubmissions(
    local.rpc,
    write,
    read,
    10,
    extractor,
  );
  expect(second, second.error).toMatchObject({ published: 1, failed: 0 });
  expect(fetches).toBe(1);
  const published = (await user<Submission[]>(admin, "hs_me_submissions"))[0];
  expect(published.status).toBe("published");
  expect(await local.rpc("hs_stats")).toMatchObject({ total: 1 });
  const detail = await local.rpc<any>("hs_detail", {
    id: published.documentId,
  });
  expect(JSON.parse(await read(detail.object_path)).markdown).toBe(
    fixture("https://example.org/manual").markdown.trim(),
  );
  expect(
    await user(admin, "hs_me_submission", {
      action: "request",
      url: "https://example.org/manual",
      kind: "article",
    }),
  ).toMatchObject({ status: "duplicate", documentId: published.documentId });
  const similar = await user<Submission>(admin, "hs_me_submission", {
    action: "request",
    url: "https://example.org/another",
    kind: "article",
  });
  await processSubmissions(local.rpc, write, read, 10, extractor);
  expect(
    (await user<Submission[]>(admin, "hs_me_submissions")).find(
      (s) => s.id === similar.id,
    )?.duplicates,
  ).toEqual([
    {
      id: published.documentId,
      title: "Synthetic public write-up",
      match: "same title",
    },
  ]);
  await user(admin, "hs_me_submission", { action: "cancel", id: similar.id });
});
it("fences cancelled previews, stale worker tokens and unapproved ingestion", async () => {
  const request = await user<Submission>(admin, "hs_me_submission", {
    action: "request",
    url: "https://example.org/cancelled",
    kind: "article",
  });
  const source = await local.rpc<any>("hs_ops_source", {
    action: "claim",
    sourceId: "manual-submissions",
    force: true,
  });
  const work = await local.rpc<any>("hs_submission_work", {
    action: "claim",
    sourceToken: source.token,
  });
  await user(admin, "hs_me_submission", { action: "cancel", id: request.id });
  const doc = fixture(request.url);
  await expect(
    local.rpc("hs_submission_work", {
      action: "preview",
      id: work.id,
      token: work.token,
      sourceToken: source.token,
      document: doc,
      contentHash: prepare(doc).contentHash,
    }),
  ).rejects.toThrow("Submission lease lost");
  await expect(
    ingestDocument(local.rpc, write, doc, read, undefined, {
      id: work.id,
      token: work.token,
      sourceToken: source.token,
    }),
  ).rejects.toThrow("Approved submission lease lost");
  await local.rpc("hs_ops_source", {
    action: "release",
    sourceId: "manual-submissions",
    token: source.token,
    ok: true,
  });
});
it("blocks withdrawn URLs and expires abandoned previews without publishing them", async () => {
  const published = (await user<Submission[]>(admin, "hs_me_submissions")).find(
    (s) => s.status === "published",
  )!;
  await local.db.query(
    "update hs_documents set status='withdrawn' where id=$1",
    [published.documentId],
  );
  expect(
    await user(admin, "hs_me_submission", {
      action: "request",
      url: published.url,
      kind: "article",
    }),
  ).toMatchObject({ status: "blocked" });
  const pending = await user<Submission>(admin, "hs_me_submission", {
    action: "request",
    url: "https://example.org/expired",
    kind: "article",
  });
  await processSubmissions(local.rpc, write, read, 10, async ({ url }) =>
    fixture(url),
  );
  await local.db.query(
    "update hs_state set value=value||jsonb_build_object('previewExpiresAt',now()-interval '1 day') where key=$1",
    ["submission:" + pending.id],
  );
  await expect(
    user(admin, "hs_me_submission", { action: "approve", id: pending.id }),
  ).rejects.toThrow("current preview");
  await processSubmissions(local.rpc, write, read, 10, async ({ url }) =>
    fixture(url),
  );
  const expired = (await user<any[]>(admin, "hs_me_submissions")).find(
    (s) => s.id === pending.id,
  );
  expect(expired.status).toBe("expired");
  expect(expired.previewMarkdown).toBeUndefined();
});
