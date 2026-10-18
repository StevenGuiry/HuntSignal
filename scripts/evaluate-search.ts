import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import {
  Repository,
  supabaseRpc,
  type Rpc,
  type ObjectReader,
} from "../packages/repository";
import {
  loadIngestionEnvironment,
  remoteConfiguration,
} from "../ingestion/config";
import { readSupabaseObject } from "../packages/supabase";
import { searchSchema } from "../packages/contracts";
import { EMBEDDING_MODEL } from "../packages/embeddings/config";
import { createEncoder } from "../packages/embeddings/runtime";
loadIngestionEnvironment();
const remote = process.argv.includes("--remote");
const caseOption = process.argv.indexOf("--cases");
const casePath =
  caseOption < 0
    ? "tests/search-eval/cases.json"
    : process.argv[caseOption + 1];
if (!casePath) throw new Error("Use --cases PATH");
const resultName =
  caseOption < 0
    ? "search"
    : basename(casePath, ".json").replace(/[^a-zA-Z0-9_-]/g, "");
let rpc: Rpc,
  read: ObjectReader,
  close = async () => {};
if (remote) {
  const { url, key } = remoteConfiguration();
  rpc = supabaseRpc(url, key);
  read = (path) =>
    readSupabaseObject(url, key, process.env.ARCHIVE_BUCKET || "archive", path);
} else {
  const { openLocal, readLocalObject } = await import("../packages/local");
  const local = await openLocal();
  rpc = local.rpc;
  read = readLocalObject;
  close = () => local.db.close();
}
const encoder = await createEncoder(resolve("public/models") + "/");
const dataRoot = resolve(process.env.HUNTSIGNAL_DATA_DIR || ".data");
try {
  const cases = JSON.parse(await readFile(casePath, "utf8")) as {
    q: string;
    title: string;
    kind: string;
  }[];
  const repository = new Repository(rpc, read);
  const results: {
    q: string;
    title: string;
    kind: string;
    keywordRank: number | null;
    hybridRank: number | null;
    milliseconds: number;
    keywordMilliseconds: number;
  }[] = [];
  for (const entry of cases) {
    const keywordStart = performance.now();
    const keyword = await repository.search(searchSchema.parse({ q: entry.q }));
    const keywordMilliseconds = Math.round(performance.now() - keywordStart);
    const [vector] = await encoder.embed([entry.q]);
    const start = performance.now();
    const hybrid = await repository.search(
      searchSchema.parse({
        q: entry.q,
        mode: "hybrid",
        modelId: EMBEDDING_MODEL.id,
        vector,
      }),
    );
    const target = entry.title.toLowerCase();
    const position = (items: { title: string }[]) => {
      const n = items.findIndex((d) => d.title.toLowerCase() === target);
      return n < 0 ? null : n + 1;
    };
    results.push({
      ...entry,
      keywordRank: position(keyword.items),
      hybridRank: position(hybrid.items),
      milliseconds: Math.round(performance.now() - start),
      keywordMilliseconds,
    });
    if (results.length % 10 === 0)
      console.log(
        JSON.stringify({ evaluated: results.length, total: cases.length }),
      );
  }
  const metrics = (key: "keywordRank" | "hybridRank", rows = results) => ({
    recall20: rows.filter((r) => r[key] !== null).length / rows.length,
    ndcg10:
      rows.reduce(
        (n, r) =>
          n + (r[key] && r[key]! <= 10 ? 1 / Math.log2(r[key]! + 1) : 0),
        0,
      ) / rows.length,
  });
  const summary = {
    queries: results.length,
    keyword: metrics("keywordRank"),
    hybrid: metrics("hybridRank"),
    naturalLanguage: {
      keyword: metrics(
        "keywordRank",
        results.filter((r) => r.kind === "natural"),
      ),
      hybrid: metrics(
        "hybridRank",
        results.filter((r) => r.kind === "natural"),
      ),
    },
    queryP95Ms: results.map((r) => r.milliseconds).sort((a, b) => a - b)[
      Math.ceil(results.length * 0.95) - 1
    ],
    keywordP95Ms: results
      .map((r) => r.keywordMilliseconds)
      .sort((a, b) => a - b)[Math.ceil(results.length * 0.95) - 1],
    evaluation:
      "One designated relevant article per query; a regression set, not exhaustive human relevance judgments.",
  };
  await mkdir(resolve(dataRoot, "evaluation"), { recursive: true });
  await writeFile(
    resolve(
      dataRoot,
      `evaluation/${remote ? "hosted-" : ""}${resultName}.json`,
    ),
    JSON.stringify({ summary, results }, null, 2),
  );
  console.log(JSON.stringify(summary));
  if (summary.hybrid.recall20 < 0.8) process.exitCode = 1;
} finally {
  await encoder.dispose();
  await close();
}
