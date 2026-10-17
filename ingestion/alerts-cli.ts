import { loadIngestionEnvironment, remoteConfiguration } from "./config";
import { supabaseRpc, type Rpc } from "../packages/repository";
import { processAlerts } from "../packages/alerts";
loadIngestionEnvironment();
let rpc: Rpc,
  close = async () => {};
if (process.argv.includes("--remote")) {
  const { url, key } = remoteConfiguration();
  rpc = supabaseRpc(url, key);
} else {
  const { openLocal } = await import("../packages/local");
  const local = await openLocal();
  rpc = local.rpc;
  close = () => local.db.close();
}
try {
  console.log(JSON.stringify(await processAlerts(rpc)));
} finally {
  await close();
}
