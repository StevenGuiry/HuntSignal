/** A bounded public-source preflight. Does not write to the archive or print bodies. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { wstg } from "../ingestion/adapters/wstg";
import { arxiv } from "../ingestion/adapters/arxiv";
import { bugcrowd } from "../ingestion/adapters/bugcrowd";
import { yeswehack } from "../ingestion/adapters/yeswehack";
import { rss, feedConfigSchema } from "../ingestion/adapters/rss";
import { documentSchema, type InputDocument } from "../packages/contracts";
import { safeError } from "../ingestion/operations";
const feeds = feedConfigSchema
  .array()
  .parse(JSON.parse(await readFile("ingestion/feeds.json", "utf8")));
const sources: { id: string; read: () => AsyncIterable<InputDocument> }[] = [
  { id: "owasp-wstg", read: () => wstg(3) },
  { id: "arxiv-security", read: () => arxiv(3) },
  { id: "bugcrowd", read: () => bugcrowd(3) },
  { id: "yeswehack-research", read: () => yeswehack(3) },
  ...feeds.map((f) => ({ id: f.id, read: () => rss(f, 3) })),
];
const results = [];
for (const source of sources) {
  try {
    const docs = [];
    for await (const raw of source.read()) {
      const d = documentSchema.parse(raw);
      docs.push({
        title: d.title,
        url: d.canonicalUrl,
        kind: d.kind,
        completeness: d.completeness,
        characters: d.markdown.length,
      });
    }
    if (!docs.length)
      throw new Error("No matching documents in validation sample");
    results.push({ source: source.id, status: "passed", documents: docs });
    console.log(
      JSON.stringify({
        source: source.id,
        status: "passed",
        documents: docs.length,
      }),
    );
  } catch (e) {
    results.push({ source: source.id, status: "failed", error: safeError(e) });
    console.log(JSON.stringify(results.at(-1)));
    process.exitCode = 1;
  }
}
await mkdir(".data", { recursive: true });
await writeFile(
  ".data/source-validation.json",
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
);
