import { resolve } from "node:path";
import { loadIngestionEnvironment, remoteConfiguration } from "./config";
import {
  supabaseRpc,
  type ObjectReader,
  type Rpc,
} from "../packages/repository";
import { readSupabaseObject } from "../packages/supabase";
import { createEncoder } from "../packages/embeddings/runtime";
import { enrich } from "./enrich";
loadIngestionEnvironment();
const args = process.argv.slice(2);
const i = args.indexOf("--limit");
const limit = i < 0 ? 1000 : Number(args[i + 1]);
if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
  throw new Error("--limit must be 1–5000");
let rpc: Rpc,
  read: ObjectReader,
  close = async () => {};
if (args.includes("--remote")) {
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
let encoder: Awaited<ReturnType<typeof createEncoder>> | undefined;
try {
  const status = await rpc<{ database_bytes: number }>("hs_phase2_status");
  if (status.database_bytes > 400_000_000)
    throw new Error(
      "Database exceeded the 400 MB indexing threshold. Review capacity before continuing.",
    );
  encoder = await createEncoder(resolve("public/models") + "/");
  const result = await enrich(rpc, read, encoder, limit);
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
  console.log(JSON.stringify(await rpc("hs_phase2_status")));
} finally {
  await encoder?.dispose();
  await close();
}
