import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ingestionContext } from "./context";
import { runSource, type DiscoveryContext } from "./operations";
import { pentesterland } from "./adapters/pentesterland";
import { owasp } from "./adapters/owasp";
import { hackerone } from "./adapters/hackerone";
import { rss, feedConfigSchema } from "./adapters/rss";
import { wstg } from "./adapters/wstg";
import { arxiv } from "./adapters/arxiv";
import { bugcrowd } from "./adapters/bugcrowd";
import { yeswehack } from "./adapters/yeswehack";
import { sources } from "./sources";
import { documentSchema, type InputDocument } from "../packages/contracts";
const args = process.argv.slice(2),
  command = args[0] || "pilot";
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const limit = Number(option("--limit", command === "pilot" ? "500" : "100"));
if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
  throw new Error("--limit must be between 1 and 5000");
const feeds = feedConfigSchema
  .array()
  .parse(
    JSON.parse(
      await readFile(
        resolve(option("--feeds", "ingestion/feeds.json")),
        "utf8",
      ),
    ),
  );
const registry = [
  ...sources,
  ...feeds.map((f) => ({
    id: f.id,
    name: f.name,
    url: f.url,
    pollSeconds: f.pollSeconds || 14400,
  })),
];
const context = await ingestionContext(args.includes("--remote"));
let failed = 0;
try {
  const run = async (
    id: string,
    discover: (c: DiscoveryContext) => AsyncIterable<InputDocument>,
    mode: "recent" | "backfill" = "recent",
  ) => {
    const config = registry.find((s) => s.id === id);
    if (config) await context.rpc("hs_ops_register_source", config);
    const result = await runSource(
      context.rpc,
      context.write,
      context.read,
      id,
      discover,
      {
        mode,
        force:
          !["hourly", "refresh"].includes(command) || args.includes("--force"),
      },
    );
    failed += result.failed;
    console.log(JSON.stringify(result));
  };
  if (command === "pilot") {
    const articles = Math.min(100, Math.floor(limit / 5));
    if (articles) await run("owasp-cheatsheets", () => owasp(articles));
    await run("pentester-land", () => pentesterland(limit - articles));
  } else if (["hourly", "refresh", "backfill"].includes(command)) {
    const mode = command === "backfill" ? "backfill" : "recent";
    const source = option("--source", "all");
    if (source !== "all" && !registry.some((s) => s.id === source))
      throw new Error("Unknown source; use a configured source ID");
    if (
      command !== "backfill" &&
      (source === "all" || source === "owasp-cheatsheets")
    )
      await run("owasp-cheatsheets", () => owasp(Math.min(limit, 100)), mode);
    if (source === "all" || source === "pentester-land")
      await run("pentester-land", (c) => pentesterland(limit, false, c), mode);
    if (
      (source === "all" || source === "hackerone") &&
      process.env.HACKERONE_API_TOKEN
    )
      await run("hackerone", (c) => hackerone(limit, c), mode);
    if (source === "all" || source === "bugcrowd")
      await run("bugcrowd", (c) => bugcrowd(limit, c), mode);
    if (source === "all" || source === "owasp-wstg")
      await run("owasp-wstg", (c) => wstg(limit, c), mode);
    if (source === "all" || source === "arxiv-security")
      await run("arxiv-security", (c) => arxiv(limit, c), mode);
    if (source === "all" || source === "yeswehack-research")
      await run("yeswehack-research", (c) => yeswehack(limit, c), mode);
    for (const feed of feeds)
      if (source === "all" || source === feed.id)
        await run(feed.id, (c) => rss(feed, limit, c), mode);
  } else if (command === "owasp")
    await run("owasp-cheatsheets", () => owasp(limit));
  else if (command === "hackerone")
    await run("hackerone", (c) => hackerone(limit, c));
  else if (command === "import") {
    const path = option("--file", "");
    if (!path) throw new Error("Use import --file documents.json");
    const docs = JSON.parse(await readFile(resolve(path), "utf8"));
    async function* inputs() {
      for (const d of docs.slice(0, limit)) yield documentSchema.parse(d);
    }
    await run("manual-import", () => inputs());
  } else
    throw new Error(
      "Use refresh, hourly, backfill, pilot, owasp, hackerone, or import",
    );
  console.log(JSON.stringify({ archive: await context.rpc("hs_stats") }));
} finally {
  await context.close();
}
if (failed) process.exitCode = 1;
