import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ingestionContext } from "./context";
import { runSource, type DiscoveryContext } from "./operations";
import { pentesterland } from "./adapters/pentesterland";
import { owasp } from "./adapters/owasp";
import { hackerone } from "./adapters/hackerone";
import { rss, type FeedConfig } from "./adapters/rss";
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
const context = await ingestionContext(args.includes("--remote"));
let failed = 0;
try {
  const run = async (
    id: string,
    discover: (c: DiscoveryContext) => AsyncIterable<InputDocument>,
    mode: "recent" | "backfill" = "recent",
  ) => {
    const result = await runSource(
      context.rpc,
      context.write,
      context.read,
      id,
      discover,
      { mode, force: command !== "hourly" || args.includes("--force") },
    );
    failed += result.failed;
    console.log(JSON.stringify(result));
  };
  if (command === "pilot") {
    const articles = Math.min(100, Math.floor(limit / 5));
    if (articles) await run("owasp-cheatsheets", () => owasp(articles));
    await run("pentester-land", () => pentesterland(limit - articles));
  } else if (command === "hourly" || command === "backfill") {
    const mode = command === "backfill" ? "backfill" : "recent";
    const source = option("--source", "all");
    if (
      command === "hourly" &&
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
    const path = option("--feeds", "ingestion/feeds.json");
    const feeds = JSON.parse(
      await readFile(resolve(path), "utf8"),
    ) as FeedConfig[];
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
    throw new Error("Use hourly, backfill, pilot, owasp, hackerone, or import");
  console.log(JSON.stringify({ archive: await context.rpc("hs_stats") }));
} finally {
  await context.close();
}
if (failed) process.exitCode = 1;
