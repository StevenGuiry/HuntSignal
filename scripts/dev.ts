import { serve } from "@hono/node-server";
import { createServer } from "vite";
import { Repository, supabaseRpc } from "../packages/repository";
import { createApp } from "../apps/api/app";
import {
  loadIngestionEnvironment,
  remoteConfiguration,
} from "../ingestion/config";
import { readSupabaseObject } from "../packages/supabase";
import { accountBackend } from "../apps/api/personal";
loadIngestionEnvironment();
let app: ReturnType<typeof createApp>,
  close = async () => {};
if (process.argv.includes("--remote")) {
  const { url, key } = remoteConfiguration();
  app = createApp(
    new Repository(supabaseRpc(url, key), (path) =>
      readSupabaseObject(
        url,
        key,
        process.env.ARCHIVE_BUCKET || "archive",
        path,
      ),
    ),
    "supabase-dev",
    accountBackend(
      url,
      process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
      key,
    ),
  );
} else {
  const { openLocal, readLocalObject } = await import("../packages/local");
  const local = await openLocal();
  close = () => local.db.close();
  app = createApp(new Repository(local.rpc, readLocalObject));
}
const api = serve({
  fetch: app.fetch,
  hostname: "127.0.0.1",
  port: 8787,
});
const vite = await createServer();
await vite.listen();
vite.printUrls();
const stop = async () => {
  api.close();
  await vite.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
