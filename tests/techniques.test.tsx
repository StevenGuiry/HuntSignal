import { beforeAll, afterAll, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { extractTechniques, indexTechniques } from "../ingestion/techniques";
import {
  TECHNIQUE_VERSION,
  techniqueSourceUrl,
  type TechniqueCard,
} from "../packages/techniques";
import { TechniqueEvidenceCard } from "../apps/web/Techniques";
import { openLocal } from "../packages/local";
import { ingestDocument } from "../ingestion/pipeline";
import { Repository } from "../packages/repository";
import { createApp } from "../apps/api/app";
import type { InputDocument } from "../packages/contracts";

const payload = "<svg/onload=alert(document.domain)>\n";
const text = `# Stored XSS\n\nThe attacker stored an XSS payload in the profile.\n\n## Reproduction\n\nThe injected payload was:\n\n\`\`\`html\n${payload}\`\`\`\n\nThis triggered script execution in the proof of concept.\n\n## Remediation\n\nEscape input, rather than inserting \`<script>alert(1)</script>\` as HTML.`;
it("extracts payloads verbatim, retains encodings, and links exact source offsets including Unicode", () => {
  const source = "Researcher 🧪\n\n" + text;
  const result = extractTechniques(source, {
    title: "Stored XSS",
    topics: ["XSS"],
  });
  const xss = result.items.find((i) => i.kind === "payload")!;
  expect(xss.text).toBe(payload);
  expect(source.slice(xss.sourceStart, xss.sourceEnd)).toBe(payload);
  expect(xss.label).toBe("HTML event-handler injection");
  expect(result.items.some((i) => i.text.includes("Escape input"))).toBe(false);
  const encoded = extractTechniques(
    "An XSS payload: `%3Cscript%3Ealert(1)%3C/script%3E`.",
    { title: "XSS", topics: [] },
  );
  expect(
    encoded.items.some(
      (i) =>
        i.kind === "payload" && i.text === "%3Cscript%3Ealert(1)%3C/script%3E",
    ),
  ).toBe(true);
});
it("excludes responses, mitigations and explicitly failed examples; never invents missing payloads", () => {
  const source = `# XSS report\n\n## Response\n\n\`\`\`http\nHTTP/1.1 200 OK\n\n${payload}\`\`\`\n\n## Test\n\nThis payload did not work:\n\n\`\`\`html\n${payload}\`\`\`\n\n## Patch\n\n\`\`\`html\n${payload}\`\`\``;
  expect(
    extractTechniques(source, { title: "XSS", topics: ["XSS"] }).items.filter(
      (i) => i.kind === "payload",
    ),
  ).toEqual([]);
  expect(
    extractTechniques(
      "The report was disclosed without reproduction details.",
      { title: "Stored XSS", topics: ["XSS"] },
    ).items,
  ).toEqual([]);
});
it("does not classify server configuration or bare scheme names as XSS payloads", () => {
  const server =
    'An RCE exploit leverages this server configuration:\n\n```xml\n<script location="component://processor.groovy"/>\n```';
  expect(
    extractTechniques(server, {
      title: "Server-side code execution",
      topics: ["RCE", "XSS"],
    }).items.filter((i) => i.kind === "payload"),
  ).toEqual([]);
  expect(
    extractTechniques(
      "The attack rejects `javascript:` and accepts only HTTPS.",
      { title: "Open redirect", topics: ["XSS"] },
    ).items.filter((i) => i.kind === "payload"),
  ).toEqual([]);
  const memory = extractTechniques(
    "This vulnerability triggers a use-after-free when the request is retried.",
    { title: "Memory safety report", topics: [] },
  );
  expect(memory.items.some((i) => i.techniqueId === "use-after-free")).toBe(
    true,
  );
});
it("recognises several vulnerability families with supporting context and bounds large excerpts", () => {
  const source =
    "A UNION-based SQL injection payload was used:\n\n```sql\nUNION SELECT 1,2,3\n```\n\nAn SSRF exploit reached internal services:\n\n`http://169.254.169.254/latest/meta-data/`\n\nA path traversal payload:\n\n`../../etc/passwd`";
  const items = extractTechniques(source, {
    title: "Injection report",
    topics: ["SQL injection", "SSRF", "Path traversal"],
  }).items;
  for (const topic of ["SQL injection", "SSRF", "Path traversal"])
    expect(items.some((i) => i.topic === topic && i.kind === "payload")).toBe(
      true,
    );
  const large = extractTechniques(
    "XSS payload:\n\n```html\n<script>" + "x".repeat(9000) + "</script>\n```",
    { title: "XSS", topics: ["XSS"] },
  );
  expect(large.oversized).toBeGreaterThan(0);
  expect(large.items.some((i) => i.kind === "payload")).toBe(false);
});
it("renders hostile source strings as inert text with no active payload URLs", () => {
  const item: TechniqueCard = {
    ...extractTechniques(text, { title: "XSS", topics: ["XSS"] }).items.find(
      (i) => i.kind === "payload",
    )!,
    document_id: "10000000-0000-4000-8000-000000000001",
    revision_id: "20000000-0000-4000-8000-000000000002",
    title: "Synthetic report",
    canonical_url: "https://example.org/report",
    platform: "Fixture",
    completeness: "full",
    published_at: null,
    ordinal: 0,
  };
  const html = renderToStaticMarkup(
    <TechniqueEvidenceCard item={item} onEvidence={() => {}} />,
  );
  expect(html).toContain("&lt;svg/onload=alert(document.domain)&gt;");
  expect(html).not.toContain("<svg/onload");
  expect(html).not.toContain('href="javascript:');
  expect(techniqueSourceUrl(item)).toContain(`at=${item.sourceStart}`);
  expect(techniqueSourceUrl(item)).toContain(`rev=${item.revision_id}`);
});
let local: Awaited<ReturnType<typeof openLocal>>;
const objects = new Map<string, string>(),
  write = async (p: string, v: string) => {
    objects.set(p, v);
  },
  read = async (p: string) => objects.get(p)!;
let docId: string, revisionId: string;
const input: InputDocument = {
  sourceId: "fixture",
  sourceName: "Fixture",
  sourceUrl: "https://example.org",
  externalId: "xss",
  canonicalUrl: "https://example.org/xss",
  title: "Stored XSS report",
  kind: "report",
  platform: "Fixture",
  authors: [],
  topics: ["XSS"],
  programs: [],
  excerpt: "",
  markdown: text,
  publishedAt: null,
  completeness: "full",
  license: "Fixture",
  licenseUrl: null,
  attribution: "Synthetic fixture",
  rightsEvidence: "https://example.org",
  canArchive: true,
};
beforeAll(async () => {
  local = await openLocal(true);
  docId = (await ingestDocument(local.rpc, write, input)).id;
  revisionId = (await local.rpc<any>("hs_detail", { id: docId }))
    .current_revision_id;
  await ingestDocument(local.rpc, write, {
    ...input,
    externalId: "article",
    canonicalUrl: "https://example.org/article",
    kind: "article",
  });
}, 60000);
afterAll(async () => {
  await local?.db.close();
});
it("indexes reports only, tracks empty reports, searches payloads and aliases, and restricts backend writes", async () => {
  expect(await indexTechniques(local.rpc, read)).toMatchObject({
    indexed: 1,
    failed: 0,
  });
  expect(await indexTechniques(local.rpc, read)).toMatchObject({ indexed: 0 });
  const app = createApp(new Repository(local.rpc, read));
  for (const q of ["XSS", "cross-site scripting", "<svg/onload"]) {
    const r = await app.request(
      "/api/techniques?kind=payload&q=" + encodeURIComponent(q),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const data = (await r.json()) as any;
    expect(data.total).toBeGreaterThan(0);
    expect(data.coverage).toMatchObject({
      reports: 1,
      indexed: 1,
      withPayloads: 1,
    });
    expect(data.items[0].text).toBe(payload);
  }
  expect((await app.request("/api/techniques?reportId=bad")).status).toBe(400);
  for (const fn of [
    "hs_techniques_pending",
    "hs_techniques_put",
    "hs_techniques_search",
  ])
    await expect(
      local.db.transaction(async (tx) => {
        await tx.exec("set local role authenticated");
        await tx.query(`select ${fn}('{}')`);
      }),
    ).rejects.toThrow("permission denied");
  const empty = (
    await ingestDocument(local.rpc, write, {
      ...input,
      externalId: "empty",
      canonicalUrl: "https://example.org/empty",
      markdown:
        "The report describes a vulnerability but its public summary omits all reproduction details and payloads. No examples were disclosed.",
    })
  ).id;
  await indexTechniques(local.rpc, read);
  const data = await local.rpc<any>("hs_techniques_search", {
    version: TECHNIQUE_VERSION,
    reportId: empty,
  });
  expect(data.coverage).toMatchObject({
    reports: 1,
    indexed: 1,
    withEvidence: 0,
  });
});
it("invalidates old evidence on revision change and removes withdrawn report payloads", async () => {
  await ingestDocument(local.rpc, write, {
    ...input,
    markdown: text + "\nNew source revision.",
  });
  expect(
    (await local.rpc<any>("hs_techniques_search", { reportId: docId })).total,
  ).toBe(0);
  expect(
    await local.rpc("hs_techniques_put", {
      id: docId,
      revisionId,
      version: TECHNIQUE_VERSION,
      ...extractTechniques(text, input),
    }),
  ).toEqual({ stale: true });
  await indexTechniques(local.rpc, read);
  expect(
    (await local.rpc<any>("hs_techniques_search", { reportId: docId })).total,
  ).toBeGreaterThan(0);
  await local.db.query(
    "update hs_documents set status='withdrawn' where id=$1",
    [docId],
  );
  expect(
    (await local.rpc<any>("hs_techniques_search", { reportId: docId })).total,
  ).toBe(0);
  expect(
    (
      await local.db.query(
        "select count(*)::int n from hs_technique_entries where document_id=$1",
        [docId],
      )
    ).rows[0],
  ).toEqual({ n: 0 });
});
